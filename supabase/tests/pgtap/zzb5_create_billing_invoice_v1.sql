-- pgTAP: public.create_billing_invoice_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- Fixtures: two orgs to test cross-tenant isolation
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b510';
  v_org2 UUID := '00000000-0000-0000-0000-00000000b520';
  v_client1 UUID := '00000000-0000-0000-0000-00000000b511';
  v_client2 UUID := '00000000-0000-0000-0000-00000000b521';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b513';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b514';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Billing Org A', 'b5-billing-org-a-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org2, 'B5 Billing Org B', 'b5-billing-org-b-' || left(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client1, v_org1, 'B5 Client A', 'b5-client-a-' || left(v_client1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client2, v_org2, 'B5 Client B', 'b5-client-b-' || left(v_client2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-billing-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-billing-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Sender User', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b5_org1', v_org1::text, true);
  PERFORM set_config('test.b5_client1', v_client1::text, true);
  PERFORM set_config('test.b5_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5_sender_user', v_sender_user::text, true);
  PERFORM set_config('test.b5_create_key', 'b5-pgtap-create-' || encode(gen_random_bytes(4), 'hex'), true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can create billing invoice
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.create_billing_invoice_v1(jsonb_build_object(
      'client_id', current_setting('test.b5_client1'),
      'currency', 'sar',
      'subtotal', 100,
      'tax_total', 15,
      'idempotency_key', current_setting('test.b5_create_key')
    ))->>'ok')::bool
  ),
  'ops_admin can create_billing_invoice_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT currency
      FROM public.billing_invoices
     WHERE idempotency_key = current_setting('test.b5_create_key')
     LIMIT 1
  ),
  'SAR',
  'create_billing_invoice_v1 stores currency as uppercase ISO 4217'
);

-- 2) Denied: non-admin user lacks billing.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_billing_invoice_v1(jsonb_build_object(
       'client_id', current_setting('test.b5_client1'),
       'currency', 'sar',
       'subtotal', 50
     )) $$,
  '42501',
  NULL,
  'non-admin user denied create_billing_invoice_v1 (billing.write missing)'
);
RESET ROLE;

-- 3) Ladder: capability resolves through global access_control_policy (ops_admin gets it)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'billing.write'
  ),
  'billing.write capability resolves at global ladder scope'
);

-- 4) RLS isolation: billing_invoices service-only writes (no anon/authenticated direct INSERT)
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.billing_invoices', 'insert'),
  'authenticated has no direct INSERT on billing_invoices (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
