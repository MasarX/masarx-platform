-- pgTAP: public.bulk_toggle_feature_flags_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000bd01';
  v_ops UUID := '00000000-0000-0000-0000-00000000bd11';
  v_sender UUID := '00000000-0000-0000-0000-00000000bd12';
  v_flag1 UUID := gen_random_uuid();
  v_flag2 UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Bulk Org', 'b1-bulk-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-bulk-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Bulk Ops', 'ops_admin', 'platform', NULL),
    (v_sender, v_org, 'b1-bulk-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Bulk Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES
    (v_flag1, 'b1.bulk.flag1.' || left(v_flag1::text, 8), 'tenant', v_org, FALSE, 0),
    (v_flag2, 'b1.bulk.flag2.' || left(v_flag2::text, 8), 'tenant', v_org, FALSE, 0)
  ON CONFLICT (name) DO NOTHING;

  PERFORM set_config('test.b1_bulk_ops', v_ops::text, true);
  PERFORM set_config('test.b1_bulk_sender', v_sender::text, true);
  PERFORM set_config('test.b1_bulk_flag1', v_flag1::text, true);
  PERFORM set_config('test.b1_bulk_flag2', v_flag2::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: bulk enable both
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_bulk_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.bulk_toggle_feature_flags_v1(jsonb_build_object(
    'enabled', true,
    'flags', jsonb_build_array(
      jsonb_build_object('feature_flag_id', current_setting('test.b1_bulk_flag1')),
      jsonb_build_object('feature_flag_id', current_setting('test.b1_bulk_flag2'))
    )
  ))->>'success_count')::int = 2),
  'ops_admin can bulk_toggle_feature_flags_v1 (2 flags succeed)'
);
RESET ROLE;

-- 2) Denied: sender_user cannot bulk-toggle
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_bulk_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bulk_toggle_feature_flags_v1(jsonb_build_object(
       'enabled', true,
       'flags', jsonb_build_array(
         jsonb_build_object('feature_flag_id', current_setting('test.b1_bulk_flag1'))
       )
     )) $$,
  '42501',
  NULL,
  'non-ops user denied bulk_toggle_feature_flags_v1'
);
RESET ROLE;

-- 3) Partial-success: invalid flag id returns per-flag error in results array
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_bulk_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.bulk_toggle_feature_flags_v1(jsonb_build_object(
    'enabled', true,
    'flags', jsonb_build_array(
      jsonb_build_object('feature_flag_id', current_setting('test.b1_bulk_flag1')),
      jsonb_build_object('feature_flag_id', '00000000-0000-0000-0000-0000deadbeef')
    )
  ))->>'error_count')::int >= 1),
  'bulk_toggle_feature_flags_v1 records per-flag errors in results (partial success)'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.feature_flags', 'update'),
  'authenticated has no direct UPDATE on feature_flags'
);

SELECT * FROM finish();
ROLLBACK;
