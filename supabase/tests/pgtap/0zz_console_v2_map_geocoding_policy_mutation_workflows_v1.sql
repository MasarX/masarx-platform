-- Test Suite: Console V2 map/geocoding tenant policy mutation workflows.
-- Covers the Network > Geocoding policy controls that apply safe policies
-- directly and route side-effecting address-resolution changes to approval.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

SELECT has_function(
  'api',
  'ui_apply_settings_value_v1',
  ARRAY['text', 'text', 'uuid', 'jsonb', 'text'],
  'api.ui_apply_settings_value_v1 wrapper exists for Console policy applies'
);

SELECT has_function(
  'api',
  'request_settings_change_v1',
  ARRAY['text', 'text', 'uuid', 'jsonb', 'text', 'timestamptz'],
  'api.request_settings_change_v1 wrapper exists for approval-gated policy changes'
);

SELECT has_function(
  'api',
  'resolve_settings_row_from_policy_context_v1',
  ARRAY['text', 'jsonb'],
  'service policy resolver wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_apply_settings_value_v1(text,text,uuid,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_apply_settings_value_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.request_settings_change_v1(text,text,uuid,jsonb,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated can execute api.request_settings_change_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.resolve_settings_row_from_policy_context_v1(text,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute the generic policy resolver'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.settings_category_registry scr
    WHERE scr.category IN ('map_policy', 'address_policy', 'geocoding_policy')
      AND scr.requires_schema
      AND scr.requires_global_default
      AND NOT scr.side_effecting
      AND scr.allowed_scopes ? 'tenant'
  ),
  3,
  'map/address/geocoding policies are tenant-allowed safe apply categories'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry scr
    WHERE scr.category = 'address_resolution_policy'
      AND scr.requires_schema
      AND scr.requires_global_default
      AND scr.side_effecting
      AND scr.allowed_scopes ? 'tenant'
  ),
  'address_resolution_policy is tenant-allowed and approval-gated'
);

