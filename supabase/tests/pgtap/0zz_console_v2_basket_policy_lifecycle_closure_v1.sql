-- pgTAP: Console V2 Basket policy lifecycle closure.
-- Proves the domain workbench is navigable, raw basket table pages are not,
-- and basket profile edits use a browser-safe canonical RPC.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(28);

SELECT has_function('public', 'basket_update_v1', ARRAY['jsonb'], 'public.basket_update_v1 exists');
SELECT has_function('api', 'basket_update_v1', ARRAY['jsonb'], 'api.basket_update_v1 exists');

SELECT ok(
  has_function_privilege('authenticated', 'public.basket_update_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute public.basket_update_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.basket_update_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.basket_update_v1'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.basket_update_v1(jsonb)')) LIKE '%public.basket_update_v1%',
  'api.basket_update_v1 delegates to public.basket_update_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_navigation'
      AND COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/operate/baskets'
          AND item.value->>'label' = 'Basket policy'
          AND item.value->>'resource' = 'baskets'
          AND item.value->>'capability' = 'baskets.read'
      )
  ),
  'all Console ui_navigation rows expose the Basket policy domain workbench'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
    WHERE s.category = 'ui_navigation'
      AND (
        COALESCE(item.value->>'resource', '') IN ('basket_items', 'basket_transitions')
        OR COALESCE(item.value->>'route', item.value->>'href', '') IN (
          '/console/resources/baskets',
          '/console/resources/basket_items',
          '/console/resources/basket_transitions'
        )
      )
  ),
  'Console ui_navigation does not expose raw basket table pages'
);

SELECT ok(to_regprocedure('api.basket_item_add_v1(jsonb)') IS NULL, 'no direct api.basket_item_add_v1 shortcut exists');

SELECT ok(
  NOT has_table_privilege('authenticated', 'api.basket_items', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'api.basket_items', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'api.basket_items', 'DELETE'),
  'authenticated cannot directly insert, update, or delete api.basket_items'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'basket_policy_service_match_field'
       AND owner_role = 'operations'
       AND is_mutable
  ),
  'basket policy service match selector is lookup-driven'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_policy_service_match_field'
       AND lv.value = 'service_level_or_type'
       AND lv.label = 'Service level, then type'
       AND lv.status = 'active'
  ),
  'basket policy service match options include service_level_or_type'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'basket_policy_route_key_path'
       AND owner_role = 'operations'
       AND is_mutable
  ),
  'basket policy route selector is lookup-driven'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_policy_route_key_path'
       AND lv.value = 'routing.route_key'
       AND lv.label = 'Shipment route key'
       AND lv.status = 'active'
  ),
  'basket policy route selector options include routing.route_key'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_type'
       AND lv.value = 'zone_based'
       AND lv.status = 'active'
  ),
  'basket policy editor reuses basket_type lookup rows for basket type'
);

SELECT is(
  (SELECT request_capability FROM public.settings_category_registry WHERE category = 'basket_policy'),
  'baskets.write',
  'basket_policy settings requests are gated by baskets.write'
);

SELECT is(
  (SELECT allowed_scopes FROM public.settings_category_registry WHERE category = 'basket_policy'),
  '["global", "tenant", "client", "sender"]'::jsonb,
  'basket_policy settings requests are scoped to global, tenant, client, and sender'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry scr
      JOIN public.schema_registry sr
        ON sr.category = scr.category
       AND sr.is_active
     WHERE scr.category = 'basket_policy'
       AND scr.requires_schema
       AND scr.request_capability = 'baskets.write'
  ),
  'basket_policy request capability remains tied to an active schema'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'cd585754-521d-487d-9343-414f25100201'::uuid,
  'Console V2 Basket Policy Org',
  'console-v2-basket-policy-cd585754'
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
  '3a4cb777-d34a-4447-90f3-909fce4a9201'::uuid,
  'cd585754-521d-487d-9343-414f25100201'::uuid,
  'console-v2-basket-policy@example.test',
  'Console V2 Basket Policy Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
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
VALUES
  (
    '7ff3ce83-295f-4e89-9d5c-b83ba3df0201'::uuid,
    'cd585754-521d-487d-9343-414f25100201'::uuid,
    'console-v2-basket-only@example.test',
    'Console V2 Basket Only',
    'account_manager',
    'tenant',
    NULL,
    'active'
  ),
  (
    '51a46dbb-651b-4477-a38a-4b31595b0201'::uuid,
    'cd585754-521d-487d-9343-414f25100201'::uuid,
    'console-v2-settings-only@example.test',
    'Console V2 Settings Only',
    'account_manager',
    'tenant',
    NULL,
    'active'
  )
