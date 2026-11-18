-- Migration: Console V2 create-shipment live contract repair
-- Purpose:
--   - Register service_offering_directory and shipment_directory in every
--     backend UI read registry scope used by Console V2.
--   - Preserve tenant onboarding workflow/plugin/readiness bootstraps while
--     adding service catalog defaults.
--   - Keep shipment.service_type canonical and validate selected service
--     offerings through backend metadata on the UI create path.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605042005_console_v2_create_shipment_live_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'service_offering_directory',
    'relation', 'public.v_service_offering_directory',
    'id_column', 'id',
    'capability_read', 'service_offerings.read',
    'capability_write', 'service_offerings.write',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'default_sort', jsonb_build_object('column', 'priority', 'direction', 'asc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'service_level_id', 'column', 'service_level_id', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'zone_id', 'column', 'zone_id', 'op', 'eq'),
      jsonb_build_object('key', 'level_key', 'column', 'level_key', 'op', 'eq'),
      jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq'),
      jsonb_build_object('key', 'effective_status', 'column', 'effective_status', 'op', 'eq')
    )
  );
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
    INTO v_filtered
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' <> v_resource->>'key';

  v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

  UPDATE public.settings_versions
     SET value = v_current,
         version = version + 1,
         change_reason = 'Register Console V2 service offering directory read',
         approved_at = now(),
         effective_from = now(),
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;

  FOR v_settings_version_id, v_current IN
    SELECT s.settings_version_id, COALESCE(s.cached_value, '{"resources":[]}'::jsonb)
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT (
         s.scope_type = 'global'
         AND s.scope_id IS NULL
       )
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = version + 1,
           change_reason = 'Register Console V2 service offering directory read',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id;
  END LOOP;

  v_resource := jsonb_build_object(
    'key', 'shipment_directory',
    'relation', 'public.v_shipment_directory',
    'id_column', 'id',
    'capability_read', 'shipments.read',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'tracking_number', 'column', 'tracking_number', 'op', 'ilike'),
      jsonb_build_object('key', 'client_reference_number', 'column', 'client_reference_number', 'op', 'ilike'),
      jsonb_build_object('key', 'carrier_reference_number', 'column', 'carrier_reference_number', 'op', 'ilike'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
    )
  );

  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
    INTO v_filtered
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' <> v_resource->>'key';

  v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

  UPDATE public.settings_versions
     SET value = v_current,
         version = version + 1,
         change_reason = 'Register Console V2 shipment directory read',
         approved_at = now(),
         effective_from = now(),
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;

  FOR v_settings_version_id, v_current IN
    SELECT s.settings_version_id, COALESCE(s.cached_value, '{"resources":[]}'::jsonb)
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT (
         s.scope_type = 'global'
         AND s.scope_id IS NULL
       )
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = version + 1,
           change_reason = 'Register Console V2 shipment directory read',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB;
  v_roles JSONB;
  v_updated_roles JSONB;
  v_role JSONB;
  v_role_key TEXT;
  v_keys JSONB;
  v_resource_map JSONB;
BEGIN
  FOR v_settings_version_id, v_current IN
    SELECT s.settings_version_id, COALESCE(s.cached_value, '{}'::jsonb)
      FROM public.settings s
     WHERE s.category = 'access_control_policy'
  LOOP
    v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'service_offerings.read'
    ) THEN
      v_capabilities := v_capabilities || jsonb_build_array(
        jsonb_build_object(
          'key', 'service_offerings.read',
          'label', 'Service offerings read',
          'category', 'catalog',
          'description', 'Read service catalog offerings and service-level directory rows.'
        )
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'service_offerings.write'
    ) THEN
      v_capabilities := v_capabilities || jsonb_build_array(
        jsonb_build_object(
          'key', 'service_offerings.write',
          'label', 'Service offerings write',
          'category', 'catalog',
          'description', 'Create, update, toggle, and archive service catalog offerings.'
        )
      );
    END IF;

    v_updated_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb))
    LOOP
      v_role_key := NULLIF(v_role->>'key', '');
      v_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_keys) <> 'array' THEN
        v_keys := '[]'::jsonb;
      END IF;

      IF v_role_key IN ('ops_admin', 'agreements_admin', 'account_manager') THEN
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('service_offerings.read', '*')) THEN
          v_keys := v_keys || jsonb_build_array('service_offerings.read');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('service_offerings.write', '*')) THEN
          v_keys := v_keys || jsonb_build_array('service_offerings.write');
        END IF;
      ELSIF v_role_key = 'finance' THEN
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value IN ('service_offerings.read', '*')) THEN
          v_keys := v_keys || jsonb_build_array('service_offerings.read');
        END IF;
      END IF;

      v_updated_roles := v_updated_roles || jsonb_build_array(jsonb_set(v_role, '{capability_keys}', v_keys, TRUE));
    END LOOP;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    v_resource_map := jsonb_set(
      v_resource_map,
      '{service_offerings}',
      jsonb_build_object('read', 'service_offerings.read', 'write', 'service_offerings.write'),
      TRUE
    );
    v_resource_map := jsonb_set(
      v_resource_map,
      '{service_offering_directory}',
      jsonb_build_object('read', 'service_offerings.read', 'write', 'service_offerings.write'),
      TRUE
    );

    v_next := v_current;
    v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_updated_roles, TRUE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           version = version + 1,
           change_reason = 'Add service offering access capabilities for Console V2',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_settings_version_id
       AND v_next IS DISTINCT FROM value;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;
