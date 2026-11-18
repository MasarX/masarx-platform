-- Migration: tenant onboarding service catalog defaults
-- Purpose:
--   Tenant activation must leave Console V2 with a usable, row-driven service
--   catalog for first shipment creation. This appends policy-driven branch,
--   service-level, and service-offering defaults to the canonical onboarding
--   bootstrap path. Tenant admins can still replace or extend the rows later.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605041930_tenant_onboarding_service_catalog_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.onboarding_service_catalog_defaults_v1(
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
    'create_default_branch', TRUE,
    'branch', jsonb_build_object(
      'code', 'main',
      'name', 'Main warehouse',
      'branch_type', 'warehouse',
      'timezone', 'Asia/Riyadh'
    ),
    'levels', jsonb_build_array(
      jsonb_build_object(
        'key', 'standard',
        'name', 'Standard delivery',
        'description', 'Default next-day delivery service level.',
        'metadata', jsonb_build_object(
          'tier', 'standard',
          'priority_rank', 10,
          'sla_minutes', 1440,
          'sla_label', '24h',
          'tone', 'good'
        )
      ),
      jsonb_build_object(
        'key', 'express',
        'name', 'Express delivery',
        'description', 'Default expedited delivery service level.',
        'metadata', jsonb_build_object(
          'tier', 'express',
          'priority_rank', 20,
          'sla_minutes', 480,
          'sla_label', '8h',
          'tone', 'warn'
        )
      ),
      jsonb_build_object(
        'key', 'same_day',
        'name', 'Same-day delivery',
        'description', 'Default same-day delivery service level.',
        'metadata', jsonb_build_object(
          'tier', 'same_day',
          'priority_rank', 30,
          'sla_minutes', 240,
          'sla_label', '4h',
          'tone', 'info'
        )
      )
    ),
    'offerings', jsonb_build_array(
      jsonb_build_object(
        'key', 'standard-main',
        'level_key', 'standard',
        'display', jsonb_build_object('name', 'Standard delivery', 'slug', 'standard-delivery', 'status', 'active'),
        'base_price', 25,
        'currency', 'SAR',
        'max_weight_kg', 30,
        'priority', 10
      ),
      jsonb_build_object(
        'key', 'express-main',
        'level_key', 'express',
        'display', jsonb_build_object('name', 'Express delivery', 'slug', 'express-delivery', 'status', 'active'),
        'base_price', 45,
        'currency', 'SAR',
        'max_weight_kg', 20,
        'priority', 20
      ),
      jsonb_build_object(
        'key', 'same-day-main',
        'level_key', 'same_day',
        'display', jsonb_build_object('name', 'Same-day delivery', 'slug', 'same-day-delivery', 'status', 'active'),
        'base_price', 65,
        'currency', 'SAR',
        'max_weight_kg', 15,
        'priority', 30
      )
    )
  );
  v_config JSONB := COALESCE(p_policy #> ARRAY['service_catalog_defaults'], '{}'::jsonb);
BEGIN
  IF v_config IS NULL OR jsonb_typeof(v_config) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_config);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_service_catalog_defaults_v1(
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
  v_catalog JSONB := public.onboarding_service_catalog_defaults_v1(p_policy);
  v_enabled BOOLEAN := public.onboarding_policy_bool_v1(p_policy, ARRAY['service_catalog_defaults', 'enabled'], TRUE);
  v_create_branch BOOLEAN := public.onboarding_policy_bool_v1(p_policy, ARRAY['service_catalog_defaults', 'create_default_branch'], TRUE);
  v_branch_config JSONB := COALESCE(v_catalog #> ARRAY['branch'], '{}'::jsonb);
  v_branch_code TEXT;
  v_branch_name TEXT;
  v_branch_type TEXT;
  v_branch_timezone TEXT;
  v_branch_id UUID;
  v_level JSONB;
  v_level_key TEXT;
  v_level_name TEXT;
  v_level_id UUID;
  v_offering JSONB;
  v_offering_key TEXT;
  v_offering_branch_code TEXT;
  v_offering_branch_id UUID;
  v_offering_id UUID;
  v_level_count INTEGER := 0;
  v_offering_count INTEGER := 0;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_service_catalog_defaults_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'bootstrap_tenant_service_catalog_defaults_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_branch_code := lower(NULLIF(btrim(COALESCE(v_branch_config->>'code', 'main')), ''));
  IF v_branch_code IS NULL THEN
    v_branch_code := 'main';
  END IF;
  v_branch_name := NULLIF(btrim(COALESCE(v_branch_config->>'name', 'Main warehouse')), '');
  IF v_branch_name IS NULL THEN
    v_branch_name := 'Main warehouse';
  END IF;
  v_branch_type := NULLIF(btrim(COALESCE(v_branch_config->>'branch_type', 'warehouse')), '');
  v_branch_timezone := NULLIF(btrim(COALESCE(v_branch_config->>'timezone', 'Asia/Riyadh')), '');

  IF v_create_branch THEN
    INSERT INTO public.branches (
      organization_id,
      code,
      name,
      branch_type,
      timezone,
      metadata
    )
    VALUES (
      p_organization_id,
      v_branch_code,
      v_branch_name,
      v_branch_type,
      v_branch_timezone,
      jsonb_build_object(
        'onboarding', jsonb_build_object(
          'auto_provisioned', TRUE,
          'default_key', v_branch_code,
          'trigger_source', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual')
        )
      )
    )
    ON CONFLICT (organization_id, code) DO NOTHING;
  END IF;

  SELECT b.id
    INTO v_branch_id
    FROM public.branches b
   WHERE b.organization_id = p_organization_id
     AND b.code = v_branch_code
   LIMIT 1;

  IF v_branch_id IS NULL THEN
    SELECT b.id
      INTO v_branch_id
      FROM public.branches b
     WHERE b.organization_id = p_organization_id
       AND b.is_active IS TRUE
     ORDER BY b.created_at ASC
     LIMIT 1;
  END IF;

  IF v_branch_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', TRUE,
      'organization_id', p_organization_id,
      'branch_created_or_found', FALSE,
      'service_levels_created_or_found', 0,
      'service_offerings_created_or_found', 0,
      'reason', 'no_branch_available'
    );
  END IF;

  FOR v_level IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(v_catalog->'levels', '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_level) <> 'object' THEN
      CONTINUE;
    END IF;

    v_level_key := lower(NULLIF(btrim(v_level->>'key'), ''));
    v_level_name := NULLIF(btrim(v_level->>'name'), '');
    IF v_level_key IS NULL OR v_level_name IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.service_levels (
      organization_id,
      key,
      name,
      description,
      is_active,
      metadata
    )
    VALUES (
      p_organization_id,
      v_level_key,
      v_level_name,
      NULLIF(btrim(v_level->>'description'), ''),
      COALESCE((v_level->>'is_active')::BOOLEAN, TRUE),
      COALESCE(v_level->'metadata', '{}'::jsonb)
      || jsonb_build_object(
        'onboarding', jsonb_build_object(
          'auto_provisioned', TRUE,
          'default_key', v_level_key,
          'trigger_source', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual')
        )
      )
    )
    ON CONFLICT (organization_id, key) DO NOTHING;

    SELECT sl.id
      INTO v_level_id
      FROM public.service_levels sl
     WHERE sl.organization_id = p_organization_id
       AND sl.key = v_level_key
     LIMIT 1;

    IF v_level_id IS NOT NULL THEN
      v_level_count := v_level_count + 1;
    END IF;
  END LOOP;

  FOR v_offering IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(v_catalog->'offerings', '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_offering) <> 'object' THEN
      CONTINUE;
    END IF;

    v_level_key := lower(NULLIF(btrim(v_offering->>'level_key'), ''));
    IF v_level_key IS NULL THEN
      CONTINUE;
    END IF;

    SELECT sl.id
      INTO v_level_id
      FROM public.service_levels sl
     WHERE sl.organization_id = p_organization_id
       AND sl.key = v_level_key
       AND sl.is_active IS TRUE
     LIMIT 1;

    IF v_level_id IS NULL THEN
      CONTINUE;
    END IF;

    v_offering_key := NULLIF(btrim(COALESCE(v_offering->>'key', format('%s-main', v_level_key))), '');
    IF v_offering_key IS NULL THEN
      v_offering_key := format('%s-main', v_level_key);
    END IF;

    v_offering_branch_code := lower(NULLIF(btrim(COALESCE(v_offering->>'branch_code', v_branch_code)), ''));
    SELECT b.id
      INTO v_offering_branch_id
      FROM public.branches b
     WHERE b.organization_id = p_organization_id
       AND b.code = COALESCE(v_offering_branch_code, v_branch_code)
     LIMIT 1;

    IF v_offering_branch_id IS NULL THEN
      v_offering_branch_id := v_branch_id;
    END IF;

    SELECT so.id
      INTO v_offering_id
      FROM public.service_offerings so
     WHERE so.service_level_id = v_level_id
       AND so.branch_id = v_offering_branch_id
       AND so.zone_id IS NULL
       AND so.metadata #>> ARRAY['onboarding', 'default_key'] = v_offering_key
     LIMIT 1;

    IF v_offering_id IS NULL THEN
      INSERT INTO public.service_offerings (
        service_level_id,
        branch_id,
        zone_id,
        priority,
        is_active,
        metadata
      )
      VALUES (
        v_level_id,
        v_offering_branch_id,
        NULL,
        COALESCE((v_offering->>'priority')::INTEGER, 0),
        COALESCE((v_offering->>'is_active')::BOOLEAN, TRUE),
        jsonb_build_object(
          'display', COALESCE(
            v_offering->'display',
            jsonb_build_object(
              'name', initcap(replace(v_level_key, '_', ' ')),
              'slug', replace(v_level_key, '_', '-'),
              'status', 'active'
            )
          ),
          'base_price', COALESCE(v_offering->'base_price', '0'::jsonb),
          'currency', COALESCE(v_offering->'currency', '"SAR"'::jsonb),
          'max_weight_kg', COALESCE(v_offering->'max_weight_kg', '30'::jsonb),
          'onboarding', jsonb_build_object(
            'auto_provisioned', TRUE,
            'default_key', v_offering_key,
            'trigger_source', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual')
          )
        )
      )
      RETURNING id INTO v_offering_id;
    END IF;

    IF v_offering_id IS NOT NULL THEN
      v_offering_count := v_offering_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'branch_id', v_branch_id,
    'service_levels_created_or_found', v_level_count,
    'service_offerings_created_or_found', v_offering_count
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
  v_catalog_result JSONB := '{}'::jsonb;
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

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'service_catalog_defaults', v_catalog_result,
    'rbac_templates_provisioned', v_provisioned
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.onboarding_service_catalog_defaults_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_service_catalog_defaults_v1(UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_service_catalog_defaults_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_service_catalog_defaults_v1(UUID, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.onboarding_service_catalog_defaults_v1(JSONB) FROM authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_service_catalog_defaults_v1(UUID, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_service_catalog_defaults_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_service_catalog_defaults_v1(UUID, JSONB, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605041930_tenant_onboarding_service_catalog_defaults_v1'));
COMMIT;