CREATE FUNCTION pg_temp.test_map_geocoding_policy_mutation() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_map_result JSONB;
  v_address_result JSONB;
  v_geocoding_result JSONB;
  v_map_version UUID;
  v_address_version UUID;
  v_geocoding_version UUID;
  v_request_version UUID;
  v_request_event UUID;
  v_resolved RECORD;
  v_map_policy JSONB := jsonb_build_object(
    'version', 1,
    'tile_provider', jsonb_build_object(
      'engine', 'maplibre',
      'provider', 'openstreetmap',
      'data_provider', 'openstreetmap',
      'url_template', '/tiles/osm/{z}/{x}/{y}.png',
      'allowed_hosts', jsonb_build_array('localhost', '127.0.0.1', 'tiles.ouikyoqziionthjyllvrvqmh.example.invalid'),
      'usage_tier', 'production_cached',
      'cache_required', true,
      'same_origin_proxy_allowed', true,
      'attribution_label', 'OpenStreetMap contributors',
      'attribution_url', 'https://www.openstreetmap.org/copyright',
      'license', 'ODbL'
    ),
    'default_viewport', jsonb_build_object(
      'minLat', 16,
      'maxLat', 32,
      'minLng', 34,
      'maxLng', 56
    ),
    'logistics_stack', jsonb_build_object(
      'spatial_source_of_truth', 'postgis',
      'routing_engine', 'valhalla',
      'optimization_engine', 'vroom'
    ),
    'provider_overrides', jsonb_build_object(
      'default', 'osm_cached',
      'tenant_override_allowed', true
    )
  );
  v_address_policy JSONB := jsonb_build_object(
    'version', 1,
    'country_default', 'SA',
    'capture_modes', jsonb_build_array('short_national_address', 'coordinates', 'free_text'),
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'address', 'label', 'Address', 'required', true),
      jsonb_build_object('key', 'sa_short_code', 'label', 'Saudi short national address', 'required', false),
      jsonb_build_object('key', 'coordinates', 'label', 'Coordinates', 'required', false)
    ),
    'show_coordinates', true,
    'show_accuracy', true,
    'coordinate_capture', jsonb_build_object(
      'accept_provided', true,
      'validate_bounds_country', 'SA',
      'manual_review_on_out_of_bounds', true
    )
  );
  v_geocoding_policy JSONB := jsonb_build_object(
    'version', 1,
    'provider_priority', '[]'::jsonb,
    'local_lookup', jsonb_build_object(
      'enabled', true,
      'source', 'postgis',
      'allow_provider_fallback', false
    ),
    'coordinate_handling', jsonb_build_object(
      'country_boundary', 'SA',
      'use_provided_coordinates', true,
      'validate_bounds', true
    ),
    'matching_plugins', jsonb_build_array(
      jsonb_build_object('name', 'short_code', 'enabled', true, 'params', jsonb_build_object('country', 'SA', 'code_type', 'sa_short_code')),
      jsonb_build_object('name', 'fuzzy', 'enabled', true, 'params', jsonb_build_object('min_score', 0.81))
    ),
    'provider_agreement_rules', jsonb_build_object('if_disagree', 'manual_review'),
    'metadata', jsonb_build_object(
      'external_provider_default', 'disabled_until_explicitly_configured',
      'provider_strategy', 'postgis_canonical_local_then_manual_review',
      'operator_marker', 'MapGeocodingPolicyPgtap20260530',
      'open_geocoding_stack', jsonb_build_object(
        'map_engine', 'maplibre',
        'map_data', 'openstreetmap',
        'geospatial_source_of_truth', 'postgis',
        'routing_engine', 'valhalla',
        'optimization_engine', 'vroom'
      )
    ),
    'decision_workflow_id', 'workflow_geocoding_standard'
  );
  v_address_resolution_policy JSONB := jsonb_build_object(
    'version', 1,
    'fields', jsonb_build_array(
      jsonb_build_object('name', 'sa_short_code', 'sources', jsonb_build_array('provided_payload', 'short_code_registry', 'manual_review'), 'fallback', 'latest_non_empty'),
      jsonb_build_object('name', 'coordinates', 'sources', jsonb_build_array('provided_payload', 'geocode_cache', 'manual_review'), 'fallback', 'latest_non_empty')
    ),
    'manual_review', jsonb_build_object('enabled', true, 'queue', 'address_resolution_review'),
    'operator_marker', 'AddressResolutionRequestPgtap20260530'
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Map Geocoding Policy Org', 'map-geocoding-policy-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'map-geocoding-policy-' || left(v_user::text, 8) || '@example.com',
    'Map Geocoding Policy User',
    'ops_admin',
    'tenant',
    NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_apply_settings_value_v1(
    'map_policy',
    'tenant',
    v_org,
    v_map_policy,
    'pgTAP Console map policy workflow apply'
  )
    INTO v_map_result;

  SELECT api.ui_apply_settings_value_v1(
    'address_policy',
    'tenant',
    v_org,
    v_address_policy,
    'pgTAP Console Saudi address policy workflow apply'
  )
    INTO v_address_result;

  SELECT api.ui_apply_settings_value_v1(
    'geocoding_policy',
    'tenant',
    v_org,
    v_geocoding_policy,
    'pgTAP Console geocoding policy workflow apply'
  )
    INTO v_geocoding_result;

  v_map_version := (v_map_result->>'settings_version_id')::uuid;
  v_address_version := (v_address_result->>'settings_version_id')::uuid;
  v_geocoding_version := (v_geocoding_result->>'settings_version_id')::uuid;

  RETURN NEXT ok((v_map_result->>'applied')::boolean, 'tenant map_policy apply returns applied=true');
  RETURN NEXT ok((v_address_result->>'applied')::boolean, 'tenant address_policy apply returns applied=true');
  RETURN NEXT ok((v_geocoding_result->>'applied')::boolean, 'tenant geocoding_policy apply returns applied=true');

  SELECT *
    INTO v_resolved
    FROM public.resolve_map_policy(
      jsonb_build_object('organization_id', v_org::text)
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_resolved.settings_version_id = v_map_version
    AND v_resolved.scope_type = 'tenant'
    AND v_resolved.scope_id = v_org
    AND v_resolved.value #>> '{tile_provider,engine}' = 'maplibre'
    AND v_resolved.value #>> '{tile_provider,data_provider}' = 'openstreetmap'
    AND v_resolved.value #>> '{logistics_stack,spatial_source_of_truth}' = 'postgis'
    AND v_resolved.value #>> '{logistics_stack,routing_engine}' = 'valhalla'
    AND v_resolved.value #>> '{logistics_stack,optimization_engine}' = 'vroom',
    'api resolver reads back tenant map_policy with open provider stack'
  );

  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  SELECT *
    INTO v_resolved
    FROM api.resolve_settings_row_from_policy_context_v1(
      'address_policy',
      jsonb_build_object('organization_id', v_org::text)
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_resolved.settings_version_id = v_address_version
    AND v_resolved.scope_type = 'tenant'
    AND v_resolved.value->>'country_default' = 'SA'
    AND COALESCE((v_resolved.value #>> '{coordinate_capture,accept_provided}')::boolean, false)
    AND COALESCE((v_resolved.value #>> '{coordinate_capture,manual_review_on_out_of_bounds}')::boolean, false)
    AND v_resolved.value->'capture_modes' ? 'short_national_address',
    'api resolver reads back tenant address_policy with Saudi short address and coordinates'
  );

  SELECT *
    INTO v_resolved
    FROM api.resolve_settings_row_from_policy_context_v1(
      'geocoding_policy',
      jsonb_build_object('organization_id', v_org::text)
    )
    LIMIT 1;

  RETURN NEXT ok(
    v_resolved.settings_version_id = v_geocoding_version
    AND v_resolved.scope_type = 'tenant'
    AND v_resolved.value #>> '{coordinate_handling,country_boundary}' = 'SA'
    AND v_resolved.value #>> '{provider_agreement_rules,if_disagree}' = 'manual_review'
    AND v_resolved.value #>> '{metadata,provider_strategy}' = 'postgis_canonical_local_then_manual_review'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_resolved.value->'matching_plugins', '[]'::jsonb)) plugin(value)
      WHERE plugin.value->>'name' = 'short_code'
        AND COALESCE((plugin.value->>'enabled')::boolean, false)
        AND plugin.value #>> '{params,code_type}' = 'sa_short_code'
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_resolved.value->'matching_plugins', '[]'::jsonb)) plugin(value)
      WHERE plugin.value->>'name' = 'fuzzy'
        AND COALESCE((plugin.value->>'enabled')::boolean, false)
    ),
    'api resolver reads back tenant geocoding_policy with SA, short_code, fuzzy, and manual review'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT settings_version_id, domain_event_id
    INTO v_request_version, v_request_event
    FROM api.request_settings_change_v1(
      p_category := 'address_resolution_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := v_address_resolution_policy,
      p_change_reason := 'pgTAP Console address resolution policy request',
      p_effective_from := now()
    );

  RETURN NEXT ok(v_request_version IS NOT NULL, 'address_resolution_policy request returns settings_version_id');
  RETURN NEXT ok(v_request_event IS NOT NULL, 'address_resolution_policy request returns domain_event_id');

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings_versions sv
      WHERE sv.id IN (v_map_version, v_address_version, v_geocoding_version)
        AND sv.scope_type = 'tenant'
        AND sv.scope_id = v_org
        AND sv.approved_at IS NOT NULL
        AND sv.effective_until IS NULL
    ),
    3,
    'safe policy applies persist active approved tenant settings_versions'
  );

  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.settings s
      WHERE s.settings_version_id IN (v_map_version, v_address_version, v_geocoding_version)
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org
    ),
    3,
    'safe policy applies refresh tenant settings cache'
  );

  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.domain_events de
      WHERE de.event_type = 'settings_change.applied'
        AND de.resource_type = 'settings_version'
        AND de.resource_id IN (v_map_version, v_address_version, v_geocoding_version)
    ),
    3,
    'safe policy applies emit settings_change.applied events'
  );

  RETURN NEXT is(
    (
      SELECT COUNT(*)::INT
      FROM public.decision_log dl
      WHERE dl.decision_category = 'settings'
        AND dl.resource_type = 'settings_version'
        AND dl.resource_id IN (v_map_version, v_address_version, v_geocoding_version)
        AND dl.decision_point = 'apply'
        AND dl.decision_outcome = 'applied'
        AND dl.performed_by_system = 'ui_apply_settings_value_v1'
    ),
    3,
    'safe policy applies emit decision_log lineage'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings_versions sv
      WHERE sv.id = v_request_version
        AND sv.category = 'address_resolution_policy'
        AND sv.scope_type = 'tenant'
        AND sv.scope_id = v_org
        AND sv.approved_at IS NULL
        AND sv.requested_by = v_user
        AND sv.value->>'operator_marker' = 'AddressResolutionRequestPgtap20260530'
    ),
    'address_resolution_policy request stores pending settings_versions row'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.domain_events de
      WHERE de.id = v_request_event
        AND de.resource_type = 'settings_version'
        AND de.resource_id = v_request_version
        AND de.event_type = 'settings_change.requested'
        AND de.status = 'pending'
    ),
    'address_resolution_policy request emits pending settings_change.requested event'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'address_resolution_policy'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org
        AND s.settings_version_id = v_request_version
    ),
    'address_resolution_policy request does not replace active settings cache before approval'
  );
END;
$$;
SELECT * FROM pg_temp.test_map_geocoding_policy_mutation();

SELECT * FROM finish();
ROLLBACK;
