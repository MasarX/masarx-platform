-- pgTAP: public.lookup_value_create_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b608';
  v_ops UUID := '00000000-0000-0000-0000-00000000b681';
  v_sender UUID := '00000000-0000-0000-0000-00000000b682';
  v_def UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 LV Create Org', 'b6-lv-cre-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-lv-cre-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 LV Cre Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-lv-cre-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 LV Cre Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_definitions (id, category, organization_id, scope_type, is_mutable)
  VALUES (v_def, 'b6_lv_cre_cat_' || left(v_def::text, 6), v_org, 'tenant', TRUE)
  ON CONFLICT (category) DO NOTHING;

  PERFORM set_config('test.b6_lv_cre_org', v_org::text, true);
  PERFORM set_config('test.b6_lv_cre_ops', v_ops::text, true);
  PERFORM set_config('test.b6_lv_cre_sender', v_sender::text, true);
  PERFORM set_config('test.b6_lv_cre_def', v_def::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_lv_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.lookup_value_create_v1(jsonb_build_object(
      'lookup_definition_id', current_setting('test.b6_lv_cre_def'),
      'value', 'b6_lv_cre_v_' || gen_random_uuid()::text,
      'label', 'B6 LV Cre New',
      'status', 'draft'
    ))->>'ok')::bool
  ),
  'ops_admin can lookup_value_create_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_lv_cre_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.lookup_value_create_v1(jsonb_build_object(
       'lookup_definition_id', current_setting('test.b6_lv_cre_def'),
       'value', 'b6_lv_cre_v_deny',
       'label', 'B6 LV Cre Deny'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied lookup_value_create_v1'
);
RESET ROLE;

-- 3) Ladder/audit: revision row appended
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'lookup_values.create'
       AND organization_id = current_setting('test.b6_lv_cre_org')::uuid
  ),
  'lookup_value_create_v1 wrote decision_log row'
);

-- 4) RLS isolation (revisions are service-only)
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.lookup_value_revisions', 'select'),
  'authenticated has no SELECT on lookup_value_revisions (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