END;
$do$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_onboarding_v1(
  p_organization_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_ensure_globals BOOLEAN;
  v_provision_templates BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_globals_result JSONB := '{}'::jsonb;
  v_binding_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
  v_catalog_result JSONB := '{}'::jsonb;
  v_readiness JSONB := '{}'::jsonb;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
  v_template TEXT;
  v_provisioned JSONB := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_ensure_globals := public.onboarding_policy_bool_v1(v_policy, ARRAY['ensure_global_required_defaults'], TRUE);
  IF v_ensure_globals THEN
    v_globals_result := public.ensure_required_global_defaults_v1();
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('tenant', p_organization_id, v_policy, p_trigger_source);
  v_binding_result := public.bootstrap_workflow_binding_defaults_v1('tenant', p_organization_id, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('tenant', p_organization_id, p_trigger_source);

  IF COALESCE((v_plugin_result->>'ok')::boolean, FALSE) IS FALSE THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1 plugin baseline blocked'
      USING DETAIL = v_plugin_result::text;
  END IF;

  v_catalog_result := public.bootstrap_tenant_service_catalog_defaults_v1(p_organization_id, v_policy, p_trigger_source);

  v_provision_templates := public.onboarding_policy_bool_v1(v_policy, ARRAY['rbac', 'provision_templates'], TRUE);
  IF v_provision_templates THEN
    v_template_keys_json := COALESCE(v_policy #> ARRAY['rbac', 'template_keys'], '[]'::jsonb);
    IF jsonb_typeof(v_template_keys_json) <> 'array' THEN
      v_template_keys_json := '[]'::jsonb;
    END IF;

    SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
      INTO v_template_keys
      FROM jsonb_array_elements_text(v_template_keys_json);

    IF array_length(v_template_keys, 1) IS NOT NULL THEN
      PERFORM public.provision_rbac_roles_from_templates_v1(
        p_organization_id,
        v_template_keys,
        NULL
      );

      FOREACH v_template IN ARRAY v_template_keys LOOP
        v_provisioned := v_provisioned || jsonb_build_array(v_template);
      END LOOP;
    END IF;
  END IF;

  v_readiness := public.onboarding_readiness_snapshot_v1('tenant', p_organization_id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'workflow_bindings', v_binding_result,
    'integration_plugins', v_plugin_result,
    'service_catalog_defaults', v_catalog_result,
    'rbac_templates_provisioned', v_provisioned,
    'readiness', v_readiness
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_create_shipment_v1(
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_service_type TEXT DEFAULT NULL,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL,
  p_carrier_reference_number TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_template_id UUID;
  v_client_id UUID := p_client_id;
  v_sender_id UUID := p_sender_id;
  v_sender_client_id UUID;
  v_sender_org_id UUID;
  v_service_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'delivery');
  v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'pending');
  v_tracking_number TEXT := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_client_reference_number TEXT := NULLIF(btrim(COALESCE(p_client_reference_number, '')), '');
  v_carrier_reference_number TEXT := NULLIF(btrim(COALESCE(p_carrier_reference_number, '')), '');
  v_metadata JSONB := CASE
    WHEN jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) = 'object' THEN COALESCE(p_metadata, '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_dry_run BOOLEAN;
  v_service_offering_text TEXT;
  v_service_offering_id UUID;
  v_service_level_id UUID;
  v_service_level_key TEXT;
  v_service_offering_branch_id UUID;
  v_service_offering_zone_id UUID;
  v_service_offering_display_name TEXT;
  v_recipient_text TEXT;
  v_recipient_id UUID;
  v_cod_amount NUMERIC;
  v_cod_currency TEXT;
  v_correlation_id UUID := gen_random_uuid();
  v_run_id UUID;
  v_context JSONB;
  v_run_context JSONB := '{}'::jsonb;
  v_progress JSONB;
  v_create_result JSONB := '{}'::jsonb;
  v_shipment_id UUID;
  v_attempt INT;
  v_workflow_status TEXT;
  v_operation TEXT;
BEGIN
  v_dry_run := lower(COALESCE(v_metadata #>> ARRAY['ui','dry_run'], v_metadata->>'dry_run', 'false')) IN ('true', '1', 'yes', 'on');
  v_metadata := v_metadata - 'ui' - 'dry_run';
  v_cod_currency := NULLIF(btrim(COALESCE(v_metadata->>'cod_currency', '')), '');
  IF NULLIF(btrim(COALESCE(v_metadata->>'cod_amount', '')), '') IS NOT NULL THEN
    IF NULLIF(btrim(COALESCE(v_metadata->>'cod_amount', '')), '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
      v_cod_amount := (v_metadata->>'cod_amount')::NUMERIC;
    ELSE
      RAISE EXCEPTION 'ui_create_shipment_v1 cod_amount must be numeric';
    END IF;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires authenticated user';
  END IF;

  PERFORM public.assert_capability_v1('shipments.write', v_scope_type, v_scope_id);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires organization context';
  END IF;

  IF v_scope_type = 'client' AND v_scope_id IS NOT NULL THEN
    IF v_client_id IS NOT NULL AND v_client_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 client scope cannot create for another client';
    END IF;
    v_client_id := v_scope_id;
  END IF;

  IF v_scope_type = 'sender' AND v_scope_id IS NOT NULL THEN
    IF v_sender_id IS NOT NULL AND v_sender_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender scope cannot create for another sender';
    END IF;
    v_sender_id := v_scope_id;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id
     LIMIT 1;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender not found';
    END IF;
    IF v_sender_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is outside the current organization';
    END IF;
    IF v_client_id IS NULL THEN
      v_client_id := v_sender_client_id;
    ELSIF v_client_id <> v_sender_client_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender must belong to the selected client';
    END IF;
  END IF;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires client_id';
  END IF;

  PERFORM 1
    FROM public.clients c
   WHERE c.id = v_client_id
     AND c.organization_id = v_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 client is outside the current organization';
  END IF;

  v_service_offering_text := NULLIF(btrim(COALESCE(v_metadata->>'service_offering_id', '')), '');
  IF v_service_offering_text IS NULL
     AND v_service_type ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_service_offering_text := v_service_type;
    v_service_type := 'delivery';
  END IF;

  IF v_service_offering_text IS NOT NULL THEN
    BEGIN
      v_service_offering_id := v_service_offering_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 service_offering_id must be a uuid';
    END;

    SELECT so.id, so.service_level_id, sl.key, so.branch_id, so.zone_id, so.metadata->'display'->>'name'
      INTO v_service_offering_id, v_service_level_id, v_service_level_key, v_service_offering_branch_id, v_service_offering_zone_id, v_service_offering_display_name
      FROM public.service_offerings so
      JOIN public.service_levels sl ON sl.id = so.service_level_id
     WHERE so.id = v_service_offering_id
       AND sl.organization_id = v_org_id
       AND sl.is_active IS TRUE
       AND so.is_active IS TRUE
       AND lower(COALESCE(sl.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
       AND lower(COALESCE(so.metadata->'display'->>'status', 'active')) NOT IN ('archived', 'draft')
       AND now() >= so.effective_from
       AND (so.effective_to IS NULL OR now() < so.effective_to)
     LIMIT 1;

    IF v_service_offering_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 service offering is unavailable for the current organization';
    END IF;

    v_metadata := jsonb_strip_nulls(
      v_metadata || jsonb_build_object(
        'service_offering_id', v_service_offering_id,
        'service_level_id', v_service_level_id,
        'service_level_key', v_service_level_key,
        'service_offering_branch_id', v_service_offering_branch_id,
        'service_offering_zone_id', v_service_offering_zone_id,
        'service_offering_display_name', v_service_offering_display_name
      )
    );
  END IF;

  v_recipient_text := NULLIF(btrim(COALESCE(v_metadata->>'recipient_id', '')), '');
  IF v_recipient_text IS NOT NULL THEN
    BEGIN
      v_recipient_id := v_recipient_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 recipient_id must be a uuid';
    END;

    PERFORM 1
      FROM public.recipients r
     WHERE r.id = v_recipient_id
       AND r.organization_id = v_org_id
       AND r.client_id = v_client_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 recipient is outside the selected client';
    END IF;

    v_metadata := jsonb_strip_nulls(v_metadata || jsonb_build_object('recipient_id', v_recipient_id));
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 workflow template shipment_manual_create_v1 not found';
  END IF;

  IF v_dry_run THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'status', 'shipment_create_preview',
        'dry_run', TRUE,
        'workflow_template_id', v_template_id,
        'correlation_id', v_correlation_id,
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'recipient_id', v_recipient_id,
        'service_type', v_service_type,
        'service_offering_id', v_service_offering_id,
        'client_reference_number', v_client_reference_number,
        'carrier_reference_number', v_carrier_reference_number,
        'tracking_number', v_tracking_number,
        'tracking_will_be_reserved', v_tracking_number IS NULL,
        'metadata', v_metadata
      )
    );
  END IF;

  PERFORM set_config('request.correlation_id', v_correlation_id::text, true);

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'trigger_source', 'manual',
      'correlation_id', v_correlation_id,
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'recipient_id', v_recipient_id,
      'requested_by', auth.uid(),
      'service_type', v_service_type,
      'initial_status', v_status,
      'planned_tracking_number', v_tracking_number,
      'client_reference_number', v_client_reference_number,
      'carrier_reference_number', v_carrier_reference_number,
      'metadata', v_metadata,
      'payload', jsonb_build_object(
        'resource', jsonb_strip_nulls(
          jsonb_build_object(
            'type', 'shipment',
            'service_type', v_service_type,
            'recipient_id', v_recipient_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', v_client_reference_number,
            'carrier_reference_number', v_carrier_reference_number,
            'status', v_status,
            'metadata', jsonb_strip_nulls(
              v_metadata
              || jsonb_build_object(
                'source', 'ui.manual_create',
                'requested_by', auth.uid(),
                'correlation_id', v_correlation_id
              )
            )
          )
        )
      ),
      'ui', jsonb_build_object(
        'source', 'shipment_manual_create',
        'workflow_template_id', v_template_id
      )
    )
  );

  v_run_id := public.start_workflow_run(v_template_id, v_context);

  UPDATE public.workflow_runs
     SET triggered_by_request_id = COALESCE(triggered_by_request_id, v_correlation_id),
         updated_at = now()
   WHERE id = v_run_id;

  FOR v_attempt IN 1..6 LOOP
    SELECT public.progress_workflow_run(v_run_id) INTO v_progress;

    SELECT workflow_status, context
      INTO v_workflow_status, v_run_context
      FROM public.workflow_runs
     WHERE id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'waiting', 'blocked');
  END LOOP;

  SELECT step.operation_result
    INTO v_create_result
    FROM public.workflow_run_steps step
   WHERE step.workflow_run_id = v_run_id
     AND step.handler_key = 'shipment_create'
   ORDER BY step.sequence_order
   LIMIT 1;

  BEGIN
    v_shipment_id := COALESCE(
      NULLIF(v_run_context#>>'{shipment,id}', '')::UUID,
      NULLIF(v_run_context#>>'{workflow,context_patch,shipment,id}', '')::UUID,
      NULLIF(v_create_result->>'shipment_id', '')::UUID,
      NULLIF(v_run_context->>'planned_shipment_id', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL AND v_client_id IS NOT NULL THEN
    SELECT resolved.shipment_id, resolved.operation
      INTO v_shipment_id, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client_id,
        COALESCE(NULLIF(v_run_context#>>'{shipment,tracking_number}', ''), v_tracking_number),
        v_client_reference_number
      ) AS resolved
     LIMIT 1;
  END IF;

  v_operation := COALESCE(
    v_create_result->>'operation',
    v_operation,
    CASE WHEN v_shipment_id IS NOT NULL THEN 'inserted' ELSE NULL END
  );

  IF v_shipment_id IS NOT NULL THEN
    UPDATE public.shipments s
       SET recipient_id = COALESCE(v_recipient_id, s.recipient_id),
           cod_amount = COALESCE(v_cod_amount, s.cod_amount),
           cod_currency = COALESCE(v_cod_currency, s.cod_currency),
           metadata = jsonb_strip_nulls(
             COALESCE(s.metadata, '{}'::jsonb)
             || v_metadata
             || jsonb_build_object(
               'source', 'ui.manual_create',
               'requested_by', auth.uid(),
               'correlation_id', v_correlation_id
             )
           ),
           updated_at = now()
     WHERE s.id = v_shipment_id
       AND s.client_id = v_client_id;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', CASE
        WHEN v_workflow_status = 'completed' AND v_shipment_id IS NOT NULL THEN 'shipment_created'
        ELSE COALESCE(v_workflow_status, 'workflow_started')
      END,
      'dry_run', FALSE,
      'workflow_template_id', v_template_id,
      'workflow_run_id', v_run_id,
      'workflow_status', v_workflow_status,
      'correlation_id', v_correlation_id,
      'shipment_id', v_shipment_id,
      'tracking_number', COALESCE(
        NULLIF(v_run_context#>>'{shipment,tracking_number}', ''),
        NULLIF(v_create_result->>'tracking_number', ''),
        v_tracking_number
      ),
      'operation', v_operation
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605042005_console_v2_create_shipment_live_contract_v1'));
COMMIT;
