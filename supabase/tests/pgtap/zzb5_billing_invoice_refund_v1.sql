-- pgTAP: public.billing_invoice_refund_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

-- Fixtures: an issued, fully-paid invoice ready for refund.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b560';
  v_client1 UUID := '00000000-0000-0000-0000-00000000b561';
  v_invoice1 UUID := '00000000-0000-0000-0000-00000000b562';
  v_invoice2 UUID := '00000000-0000-0000-0000-00000000b565';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b563';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b564';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Refund Org', 'b5-refund-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client1, v_org1, 'B5 Refund Client', 'b5-refund-client-' || left(v_client1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-refund-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Refund Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-refund-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Refund Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency, invoice_number,
    subtotal, tax_total, total, amount_paid, amount_due,
    issued_at, paid_at, created_by_user_id, version
  )
  VALUES (
    v_invoice1, v_org1, v_client1, 'paid', 'sar', 'INV-B5-REF-001',
    100, 15, 115, 115, 0,
    now() - interval '1 day', now() - interval '1 hour', v_ops_admin, 2
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency, invoice_number,
    subtotal, tax_total, total, amount_paid, amount_due,
    issued_at, created_by_user_id, version
  )
  VALUES (
    v_invoice2, v_org1, v_client1, 'issued', 'sar', 'INV-B5-REF-002',
    100, 15, 115, 40, 75,
    now() - interval '2 days', v_ops_admin, 2
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'issued',
      amount_paid = 40,
      amount_due = 75,
      version = 2,
      updated_at = now();

  PERFORM set_config('test.b5r_org1', v_org1::text, true);
  PERFORM set_config('test.b5r_invoice1', v_invoice1::text, true);
  PERFORM set_config('test.b5r_invoice2', v_invoice2::text, true);
  PERFORM set_config('test.b5r_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5r_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Denied: ops_admin cannot refund without an operator reason
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5r_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.billing_invoice_refund_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.b5r_invoice1'),
       'refund_amount', 5
     )) $$,
  '23502',
  'billing_invoice_refund_v1 requires refund_reason',
  'ops_admin cannot billing_invoice_refund_v1 without refund_reason'
);
RESET ROLE;

-- 2) Allowed: ops_admin can refund a paid billing invoice
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5r_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.billing_invoice_refund_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.b5r_invoice1'),
      'refund_amount', 50,
      'refund_reason', 'pgtap-partial-refund'
    ))->>'ok')::bool
  ),
  'ops_admin can billing_invoice_refund_v1 (partial refund)'
);
RESET ROLE;

-- 3) Allowed: ops_admin can refund a partially paid issued billing invoice
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5r_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT (public.billing_invoice_refund_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.b5r_invoice2'),
      'refund_amount', 15,
      'refund_reason', 'pgtap-issued-partial-refund'
    ))->>'status')
  ),
  'issued',
  'ops_admin can billing_invoice_refund_v1 for partially paid issued invoice'
);
RESET ROLE;

-- 4) Denied: non-admin user lacks invoices.refund
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5r_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.billing_invoice_refund_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.b5r_invoice1'),
       'refund_amount', 10
     )) $$,
  '42501',
  NULL,
  'non-admin user denied billing_invoice_refund_v1 (invoices.refund missing)'
);
RESET ROLE;

-- 5) Ladder: capability resolves through global access_control_policy
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'invoices.refund'
  ),
  'invoices.refund capability resolves at global ladder scope'
);

-- 6) RLS isolation: billing_invoices service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.billing_invoices', 'update'),
  'authenticated has no direct UPDATE on billing_invoices (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
