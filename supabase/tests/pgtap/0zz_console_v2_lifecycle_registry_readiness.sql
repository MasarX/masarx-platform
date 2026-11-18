-- pgTAP: Console V2 lifecycle resource registry keys resolve in live API mode.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '2bd7f8b0-6f16-48ab-b9b2-c439f58ed112'::uuid,
  'Console V2 Lifecycle Registry Org',
  'console-v2-lifecycle-registry-2bd7f8b0'
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
  'f4fb9e35-57ef-4415-9127-f96f5663ed7f'::uuid,
  '2bd7f8b0-6f16-48ab-b9b2-c439f58ed112'::uuid,
  'console-v2-lifecycle-registry@example.test',
  'Console V2 Lifecycle Registry Super Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT has_view(
  'public',
  'lookup_values_console_v1',
  'lookup_values_console_v1 exposes category-aware lookup values for live Console V2 hydration'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'lookup_values',
      'branch_summary',
      'branch_memberships',
      'branch_capacity_heatmap',
      'branch_coverage_windows',
      'route_runs',
      'zone_summary',
      'zone_override_requests',
      'service_levels',
      'service_offerings',
      'subscriptions',
      'shipment_directory',
      'tenant_signup_request_summary',
      'scope_type_registry'
    ]) AS required(key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS item(value)
      WHERE item.value->>'key' = required.key
    )
  ),
  'ui_read_registry contains the lifecycle resource keys used by Console V2 route scan'
);

SELECT set_config('request.jwt.claim.sub', 'f4fb9e35-57ef-4415-9127-f96f5663ed7f', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'f4fb9e35-57ef-4415-9127-f96f5663ed7f',
    'role', 'authenticated',
    'email', 'console-v2-lifecycle-registry@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

DO $probe$
DECLARE
  v_lookup JSONB;
  v_lookup_rows JSONB;
  v_resource TEXT;
  v_list JSONB;
BEGIN
  SELECT api.ui_list_resource_v1(
    'lookup_values',
    '{"category":"user_status","status":"active"}'::jsonb,
    10,
    0,
    '{"key":"sort_order","dir":"asc"}'::jsonb
  )
    INTO v_lookup;

  v_lookup_rows := COALESCE(v_lookup->'rows', v_lookup->'items', '[]'::jsonb);

  IF COALESCE(jsonb_array_length(v_lookup_rows), 0) = 0 THEN
    RAISE EXCEPTION 'lookup_values category/status filter returned no user_status rows';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_lookup_rows) AS row(value)
    WHERE row.value->>'category' = 'user_status'
      AND row.value->>'value' = 'active'
  ) THEN
    RAISE EXCEPTION 'lookup_values did not return user_status.active through category-aware projection';
  END IF;

  FOREACH v_resource IN ARRAY ARRAY[
    'branch_summary',
    'branch_memberships',
    'branch_capacity_heatmap',
    'branch_coverage_windows',
    'route_runs',
    'zone_summary',
    'zone_override_requests',
    'service_levels',
    'service_offerings',
    'subscriptions',
    'shipment_directory',
    'tenant_signup_request_summary',
    'scope_type_registry'
  ]
  LOOP
    SELECT api.ui_list_resource_v1(v_resource, '{}'::jsonb, 5, 0, NULL::jsonb)
      INTO v_list;
    IF v_list->>'resource' IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'api.ui_list_resource_v1 returned wrong resource for %', v_resource;
    END IF;
  END LOOP;
END;
$probe$;

RESET ROLE;

SELECT pass('authenticated Console V2 lifecycle registry reads complete without unknown-resource errors');

SELECT * FROM finish();

ROLLBACK;
