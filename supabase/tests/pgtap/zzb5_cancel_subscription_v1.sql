-- pgTAP: public.cancel_subscription_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- Fixtures: an active subscription tied to a tenant client.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000b5d0';
  v_client1 UUID := '00000000-0000-0000-0000-00000000b5d1';
  v_subscription1 UUID := '00000000-0000-0000-0000-00000000b5d2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000b5d3';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b5d4';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'B5 Cancel Sub Org', 'b5-csub-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client1, v_org1, 'B5 Cancel Sub Client', 'b5-csub-client-' || left(v_client1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'b5-csub-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'B5 Cancel Sub Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'b5-csub-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'B5 Cancel Sub Sender', 'account_manager', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (
    id, organization_id, client_id, plan_key, status,
    starts_at, currency, price_amount, version
  )
  VALUES (
    v_subscription1, v_org1, v_client1, 'pro_monthly', 'active',
    now() - interval '1 month', 'sar', 199, 1
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b5sub_org1', v_org1::text, true);
  PERFORM set_config('test.b5sub_subscription1', v_subscription1::text, true);
  PERFORM set_config('test.b5sub_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.b5sub_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can cancel an active subscription
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5sub_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.cancel_subscription_v1(jsonb_build_object(
      'subscription_id', current_setting('test.b5sub_subscription1'),
      'cancellation_reason', 'pgtap-cancel'
    ))->>'ok')::bool
  ),
  'ops_admin can cancel_subscription_v1 (active -> canceled)'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks billing.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b5sub_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.cancel_subscription_v1(jsonb_build_object(
       'subscription_id', current_setting('test.b5sub_subscription1'),
       'cancellation_reason', 'denied-attempt'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied cancel_subscription_v1 (billing.write missing)'
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
       AND cap->>'key' = 'billing.write'
  ),
  'billing.write capability resolves at global ladder scope'
);

-- 4) RLS isolation: subscriptions service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.subscriptions', 'update'),
  'authenticated has no direct UPDATE on subscriptions (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
