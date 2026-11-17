-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S07
-- Migration: UI read registry + navigation for integration plugin studio

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220060_ui_registry_navigation_integration_plugins_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) ui_read_registry resources
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;

  v_plugins JSONB := jsonb_build_object(
    'key', 'integration_plugins',
    'label', 'Integration plugins',
    'relation', 'public.integration_plugins',
    'id_column', 'id',
    'capability_read', 'integration_plugins.read',
    'capability_write', 'integration_plugins.write',
    'select', jsonb_build_array(
      'id','organization_id','plugin_key','name','description','plugin_kind','status','rollout_tier',
      'reusable_within_tenant','base_plugin_id','active_version_id','managed_by','metadata',
      'created_by','updated_by','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','plugin_kind','column','plugin_kind','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','name','column','name','op','ilike'),
      jsonb_build_object('key','plugin_key','column','plugin_key','op','ilike')
    ),
    'default_sort', jsonb_build_object('column','updated_at','direction','desc')
  );

  v_versions JSONB := jsonb_build_object(
    'key', 'integration_plugin_versions',
    'label', 'Integration plugin versions',
    'relation', 'public.integration_plugin_versions',
    'id_column', 'id',
    'capability_read', 'integration_plugins.read',
    'capability_write', 'integration_plugins.write',
    'select', jsonb_build_array(
      'id','plugin_id','organization_id','version_no','status','source_type','source_payload',
      'normalized_contract','inbound_config','mapping_config','workflow_binding','outbound_operations',
      'auth_bindings','validation_summary','submitted_at','submitted_by','approved_at','approved_by',
      'activated_at','activated_by','approval_reason','artifact_hash','diff_hash','metadata',
      'created_by','updated_by','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','plugin_id','column','plugin_id','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','source_type','column','source_type','op','eq')
    ),
    'default_sort', jsonb_build_object('column','version_no','direction','desc')
  );

  v_bindings JSONB := jsonb_build_object(
    'key', 'integration_plugin_bindings',
    'label', 'Integration plugin bindings',
    'relation', 'public.integration_plugin_bindings',
    'id_column', 'id',
    'capability_read', 'integration_plugins.read',
    'capability_write', 'integration_plugins.activate',
    'select', jsonb_build_array(
      'id','plugin_version_id','organization_id','scope_type','scope_id','binding_type','runtime_resource_type',
      'runtime_resource_id','enabled','activation_payload','metadata','created_by','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','plugin_version_id','column','plugin_version_id','op','eq'),
      jsonb_build_object('key','scope_type','column','scope_type','op','eq'),
      jsonb_build_object('key','binding_type','column','binding_type','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );

  v_validation_runs JSONB := jsonb_build_object(
    'key', 'integration_plugin_validation_runs',
    'label', 'Integration plugin validation runs',
    'relation', 'public.integration_plugin_validation_runs',
    'id_column', 'id',
    'capability_read', 'integration_plugins.read',
    'capability_write', 'integration_plugins.test',
    'select', jsonb_build_array(
      'id','plugin_version_id','organization_id','run_type','status','sandbox_mode','request_payload',
      'result_payload','correlation_id','executed_by','evidence_hash','error_message','created_at','completed_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','plugin_version_id','column','plugin_version_id','op','eq'),
      jsonb_build_object('key','run_type','column','run_type','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );

  v_approval_events JSONB := jsonb_build_object(
    'key', 'integration_plugin_approval_events',
    'label', 'Integration plugin approval events',
    'relation', 'public.integration_plugin_approval_events',
    'id_column', 'id',
    'capability_read', 'integration_plugins.read',
    'capability_write', 'integration_plugins.approve',
    'select', jsonb_build_array(
      'id','plugin_version_id','organization_id','action','actor_user_id','reason','diff_hash',
      'artifact_hash','payload','created_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','plugin_version_id','column','plugin_version_id','op','eq'),
      jsonb_build_object('key','action','column','action','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );

  v_defs JSONB := jsonb_build_array(v_plugins, v_versions, v_bindings, v_validation_runs, v_approval_events);
  v_def JSONB;
  v_key TEXT;
  v_found BOOLEAN;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_def IN SELECT * FROM jsonb_array_elements(v_defs)
  LOOP
    v_key := v_def->>'key';
    v_found := FALSE;
    v_updated := '[]'::jsonb;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources)
    LOOP
      IF v_item->>'key' = v_key THEN
        v_item := v_def;
        v_found := TRUE;
      END IF;
      v_updated := v_updated || jsonb_build_array(v_item);
    END LOOP;

    IF v_found IS FALSE THEN
      v_updated := v_updated || jsonb_build_array(v_def);
    END IF;

    v_resources := v_updated;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add integration plugin resources to ui_read_registry',
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
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-------------------------------------------------------------------------------
-- 2) ui_navigation entries
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_found BOOLEAN := FALSE;
  v_item JSONB := jsonb_build_object(
    'id', 'console-integration-plugins',
    'label', 'Integration Plugins',
    'href', '/console/integrations/plugins',
    'resource', 'integration_plugins',
    'capability', 'integration_plugins.read'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  FOR v_section IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'integrations' THEN
      v_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) item
        WHERE item->>'id' = 'console-integration-plugins'
      ) THEN
        v_items := v_items || jsonb_build_array(v_item);
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_console_sections := v_console_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_found IS FALSE THEN
    v_console_sections := v_console_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'integrations',
        'label', 'Integrations',
        'items', jsonb_build_array(v_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add Integration Plugins navigation item',
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
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202602220060_ui_registry_navigation_integration_plugins_v1'));
COMMIT;
