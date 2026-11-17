-- Migration: Access control policy expansion for UI resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071220_access_control_policy_ui_resources'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object('key','zones.read','label','Zones read','category','operations'),
    jsonb_build_object('key','zones.write','label','Zones write','category','operations'),
    jsonb_build_object('key','baskets.read','label','Baskets read','category','operations'),
    jsonb_build_object('key','baskets.write','label','Baskets write','category','operations'),
    jsonb_build_object('key','lookups.read','label','Lookups read','category','reference'),
    jsonb_build_object('key','lookups.write','label','Lookups write','category','reference'),
    jsonb_build_object('key','mappings.read','label','Mappings read','category','integrations'),
    jsonb_build_object('key','mappings.write','label','Mappings write','category','integrations'),
    jsonb_build_object('key','webhooks.read','label','Webhooks read','category','integrations'),
    jsonb_build_object('key','webhooks.write','label','Webhooks write','category','integrations'),
    jsonb_build_object('key','label_design.read','label','Label design read','category','labels'),
    jsonb_build_object('key','label_design.write','label','Label design write','category','labels')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_cap IN SELECT * FROM jsonb_array_elements(v_new_caps) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_caps) AS item
      WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
    END IF;
  END LOOP;

  v_roles := '[]'::jsonb;
  FOR v_role IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' = 'ops_admin' THEN
      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
            UNION ALL SELECT unnest(ARRAY[
              'zones.read','zones.write',
              'baskets.read','baskets.write',
              'lookups.read','lookups.write',
              'mappings.read','mappings.write',
              'webhooks.read','webhooks.write',
              'label_design.read','label_design.write'
            ]) AS cap
          ) AS caps
          ORDER BY cap
        )),
        false
      );
    END IF;
    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  IF NOT (v_resource_map ? 'zones') THEN
    v_resource_map := jsonb_set(v_resource_map, '{zones}', jsonb_build_object('read','zones.read','write','zones.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'zone_districts') THEN
    v_resource_map := jsonb_set(v_resource_map, '{zone_districts}', jsonb_build_object('read','zones.read','write','zones.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'baskets') THEN
    v_resource_map := jsonb_set(v_resource_map, '{baskets}', jsonb_build_object('read','baskets.read','write','baskets.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'basket_items') THEN
    v_resource_map := jsonb_set(v_resource_map, '{basket_items}', jsonb_build_object('read','baskets.read','write','baskets.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'basket_transitions') THEN
    v_resource_map := jsonb_set(v_resource_map, '{basket_transitions}', jsonb_build_object('read','baskets.read'), true);
  END IF;
  IF NOT (v_resource_map ? 'lookup_definitions') THEN
    v_resource_map := jsonb_set(v_resource_map, '{lookup_definitions}', jsonb_build_object('read','lookups.read','write','lookups.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'lookup_values') THEN
    v_resource_map := jsonb_set(v_resource_map, '{lookup_values}', jsonb_build_object('read','lookups.read','write','lookups.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'mapping_configs') THEN
    v_resource_map := jsonb_set(v_resource_map, '{mapping_configs}', jsonb_build_object('read','mappings.read','write','mappings.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'field_mappings') THEN
    v_resource_map := jsonb_set(v_resource_map, '{field_mappings}', jsonb_build_object('read','mappings.read','write','mappings.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'webhook_sources') THEN
    v_resource_map := jsonb_set(v_resource_map, '{webhook_sources}', jsonb_build_object('read','webhooks.read','write','webhooks.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'webhook_rules') THEN
    v_resource_map := jsonb_set(v_resource_map, '{webhook_rules}', jsonb_build_object('read','webhooks.read','write','webhooks.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'webhook_inbox') THEN
    v_resource_map := jsonb_set(v_resource_map, '{webhook_inbox}', jsonb_build_object('read','webhooks.read'), true);
  END IF;
  IF NOT (v_resource_map ? 'webhook_response_history') THEN
    v_resource_map := jsonb_set(v_resource_map, '{webhook_response_history}', jsonb_build_object('read','webhooks.read'), true);
  END IF;
  IF NOT (v_resource_map ? 'webhook_log') THEN
    v_resource_map := jsonb_set(v_resource_map, '{webhook_log}', jsonb_build_object('read','audit_log.read'), true);
  END IF;
  IF NOT (v_resource_map ? 'api_call_log') THEN
    v_resource_map := jsonb_set(v_resource_map, '{api_call_log}', jsonb_build_object('read','audit_log.read'), true);
  END IF;
  IF NOT (v_resource_map ? 'api_route_packs') THEN
    v_resource_map := jsonb_set(v_resource_map, '{api_route_packs}', jsonb_build_object('read','api_routes.read','write','system.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'api_routes') THEN
    v_resource_map := jsonb_set(v_resource_map, '{api_routes}', jsonb_build_object('read','api_routes.read','write','system.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'providers') THEN
    v_resource_map := jsonb_set(v_resource_map, '{providers}', jsonb_build_object('read','integrations.read','write','system.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'operation_templates') THEN
    v_resource_map := jsonb_set(v_resource_map, '{operation_templates}', jsonb_build_object('read','integrations.read','write','system.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'label_sections') THEN
    v_resource_map := jsonb_set(v_resource_map, '{label_sections}', jsonb_build_object('read','label_design.read','write','label_design.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'label_design_tokens') THEN
    v_resource_map := jsonb_set(v_resource_map, '{label_design_tokens}', jsonb_build_object('read','label_design.read','write','label_design.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'label_template_validation') THEN
    v_resource_map := jsonb_set(v_resource_map, '{label_template_validation}', jsonb_build_object('read','label_design.read'), true);
  END IF;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, true);
  v_current := jsonb_set(v_current, '{roles}', v_roles, true);
  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Extend access_control_policy for UI resources',
        approved_at = now(),
        effective_from = now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = now()
  FROM applied
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601071220_access_control_policy_ui_resources'));
COMMIT;
