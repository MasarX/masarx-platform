BEGIN;

SELECT plan(10);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000c560';
  v_client uuid := '00000000-0000-0000-0000-00000000c561';
  v_invoice uuid := '00000000-0000-0000-0000-00000000c562';
  v_ops uuid := '00000000-0000-0000-0000-00000000c563';
  v_res jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Refund Org', 'console-billing-refund-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Refund Client', 'console-billing-refund-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops, v_org, 'console-billing-refund@example.com', 'Console Billing Refund Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency, invoice_number,
    subtotal, tax_total, total, amount_paid, amount_due,
    issued_at, paid_at, created_by_user_id, version
  )
  VALUES (
    v_invoice, v_org, v_client, 'paid', 'sar', 'INV-CV2-REFUND-001',
    100, 15, 115, 115, 0,
    now() - interval '2 days', now() - interval '1 day', v_ops, 2
  )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      version = EXCLUDED.version,
      updated_at = now();

  PERFORM set_config('test.billing_refund_invoice', v_invoice::text, true);
  PERFORM set_config('test.billing_refund_ops', v_ops::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_refund_ops'), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.billing_invoice_refund_v1(jsonb_build_object(
    'billing_invoice_id', current_setting('test.billing_refund_invoice'),
    'refund_amount', 115,
    'refund_reason', 'full browser refund proof'
  ));
  PERFORM set_config('test.billing_refund_status', v_res->>'status', true);
  PERFORM set_config('test.billing_refund_correlation_id', v_res->>'correlation_id', true);
END $$;
RESET ROLE;

SELECT is(
  current_setting('test.billing_refund_status'),
  'refunded',
  'full refund returns refunded lifecycle'
);

SELECT lives_ok(
  $$ SELECT current_setting('test.billing_refund_correlation_id')::uuid $$,
  'refund returns UUID correlation_id'
);

SELECT is(
  (
    SELECT decision_outcome
    FROM public.decision_log
    WHERE resource_id = current_setting('test.billing_refund_invoice')::uuid
      AND decision_category = 'billing_invoice.refund'
      AND correlation_id = current_setting('test.billing_refund_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'refunded',
  'refund decision log records correlated outcome'
);

SELECT is(
  (
    SELECT event_type
    FROM public.domain_events
    WHERE resource_id = current_setting('test.billing_refund_invoice')::uuid
      AND resource_type = 'billing_invoice'
      AND correlation_id = current_setting('test.billing_refund_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'billing_invoice.refunded',
  'refund domain event records correlated event'
);

SELECT is(
  (
    SELECT status
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_refund_invoice')::uuid
  ),
  'refunded',
  'full refund stores refunded invoice status'
);

SELECT is(
  (
    SELECT amount_paid::numeric
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_refund_invoice')::uuid
  ),
  0::numeric,
  'full refund clears amount_paid'
);

SELECT is(
  (
    SELECT amount_due::numeric
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_refund_invoice')::uuid
  ),
  0::numeric,
  'full refund keeps amount_due closed'
);

SELECT is(
  (
    SELECT to_status
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_refund_invoice')::uuid
      AND event_type = 'billing_invoice.refunded'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'refunded',
  'refund event records refunded target status'
);

SELECT is(
  (
    SELECT payload->>'refund_reason'
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_refund_invoice')::uuid
      AND event_type = 'billing_invoice.refunded'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'full browser refund proof',
  'refund event records reason'
);

SELECT is(
  (
    SELECT payment_status
    FROM public.v_billing_invoice_directory
    WHERE invoice_id = current_setting('test.billing_refund_invoice')::uuid
  ),
  'refunded',
  'billing invoice directory projects refunded payment status'
);

SELECT * FROM finish();

ROLLBACK;
