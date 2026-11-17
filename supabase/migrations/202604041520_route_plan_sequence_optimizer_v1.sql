-- Migration: Route plan sequence optimizer v1
-- Purpose:
--   - Add the canonical route-plan solve/sequence optimization contract for UC072.
--   - Keep sequencing solver-agnostic, settings-driven, and route_plan SSOT-first.
--   - Expose browser-safe UI/API wrappers and a dedicated UI command RPC.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604041520_route_plan_sequence_optimizer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------
-- 1) Row-driven route-planning policy
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_default_policy_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', true,
    'deadline_hard_sort', true,
    'priority_paths', jsonb_build_array(
      'priority_score',
      'metadata.priority_score',
      'metadata.priority.score'
    ),
    'window_start_paths', jsonb_build_array(
      'planned_window_start_at',
      'metadata.planned_window_start_at',
      'metadata.promised_window_start_at'
    ),
    'window_end_paths', jsonb_build_array(
      'planned_window_end_at',
      'metadata.planned_window_end_at',
      'metadata.promised_window_end_at'
    ),
    'travel_minutes_paths', jsonb_build_array(
      'metadata.route.travel_minutes',
      'metadata.travel_minutes',
      'travel_minutes'
    ),
    'traffic_delay_minutes_paths', jsonb_build_array(
      'metadata.route.traffic_delay_minutes',
      'metadata.traffic_delay_minutes',
      'traffic_delay_minutes'
    ),
    'service_minutes_paths', jsonb_build_array(
      'metadata.route.service_minutes',
      'metadata.service_minutes',
      'service_minutes'
    ),
    'weights', jsonb_build_object(
      'window', 3,
      'priority', 4,
      'travel', 2,
      'traffic_delay', 2,
      'service', 1
    )
  );
$function$;

COMMENT ON FUNCTION public.route_plan_default_policy_v1()
  IS 'Canonical default route planning policy for deterministic stop sequencing.';

REVOKE ALL ON FUNCTION public.route_plan_default_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_default_policy_v1() FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_default_policy_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_default_policy_v1() TO service_role;

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
SELECT
  'route_planning_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Route Planning Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "deadline_hard_sort": { "type": ["boolean", "null"] },
      "priority_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "window_start_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "window_end_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "travel_minutes_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "traffic_delay_minutes_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "service_minutes_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "weights": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "window": { "type": ["number", "null"], "minimum": 0 },
          "priority": { "type": ["number", "null"], "minimum": 0 },
          "travel": { "type": ["number", "null"], "minimum": 0 },
          "traffic_delay": { "type": ["number", "null"], "minimum": 0 },
          "service": { "type": ["number", "null"], "minimum": 0 }
        }
      }
    }
  }'::jsonb,
  'Deterministic sequencing policy for route_plans; resolves through the settings ladder before freeze/apply.',
  jsonb_build_array(public.route_plan_default_policy_v1()),
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM public.schema_registry sr
  WHERE sr.category = 'route_planning_policy'
    AND sr.version = 1
);

WITH default_policy AS (
  SELECT public.route_plan_default_policy_v1() AS value
)
INSERT INTO public.settings_versions (
  category,
  scope_type,
  scope_id,
  schema_version,
  value,
  version,
  created_at
)
SELECT
  'route_planning_policy',
  'global',
  NULL,
  1,
  dp.value,
  1,
  now()
FROM default_policy dp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = 'route_planning_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
    AND sv.version = 1
);

INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  sv.category,
  sv.scope_type,
  sv.scope_id,
  sv.id,
  sv.value,
  now()
FROM public.settings_versions sv
WHERE sv.category = 'route_planning_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = sv.category
      AND s.scope_type = sv.scope_type
      AND s.scope_id IS NULL
  );

