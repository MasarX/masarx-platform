-- pgTAP: Console V2 branch lifecycle views require related resources in
-- scoped ui_read_registry rows, not raw table-page fallbacks.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('branches'),
      ('branch_summary'),
      ('branch_zones'),
      ('branch_memberships'),
      ('branch_capacity_heatmap'),
      ('branch_coverage_windows'),
      ('zones'),
      ('route_runs'),
      ('vehicle_directory')
    ) AS required(resource_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = required.resource_key
    )
  ),
  'global ui_read_registry exposes every resource needed by the branch lifecycle screen'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(
          (
            SELECT sg.cached_value
            FROM public.settings sg
            WHERE sg.category = 'ui_read_registry'
              AND sg.scope_type = 'global'
              AND sg.scope_id IS NULL
            LIMIT 1
          )->'resources',
          '[]'::jsonb
        )) gr(value)
        WHERE gr.value->>'key' IN (
          'branches',
          'branch_summary',
          'branch_zones',
          'branch_memberships',
          'branch_capacity_heatmap',
          'branch_coverage_windows',
          'zones',
          'route_runs',
          'vehicle_directory'
        )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) sr(value)
            WHERE sr.value->>'key' = gr.value->>'key'
          )
      )
  ),
  'scoped ui_read_registry rows include all related branch lifecycle resources'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
    WHERE r.value->>'key' = 'vehicle_directory'
      AND r.value->>'relation' = 'public.v_vehicle_directory'
      AND r.value->>'capability_read' = 'fleet.read'
  ),
  'branch vehicle tab uses the canonical vehicle directory projection'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
    WHERE r.value->>'key' = 'branch_zones'
      AND r.value ? 'scope_columns'
  ),
  'branch_zones relies on RLS-backed branch joins and does not declare a nonexistent organization_id scope column'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'cd585754-521d-487d-9343-414f25100101'::uuid,
  'Console V2 Branch Registry Org',
  'console-v2-branch-registry-cd585754'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '3a4cb777-d34a-4447-90f3-909fce4a9b11'::uuid,
  'cd585754-521d-487d-9343-414f25100101'::uuid,
  'console-v2-branch-registry@example.test',
  'Console V2 Branch Registry Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', '3a4cb777-d34a-4447-90f3-909fce4a9b11', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '3a4cb777-d34a-4447-90f3-909fce4a9b11',
    'role', 'authenticated',
    'email', 'console-v2-branch-registry@example.test'
  )::text,
  true
);

SET LOCAL ROLE authenticated;

DO $probe$
DECLARE
  v_result JSONB;
BEGIN
  FOREACH v_result IN ARRAY ARRAY[
    api.ui_list_resource_v1('branches', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('branch_summary', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('branch_zones', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('branch_memberships', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('branch_capacity_heatmap', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('branch_coverage_windows', '{}'::jsonb, 5, 0, NULL::jsonb),
    api.ui_list_resource_v1('vehicle_directory', '{"current_branch_id":"00000000-0000-0000-0000-000000000001"}'::jsonb, 5, 0, NULL::jsonb)
  ] LOOP
    IF v_result->>'resource' IS NULL THEN
      RAISE EXCEPTION 'branch lifecycle resource read returned malformed payload';
    END IF;
  END LOOP;
END;
$probe$;

RESET ROLE;

SELECT pass('Console V2 branch lifecycle resource reads accept branch-related resources');

SELECT * FROM finish();

ROLLBACK;
