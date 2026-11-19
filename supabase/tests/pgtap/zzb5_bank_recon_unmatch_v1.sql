-- pgTAP: public.bank_recon_unmatch_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- Fixtures: an existing matched bank_recon_matches row.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b5a0';
  v_client1 UUID := '00000000-0000-0000-0000-00000000b5a1';
  v_invoice1 UUID := '00000000-0000-0000-0000-00000000b5a2';
  v_match1 UUID := '00000000-0000-0000-0000-00000000b5a3';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b5a4';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b5a5';
  v_event_id UUID := '00000000-0000-0000-0000-00000000b5a6';
  v_event_at TIMESTAMPTZ := now() - interval '2 hours';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Unmatch Org', 'b5-unmatch-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client1, v_org1, 'B5 Unmatch Client', 'b5-unmatch-client-' || left(v_client1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-unmatch-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Unmatch Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-unmatch-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Unmatch Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    created_by_user_id, version
  )
  VALUES (
    v_invoice1, v_org1, v_client1, 'issued', 'sar',
    100, 15, 115, 0, 115,
    v_ops_admin, 1
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.bank_recon_matches (
    id, organization_id,
    bank_statement_event_id, bank_statement_occurred_at,
    resource_type, resource_id,
    matched_amount, currency,
    status, matched_by, matched_at
  )
  VALUES (
    v_match1, v_org1,
    v_event_id, v_event_at,
    'billing_invoice', v_invoice1,
    115, 'sar',
    'matched', v_ops_admin, now() - interval '1 hour'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b5n_org1', v_org1::text, true);
  PERFORM set_config('test.b5n_match1', v_match1::text, true);
  PERFORM set_config('test.b5n_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5n_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can unmatch a matched pair
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5n_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.bank_recon_unmatch_v1(jsonb_build_object(
      'bank_recon_match_id', current_setting('test.b5n_match1'),
      'unmatch_reason', 'pgtap-undo-match'
    ))->>'ok')::bool
  ),
  'ops_admin can bank_recon_unmatch_v1 (matched -> unmatched)'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks finance.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5n_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bank_recon_unmatch_v1(jsonb_build_object(
       'bank_recon_match_id', current_setting('test.b5n_match1'),
       'unmatch_reason', 'denied-test'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied bank_recon_unmatch_v1 (finance.write missing)'
);
RESET ROLE;

-- 3) Ladder: capability is a baseline rbac_permission lookup value
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'finance.write'
  ),
  'finance.write is registered as a baseline rbac_permission lookup value'
);

-- 4) RLS isolation: bank_recon_matches service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.bank_recon_matches', 'update'),
  'authenticated has no direct UPDATE on bank_recon_matches (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