ON CONFLICT (id) DO NOTHING;

SELECT *
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'tenant',
    'cd585754-521d-487d-9343-414f25100201'::uuid,
    jsonb_build_object(
      'roles',
      jsonb_build_array(
        jsonb_build_object(
          'key', 'super_admin',
          'capability_keys', jsonb_build_array('*')
        ),
        jsonb_build_object(
          'key', 'basket_policy_editor',
          'capability_keys', jsonb_build_array('baskets.write')
        ),
        jsonb_build_object(
          'key', 'settings_policy_editor',
          'capability_keys', jsonb_build_array('settings.write')
        )
      )
      ,
      'assignments',
      jsonb_build_object(
        'user_id',
        jsonb_build_object(
          '7ff3ce83-295f-4e89-9d5c-b83ba3df0201', jsonb_build_array('basket_policy_editor'),
          '51a46dbb-651b-4477-a38a-4b31595b0201', jsonb_build_array('settings_policy_editor')
        )
      )
    ),
    1,
    'pgTAP Console V2 basket policy permission proof'
  );

DELETE FROM public.settings_cache
 WHERE cache_key LIKE 'access_control_policy:%';

DO $$
DECLARE
  v_request_version UUID;
  v_request_event UUID;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '7ff3ce83-295f-4e89-9d5c-b83ba3df0201', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    public.user_has_capability_v1(
      'baskets.write',
      'tenant',
      'cd585754-521d-487d-9343-414f25100201'::uuid
    ),
    'basket policy editor has baskets.write without broad settings.write'
  );

  SELECT settings_version_id, domain_event_id
    INTO v_request_version, v_request_event
    FROM api.request_settings_change_v1(
      p_category := 'basket_policy',
      p_scope_type := 'tenant',
      p_scope_id := 'cd585754-521d-487d-9343-414f25100201'::uuid,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', true,
        'basket_type', 'zone_based',
        'open_states', jsonb_build_array('forming', 'ready'),
        'create_if_missing', true,
        'require_zone', false,
        'capacity_count', 75
      ),
      p_change_reason := 'pgTAP Console V2 basket policy baskets.write request',
      p_effective_from := now()
    );

  EXECUTE 'RESET ROLE';

  PERFORM ok(
    v_request_version IS NOT NULL AND v_request_event IS NOT NULL,
    'baskets.write operator can request basket_policy through api.request_settings_change_v1'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.settings_versions sv
       WHERE sv.id = v_request_version
         AND sv.category = 'basket_policy'
         AND sv.scope_type = 'tenant'
         AND sv.scope_id = 'cd585754-521d-487d-9343-414f25100201'::uuid
         AND sv.approved_at IS NULL
         AND sv.requested_by = '7ff3ce83-295f-4e89-9d5c-b83ba3df0201'::uuid
         AND sv.value->>'basket_type' = 'zone_based'
    ),
    'basket_policy request persists pending tenant settings_versions row from basket operator'
  );

  PERFORM set_config('request.jwt.claim.sub', '51a46dbb-651b-4477-a38a-4b31595b0201', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    NOT public.user_has_capability_v1(
      'baskets.write',
      'tenant',
      'cd585754-521d-487d-9343-414f25100201'::uuid
    ),
    'settings-only operator does not satisfy basket policy request capability'
  );

  PERFORM throws_ok(
    $sql$
      SELECT api.request_settings_change_v1(
        p_category := 'basket_policy',
        p_scope_type := 'tenant',
        p_scope_id := 'cd585754-521d-487d-9343-414f25100201'::uuid,
        p_value := jsonb_build_object('version', 1, 'enabled', false),
        p_change_reason := 'pgTAP denied settings-only basket policy request',
        p_effective_from := now()
      )
    $sql$,
    '42501',
    NULL,
    'settings.write alone cannot request basket_policy'
  );

  EXECUTE 'RESET ROLE';
