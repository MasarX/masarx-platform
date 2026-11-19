SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d9b0';
  v_client UUID := '00000000-0000-0000-0000-00000000d9b1';
  v_invoice UUID := '00000000-0000-0000-0000-00000000d9b2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000d9b3';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Line Guard Org', 'console-billing-line-guard-org')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Line Guard Client', 'console-billing-line-guard-client')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_admin,
    v_org,
    'console-billing-line-guard-ops@example.com',
    'Console Billing Line Guard Ops',
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
    'INV-PGTAP-LINE-GUARD-1',
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

  DELETE FROM public.billing_invoice_lines WHERE invoice_id = v_invoice;
  INSERT INTO public.billing_invoice_lines (
    invoice_id, organization_id, line_type, description, quantity, unit_price, amount, currency
  )
  VALUES (
    v_invoice, v_org, 'shipment_charge', 'Line-backed total guard fixture', 1, 115, 115, 'sar'
  );

  PERFORM set_config('test.billing_line_guard_invoice_id', v_invoice::text, true);
  PERFORM set_config('test.billing_line_guard_ops', v_ops_admin::text, true);
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_line_guard_ops'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  format(
    $$ SELECT public.update_billing_invoice_v1(jsonb_build_object('billing_invoice_id', %L, 'total', 230)) $$,
    current_setting('test.billing_line_guard_invoice_id')
  ),
  '22023',
  NULL,
  'line-backed draft invoice rejects mismatched header total'
);

SELECT lives_ok(
  format(
    $$ SELECT public.update_billing_invoice_v1(jsonb_build_object('billing_invoice_id', %L, 'total', 115, 'due_at', '2026-07-20T00:00:00Z')) $$,
    current_setting('test.billing_line_guard_invoice_id')
  ),
  'line-backed draft invoice accepts matching line total'
);

RESET ROLE;

SELECT is(
  (SELECT total FROM public.billing_invoices WHERE id = current_setting('test.billing_line_guard_invoice_id')::uuid),
  115::numeric,
  'line-backed invoice total remains aligned to the line amount'
);

SELECT * FROM finish();
ROLLBACK;
