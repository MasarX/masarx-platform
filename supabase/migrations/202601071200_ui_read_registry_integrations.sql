-- Migration: UI read registry integrations + ops resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071200_ui_read_registry_integrations'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','zones',
      'label','Zones',
      'relation','public.zones',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','zones.read',
      'select', jsonb_build_array(
        'id','organization_id','name','slug','description','sort_order','is_active','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','name','column','name','op','ilike'),
        jsonb_build_object('key','slug','column','slug','op','ilike'),
        jsonb_build_object('key','is_active','column','is_active','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','zone_districts',
      'label','Zone districts',
      'relation','public.zone_districts',
      'id_column','id',
      'capability_read','zones.read',
      'select', jsonb_build_array(
        'id','zone_id','canonical_district_id','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','zone_id','column','zone_id','op','eq'),
        jsonb_build_object('key','canonical_district_id','column','canonical_district_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','baskets',
      'label','Baskets',
      'relation','public.baskets',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','baskets.read',
      'select', jsonb_build_array(
        'id','organization_id','zone_id','basket_type','state','current_count','capacity_count','expires_at','version','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','state','column','state','op','eq'),
        jsonb_build_object('key','basket_type','column','basket_type','op','eq'),
        jsonb_build_object('key','zone_id','column','zone_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','basket_items',
      'label','Basket items',
      'relation','public.basket_items',
      'id_column','id',
      'capability_read','baskets.read',
      'select', jsonb_build_array(
        'id','basket_id','shipment_id','shipment_client_id','added_at','removed_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','basket_id','column','basket_id','op','eq'),
        jsonb_build_object('key','shipment_id','column','shipment_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','added_at','direction','desc')
    ),
    jsonb_build_object(
      'key','basket_transitions',
      'label','Basket transitions',
      'relation','public.basket_transitions',
      'id_column','id',
      'capability_read','baskets.read',
      'select', jsonb_build_array(
        'id','basket_id','previous_state','new_state','changed_at','changed_by','notes'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','basket_id','column','basket_id','op','eq'),
        jsonb_build_object('key','new_state','column','new_state','op','eq')
      ),
      'default_sort', jsonb_build_object('column','changed_at','direction','desc')
    ),
    jsonb_build_object(
      'key','providers',
      'label','Providers',
      'relation','public.providers',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','integrations.read',
      'select', jsonb_build_array(
        'id','organization_id','name','provider_type','enabled','priority_rank','health_status','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_type','column','provider_type','op','eq'),
        jsonb_build_object('key','enabled','column','enabled','op','eq'),
        jsonb_build_object('key','health_status','column','health_status','op','eq'),
        jsonb_build_object('key','name','column','name','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','operation_templates',
      'label','Operation templates',
      'relation','public.operation_templates',
      'id_column','id',
      'capability_read','integrations.read',
      'select', jsonb_build_array(
        'id','provider_id','operation_name','method','url_template','timeout_seconds','mapping_config_id','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','operation_name','column','operation_name','op','ilike'),
        jsonb_build_object('key','method','column','method','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','mapping_configs',
      'label','Mapping configs',
      'relation','public.mapping_configs',
      'id_column','id',
      'capability_read','mappings.read',
      'select', jsonb_build_array(
        'id','mapping_type','mapping_key','mapping_version','mapping_config','notes','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','mapping_type','column','mapping_type','op','eq'),
        jsonb_build_object('key','mapping_key','column','mapping_key','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    ),
    jsonb_build_object(
      'key','field_mappings',
      'label','Field mappings',
      'relation','public.field_mappings',
      'id_column','id',
      'capability_read','mappings.read',
      'select', jsonb_build_array(
        'id','mapping_domain','provider_name','direction','provider_value','canonical_value','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','mapping_domain','column','mapping_domain','op','eq'),
        jsonb_build_object('key','provider_name','column','provider_name','op','ilike'),
        jsonb_build_object('key','direction','column','direction','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','webhook_sources',
      'label','Webhook sources',
      'relation','public.webhook_sources',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','webhooks.read',
      'select', jsonb_build_array(
        'id','organization_id','sender_id','source_identifier','name','provider_type','mapping_config_id','rate_limit_per_hour','enabled','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','source_identifier','column','source_identifier','op','ilike'),
        jsonb_build_object('key','provider_type','column','provider_type','op','eq'),
        jsonb_build_object('key','enabled','column','enabled','op','eq'),
        jsonb_build_object('key','sender_id','column','sender_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','webhook_rules',
      'label','Webhook rules',
      'relation','public.webhook_rules',
      'id_column','id',
      'capability_read','webhooks.read',
      'select', jsonb_build_array(
        'id','webhook_source_id','event_type','name','priority','mapping_config_id','workflow_template_id','domain_category','enabled','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','webhook_source_id','column','webhook_source_id','op','eq'),
        jsonb_build_object('key','event_type','column','event_type','op','eq'),
        jsonb_build_object('key','enabled','column','enabled','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','webhook_inbox',
      'label','Webhook inbox',
      'relation','public.webhook_inbox',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','webhooks.read',
      'select', jsonb_build_array(
        'id','organization_id','webhook_source_id','provider_type','external_id','event_type','processing_status','correlation_id','created_at','processed_at','error_message','raw_payload','transformed_payload'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','webhook_source_id','column','webhook_source_id','op','eq'),
        jsonb_build_object('key','event_type','column','event_type','op','eq'),
        jsonb_build_object('key','processing_status','column','processing_status','op','eq'),
        jsonb_build_object('key','external_id','column','external_id','op','eq'),
        jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','webhook_response_history',
      'label','Webhook responses',
      'relation','public.webhook_response_history',
      'id_column','id',
      'capability_read','webhooks.read',
      'select', jsonb_build_array(
        'id','webhook_inbox_id','webhook_source_id','response_mode','http_status_code','response_outcome','response_reason','workflow_run_id','workflow_run_step_id','idempotency_key','http_headers','http_body','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','webhook_source_id','column','webhook_source_id','op','eq'),
        jsonb_build_object('key','webhook_inbox_id','column','webhook_inbox_id','op','eq'),
        jsonb_build_object('key','response_outcome','column','response_outcome','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','webhook_log',
      'label','Webhook log',
      'relation','public.webhook_log',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','audit_log.read',
      'select', jsonb_build_array(
        'id','organization_id','webhook_source_id','direction','method','url','response_status','duration_ms','error_message','retry_count','timestamp'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','webhook_source_id','column','webhook_source_id','op','eq'),
        jsonb_build_object('key','direction','column','direction','op','eq'),
        jsonb_build_object('key','response_status','column','response_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','timestamp','direction','desc')
    ),
    jsonb_build_object(
      'key','api_call_log',
      'label','API call log',
      'relation','public.api_call_log',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','audit_log.read',
      'select', jsonb_build_array(
        'id','organization_id','provider_id','operation','method','url','response_status','duration_ms','error_message','circuit_breaker_state','correlation_id','timestamp'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_id','column','provider_id','op','eq'),
        jsonb_build_object('key','operation','column','operation','op','eq'),
        jsonb_build_object('key','response_status','column','response_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','timestamp','direction','desc')
    ),
    jsonb_build_object(
      'key','api_route_packs',
      'label','API route packs',
      'relation','public.api_route_packs',
      'id_column','id',
      'capability_read','api_routes.read',
      'select', jsonb_build_array(
        'id','name','description','enabled','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','name','column','name','op','ilike'),
        jsonb_build_object('key','enabled','column','enabled','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','api_routes',
      'label','API routes',
      'relation','public.api_routes',
      'id_column','id',
      'capability_read','api_routes.read',
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
      'key','lookup_definitions',
      'label','Lookup definitions',
      'relation','public.lookup_definitions',
      'id_column','id',
      'capability_read','lookups.read',
      'select', jsonb_build_array(
        'id','category','description','owner_role','approval_policy','is_mutable','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','category','column','category','op','ilike'),
        jsonb_build_object('key','owner_role','column','owner_role','op','eq'),
        jsonb_build_object('key','is_mutable','column','is_mutable','op','eq')
      ),
      'default_sort', jsonb_build_object('column','category','direction','asc')
    ),
    jsonb_build_object(
      'key','lookup_values',
      'label','Lookup values',
      'relation','public.lookup_values',
      'id_column','id',
      'capability_read','lookups.read',
      'select', jsonb_build_array(
        'id','lookup_definition_id','value','label','description','status','sort_order','is_default','metadata','effective_from','effective_until','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','lookup_definition_id','column','lookup_definition_id','op','eq'),
        jsonb_build_object('key','value','column','value','op','ilike'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','is_default','column','is_default','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','label_sections',
      'label','Label sections',
      'relation','public.label_sections',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','label_design.read',
      'select', jsonb_build_array(
        'id','organization_id','template_id','section_key','x','y','width','height','padding_top','padding_right','padding_bottom','padding_left','z_index','metadata','created_at','created_by'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','template_id','column','template_id','op','eq'),
        jsonb_build_object('key','section_key','column','section_key','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','label_design_tokens',
      'label','Label design tokens',
      'relation','public.label_design_tokens',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','label_design.read',
      'select', jsonb_build_array(
        'id','organization_id','template_id','token_key','token_type','value','metadata','created_at','created_by'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','template_id','column','template_id','op','eq'),
        jsonb_build_object('key','token_key','column','token_key','op','ilike'),
        jsonb_build_object('key','token_type','column','token_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','label_template_validation',
      'label','Label template validation',
      'relation','public.label_template_validation',
      'id_column','template_id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read','label_design.read',
      'select', jsonb_build_array(
        'template_id','organization_id','validation_status','validated_at','validated_by','validation_errors','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','template_id','column','template_id','op','eq'),
        jsonb_build_object('key','validation_status','column','validation_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    )
  );
  v_item JSONB;
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

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = v_item->>'key'
    ) THEN
      v_resources := v_resources || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
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
        change_reason = 'Add ops/integration resources to ui_read_registry',
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

SELECT pg_advisory_unlock(hashtext('202601071200_ui_read_registry_integrations'));
COMMIT;