END $$;

INSERT INTO public.zones (id, organization_id, name, slug, is_active)
VALUES (
  '21e7130e-7b39-41ff-afdd-f7d62b090201'::uuid,
  'cd585754-521d-487d-9343-414f25100201'::uuid,
  'Basket Closure Zone',
  'basket-closure-zone',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.baskets (
  id,
  organization_id,
  zone_id,
  basket_type,
  state,
  current_count,
  capacity_count
)
VALUES (
  '44b85404-7b7f-4943-b0cb-f4b6a1c80201'::uuid,
  'cd585754-521d-487d-9343-414f25100201'::uuid,
  '21e7130e-7b39-41ff-afdd-f7d62b090201'::uuid,
  'zone_based',
  'forming',
  2,
  10
)
ON CONFLICT (id) DO UPDATE
SET current_count = EXCLUDED.current_count,
    capacity_count = EXCLUDED.capacity_count,
    state = EXCLUDED.state;

SELECT set_config('request.jwt.claim.sub', '3a4cb777-d34a-4447-90f3-909fce4a9201', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '3a4cb777-d34a-4447-90f3-909fce4a9201',
    'role', 'authenticated',
    'email', 'console-v2-basket-policy@example.test'
  )::text,
  true
);

SET LOCAL ROLE authenticated;

SELECT ok(
  (api.basket_update_v1(
    jsonb_build_object(
      'basket_id', '44b85404-7b7f-4943-b0cb-f4b6a1c80201',
      'patch', jsonb_build_object('capacity_count', 25, 'expires_in_minutes', 45)
    )
  )->>'ok')::boolean,
  'api.basket_update_v1 updates basket profile fields'
);

RESET ROLE;

SELECT is(
  (
    SELECT capacity_count::text
    FROM public.baskets
    WHERE id = '44b85404-7b7f-4943-b0cb-f4b6a1c80201'::uuid
  ),
  '25',
  'basket_update_v1 persists capacity changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE organization_id = 'cd585754-521d-487d-9343-414f25100201'::uuid
       AND event_type = 'basket.updated'
       AND resource_type = 'basket'
       AND resource_id = '44b85404-7b7f-4943-b0cb-f4b6a1c80201'::uuid
       AND payload->'changed' ? 'capacity_count'
  ),
  'basket_update_v1 emits basket.updated domain event evidence'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE organization_id = 'cd585754-521d-487d-9343-414f25100201'::uuid
       AND decision_category = 'baskets.update'
       AND resource_type = 'basket'
       AND resource_id = '44b85404-7b7f-4943-b0cb-f4b6a1c80201'::uuid
       AND decision_point = 'basket_update_v1'
       AND decision_outcome = 'updated'
       AND performed_by_system = 'basket_update_v1'
       AND decision_inputs->'changed' ? 'capacity_count'
  ),
  'basket_update_v1 writes decision_log evidence'
);

SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT api.basket_update_v1('{"basket_id":"44b85404-7b7f-4943-b0cb-f4b6a1c80201","patch":{"basket_items":[]}}'::jsonb)$$,
  '22023',
  'basket_update_v1 unsupported patch keys: basket_items',
  'basket_update_v1 rejects unsupported basket item patch keys'
);

SELECT throws_ok(
  $$SELECT api.basket_update_v1('{"basket_id":"44b85404-7b7f-4943-b0cb-f4b6a1c80201","patch":{"state":"ready"}}'::jsonb)$$,
  '22023',
  'basket_update_v1 profile edits cannot patch identity, count, version, or state; use ui_update_basket_state_v1 for state',
  'basket_update_v1 rejects direct state mutation'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
