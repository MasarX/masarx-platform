-- Migration: Console V2 tenant provider defaults
-- Purpose:
--   Newly approved tenants must be able to configure integration credentials
--   from Console V2 without depending on demo seed rows. This adds a
--   row-driven provider-default bootstrap to the canonical tenant onboarding
--   path and backfills existing tenants.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071030_console_v2_tenant_provider_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.onboarding_provider_defaults_v1(
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := jsonb_build_object(
    'enabled', TRUE,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'key', 'default-shipment-webhook-intake',
        'name', 'Default Shipment Webhook Intake',
        'provider_type', 'webhook',
        'priority_rank', 10,
        'metadata', jsonb_build_object(
          'vendor', 'MasarX',
          'purpose', 'inbound_shipment_intake',
          'requires_credentials', TRUE
        )
      ),
      jsonb_build_object(
        'key', 'osm-geocoding',
        'name', 'OpenStreetMap Geocoding',
        'provider_type', 'geocoding',
        'priority_rank', 20,
        'metadata', jsonb_build_object(
          'vendor', 'OpenStreetMap',
          'purpose', 'address_geocoding',
          'open_source', TRUE,
          'requires_credentials', FALSE
        )
      ),
      jsonb_build_object(
        'key', 'valhalla-routing',
        'name', 'Valhalla Routing',
        'provider_type', 'routing',
        'priority_rank', 30,
        'metadata', jsonb_build_object(
          'vendor', 'Valhalla',
          'purpose', 'route_matrix_and_eta',
          'open_source', TRUE,
          'requires_credentials', FALSE
        )
      ),
      jsonb_build_object(
        'key', 'vroom-optimization',
        'name', 'VROOM Optimization',
        'provider_type', 'routing',
        'priority_rank', 40,
        'metadata', jsonb_build_object(
          'vendor', 'VROOM',
          'purpose', 'route_optimization',
          'open_source', TRUE,
          'requires_credentials', FALSE
        )
      ),
      jsonb_build_object(
        'key', 'default-customer-notifications',
        'name', 'Default Customer Notifications',
        'provider_type', 'comms',
        'priority_rank', 50,
        'metadata', jsonb_build_object(
          'vendor', 'MasarX',
          'purpose', 'customer_notifications',
          'requires_credentials', TRUE
        )
      ),
      jsonb_build_object(
        'key', 'default-cod-collection',
        'name', 'Default COD Collection',
        'provider_type', 'payment',
        'priority_rank', 60,
        'metadata', jsonb_build_object(
          'vendor', 'MasarX',
          'purpose', 'cod_reconciliation',
          'requires_credentials', FALSE
        )
      ),
      jsonb_build_object(
        'key', 'default-delivery-partner-api',
        'name', 'Default Delivery Partner API',
        'provider_type', 'delivery',
        'priority_rank', 70,
        'metadata', jsonb_build_object(
          'vendor', 'MasarX',
          'purpose', 'partner_delivery_handoff',
          'requires_credentials', TRUE
        )
      )
    )
  );
  v_config JSONB := COALESCE(p_policy #> ARRAY['provider_defaults'], '{}'::jsonb);
  v_result JSONB;
BEGIN
  IF v_config IS NULL OR jsonb_typeof(v_config) <> 'object' THEN
    RETURN v_default;
  END IF;

  v_result := public.jsonb_deep_merge(v_default, v_config);
  IF jsonb_typeof(COALESCE(v_result->'providers', '[]'::jsonb)) <> 'array' THEN
    v_result := jsonb_set(v_result, '{providers}', v_default->'providers', TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_provider_defaults_v1(
  p_organization_id UUID,
  p_policy JSONB,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_config JSONB := public.onboarding_provider_defaults_v1(p_policy);
  v_enabled BOOLEAN := public.onboarding_policy_bool_v1(p_policy, ARRAY['provider_defaults', 'enabled'], TRUE);
  v_provider JSONB;
  v_provider_key TEXT;
  v_name TEXT;
  v_provider_type TEXT;
  v_priority_rank INTEGER;
  v_metadata JSONB;
  v_count INTEGER := 0;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_provider_defaults_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'bootstrap_tenant_provider_defaults_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  FOR v_provider IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(v_config->'providers', '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_provider) <> 'object' THEN
      CONTINUE;
    END IF;

    v_provider_key := lower(NULLIF(btrim(COALESCE(v_provider->>'key', '')), ''));
    v_name := NULLIF(btrim(COALESCE(v_provider->>'name', '')), '');
    v_provider_type := lower(NULLIF(btrim(COALESCE(v_provider->>'provider_type', '')), ''));
    v_priority_rank := COALESCE(NULLIF(v_provider->>'priority_rank', '')::INTEGER, 100);
    v_metadata := COALESCE(v_provider->'metadata', '{}'::jsonb)
      || jsonb_build_object(
        'onboarding', jsonb_build_object(
          'auto_provisioned', TRUE,
          'default_key', v_provider_key,
          'trigger_source', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual')
        )
      );

    IF v_provider_key IS NULL OR v_name IS NULL OR v_provider_type IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.providers (
      organization_id,
      name,
      provider_type,
      enabled,
      priority_rank,
      health_status,
      metadata
    )
    VALUES (
      p_organization_id,
      v_name,
      v_provider_type,
      COALESCE((v_provider->>'enabled')::BOOLEAN, TRUE),
      v_priority_rank,
      COALESCE(NULLIF(btrim(v_provider->>'health_status'), ''), 'healthy'),
      v_metadata
    )
    ON CONFLICT (organization_id, name, provider_type) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           priority_rank = EXCLUDED.priority_rank,
           health_status = EXCLUDED.health_status,
           metadata = COALESCE(providers.metadata, '{}'::jsonb)
             || jsonb_build_object('onboarding', EXCLUDED.metadata->'onboarding'),
           updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'providers_created_or_found', v_count
  );
END;
$function$;

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
  v_provider_result JSONB := '{}'::jsonb;
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
  v_provider_result := public.bootstrap_tenant_provider_defaults_v1(p_organization_id, v_policy, p_trigger_source);

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
    'provider_defaults', v_provider_result,
    'rbac_templates_provisioned', v_provisioned,
    'readiness', v_readiness
  );
