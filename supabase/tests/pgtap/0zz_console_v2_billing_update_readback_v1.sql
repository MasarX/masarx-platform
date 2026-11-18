-- pgTAP: Console V2 billing draft update readback and lineage contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d5b0';
  v_client UUID := '00000000-0000-0000-0000-00000000d5b1';
  v_invoice UUID := '00000000-0000-0000-0000-00000000d5b2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000d5b3';
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Update Org', 'console-billing-update-org')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Update Client', 'console-billing-update-client')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_admin,
    v_org,
    'console-billing-update-ops@example.com',
    'Console Billing Update Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        user_type = EXCLUDED.user_type,
        access_scope_type = EXCLUDED.access_scope_type;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, invoice_number, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, due_at, version, metadata
  )
  VALUES (
    v_invoice,
    v_org,
    v_client,
    'INV-PGTAP-UPDATE-1',
    'draft',
    'sar',
    100,
    15,
    115,
    0,
    115,
    '2026-06-01T00:00:00Z',
    '2026-06-30T00:00:00Z',
    '2026-07-15T00:00:00Z',
    1,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
    SET status = 'draft',
        subtotal = 100,
        tax_total = 15,
        total = 115,
        amount_paid = 0,
        amount_due = 115,
        version = 1;

  PERFORM set_config('request.jwt.claim.sub', v_ops_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.update_billing_invoice_v1(jsonb_build_object(
    'billing_invoice_id', v_invoice,
    'currency', 'SAR',
    'total', 230,
    'period_start_at', '2026-07-01T00:00:00Z',
    'period_end_at', '2026-07-31T00:00:00Z',
    'due_at', '2026-08-15T00:00:00Z'
  ))
  INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM set_config('test.billing_update_invoice_id', v_invoice::text, true);
  PERFORM set_config('test.billing_update_correlation', v_result->>'correlation_id', true);
END $$;

SELECT is(
  (SELECT status FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  'draft',
  'draft invoice remains draft after edit'
);

SELECT is(
  (SELECT total FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  230::numeric,
  'invoice total updates'
);

SELECT is(
  (SELECT amount_due FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  230::numeric,
  'invoice amount_due updates'
);

SELECT is(
  (SELECT currency FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  'SAR',
  'invoice currency normalizes to uppercase'
);

SELECT is(
  (SELECT due_at::date FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  '2026-08-15'::date,
  'invoice due date updates'
);

SELECT is(
  (SELECT version FROM public.billing_invoices WHERE id = current_setting('test.billing_update_invoice_id')::uuid),
  2,
  'invoice version increments'
);

SELECT is(
  (SELECT event_type FROM public.billing_invoice_events WHERE invoice_id = current_setting('test.billing_update_invoice_id')::uuid ORDER BY created_at DESC, id DESC LIMIT 1),
  'billing_invoice.updated',
  'billing invoice update event is appended'
);

SELECT is(
  (SELECT (payload->>'total')::numeric FROM public.billing_invoice_events WHERE invoice_id = current_setting('test.billing_update_invoice_id')::uuid ORDER BY created_at DESC, id DESC LIMIT 1),
  230::numeric,
  'billing invoice event payload carries total'
);

SELECT ok(
  current_setting('test.billing_update_correlation')::uuid IS NOT NULL,
  'update_billing_invoice_v1 returns UUID correlation'
);

SELECT is(
  (SELECT decision_outcome FROM public.decision_log WHERE resource_type = 'billing_invoice' AND resource_id = current_setting('test.billing_update_invoice_id')::uuid AND correlation_id = current_setting('test.billing_update_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  'updated',
  'decision log is correlated'
);

SELECT is(
  (SELECT event_type FROM public.domain_events WHERE resource_type = 'billing_invoice' AND resource_id = current_setting('test.billing_update_invoice_id')::uuid AND correlation_id = current_setting('test.billing_update_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  'billing_invoice.updated',
  'domain event is correlated'
);

SELECT is(
  (SELECT (payload->>'total')::numeric FROM public.domain_events WHERE resource_type = 'billing_invoice' AND resource_id = current_setting('test.billing_update_invoice_id')::uuid AND correlation_id = current_setting('test.billing_update_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  230::numeric,
  'domain event payload carries total'
);

SELECT * FROM finish();
ROLLBACK;
