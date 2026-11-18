-- pgTAP: public.billing_invoice_send_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- Fixtures
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b550';
  v_client1 UUID := '00000000-0000-0000-0000-00000000b551';
  v_invoice1 UUID := '00000000-0000-0000-0000-00000000b552';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b553';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b554';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Send Org', 'b5-send-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client1, v_org1, 'B5 Send Client', 'b5-send-client-' || left(v_client1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-send-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Send Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-send-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Send Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    created_by_user_id, version
  )
  VALUES (
    v_invoice1, v_org1, v_client1, 'draft', 'sar',
    100, 15, 115, 0, 115,
    v_ops_admin, 1
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b5s_org1', v_org1::text, true);
  PERFORM set_config('test.b5s_invoice1', v_invoice1::text, true);
  PERFORM set_config('test.b5s_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5s_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can send (issue) draft billing invoice
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5s_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.billing_invoice_send_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.b5s_invoice1'),
      'invoice_number', 'INV-B5-' || encode(gen_random_bytes(3), 'hex')
    ))->>'ok')::bool
  ),
  'ops_admin can billing_invoice_send_v1 (draft -> issued)'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks invoices.send
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5s_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.billing_invoice_send_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.b5s_invoice1'),
       'invoice_number', 'INV-DENIED'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied billing_invoice_send_v1 (invoices.send missing)'
);
RESET ROLE;

-- 3) Ladder: capability resolves through global access_control_policy
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'invoices.send'
  ),
  'invoices.send capability resolves at global ladder scope'
);

-- 4) RLS isolation: billing_invoices service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.billing_invoices', 'update'),
  'authenticated has no direct UPDATE on billing_invoices (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