END;
$function$;

DO $do$
DECLARE
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_org RECORD;
BEGIN
  FOR v_org IN
    SELECT id
      FROM public.organizations
     WHERE billing_status IS DISTINCT FROM 'suspended'
  LOOP
    PERFORM public.bootstrap_tenant_provider_defaults_v1(
      v_org.id,
      v_policy,
      'migration-backfill'
    );
  END LOOP;
END;
$do$;

REVOKE ALL ON FUNCTION public.onboarding_provider_defaults_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_provider_defaults_v1(UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_provider_defaults_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_provider_defaults_v1(UUID, JSONB, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_provider_defaults_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_provider_defaults_v1(UUID, JSONB, TEXT) TO service_role;

COMMENT ON FUNCTION public.onboarding_provider_defaults_v1(JSONB) IS
  'Returns row-driven provider defaults used by tenant onboarding. Policy override: saas_onboarding_policy.provider_defaults.';
COMMENT ON FUNCTION public.bootstrap_tenant_provider_defaults_v1(UUID, JSONB, TEXT) IS
  'Materializes tenant provider catalog defaults so Console V2 credential setup is backend-backed and not seed-dependent.';
COMMENT ON FUNCTION public.bootstrap_tenant_onboarding_v1(UUID, TEXT) IS
  'Canonical tenant onboarding bootstrap. Materializes settings, workflow bindings, integration plugins, service catalog, provider catalog defaults, RBAC templates, and readiness.';

SELECT pg_advisory_unlock(hashtext('202605071030_console_v2_tenant_provider_defaults_v1'));
COMMIT;
