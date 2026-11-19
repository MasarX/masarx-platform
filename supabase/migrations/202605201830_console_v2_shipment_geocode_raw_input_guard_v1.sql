-- Migration: Console V2 shipment geocode raw-input guard
-- Purpose:
--   Keep operator-triggered shipment geocode refreshes backend-backed and
--   fail-closed: plain-text addresses.raw_input must not crash local lookup,
--   and nested geocode workflow failures must propagate to the Console action.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605201830_console_v2_shipment_geocode_raw_input_guard_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_geo_local_lookup_v1_raw_input_guard_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
             RENAME TO execute_geo_local_lookup_v1_raw_input_guard_base';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_plain_raw_input_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_started_at TIMESTAMPTZ := clock_timestamp();
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_local_cfg JSONB := COALESCE(v_policy->'local_lookup', '{}'::jsonb);
  v_min_conf NUMERIC := COALESCE(NULLIF(v_local_cfg->>'min_confidence', '')::NUMERIC, 0.6);
  v_ctx RECORD;
  v_address RECORD;
  v_city RECORD;
  v_district RECORD;
  v_city_text TEXT;
  v_district_text TEXT;
  v_country_text TEXT;
  v_province_text TEXT;
  v_confidence NUMERIC := 0;
  v_centroid GEOGRAPHY;
  v_geocode JSONB;
  v_match JSONB;
  v_response public.workflow_handler_response;
  v_attempt_id UUID;
