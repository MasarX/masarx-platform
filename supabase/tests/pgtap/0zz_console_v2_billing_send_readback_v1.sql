BEGIN;

SELECT plan(10);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000c570';
  v_client uuid := '00000000-0000-0000-0000-00000000c571';
  v_invoice uuid := '00000000-0000-0000-0000-00000000c572';
  v_ops uuid := '00000000-0000-0000-0000-00000000c573';
  v_res jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Send Org', 'console-billing-send-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Send Client', 'console-billing-send-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops, v_org, 'console-billing-send@example.com', 'Console Billing Send Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency, invoice_number,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, due_at, created_by_user_id, version
  )
  VALUES (
    v_invoice, v_org, v_client, 'draft', 'sar', NULL,
    100, 15, 115, 0, 115,
    '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', now() + interval '15 days', v_ops, 1
  )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      invoice_number = EXCLUDED.invoice_number,
      issued_at = NULL,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      due_at = EXCLUDED.due_at,
      version = EXCLUDED.version,
      updated_at = now();

  PERFORM set_config('test.billing_send_invoice', v_invoice::text, true);
  PERFORM set_config('test.billing_send_ops', v_ops::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_send_ops'), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.billing_invoice_send_v1(jsonb_build_object(
    'billing_invoice_id', current_setting('test.billing_send_invoice')
  ));
  PERFORM set_config('test.billing_send_status', v_res->>'ok', true);
  PERFORM set_config('test.billing_send_invoice_number', v_res->>'invoice_number', true);
  PERFORM set_config('test.billing_send_correlation_id', v_res->>'correlation_id', true);
END $$;
RESET ROLE;

SELECT is(
  current_setting('test.billing_send_status'),
  'true',
  'send returns ok'
);

SELECT ok(
  current_setting('test.billing_send_invoice_number') LIKE 'INV-%',
  'send generates backend-owned invoice number when missing'
);

SELECT lives_ok(
  $$ SELECT current_setting('test.billing_send_correlation_id')::uuid $$,
  'send returns UUID correlation_id'
);

SELECT is(
  (
    SELECT status
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_send_invoice')::uuid
  ),
  'issued',
  'send stores issued status'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_send_invoice')::uuid
      AND issued_at IS NOT NULL
  ),
  'send stores issued_at'
);

SELECT is(
  (
    SELECT payment_status
    FROM public.v_billing_invoice_directory
    WHERE invoice_id = current_setting('test.billing_send_invoice')::uuid
  ),
  'issued',
  'directory projects issued payment status'
);

SELECT is(
  (
    SELECT to_status
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_send_invoice')::uuid
      AND event_type = 'billing_invoice.issued'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'issued',
  'send event records issued target status'
);

SELECT is(
  (
    SELECT decision_outcome
    FROM public.decision_log
    WHERE resource_id = current_setting('test.billing_send_invoice')::uuid
      AND decision_category = 'billing_invoice.send'
      AND correlation_id = current_setting('test.billing_send_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'issued',
  'send decision log records correlated outcome'
);

SELECT is(
  (
    SELECT event_type
    FROM public.domain_events
    WHERE resource_id = current_setting('test.billing_send_invoice')::uuid
      AND resource_type = 'billing_invoice'
      AND correlation_id = current_setting('test.billing_send_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'billing_invoice.issued',
  'send domain event records correlated event'
);

SELECT is(
  (
    SELECT (payload->>'total')::numeric
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_send_invoice')::uuid
      AND event_type = 'billing_invoice.issued'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  115::numeric,
  'send event carries invoice total'
);

SELECT * FROM finish();

ROLLBACK;
