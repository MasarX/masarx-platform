-- pgTAP: public.lookup_value_promote_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b60b';
  v_ops UUID := '00000000-0000-0000-0000-00000000b6b1';
  v_sender UUID := '00000000-0000-0000-0000-00000000b6b2';
  v_def UUID := gen_random_uuid();
  v_val UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 LV Promote Org', 'b6-lv-pro-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-lv-pro-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 LV Pro Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-lv-pro-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 LV Pro Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_definitions (id, category, organization_id, scope_type, is_mutable)
  VALUES (v_def, 'b6_lv_pro_cat_' || left(v_def::text, 6), v_org, 'tenant', TRUE)
  ON CONFLICT (category) DO NOTHING;

  INSERT INTO public.lookup_values (id, lookup_definition_id, organization_id, value, label, status)
  VALUES (v_val, v_def, v_org, 'b6_lv_pro_v_' || left(v_val::text, 6), 'B6 LV Pro', 'draft')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_lv_pro_org', v_org::text, true);
  PERFORM set_config('test.b6_lv_pro_ops', v_ops::text, true);
  PERFORM set_config('test.b6_lv_pro_sender', v_sender::text, true);
  PERFORM set_config('test.b6_lv_pro_val', v_val::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (draft -> active)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_lv_pro_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.lookup_value_promote_v1(jsonb_build_object(
      'lookup_value_id', current_setting('test.b6_lv_pro_val')
    ))->>'ok')::bool
  ),
  'ops_admin can lookup_value_promote_v1 (draft -> active)'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_lv_pro_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.lookup_value_promote_v1(jsonb_build_object(
       'lookup_value_id', current_setting('test.b6_lv_pro_val')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied lookup_value_promote_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'lookup_values.promote'
       AND resource_id = current_setting('test.b6_lv_pro_val')::uuid
  ),
  'lookup_value_promote_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.lookup_value_revisions', 'select'),
  'authenticated has no SELECT on lookup_value_revisions (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