BEGIN
  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.address_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'matched', FALSE,
      'reason', 'address_missing'
    );
    RETURN v_response;
  END IF;

  SELECT
      a.city,
      a.district,
      a.province,
      a.country,
      a.normalized_line1,
      a.normalized_line2
    INTO v_address
    FROM public.addresses a
   WHERE a.id = v_ctx.address_id
   LIMIT 1;

  SELECT
      NULL::uuid AS id,
      NULL::text AS name_canonical,
      NULL::text AS name_arabic,
      NULL::geography AS centroid,
      NULL::bigint AS source_city_id,
      NULL::text AS province,
      NULL::text AS region_code,
      NULL::timestamptz AS updated_at,
      NULL::numeric AS score,
      FALSE AS exact_match
    INTO v_city;

  SELECT
      NULL::uuid AS id,
      NULL::text AS name_canonical,
      NULL::text AS name_arabic,
      NULL::geography AS centroid,
      NULL::bigint AS source_district_id,
      NULL::timestamptz AS updated_at,
      NULL::numeric AS score
    INTO v_district;

  v_city_text := NULLIF(v_address.city, '');
  v_district_text := NULLIF(v_address.district, '');
  v_country_text := COALESCE(NULLIF(v_address.country, ''), 'SA');
  v_province_text := NULLIF(v_address.province, '');

  IF v_city_text IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'matched', FALSE,
      'reason', 'city_missing',
      'raw_input_parse_guard', TRUE
    );
    RETURN v_response;
  END IF;

  WITH city_matches AS (
    SELECT
      c.id,
      c.name_canonical,
      c.name_arabic,
      c.centroid,
      c.source_city_id,
      c.province,
      c.updated_at,
      GREATEST(
        similarity(lower(c.name_canonical), lower(v_city_text)),
        similarity(lower(COALESCE(c.name_arabic, '')), lower(v_city_text)),
        COALESCE((
          SELECT MAX(similarity(lower(an), lower(v_city_text)))
          FROM unnest(COALESCE(c.alternate_names, ARRAY[]::text[])) AS an
        ), 0)
      ) AS score,
      (
        lower(c.name_canonical) = lower(v_city_text)
        OR lower(COALESCE(c.name_arabic, '')) = lower(v_city_text)
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(c.alternate_names, ARRAY[]::text[])) AS an
          WHERE lower(an) = lower(v_city_text)
        )
      ) AS exact_match
    FROM public.canonical_cities c
    WHERE c.organization_id = v_ctx.organization_id
      AND c.is_active = TRUE
      AND c.centroid IS NOT NULL
      AND (v_country_text IS NULL OR lower(c.country_code) = lower(v_country_text))
      AND (
        v_province_text IS NULL
        OR lower(c.province) = lower(v_province_text)
        OR lower(COALESCE(c.region_code, '')) = lower(v_province_text)
      )
  )
  SELECT *
    INTO v_city
    FROM city_matches
   ORDER BY exact_match DESC, score DESC, updated_at DESC
   LIMIT 1;

  IF NOT FOUND OR v_city.score IS NULL OR v_city.score < v_min_conf THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'matched', FALSE,
      'reason', 'city_match_below_threshold',
      'score', v_city.score,
      'raw_input_parse_guard', TRUE
    );
    RETURN v_response;
  END IF;

  IF v_district_text IS NOT NULL THEN
    WITH district_matches AS (
      SELECT
        d.id,
        d.name_canonical,
        d.name_arabic,
        d.centroid,
        d.source_district_id,
        d.updated_at,
        GREATEST(
          similarity(lower(d.name_canonical), lower(v_district_text)),
          similarity(lower(COALESCE(d.name_arabic, '')), lower(v_district_text)),
          COALESCE((
            SELECT MAX(similarity(lower(an), lower(v_district_text)))
            FROM unnest(COALESCE(d.alternate_names, ARRAY[]::text[])) AS an
          ), 0)
        ) AS score
      FROM public.canonical_districts d
      WHERE d.city_id = v_city.id
        AND d.is_active = TRUE
    )
    SELECT *
      INTO v_district
      FROM district_matches
     ORDER BY score DESC, updated_at DESC
     LIMIT 1;
  END IF;

  v_confidence := LEAST(GREATEST(COALESCE(v_district.score, v_city.score, 0), 0), 1);
  v_centroid := COALESCE(v_district.centroid, v_city.centroid);

  IF v_centroid IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'matched', FALSE,
      'reason', 'centroid_missing',
      'raw_input_parse_guard', TRUE
    );
    RETURN v_response;
  END IF;

  v_geocode := jsonb_strip_nulls(jsonb_build_object(
    'provider_name', 'canonical_lookup',
    'is_primary', TRUE,
    'confidence_score', v_confidence,
    'accuracy_type', 'canonical_centroid',
    'coordinates', jsonb_build_object(
      'latitude', ST_Y(v_centroid::geometry),
      'longitude', ST_X(v_centroid::geometry)
    ),
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'city_id', v_city.id,
      'source_city_id', v_city.source_city_id,
      'district_id', v_district.id,
      'source_district_id', v_district.source_district_id,
      'city_match', v_city.name_canonical,
      'district_match', v_district.name_canonical,
      'city_score', v_city.score,
      'district_score', v_district.score,
      'country', v_country_text,
      'province', v_province_text,
      'match_plugin', 'plain_raw_input_guard',
      'match_type', CASE WHEN v_district.id IS NOT NULL THEN 'district_match' ELSE 'city_match' END,
      'routing_reason', 'plain_raw_input_normalized_columns'
    ))
  ));

  INSERT INTO public.geocoding_attempts (
    organization_id,
    client_id,
    sender_id,
    address_id,
    workflow_run_step_id,
    provider_name,
    attempt_order,
    attempt_type,
    status,
    confidence,
    duration_ms,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_ctx.organization_id,
    v_ctx.client_id,
    v_ctx.sender_id,
    v_ctx.address_id,
    p_step.id,
    'canonical_lookup',
    1,
    'local',
    'succeeded',
    v_confidence,
    GREATEST(0, floor(extract(epoch from clock_timestamp() - v_started_at) * 1000)::int),
    jsonb_build_object(
      'geocode', v_geocode,
      'match_source', 'canonical_lookup',
      'match_plugin', 'plain_raw_input_guard',
      'match_type', CASE WHEN v_district.id IS NOT NULL THEN 'district_match' ELSE 'city_match' END,
      'routing_reason', 'plain_raw_input_normalized_columns'
    ),
    now(),
    now()
  )
  RETURNING id INTO v_attempt_id;

  v_match := jsonb_build_object(
    'plugin', 'plain_raw_input_guard',
    'match_type', CASE WHEN v_district.id IS NOT NULL THEN 'district_match' ELSE 'city_match' END,
    'score', v_confidence,
    'routing_reason', 'plain_raw_input_normalized_columns',
    'attempt_id', v_attempt_id
  );
  PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

  v_response.status := 'completed';
  v_response.operation_result := jsonb_build_object(
    'matched', TRUE,
    'attempt_id', v_attempt_id,
    'confidence', v_confidence,
    'raw_input_parse_guard', TRUE
  );
  v_response.context_patch := jsonb_build_object(
    'geocoding',
    jsonb_strip_nulls(jsonb_build_object(
      'local_match', TRUE,
      'selected_geocode', v_geocode,
      'manual_review_required', FALSE,
      'successful', TRUE,
      'require_fallback', FALSE,
      'match_plugin', 'plain_raw_input_guard',
      'match_type', CASE WHEN v_district.id IS NOT NULL THEN 'district_match' ELSE 'city_match' END,
      'geocoding_match', v_match
    ))
  );
  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_plain_raw_input_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_local_lookup_plain_raw_input_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Fallback local geocode lookup for addresses whose raw_input text is not JSON; resolves from normalized address columns and row-driven geocoding policy.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_response public.workflow_handler_response;
