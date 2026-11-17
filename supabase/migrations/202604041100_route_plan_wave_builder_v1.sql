-- Migration: Route plan delivery wave builder v1
-- Purpose:
--   - Build delivery-wave route plans from shipment promise outputs plus branch readiness rows.
--   - Keep route_plans as the canonical planning SSOT; do not write route_runs directly here.
--   - Expose an authenticated UI/API wrapper for browser-safe delivery-wave creation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604041100_route_plan_wave_builder_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Delivery-wave candidate selection
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_delivery_wave_candidates_v1(
  p_input JSONB
)
RETURNS TABLE (
  sequence_order INT,
  shipment_id UUID,
  client_id UUID,
  zone_id UUID,
  branch_id UUID,
  service_level TEXT,
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  priority_score NUMERIC,
  tracking_number TEXT,
  stop_payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_wave_selection JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_planned_date DATE := NULL;
  v_planned_reference_at TIMESTAMPTZ := NULL;
  v_reference_timezone TEXT := 'UTC';
  v_reference_local TIMESTAMP := NULL;
  v_service_type TEXT := 'delivery';
  v_statuses TEXT[] := ARRAY['created'];
  v_limit INT := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'route_plan_delivery_wave_candidates_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_reference_at := NULLIF(v_input->>'planned_reference_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_reference_at := NULL; END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_delivery_wave_candidates_v1 missing organization_id'
      USING ERRCODE = '23514';
  END IF;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_delivery_wave_candidates_v1 missing branch_id'
      USING ERRCODE = '23514';
  END IF;
  IF v_planned_date IS NULL THEN
    RAISE EXCEPTION 'route_plan_delivery_wave_candidates_v1 missing planned_date'
      USING ERRCODE = '23514';
  END IF;

  v_wave_selection := COALESCE(
    v_input #> '{inputs,wave_selection}',
    v_input->'wave_selection',
    '{}'::jsonb
  );
  IF jsonb_typeof(v_wave_selection) <> 'object' THEN
    v_wave_selection := '{}'::jsonb;
  END IF;

  v_service_type := lower(
    COALESCE(NULLIF(btrim(COALESCE(v_wave_selection->>'service_type', '')), ''), 'delivery')
  );

  IF jsonb_typeof(COALESCE(v_wave_selection->'statuses', 'null'::jsonb)) = 'array' THEN
    SELECT COALESCE(
             array_agg(lower(btrim(value))) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
             ARRAY[]::text[]
           )
      INTO v_statuses
      FROM jsonb_array_elements_text(v_wave_selection->'statuses') AS s(value);
  END IF;

  IF COALESCE(array_length(v_statuses, 1), 0) = 0 THEN
    v_statuses := ARRAY['created'];
  END IF;

  BEGIN v_limit := NULLIF(v_wave_selection->>'limit', '')::int; EXCEPTION WHEN others THEN v_limit := NULL; END;
  IF v_limit IS NOT NULL AND v_limit < 1 THEN
    v_limit := NULL;
  END IF;

  IF v_planned_reference_at IS NULL THEN
    SELECT COALESCE(NULLIF(b.timezone, ''), NULLIF(o.timezone, ''), 'UTC')
      INTO v_reference_timezone
      FROM public.organizations o
      LEFT JOIN public.branches b
        ON b.id = v_branch_id
     WHERE o.id = v_org_id
     LIMIT 1;

    v_planned_reference_at := ((v_planned_date::text || ' 12:00:00')::timestamp AT TIME ZONE v_reference_timezone);
  ELSE
    SELECT COALESCE(NULLIF(b.timezone, ''), NULLIF(o.timezone, ''), 'UTC')
      INTO v_reference_timezone
      FROM public.organizations o
      LEFT JOIN public.branches b
        ON b.id = v_branch_id
     WHERE o.id = v_org_id
     LIMIT 1;
  END IF;

  v_reference_timezone := COALESCE(NULLIF(v_reference_timezone, ''), 'UTC');
  v_reference_local := v_planned_reference_at AT TIME ZONE v_reference_timezone;

  RETURN QUERY
  WITH candidate_base AS (
    SELECT
      s.id AS shipment_id,
      s.client_id,
      s.zone_id,
      COALESCE(s.branch_id, public.resolve_branch_id_for_zone_at(s.zone_id, v_planned_reference_at)) AS effective_branch_id,
      lower(COALESCE(NULLIF(btrim(COALESCE(s.service_level, '')), ''), 'standard')) AS shipment_service_level,
      s.promised_delivery_date,
      s.promised_window_start_at,
      s.promised_window_end_at,
      s.priority_score,
      s.tracking_number,
      s.created_at
    FROM public.shipments s
    WHERE s.organization_id = v_org_id
      AND lower(COALESCE(NULLIF(btrim(COALESCE(s.service_type, '')), ''), 'delivery')) = v_service_type
      AND lower(COALESCE(NULLIF(btrim(COALESCE(s.status, '')), ''), 'created')) = ANY (v_statuses)
      AND s.promised_delivery_date IS NOT NULL
      AND s.promised_delivery_date <= v_planned_date
      AND s.zone_id IS NOT NULL
  ),
  eligible AS (
    SELECT
      cb.shipment_id,
      cb.client_id,
      cb.zone_id,
      cb.effective_branch_id AS branch_id,
      sl.id AS service_level_id,
      cb.shipment_service_level AS service_level,
      cb.promised_delivery_date,
      cb.promised_window_start_at,
      cb.promised_window_end_at,
      cb.priority_score,
      cb.tracking_number,
      cb.created_at
    FROM candidate_base cb
    JOIN public.service_levels sl
      ON sl.organization_id = v_org_id
     AND sl.is_active IS TRUE
     AND sl.key = cb.shipment_service_level
    WHERE cb.effective_branch_id = v_branch_id
      AND EXISTS (
        SELECT 1
        FROM public.service_offerings so
        WHERE so.branch_id = v_branch_id
          AND so.service_level_id = sl.id
          AND so.is_active IS TRUE
          AND so.effective_from <= v_planned_reference_at
          AND (so.effective_to IS NULL OR so.effective_to > v_planned_reference_at)
          AND (so.zone_id IS NULL OR so.zone_id = cb.zone_id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.route_stops rs
        JOIN public.route_runs rr
          ON rr.id = rs.route_run_id
        WHERE rs.client_id = cb.client_id
          AND rs.shipment_id = cb.shipment_id
          AND rr.organization_id = v_org_id
          AND rr.status IN ('planned', 'in_progress')
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM public.branch_capacity_windows bcw
          WHERE bcw.branch_id = v_branch_id
            AND bcw.is_active IS TRUE
            AND bcw.effective_from <= v_planned_reference_at
            AND (bcw.effective_to IS NULL OR bcw.effective_to > v_planned_reference_at)
        )
        OR EXISTS (
          SELECT 1
          FROM public.branch_capacity_windows bcw
          WHERE bcw.branch_id = v_branch_id
            AND bcw.is_active IS TRUE
            AND bcw.effective_from <= v_planned_reference_at
            AND (bcw.effective_to IS NULL OR bcw.effective_to > v_planned_reference_at)
            AND (bcw.zone_id IS NULL OR bcw.zone_id = cb.zone_id)
            AND (bcw.service_level_id IS NULL OR bcw.service_level_id = sl.id)
            AND (bcw.day_of_week IS NULL OR bcw.day_of_week = EXTRACT(DOW FROM v_reference_local)::smallint)
            AND (
              bcw.window_start_local IS NULL
              OR (
                v_reference_local::time >= bcw.window_start_local
                AND v_reference_local::time < bcw.window_end_local
              )
            )
        )
      )
  ),
  ranked AS (
    SELECT
      row_number() OVER (
        ORDER BY
          e.priority_score DESC NULLS LAST,
          e.promised_window_start_at ASC NULLS LAST,
          e.promised_delivery_date ASC,
          e.created_at ASC,
          e.shipment_id
      )::int AS sequence_order,
      e.shipment_id,
      e.client_id,
      e.zone_id,
      e.branch_id,
      e.service_level,
      e.promised_delivery_date,
      e.promised_window_start_at,
      e.promised_window_end_at,
      e.priority_score,
      e.tracking_number
    FROM eligible e
  )
  SELECT
    r.sequence_order,
    r.shipment_id,
    r.client_id,
    r.zone_id,
    r.branch_id,
    r.service_level,
    r.promised_delivery_date,
    r.promised_window_start_at,
    r.promised_window_end_at,
    r.priority_score,
    r.tracking_number,
    jsonb_strip_nulls(
      jsonb_build_object(
        'client_id', r.client_id,
        'shipment_id', r.shipment_id,
        'stop_kind', 'delivery',
        'sequence_order', r.sequence_order,
        'planned_window_start_at', r.promised_window_start_at,
        'planned_window_end_at', r.promised_window_end_at,
        'metadata', jsonb_strip_nulls(
          jsonb_build_object(
            'source', 'delivery_wave_builder',
            'planned_date', v_planned_date,
            'reference_at', v_planned_reference_at,
            'reference_timezone', v_reference_timezone,
            'service_level', r.service_level,
            'tracking_number', r.tracking_number
          )
        )
      )
    ) AS stop_payload
  FROM ranked r
  WHERE v_limit IS NULL OR r.sequence_order <= v_limit
  ORDER BY r.sequence_order;
END;
$function$;

COMMENT ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) IS
  'Compute due delivery-wave candidates for a branch/planned_date using shipment promises, service offerings, branch coverage, and branch capacity readiness.';

REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 2) Canonical delivery-wave route-plan creation
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.build_delivery_wave_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT,
  stop_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_wave_selection JSONB := '{}'::jsonb;
  v_inputs JSONB := '{}'::jsonb;
  v_constraints JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_requested_by_user_id UUID := NULL;
  v_planned_date DATE := NULL;
  v_planned_reference_at TIMESTAMPTZ := NULL;
  v_reference_timezone TEXT := 'UTC';
  v_stop_payloads JSONB := '[]'::jsonb;
  v_shipment_ids JSONB := '[]'::jsonb;
  v_candidate_count INT := 0;
  v_shipment_key TEXT := '';
  v_selection_hash TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_plan RECORD;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'build_delivery_wave_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_requested_by_user_id := NULLIF(v_input->>'requested_by_user_id', '')::uuid; EXCEPTION WHEN others THEN v_requested_by_user_id := NULL; END;
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_reference_at := NULLIF(v_input->>'planned_reference_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_reference_at := NULL; END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'build_delivery_wave_route_plan_v1 missing organization_id'
      USING ERRCODE = '23514';
  END IF;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'build_delivery_wave_route_plan_v1 missing branch_id'
      USING ERRCODE = '23514';
  END IF;
  IF v_planned_date IS NULL THEN
    RAISE EXCEPTION 'build_delivery_wave_route_plan_v1 missing planned_date'
      USING ERRCODE = '23514';
  END IF;

  v_inputs := COALESCE(v_input->'inputs', '{}'::jsonb);
  v_constraints := COALESCE(v_input->'constraints', '{}'::jsonb);
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_wave_selection := COALESCE(
    v_input #> '{inputs,wave_selection}',
    v_input->'wave_selection',
    '{}'::jsonb
  );

  IF jsonb_typeof(v_inputs) <> 'object' THEN v_inputs := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_constraints) <> 'object' THEN v_constraints := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN v_metadata := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_wave_selection) <> 'object' THEN v_wave_selection := '{}'::jsonb; END IF;

  SELECT
    COALESCE(jsonb_agg(c.stop_payload ORDER BY c.sequence_order), '[]'::jsonb),
    COALESCE(jsonb_agg(c.shipment_id ORDER BY c.sequence_order), '[]'::jsonb),
    COALESCE(string_agg(c.shipment_id::text, '|' ORDER BY c.sequence_order), ''),
    COUNT(*)::int
    INTO v_stop_payloads, v_shipment_ids, v_shipment_key, v_candidate_count
  FROM public.route_plan_delivery_wave_candidates_v1(v_input) AS c;

  IF COALESCE(v_candidate_count, 0) < 1 THEN
    RAISE EXCEPTION 'build_delivery_wave_route_plan_v1 found no eligible delivery-wave candidates'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(NULLIF(b.timezone, ''), NULLIF(o.timezone, ''), 'UTC')
    INTO v_reference_timezone
    FROM public.organizations o
    LEFT JOIN public.branches b
      ON b.id = v_branch_id
   WHERE o.id = v_org_id
   LIMIT 1;

  IF v_planned_reference_at IS NULL THEN
    v_planned_reference_at := ((v_planned_date::text || ' 12:00:00')::timestamp AT TIME ZONE COALESCE(NULLIF(v_reference_timezone, ''), 'UTC'));
  END IF;

  v_selection_hash := encode(
    digest(
      jsonb_build_object(
        'wave_selection', v_wave_selection,
        'shipment_ids', v_shipment_ids
      )::text,
      'sha256'
    ),
    'hex'
  );

  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  IF v_idempotency_key IS NULL THEN
    v_idempotency_key := format(
      'delivery-wave:%s:%s:%s',
      v_branch_id,
      v_planned_date,
      v_selection_hash
    );
  END IF;

  v_inputs := jsonb_strip_nulls(
    (v_inputs - 'stops' - 'wave_selection')
    || jsonb_build_object(
      'wave_selection', v_wave_selection,
      'stops', v_stop_payloads
    )
  );

  v_constraints := jsonb_strip_nulls(
    v_constraints
    || jsonb_build_object(
      'builder', jsonb_build_object(
        'mode', 'delivery_wave',
        'planned_reference_at', v_planned_reference_at,
        'reference_timezone', COALESCE(NULLIF(v_reference_timezone, ''), 'UTC')
      )
    )
  );

  v_metadata := jsonb_strip_nulls(
    v_metadata
    || jsonb_build_object(
      'builder', jsonb_strip_nulls(
        jsonb_build_object(
          'mode', 'delivery_wave',
          'candidate_count', v_candidate_count,
          'shipment_ids', v_shipment_ids,
          'shipment_key', v_shipment_key,
          'selection_hash', v_selection_hash,
          'planned_reference_at', v_planned_reference_at,
          'reference_timezone', COALESCE(NULLIF(v_reference_timezone, ''), 'UTC')
        )
      )
    )
  );

  SELECT *
    INTO v_plan
    FROM public.create_route_plan_v1(
      jsonb_build_object(
        'organization_id', v_org_id,
        'branch_id', v_branch_id,
        'planned_date', v_planned_date,
        'requested_by_user_id', v_requested_by_user_id,
        'idempotency_key', v_idempotency_key,
        'inputs', v_inputs,
        'constraints', v_constraints,
        'metadata', v_metadata
      )
    )
   LIMIT 1;

  PERFORM public.route_plan_log_event_v1(
    v_plan.route_plan_id,
    'delivery_wave_built',
    NULL,
    v_plan.status,
    jsonb_strip_nulls(
      jsonb_build_object(
        'candidate_count', v_candidate_count,
        'shipment_ids', v_shipment_ids,
        'selection_hash', v_selection_hash,
        'planned_reference_at', v_planned_reference_at,
        'reference_timezone', COALESCE(NULLIF(v_reference_timezone, ''), 'UTC'),
        'wave_selection', v_wave_selection
      )
    ),
    v_requested_by_user_id,
    'route_plan_service',
    format('delivery-wave-built:%s', v_idempotency_key)
  );

  route_plan_id := v_plan.route_plan_id;
  created := v_plan.created;
  status := v_plan.status;
  version := v_plan.version;
  stop_count := v_candidate_count;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.build_delivery_wave_route_plan_v1(JSONB) IS
  'Build a route_plan from due delivery-wave candidates using shipment promise outputs and branch readiness rows.';

REVOKE ALL ON FUNCTION public.build_delivery_wave_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_delivery_wave_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.build_delivery_wave_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_delivery_wave_route_plan_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Authenticated UI/API wrappers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_build_delivery_wave_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT,
  stop_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_build_delivery_wave_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'organization_id', v_ctx.organization_id,
      'requested_by_user_id', v_ctx.user_id
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.build_delivery_wave_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_build_delivery_wave_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for delivery-wave route_plan creation with server-derived tenant actor context.';

REVOKE ALL ON FUNCTION public.ui_build_delivery_wave_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_build_delivery_wave_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_build_delivery_wave_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_build_delivery_wave_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT,
  stop_count INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_build_delivery_wave_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_build_delivery_wave_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_build_delivery_wave_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_build_delivery_wave_route_plan_v1(JSONB) TO authenticated, service_role;

COMMIT;
