-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: UI registry updates for shared mapping studio resources

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061210_ui_registry_mapping_studio_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_def JSONB;
  v_found BOOLEAN;
  v_key TEXT;
  v_defs JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'mapping_configs',
      'label', 'Mapping configs',
      'relation', 'public.mapping_configs',
      'id_column', 'id',
      'capability_read', 'mappings.read',
      'capability_write', 'mappings.write',
      'select', jsonb_build_array(
        'id','organization_id','mapping_type','mapping_key','mapping_version','mapping_config','notes','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','mapping_type','column','mapping_type','op','eq'),
        jsonb_build_object('key','mapping_key','column','mapping_key','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'webhook_sources',
      'label', 'Webhook sources',
      'relation', 'public.webhook_sources',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read', 'webhooks.read',
      'capability_write', 'webhooks.write',
      'select', jsonb_build_array(
        'id','organization_id','sender_id','source_identifier','name','provider_type','mapping_config_id','rate_limit_per_hour','enabled','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
        jsonb_build_object('key','source_identifier','column','source_identifier','op','ilike'),
        jsonb_build_object('key','provider_type','column','provider_type','op','eq'),
        jsonb_build_object('key','enabled','column','enabled','op','eq'),
        jsonb_build_object('key','sender_id','column','sender_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'operation_templates',
      'label', 'Operation templates',
      'relation', 'public.operation_templates',
      'id_column', 'id',
      'capability_read', 'integrations.read',
      'capability_write', 'system.write',
      'select', jsonb_build_array(
        'id','provider_id','operation_name','method','url_template','headers_template','body_template','request_mappings','mapping_config_id','timeout_seconds','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','operation_name','column','operation_name','op','ilike'),
        jsonb_build_object('key','method','column','method','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'api_routes',
      'label', 'API routes',
      'relation', 'public.api_routes',
      'id_column', 'id',
      'capability_read', 'api_routes.read',
      'capability_write', 'system.write',
      'select', jsonb_build_array(
        'id','pack_id','route_name','enabled','method','path_template','scope_type','scope_id','provider_id','upstream_method','upstream_path_template','policy','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','pack_id','column','pack_id','op','eq'),
        jsonb_build_object('key','enabled','column','enabled','op','eq'),
        jsonb_build_object('key','method','column','method','op','eq'),
        jsonb_build_object('key','scope_type','column','scope_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'mapping_operation_reports',
      'label', 'Mapping operation reports',
      'relation', 'public.mapping_operation_reports',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read', 'mappings.read',
      'select', jsonb_build_array(
        'id','organization_id','artifact_type','save_mode','status','primary_resource_type','primary_resource_id','workflow_template_id','correlation_id','request_summary','conversion_summary','diagnostics_summary','result_payload','decision_refs','next_steps','created_by','updated_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','artifact_type','column','artifact_type','op','eq'),
        jsonb_build_object('key','save_mode','column','save_mode','op','eq'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','primary_resource_type','column','primary_resource_type','op','eq'),
        jsonb_build_object('key','primary_resource_id','column','primary_resource_id','op','eq'),
        jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    )
  );
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
           change_reason = 'Add mapping studio resources and write capabilities to ui_read_registry',
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

SELECT pg_advisory_unlock(hashtext('202603061210_ui_registry_mapping_studio_v1'));
COMMIT;