-------------------------------------------------------------
-- 2) JSON path extraction helpers for stop sequencing
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_first_path_value_v1(
  p_doc JSONB,
  p_paths TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_path TEXT;
  v_value JSONB := NULL;
BEGIN
  IF p_doc IS NULL OR p_paths IS NULL OR array_length(p_paths, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  FOREACH v_path IN ARRAY p_paths LOOP
    IF NULLIF(btrim(COALESCE(v_path, '')), '') IS NULL THEN
      CONTINUE;
    END IF;

    v_value := public.jsonb_resolve_path(p_doc, v_path);
    IF v_value IS NOT NULL AND jsonb_typeof(v_value) IS DISTINCT FROM 'null' THEN
      RETURN v_value;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.route_plan_first_path_numeric_v1(
  p_doc JSONB,
  p_paths TEXT[]
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := public.route_plan_first_path_value_v1(p_doc, p_paths);
  v_text TEXT := NULL;
BEGIN
  IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
    RETURN NULL;
  END IF;

  v_text := NULLIF(btrim(trim(both '"' FROM v_value::text)), '');
  IF v_text IS NULL OR lower(v_text) = 'null' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_text::numeric;
  EXCEPTION
    WHEN others THEN
      RETURN NULL;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.route_plan_first_path_timestamptz_v1(
  p_doc JSONB,
  p_paths TEXT[]
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := public.route_plan_first_path_value_v1(p_doc, p_paths);
  v_text TEXT := NULL;
BEGIN
  IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
    RETURN NULL;
  END IF;

  v_text := NULLIF(btrim(trim(both '"' FROM v_value::text)), '');
  IF v_text IS NULL OR lower(v_text) = 'null' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_text::timestamptz;
  EXCEPTION
    WHEN others THEN
      RETURN NULL;
  END;
END;
$function$;

COMMENT ON FUNCTION public.route_plan_first_path_value_v1(JSONB, TEXT[])
  IS 'Resolve the first non-null JSONB value from a list of dot-paths inside a stop payload.';
COMMENT ON FUNCTION public.route_plan_first_path_numeric_v1(JSONB, TEXT[])
  IS 'Resolve the first numeric value from a list of dot-paths inside a stop payload.';
COMMENT ON FUNCTION public.route_plan_first_path_timestamptz_v1(JSONB, TEXT[])
  IS 'Resolve the first timestamptz value from a list of dot-paths inside a stop payload.';

REVOKE ALL ON FUNCTION public.route_plan_first_path_value_v1(JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_first_path_value_v1(JSONB, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_first_path_value_v1(JSONB, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_first_path_value_v1(JSONB, TEXT[]) TO service_role;

REVOKE ALL ON FUNCTION public.route_plan_first_path_numeric_v1(JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_first_path_numeric_v1(JSONB, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_first_path_numeric_v1(JSONB, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_first_path_numeric_v1(JSONB, TEXT[]) TO service_role;

REVOKE ALL ON FUNCTION public.route_plan_first_path_timestamptz_v1(JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_first_path_timestamptz_v1(JSONB, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_first_path_timestamptz_v1(JSONB, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_first_path_timestamptz_v1(JSONB, TEXT[]) TO service_role;

-------------------------------------------------------------
-- 3) Canonical solve/sequence optimization service RPC
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.solve_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  stop_count INT,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_reference_at TIMESTAMPTZ := NULL;
  v_plan public.route_plans%ROWTYPE;
  v_from_status TEXT := NULL;
  v_policy_row RECORD;
  v_policy JSONB := public.route_plan_default_policy_v1();
  v_policy_ctx JSONB := '{}'::jsonb;
  v_stops JSONB := '[]'::jsonb;
  v_solved_stops JSONB := '[]'::jsonb;
  v_solution JSONB := '{}'::jsonb;
  v_stop_hash TEXT := NULL;
  v_priority_paths TEXT[] := ARRAY[
    'priority_score',
    'metadata.priority_score',
    'metadata.priority.score'
  ];
  v_window_start_paths TEXT[] := ARRAY[
    'planned_window_start_at',
    'metadata.planned_window_start_at',
    'metadata.promised_window_start_at'
  ];
  v_window_end_paths TEXT[] := ARRAY[
    'planned_window_end_at',
    'metadata.planned_window_end_at',
    'metadata.promised_window_end_at'
  ];
  v_travel_paths TEXT[] := ARRAY[
    'metadata.route.travel_minutes',
    'metadata.travel_minutes',
    'travel_minutes'
  ];
  v_traffic_paths TEXT[] := ARRAY[
    'metadata.route.traffic_delay_minutes',
    'metadata.traffic_delay_minutes',
    'traffic_delay_minutes'
  ];
  v_service_paths TEXT[] := ARRAY[
    'metadata.route.service_minutes',
    'metadata.service_minutes',
    'service_minutes'
  ];
  v_weight_window NUMERIC := 3;
  v_weight_priority NUMERIC := 4;
  v_weight_travel NUMERIC := 2;
  v_weight_traffic NUMERIC := 2;
  v_weight_service NUMERIC := 1;
  v_deadline_hard_sort BOOLEAN := TRUE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'solve_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_reference_at := NULLIF(v_input->>'reference_at', '')::timestamptz; EXCEPTION WHEN others THEN v_reference_at := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'solve_route_plan_v1 missing route_plan_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   FOR UPDATE;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'solve_route_plan_v1 route_plan % not found', v_route_plan_id
      USING ERRCODE = '23503';
  END IF;

  v_from_status := COALESCE(v_plan.status, 'created');
  IF v_from_status NOT IN ('created', 'submitted', 'solved') THEN
    RAISE EXCEPTION 'solve_route_plan_v1 requires route_plan % in created/submitted/solved state (got %)', v_route_plan_id, v_from_status
      USING ERRCODE = '23514';
  END IF;

  IF v_reference_at IS NULL THEN
    BEGIN
      v_reference_at := NULLIF(
        COALESCE(
          v_plan.solution#>>'{optimizer,reference_at}',
          v_plan.metadata#>>'{builder,planned_reference_at}',
          v_plan.metadata->>'reference_at',
          ''
        ),
        ''
      )::timestamptz;
    EXCEPTION
      WHEN others THEN
        v_reference_at := NULL;
    END;
  END IF;

  IF v_reference_at IS NULL THEN
    v_reference_at := COALESCE(v_plan.planned_date::timestamptz, now());
  END IF;

  v_policy_ctx := jsonb_build_object('organization_id', v_plan.organization_id);

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('route_planning_policy', v_policy_ctx)
   LIMIT 1;

  IF v_policy_row.settings_id IS NULL OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'solve_route_plan_v1 missing route_planning_policy for organization %', v_plan.organization_id
      USING ERRCODE = '23514';
  END IF;

  v_policy := public.deep_merge_jsonb(
    public.route_plan_default_policy_v1(),
    COALESCE(v_policy_row.value, '{}'::jsonb)
  );

  BEGIN
    v_deadline_hard_sort := COALESCE((v_policy->>'deadline_hard_sort')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_deadline_hard_sort := TRUE;
  END;

  BEGIN
    v_weight_window := GREATEST(COALESCE((v_policy#>>'{weights,window}')::NUMERIC, 3), 0);
  EXCEPTION
    WHEN others THEN
      v_weight_window := 3;
  END;
  BEGIN
    v_weight_priority := GREATEST(COALESCE((v_policy#>>'{weights,priority}')::NUMERIC, 4), 0);
  EXCEPTION
    WHEN others THEN
      v_weight_priority := 4;
  END;
  BEGIN
    v_weight_travel := GREATEST(COALESCE((v_policy#>>'{weights,travel}')::NUMERIC, 2), 0);
  EXCEPTION
    WHEN others THEN
      v_weight_travel := 2;
  END;
  BEGIN
    v_weight_traffic := GREATEST(COALESCE((v_policy#>>'{weights,traffic_delay}')::NUMERIC, 2), 0);
  EXCEPTION
    WHEN others THEN
      v_weight_traffic := 2;
  END;
  BEGIN
    v_weight_service := GREATEST(COALESCE((v_policy#>>'{weights,service}')::NUMERIC, 1), 0);
  EXCEPTION
    WHEN others THEN
      v_weight_service := 1;
  END;

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_priority_paths
         )
    INTO v_priority_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'priority_paths', 'null'::jsonb)) = 'array' THEN v_policy->'priority_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_window_start_paths
         )
    INTO v_window_start_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'window_start_paths', 'null'::jsonb)) = 'array' THEN v_policy->'window_start_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_window_end_paths
         )
    INTO v_window_end_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'window_end_paths', 'null'::jsonb)) = 'array' THEN v_policy->'window_end_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_travel_paths
         )
    INTO v_travel_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'travel_minutes_paths', 'null'::jsonb)) = 'array' THEN v_policy->'travel_minutes_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_traffic_paths
         )
    INTO v_traffic_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'traffic_delay_minutes_paths', 'null'::jsonb)) = 'array' THEN v_policy->'traffic_delay_minutes_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_service_paths
         )
    INTO v_service_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'service_minutes_paths', 'null'::jsonb)) = 'array' THEN v_policy->'service_minutes_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' OR jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'solve_route_plan_v1 requires at least one stop on route_plan %', v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  v_stop_hash := md5(COALESCE(v_stops::text, '[]') || '|' || COALESCE(v_policy::text, '{}'));
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:solve:%s', v_route_plan_id, v_stop_hash)
  );

  settings_resolution_id := public.log_settings_resolution(
    p_organization_id := v_plan.organization_id,
    p_category := 'route_planning_policy',
    p_winning_scope_type := COALESCE(v_policy_row.scope_type, 'global'),
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := COALESCE(v_policy_row.version, 1),
    p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'route_plan_id', v_route_plan_id,
      'reference_at', v_reference_at,
      'status', v_from_status
    )),
    p_merge_notes := jsonb_build_object('resolved_from_context', v_policy_ctx)
  );

  WITH raw_stops AS (
    SELECT
      stop.value AS stop_value,
      stop.ordinality::INT AS original_sequence,
      public.route_plan_first_path_numeric_v1(stop.value, v_priority_paths) AS priority_score,
      public.route_plan_first_path_timestamptz_v1(stop.value, v_window_start_paths) AS window_start_at,
      public.route_plan_first_path_timestamptz_v1(stop.value, v_window_end_paths) AS window_end_at,
      public.route_plan_first_path_numeric_v1(stop.value, v_travel_paths) AS travel_minutes,
      public.route_plan_first_path_numeric_v1(stop.value, v_traffic_paths) AS traffic_delay_minutes,
      public.route_plan_first_path_numeric_v1(stop.value, v_service_paths) AS service_minutes
    FROM jsonb_array_elements(v_stops) WITH ORDINALITY AS stop(value, ordinality)
  ),
  scored AS (
    SELECT
      rs.*,
      COALESCE(rs.window_start_at, rs.window_end_at) AS deadline_at,
      CASE
        WHEN COALESCE(rs.window_start_at, rs.window_end_at) IS NULL THEN 1000000::NUMERIC
        ELSE GREATEST(
          EXTRACT(EPOCH FROM (COALESCE(rs.window_start_at, rs.window_end_at) - v_reference_at)) / 60.0,
          0
        )::NUMERIC
      END AS deadline_minutes,
      (
        CASE
          WHEN COALESCE(rs.window_start_at, rs.window_end_at) IS NULL THEN 1000000::NUMERIC
          ELSE GREATEST(
            EXTRACT(EPOCH FROM (COALESCE(rs.window_start_at, rs.window_end_at) - v_reference_at)) / 60.0,
            0
          )::NUMERIC
        END * v_weight_window
      )
      + (COALESCE(rs.travel_minutes, 0) * v_weight_travel)
      + (COALESCE(rs.traffic_delay_minutes, 0) * v_weight_traffic)
      + (COALESCE(rs.service_minutes, 0) * v_weight_service)
      - (COALESCE(rs.priority_score, 0) * v_weight_priority) AS optimization_penalty
    FROM raw_stops rs
  ),
  ranked AS (
    SELECT
      s.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_deadline_hard_sort THEN s.deadline_at END ASC NULLS LAST,
          s.optimization_penalty ASC,
          s.priority_score DESC NULLS LAST,
          s.deadline_at ASC NULLS LAST,
          s.original_sequence ASC
      )::INT AS sequence_order
    FROM scored s
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_strip_nulls(
               public.deep_merge_jsonb(
                 r.stop_value,
                 jsonb_build_object(
                   'sequence_order', r.sequence_order,
                   'metadata', jsonb_build_object(
                     'optimizer', jsonb_strip_nulls(
                       jsonb_build_object(
                         'reference_at', v_reference_at,
                         'deadline_at', r.deadline_at,
                         'deadline_minutes', r.deadline_minutes,
                         'penalty_score', r.optimization_penalty,
                         'priority_score', r.priority_score,
                         'travel_minutes', r.travel_minutes,
                         'traffic_delay_minutes', r.traffic_delay_minutes,
                         'service_minutes', r.service_minutes,
                         'original_sequence', r.original_sequence
                       )
                     )
                   )
                 )
               )
             )
             ORDER BY r.sequence_order
           ),
           '[]'::jsonb
         )
    INTO v_solved_stops
    FROM ranked r;

  stop_count := COALESCE(jsonb_array_length(v_solved_stops), 0);
  IF stop_count < 1 THEN
    RAISE EXCEPTION 'solve_route_plan_v1 produced no optimized stops for route_plan %', v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  v_solution := public.deep_merge_jsonb(
    CASE
      WHEN jsonb_typeof(COALESCE(v_plan.solution, 'null'::jsonb)) = 'object' THEN v_plan.solution
      ELSE '{}'::jsonb
    END,
    jsonb_build_object(
      'stops', v_solved_stops,
      'optimizer', jsonb_strip_nulls(
        jsonb_build_object(
          'reference_at', v_reference_at,
          'deadline_hard_sort', v_deadline_hard_sort,
          'policy_category', 'route_planning_policy',
          'policy_scope_type', COALESCE(v_policy_row.scope_type, 'global'),
          'policy_scope_id', v_policy_row.scope_id,
          'policy_version', COALESCE(v_policy_row.version, 1),
          'settings_resolution_id', settings_resolution_id,
          'stop_hash', v_stop_hash,
          'weights', jsonb_build_object(
            'window', v_weight_window,
            'priority', v_weight_priority,
            'travel', v_weight_travel,
            'traffic_delay', v_weight_traffic,
            'service', v_weight_service
          )
        )
      )
    )
  );

  UPDATE public.route_plans
     SET status = 'solved',
         solved_at = now(),
         solution = v_solution,
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'solved',
    v_from_status,
    'solved',
    jsonb_strip_nulls(
      jsonb_build_object(
        'stop_count', stop_count,
        'settings_resolution_id', settings_resolution_id,
        'stop_hash', v_stop_hash,
        'reference_at', v_reference_at
      )
    ),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  status := 'solved';
  version := v_plan.version;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.solve_route_plan_v1(JSONB) IS
  'Service write-path: deterministically optimize route_plan stop sequencing using route_planning_policy before freeze/apply.';

REVOKE ALL ON FUNCTION public.solve_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.solve_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.solve_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.solve_route_plan_v1(JSONB) TO service_role;

-------------------------------------------------------------
-- 4) Browser-safe UI/API wrappers
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_solve_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  stop_count INT,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_solve_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(v_route_plan_id, 'write');

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'route_plan_id', v_plan.id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.solve_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_solve_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plan sequence optimization with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_solve_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_solve_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_solve_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_solve_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  stop_count INT,
  settings_resolution_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_solve_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_solve_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_solve_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_solve_route_plan_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------
-- 5) Dedicated UI command executor for route-plan solve
-------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_route_plan_solve_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_plan JSONB := NULL;
  v_result RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 invalid route_plan id %', v_selection_id_text;
  END IF;

  v_visible_plan := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_plan IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_solve_v1 route_plan % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.ui_solve_route_plan_v1(
      jsonb_strip_nulls(
        COALESCE(v_params, '{}'::jsonb)
        || jsonb_build_object('route_plan_id', v_selection_uuid)
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'solved',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_plan_id', v_result.route_plan_id,
          'status', v_result.status,
          'version', v_result.version,
          'stop_count', v_result.stop_count,
          'settings_resolution_id', v_result.settings_resolution_id
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Optimize visible route_plans from Console/Portal without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_plan_solve_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_route_plan_solve_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_plan_solve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------
-- 6) ui_command_registry route-plan solve command
-------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_plans.solve_sequence'],
    jsonb_build_object(
      'key', 'route_plans.solve_sequence',
      'label', 'Optimize sequence',
      'description', 'Re-rank the selected route plan stops through the canonical route_planning_policy before freeze/apply.',
      'capability', 'route_plans.write',
      'schema_category', 'resource:route_plans',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_plan_solve_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Optimize route sequence?',
          'description', 'This recalculates the stop order on the selected route plan before freeze/apply.',
          'confirm_label', 'Optimize sequence',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'route_plans.solve_sequence' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'route_plans.solve_sequence'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'route_plans.solve_sequence');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             change_reason = 'Expose route_plans.solve_sequence through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
