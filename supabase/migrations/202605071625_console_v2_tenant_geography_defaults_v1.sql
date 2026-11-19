-- Console V2 first-tenant readiness: tenant-owned geography defaults.
-- Keeps zones/geocoding usable immediately after tenant approval while staying
-- row-driven through saas_onboarding_policy.geography_defaults.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.onboarding_geography_defaults_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_defaults JSONB := COALESCE(p_policy #> '{geography_defaults}', '{}'::jsonb);
BEGIN
  IF COALESCE((v_defaults->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN jsonb_build_object('enabled', FALSE, 'cities', '[]'::jsonb);
  END IF;

  IF jsonb_typeof(COALESCE(v_defaults->'cities', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'onboarding_geography_defaults_v1: geography_defaults.cities must be an array'
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'enabled', TRUE,
    'cities', COALESCE(v_defaults->'cities', '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_geography_defaults_v1(
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
  v_defaults JSONB := public.onboarding_geography_defaults_v1(p_policy);
  v_cities JSONB := COALESCE(v_defaults->'cities', '[]'::jsonb);
  v_city JSONB;
  v_district JSONB;
  v_city_id UUID;
  v_city_name TEXT;
  v_city_source TEXT;
  v_country_code TEXT;
  v_city_alt_names TEXT[];
  v_district_name TEXT;
  v_district_source TEXT;
  v_district_alt_names TEXT[];
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_cities_count INT := 0;
  v_districts_count INT := 0;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_geography_defaults_v1: organization_id is required'
      USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_tenant_geography_defaults_v1: organization % not found', p_organization_id
      USING ERRCODE = '23503';
  END IF;

  IF COALESCE((v_defaults->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'cities_created_or_found', 0,
      'districts_created_or_found', 0
    );
  END IF;

  FOR v_city IN SELECT value FROM jsonb_array_elements(v_cities)
  LOOP
    v_city_name := NULLIF(btrim(COALESCE(v_city->>'name_canonical', '')), '');
    v_city_source := NULLIF(btrim(COALESCE(v_city->>'source', '')), '');
    v_country_code := NULLIF(btrim(COALESCE(v_city->>'country_code', '')), '');

    IF v_city_name IS NULL OR v_city_source IS NULL OR v_country_code IS NULL THEN
      RAISE EXCEPTION 'bootstrap_tenant_geography_defaults_v1: city rows require name_canonical, source, and country_code'
        USING ERRCODE = '23502';
    END IF;

    SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
      INTO v_city_alt_names
      FROM jsonb_array_elements_text(COALESCE(v_city->'alternate_names', '[]'::jsonb));

    v_lat := NULLIF(v_city->>'lat', '')::DOUBLE PRECISION;
    v_lng := NULLIF(v_city->>'lng', '')::DOUBLE PRECISION;

    INSERT INTO public.canonical_cities (
      organization_id,
      name_canonical,
      name_arabic,
      alternate_names,
      province,
      country_code,
      source,
      metadata,
      centroid,
      is_active
    )
    VALUES (
      p_organization_id,
      v_city_name,
      NULLIF(btrim(COALESCE(v_city->>'name_arabic', '')), ''),
      v_city_alt_names,
      NULLIF(btrim(COALESCE(v_city->>'province', '')), ''),
      v_country_code,
      v_city_source,
      jsonb_strip_nulls(
        COALESCE(v_city->'metadata', '{}'::jsonb)
        || jsonb_build_object('onboarding_trigger_source', p_trigger_source)
      ),
      CASE
        WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography
        ELSE NULL
      END,
      TRUE
    )
    ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL DO UPDATE
       SET name_arabic = COALESCE(EXCLUDED.name_arabic, public.canonical_cities.name_arabic),
           alternate_names = COALESCE(EXCLUDED.alternate_names, public.canonical_cities.alternate_names),
           province = COALESCE(EXCLUDED.province, public.canonical_cities.province),
           country_code = EXCLUDED.country_code,
           source = EXCLUDED.source,
           metadata = COALESCE(public.canonical_cities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           centroid = COALESCE(EXCLUDED.centroid, public.canonical_cities.centroid),
           is_active = TRUE,
           updated_at = now()
    RETURNING id INTO v_city_id;

    v_cities_count := v_cities_count + 1;

    IF jsonb_typeof(COALESCE(v_city->'districts', '[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'bootstrap_tenant_geography_defaults_v1: city.districts must be an array'
        USING ERRCODE = '22023';
    END IF;

    FOR v_district IN SELECT value FROM jsonb_array_elements(COALESCE(v_city->'districts', '[]'::jsonb))
    LOOP
      v_district_name := NULLIF(btrim(COALESCE(v_district->>'name_canonical', '')), '');
      v_district_source := NULLIF(btrim(COALESCE(v_district->>'source', v_city_source, '')), '');

      IF v_district_name IS NULL OR v_district_source IS NULL THEN
        RAISE EXCEPTION 'bootstrap_tenant_geography_defaults_v1: district rows require name_canonical and source'
          USING ERRCODE = '23502';
      END IF;

      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_district_alt_names
        FROM jsonb_array_elements_text(COALESCE(v_district->'alternate_names', '[]'::jsonb));

      v_lat := NULLIF(v_district->>'lat', '')::DOUBLE PRECISION;
      v_lng := NULLIF(v_district->>'lng', '')::DOUBLE PRECISION;

      INSERT INTO public.canonical_districts (
        organization_id,
        city_id,
        name_canonical,
        name_arabic,
        alternate_names,
        source,
        metadata,
        centroid,
        centroid_lat,
        centroid_lng,
        is_active
      )
      VALUES (
        p_organization_id,
        v_city_id,
        v_district_name,
        NULLIF(btrim(COALESCE(v_district->>'name_arabic', '')), ''),
        v_district_alt_names,
        v_district_source,
        jsonb_strip_nulls(
          COALESCE(v_district->'metadata', '{}'::jsonb)
          || jsonb_build_object('onboarding_trigger_source', p_trigger_source)
        ),
        CASE
          WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
          THEN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography
          ELSE NULL
        END,
        v_lat,
        v_lng,
        TRUE
      )
      ON CONFLICT (organization_id, city_id, name_canonical) WHERE source_district_id IS NULL DO UPDATE
         SET name_arabic = COALESCE(EXCLUDED.name_arabic, public.canonical_districts.name_arabic),
             alternate_names = COALESCE(EXCLUDED.alternate_names, public.canonical_districts.alternate_names),
             source = EXCLUDED.source,
             metadata = COALESCE(public.canonical_districts.metadata, '{}'::jsonb) || EXCLUDED.metadata,
             centroid = COALESCE(EXCLUDED.centroid, public.canonical_districts.centroid),
             centroid_lat = COALESCE(EXCLUDED.centroid_lat, public.canonical_districts.centroid_lat),
             centroid_lng = COALESCE(EXCLUDED.centroid_lng, public.canonical_districts.centroid_lng),
             is_active = TRUE,
             updated_at = now();

      v_districts_count := v_districts_count + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'cities_created_or_found', v_cities_count,
    'districts_created_or_found', v_districts_count
  );
END;
$function$;

DO $do$
DECLARE
  v_root_scope TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB;
  v_geography JSONB := jsonb_build_object(
    'enabled', TRUE,
    'cities', jsonb_build_array(
      jsonb_build_object(
        'name_canonical', 'Riyadh',
        'alternate_names', jsonb_build_array('Riyad', 'Riyadh City'),
        'province', 'Riyadh Province',
        'country_code', 'SA',
        'source', 'ops_verified',
        'lat', 24.7136,
        'lng', 46.6753,
        'districts', jsonb_build_array(
          jsonb_build_object(
            'name_canonical', 'Olaya',
            'alternate_names', jsonb_build_array('Al Olaya', 'Al-Olaya'),
            'source', 'ops_verified',
            'lat', 24.7130,
            'lng', 46.6766
          ),
          jsonb_build_object(
            'name_canonical', 'Sulaymaniyah',
            'alternate_names', jsonb_build_array('Al Sulaymaniyah', 'Sulaimaniyah'),
            'source', 'ops_verified',
            'lat', 24.7041,
            'lng', 46.7002
          ),
          jsonb_build_object(
            'name_canonical', 'Malqa',
            'alternate_names', jsonb_build_array('Al Malqa', 'Al-Malqa'),
            'source', 'ops_verified',
            'lat', 24.8020,
            'lng', 46.6170
          )
        )
      )
    )
  );
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = v_root_scope
     AND s.scope_id IS NULL
   ORDER BY s.last_updated DESC NULLS LAST, s.updated_at DESC NULLS LAST
   LIMIT 1;

  v_current := COALESCE(v_current, public.resolve_saas_onboarding_policy_v1(), '{}'::jsonb);

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope,
    NULL,
    jsonb_set(v_current, '{geography_defaults}', v_geography, TRUE),
    1,
    'add tenant geography defaults for Console V2 first-tenant onboarding'
  );
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
  v_provider_result JSONB := '{}'::jsonb;
  v_geography_result JSONB := '{}'::jsonb;
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
  v_geography_result := public.bootstrap_tenant_geography_defaults_v1(p_organization_id, v_policy, p_trigger_source);

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
    'geography_defaults', v_geography_result,
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
    PERFORM public.bootstrap_tenant_geography_defaults_v1(
      v_org.id,
      v_policy,
      'migration-backfill'
    );
  END LOOP;
END;
$do$;

REVOKE ALL ON FUNCTION public.onboarding_geography_defaults_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_geography_defaults_v1(UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_geography_defaults_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_geography_defaults_v1(UUID, JSONB, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_geography_defaults_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_geography_defaults_v1(UUID, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_onboarding_v1(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.onboarding_geography_defaults_v1(JSONB) IS
  'Returns row-driven geography defaults from saas_onboarding_policy.geography_defaults.';
COMMENT ON FUNCTION public.bootstrap_tenant_geography_defaults_v1(UUID, JSONB, TEXT) IS
  'Materializes tenant-owned canonical cities and districts for first-tenant Console V2 onboarding.';

COMMIT;
