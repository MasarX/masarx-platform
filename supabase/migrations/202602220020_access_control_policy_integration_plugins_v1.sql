-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S02
-- Migration: Access control capabilities for integration plugin studio v1

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220020_access_control_policy_integration_plugins_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_entry JSONB;
  v_role_key TEXT;
  v_keys JSONB;
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

  v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'integration_plugins.read'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'integration_plugins.read',
        'label', 'Integration plugins read',
        'category', 'integrations',
        'description', 'Read integration plugins, versions, bindings, and activation state.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'integration_plugins.write'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'integration_plugins.write',
        'label', 'Integration plugins write',
        'category', 'integrations',
        'description', 'Create and edit integration plugins and draft versions.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'integration_plugins.test'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'integration_plugins.test',
        'label', 'Integration plugins test',
        'category', 'integrations',
        'description', 'Run parse/infer/preview/validate for plugin versions.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'integration_plugins.approve'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'integration_plugins.approve',
        'label', 'Integration plugins approve',
        'category', 'integrations',
        'description', 'Approve/reject submitted plugin versions.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'integration_plugins.activate'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'integration_plugins.activate',
        'label', 'Integration plugins activate',
        'category', 'integrations',
        'description', 'Activate approved plugin versions and rotate credentials.'
      )
    );
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_roles)
  LOOP
    v_role_key := NULLIF(v_entry->>'key', '');
    v_keys := COALESCE(v_entry->'capability_keys', '[]'::jsonb);

    IF jsonb_typeof(v_keys) <> 'array' THEN
      v_keys := '[]'::jsonb;
    END IF;

    IF v_role_key IN ('ops_admin', 'account_manager') THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('integration_plugins.read', '*')) THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.read');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('integration_plugins.write', '*')) THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.write');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('integration_plugins.test', '*')) THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.test');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('integration_plugins.approve', '*')) THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.approve');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('integration_plugins.activate', '*')) THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.activate');
      END IF;
      v_entry := jsonb_set(v_entry, '{capability_keys}', v_keys, true);
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_entry);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_updated_roles) item
     WHERE item->>'key' = 'tenant_integrations_approver'
  ) THEN
    v_updated_roles := v_updated_roles || jsonb_build_array(
      jsonb_build_object(
        'key', 'tenant_integrations_approver',
        'label', 'Tenant Integrations Approver',
        'capability_keys', jsonb_build_array(
          'integration_plugins.read',
          'integration_plugins.test',
          'integration_plugins.approve',
          'integration_plugins.activate'
        )
      )
    );
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_plugins}',
    jsonb_build_object(
      'read', 'integration_plugins.read',
      'write', 'integration_plugins.write',
      'test', 'integration_plugins.test',
      'approve', 'integration_plugins.approve',
      'activate', 'integration_plugins.activate'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_plugin_versions}',
    jsonb_build_object(
      'read', 'integration_plugins.read',
      'write', 'integration_plugins.write',
      'test', 'integration_plugins.test',
      'approve', 'integration_plugins.approve',
      'activate', 'integration_plugins.activate'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_plugin_bindings}',
    jsonb_build_object(
      'read', 'integration_plugins.read',
      'write', 'integration_plugins.activate'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_plugin_validation_runs}',
    jsonb_build_object(
      'read', 'integration_plugins.read',
      'write', 'integration_plugins.test'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_plugin_approval_events}',
    jsonb_build_object(
      'read', 'integration_plugins.read',
      'write', 'integration_plugins.approve'
    ),
    true
  );

  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);
  v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Add integration plugin capabilities, role, and resource map',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
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

SELECT pg_advisory_unlock(hashtext('202602220020_access_control_policy_integration_plugins_v1'));
COMMIT;
