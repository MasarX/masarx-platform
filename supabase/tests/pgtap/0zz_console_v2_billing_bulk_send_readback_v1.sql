-- pgTAP: Console V2 billing bulk send readback and lineage contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d6b0';
  v_client UUID := '00000000-0000-0000-0000-00000000d6b1';
  v_invoice_1 UUID := '00000000-0000-0000-0000-00000000d6b2';
  v_invoice_2 UUID := '00000000-0000-0000-0000-00000000d6b3';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000d6b4';
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Bulk Send Org', 'console-billing-bulk-send-org')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Bulk Send Client', 'console-billing-bulk-send-client')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_admin,
    v_org,
    'console-billing-bulk-send-ops@example.com',
    'Console Billing Bulk Send Ops',
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
  VALUES
    (
      v_invoice_1,
      v_org,
      v_client,
      'INV-PGTAP-BULK-1',
      'draft',
      'SAR',
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
    ),
    (
      v_invoice_2,
      v_org,
      v_client,
      'INV-PGTAP-BULK-2',
      'draft',
      'SAR',
      200,
      30,
      230,
      0,
      230,
      '2026-06-01T00:00:00Z',
      '2026-06-30T00:00:00Z',
      '2026-07-15T00:00:00Z',
      1,
      '{}'::jsonb
    )
  ON CONFLICT (id) DO UPDATE
    SET status = 'draft',
        issued_at = NULL,
        invoice_number = EXCLUDED.invoice_number,
        subtotal = EXCLUDED.subtotal,
        tax_total = EXCLUDED.tax_total,
        total = EXCLUDED.total,
        amount_paid = 0,
        amount_due = EXCLUDED.amount_due,
        version = 1;

  PERFORM set_config('request.jwt.claim.sub', v_ops_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_bulk_billing_invoice_send_v1(jsonb_build_object(
    'billing_invoice_ids', jsonb_build_array(v_invoice_1, v_invoice_2)
  ))
  INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM set_config('test.billing_bulk_invoice_1', v_invoice_1::text, true);
  PERFORM set_config('test.billing_bulk_invoice_2', v_invoice_2::text, true);
  PERFORM set_config('test.billing_bulk_result', v_result::text, true);
END $$;

SELECT ok(
  (current_setting('test.billing_bulk_result')::jsonb->>'ok')::boolean,
  'bulk send returns ok'
);

SELECT is(
  (current_setting('test.billing_bulk_result')::jsonb->>'succeeded_count')::integer,
  2,
  'bulk send succeeds for both selected invoices'
);

SELECT is(
  (current_setting('test.billing_bulk_result')::jsonb->>'failed_count')::integer,
  0,
  'bulk send reports no failed selected invoices'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.billing_invoices
    WHERE id IN (
      current_setting('test.billing_bulk_invoice_1')::uuid,
      current_setting('test.billing_bulk_invoice_2')::uuid
    )
      AND status = 'issued'
      AND issued_at IS NOT NULL),
  2,
  'both selected invoices are issued with issued_at'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.billing_invoices
    WHERE id IN (
      current_setting('test.billing_bulk_invoice_1')::uuid,
      current_setting('test.billing_bulk_invoice_2')::uuid
    )
      AND version = 2),
  2,
  'both selected invoices increment version once'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.billing_invoice_events
    WHERE invoice_id IN (
      current_setting('test.billing_bulk_invoice_1')::uuid,
      current_setting('test.billing_bulk_invoice_2')::uuid
    )
      AND event_type = 'billing_invoice.issued'),
  2,
  'bulk send appends issued events for both invoices'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.decision_log
    WHERE resource_type = 'billing_invoice'
      AND resource_id IN (
        current_setting('test.billing_bulk_invoice_1')::uuid,
        current_setting('test.billing_bulk_invoice_2')::uuid
      )
      AND decision_category = 'billing_invoice.send'
      AND decision_outcome = 'issued'),
  2,
  'bulk send appends decision rows for both invoices'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.domain_events
    WHERE resource_type = 'billing_invoice'
      AND resource_id IN (
        current_setting('test.billing_bulk_invoice_1')::uuid,
        current_setting('test.billing_bulk_invoice_2')::uuid
      )
      AND event_type = 'billing_invoice.issued'),
  2,
  'bulk send appends domain events for both invoices'
);

SELECT is(
  (SELECT COUNT(*)::integer
     FROM public.v_billing_invoice_directory
    WHERE invoice_id IN (
      current_setting('test.billing_bulk_invoice_1')::uuid,
      current_setting('test.billing_bulk_invoice_2')::uuid
    )
      AND payment_status = 'issued'
      AND sent_at IS NOT NULL),
  2,
  'billing invoice directory readback shows both selected invoices issued'
);

SELECT is(
  jsonb_array_length(current_setting('test.billing_bulk_result')::jsonb->'results'),
  2,
  'bulk send returns one result per selected invoice'
);

SELECT * FROM finish();
ROLLBACK;