BEGIN
  RETURN workflow_handlers.execute_geo_local_lookup_v1_raw_input_guard_base(
    p_step,
    p_run,
    p_operation_result
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    IF SQLERRM NOT ILIKE '%json%' THEN
      RAISE;
    END IF;

    RETURN workflow_handlers.execute_geo_local_lookup_plain_raw_input_v1(
      p_step,
      p_run,
      p_operation_result
    );
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_local_lookup_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Console V2 raw-input guard: delegates to the canonical local lookup handler and falls back to normalized address columns when addresses.raw_input is plain text instead of JSON.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address_id UUID := NULL;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_nested_context JSONB := '{}'::jsonb;
  v_nested_progress JSONB := '{}'::jsonb;
  v_nested_status TEXT := NULL;
  v_nested_last_error JSONB := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_nested_idempotency_key TEXT := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;

  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;

  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;

  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_nested_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_ctx->>'geocode_idempotency_key', '')), ''),
    format('shipment-update-geocode:nested:%s:%s', p_run.id, v_address_id)
  );

  v_nested_context := jsonb_strip_nulls(jsonb_build_object(
    'idempotency_key', v_nested_idempotency_key,
    'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
    'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
    'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
    'shipment_id', v_target.shipment_id,
    'destination_address_id', v_address_id,
    'address_id', v_address_id,
    'actor_user_id', NULLIF(v_ctx->>'actor_user_id', ''),
    'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode'),
    'trigger_source', 'manual',
    'parent_workflow_run_id', p_run.id,
    'parent_workflow_step_id', p_step.id
  ));

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_nested_context);

  v_nested_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_target.shipment_id,
      'client_id', v_target.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode')
    )),
    2500,
    20
  );

  SELECT wr.workflow_status, wr.last_error
    INTO v_nested_status, v_nested_last_error
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id;

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id,
        'workflow_status', v_nested_status,
        'workflow_last_error', v_nested_last_error,
        'nested_idempotency_key', v_nested_idempotency_key
      )),
      NULL::TEXT,
      NULL::TEXT,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL::UUID,
      NULL::timestamptz
    );
  END IF;

  IF lower(COALESCE(v_nested_status, '')) IN ('failed', 'cancelled', 'blocked') THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(
      NULLIF(v_nested_progress->>'error', ''),
      NULLIF(v_nested_last_error->>'error', ''),
      'nested_geocode_workflow_' || lower(COALESCE(v_nested_status, 'failed'))
    );
  ELSE
    v_result.status := 'completed';
  END IF;

  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'geocode_workflow_status', v_nested_status,
    'geocode_workflow_last_error', v_nested_last_error,
    'geocode_progress', v_nested_progress,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Starts a fresh nested geocoding workflow for each operator shipment geocode refresh, progresses it inline, records geocode_request lineage, and propagates terminal nested failures to Console.';

SELECT pg_advisory_unlock(hashtext('202605201830_console_v2_shipment_geocode_raw_input_guard_v1'));
COMMIT;
