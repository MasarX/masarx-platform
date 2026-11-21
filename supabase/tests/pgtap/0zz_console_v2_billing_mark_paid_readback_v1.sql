SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_invoice uuid := gen_random_uuid();
  v_paid_invoice uuid := gen_random_uuid();
  v_ops uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_amount_invoice uuid := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Payment Org', 'console-billing-payment-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Payment Client', 'console-billing-payment-client-' || left(v_client::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'console-billing-payment-ops-' || v_ops::text || '@example.com', 'Console Billing Payment Ops', 'ops_admin', 'tenant', NULL),
    (v_viewer, v_org, 'console-billing-payment-viewer-' || v_viewer::text || '@example.com', 'Console Billing Payment Viewer', 'billing_viewer', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency, invoice_number,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, issued_at, due_at, paid_at, created_by_user_id, version, metadata
  )
  VALUES
    (
      v_invoice, v_org, v_client, 'issued', 'sar', 'CV2-MARK-PAID-001',
      100, 15, 115, 0, 115,
      '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', '2026-06-01T08:00:00Z', '2026-06-15T00:00:00Z',
      NULL, v_ops, 1, '{}'::jsonb
    ),
    (
      v_paid_invoice, v_org, v_client, 'paid', 'sar', 'CV2-MARK-PAID-DENIED',
      70, 10.5, 80.5, 80.5, 0,
      '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', '2026-06-01T08:00:00Z', '2026-06-15T00:00:00Z',
      '2026-06-03T08:00:00Z', v_ops, 1, '{}'::jsonb
    ),
    (
      v_amount_invoice, v_org, v_client, 'issued', 'sar', 'CV2-MARK-PAID-AMOUNT',
      200, 30, 230, 0, 230,
      '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', '2026-06-01T08:00:00Z', '2026-06-15T00:00:00Z',
      NULL, v_ops, 1, '{}'::jsonb
    )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      invoice_number = EXCLUDED.invoice_number,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      paid_at = EXCLUDED.paid_at,
      version = EXCLUDED.version,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  DELETE FROM public.decision_log
  WHERE resource_id IN (v_invoice, v_paid_invoice, v_amount_invoice)
    AND resource_type = 'billing_invoice';
  DELETE FROM public.domain_events
  WHERE resource_id IN (v_invoice, v_paid_invoice, v_amount_invoice)
    AND resource_type = 'billing_invoice';

  PERFORM set_config('test.billing_payment_invoice', v_invoice::text, true);
  PERFORM set_config('test.billing_payment_paid_invoice', v_paid_invoice::text, true);
  PERFORM set_config('test.billing_payment_amount_invoice', v_amount_invoice::text, true);
  PERFORM set_config('test.billing_payment_ops', v_ops::text, true);
  PERFORM set_config('test.billing_payment_viewer', v_viewer::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_payment_viewer'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.billing_invoice_mark_paid_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.billing_payment_invoice'),
       'payment_amount', 115,
       'payment_reference', 'denied-public-payment'
     )) $$,
  '42501',
  NULL,
  'read-only billing viewer denied public.billing_invoice_mark_paid_v1'
);

SELECT throws_ok(
  $$ SELECT api.billing_invoice_mark_paid_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.billing_payment_invoice'),
       'payment_amount', 115,
       'payment_reference', 'denied-api-payment'
     )) $$,
  '42501',
  NULL,
  'read-only billing viewer denied api.billing_invoice_mark_paid_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT jsonb_build_object('status', status, 'amount_paid', amount_paid, 'amount_due', amount_due, 'paid_at', paid_at, 'version', version)::text
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_payment_invoice')::uuid
  ),
  jsonb_build_object('status', 'issued', 'amount_paid', 0::numeric, 'amount_due', 115::numeric, 'paid_at', NULL, 'version', 1)::text,
  'denied payment leaves invoice unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_payment_ops'), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := api.billing_invoice_mark_paid_v1(jsonb_build_object(
    'billing_invoice_id', current_setting('test.billing_payment_invoice'),
    'payment_amount', 115,
    'payment_reference', 'bank receipt pgtap 20260524',
    'paid_at', '2026-06-04T09:30:00Z',
    'metadata', jsonb_build_object('proof', 'console-v2-billing-mark-paid-pgtap')
  ));
  PERFORM set_config('test.billing_payment_ok', v_res->>'ok', true);
  PERFORM set_config('test.billing_payment_status', v_res->>'status', true);
  PERFORM set_config('test.billing_payment_correlation_id', v_res->>'correlation_id', true);
END $$;
RESET ROLE;

SELECT is(current_setting('test.billing_payment_ok'), 'true', 'mark paid returns ok through api wrapper');
SELECT is(current_setting('test.billing_payment_status'), 'paid', 'mark paid returns paid status');
SELECT lives_ok(
  $$ SELECT current_setting('test.billing_payment_correlation_id')::uuid $$,
  'mark paid returns UUID correlation_id'
);

SELECT is(
  (
    SELECT jsonb_build_object('status', status, 'amount_paid', amount_paid, 'amount_due', amount_due, 'paid_at', paid_at IS NOT NULL, 'version', version)::text
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_payment_invoice')::uuid
  ),
  jsonb_build_object('status', 'paid', 'amount_paid', 115::numeric, 'amount_due', 0::numeric, 'paid_at', TRUE, 'version', 2)::text,
  'mark paid stores paid invoice truth'
);

SELECT is(
  (
    SELECT payment_status
    FROM public.v_billing_invoice_directory
    WHERE invoice_id = current_setting('test.billing_payment_invoice')::uuid
  ),
  'paid',
  'directory projects paid payment status'
);

SELECT is(
  (
    SELECT is_overdue
    FROM public.v_billing_invoice_directory
    WHERE invoice_id = current_setting('test.billing_payment_invoice')::uuid
  ),
  FALSE,
  'directory removes paid invoice from overdue projection'
);

SELECT is(
  (
    SELECT to_status
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_payment_invoice')::uuid
      AND event_type = 'billing_invoice.paid'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'paid',
  'payment event records paid target status'
);

SELECT is(
  (
    SELECT payload->>'payment_reference'
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_payment_invoice')::uuid
      AND event_type = 'billing_invoice.paid'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'bank receipt pgtap 20260524',
  'payment event carries visible payment reference'
);

SELECT is(
  (
    SELECT decision_outcome
    FROM public.decision_log
    WHERE resource_id = current_setting('test.billing_payment_invoice')::uuid
      AND decision_category = 'billing_invoice.payment'
      AND correlation_id = current_setting('test.billing_payment_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'paid',
  'payment decision log records correlated outcome'
);

SELECT is(
  (
    SELECT event_type
    FROM public.domain_events
    WHERE resource_id = current_setting('test.billing_payment_invoice')::uuid
      AND resource_type = 'billing_invoice'
      AND correlation_id = current_setting('test.billing_payment_correlation_id')::uuid
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'billing_invoice.paid',
  'payment domain event records correlated event'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_payment_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.billing_invoice_mark_paid_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.billing_payment_paid_invoice'),
       'payment_amount', 80.5,
       'payment_reference', 'duplicate-payment'
     )) $$,
  '22023',
  NULL,
  'mark paid rejects already paid invoices'
);

SELECT throws_ok(
  $$ SELECT api.billing_invoice_mark_paid_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.billing_payment_amount_invoice'),
       'payment_amount', 10,
       'payment_reference', 'underpayment'
     )) $$,
  '22023',
  NULL,
  'mark paid rejects non-outstanding payment amounts'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
