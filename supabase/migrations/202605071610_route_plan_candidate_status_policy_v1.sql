-- Migration: Route plan candidate status policy v1
-- Purpose:
--   Keep delivery-wave candidate eligibility row-driven and include the
--   first-tenant Console-created shipment shape. UI-created shipments enter as
--   pending and can carry branch/zone/service-level lineage in validated
--   service-offering metadata before those columns are projected onto
--   shipments.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071610_route_plan_candidate_status_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH status_policy(value, rank) AS (
  VALUES
    ('created', 10),
    ('pending', 20),
    ('pending_dispatch', 30)
)
UPDATE public.lookup_values lv
   SET metadata = jsonb_strip_nulls(
         COALESCE(lv.metadata, '{}'::jsonb)
         || jsonb_build_object(
              'route_plan_candidate_eligible', TRUE,
              'route_plan_candidate_rank', status_policy.rank
            )
       ),
       updated_at = now()
  FROM public.lookup_definitions ld,
       status_policy
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'shipment_status'
   AND lv.value = status_policy.value;

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
  v_statuses TEXT[] := ARRAY[]::TEXT[];
  v_limit INT := NULL;
  v_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
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
    SELECT COALESCE(
             array_agg(
               lv.value
               ORDER BY
                 CASE
                   WHEN COALESCE(lv.metadata->>'route_plan_candidate_rank', '') ~ '^[0-9]+$'
                     THEN (lv.metadata->>'route_plan_candidate_rank')::int
                   ELSE COALESCE(lv.sort_order, 0)
                 END,
                 lv.value
             ),
             ARRAY[]::text[]
           )
      INTO v_statuses
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'shipment_status'
       AND lv.status = 'active'
       AND COALESCE(lv.effective_from, '-infinity'::timestamptz) <= now()
       AND COALESCE(lv.effective_until, 'infinity'::timestamptz) > now()
       AND lower(COALESCE(lv.metadata->>'route_plan_candidate_eligible', 'false')) IN ('true', '1', 'yes', 'on');
  END IF;

  IF COALESCE(array_length(v_statuses, 1), 0) = 0 THEN
    RAISE EXCEPTION 'route_plan_delivery_wave_candidates_v1 has no route-plan-eligible shipment_status lookup rows'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_limit := NULLIF(v_wave_selection->>'limit', '')::int; EXCEPTION WHEN others THEN v_limit := NULL; END;
  IF v_limit IS NOT NULL AND v_limit < 1 THEN
    v_limit := NULL;
  END IF;

  SELECT COALESCE(NULLIF(b.timezone, ''), NULLIF(o.timezone, ''), 'UTC')
    INTO v_reference_timezone
    FROM public.organizations o
    LEFT JOIN public.branches b
      ON b.id = v_branch_id
   WHERE o.id = v_org_id
   LIMIT 1;

  v_reference_timezone := COALESCE(NULLIF(v_reference_timezone, ''), 'UTC');
  IF v_planned_reference_at IS NULL THEN
    v_planned_reference_at := ((v_planned_date::text || ' 12:00:00')::timestamp AT TIME ZONE v_reference_timezone);
  END IF;
  v_reference_local := v_planned_reference_at AT TIME ZONE v_reference_timezone;

  RETURN QUERY
  WITH shipment_scope AS (
    SELECT
      s.id AS shipment_id,
      s.client_id,
      COALESCE(
        s.zone_id,
        CASE
          WHEN lower(COALESCE(s.metadata->>'service_offering_zone_id', '')) ~ v_uuid_re
            THEN (s.metadata->>'service_offering_zone_id')::uuid
          ELSE NULL
        END
      ) AS effective_zone_id,
      COALESCE(
        s.branch_id,
        CASE
          WHEN lower(COALESCE(s.metadata->>'service_offering_branch_id', '')) ~ v_uuid_re
            THEN (s.metadata->>'service_offering_branch_id')::uuid
          ELSE NULL
        END
      ) AS metadata_branch_id,
      lower(
        COALESCE(
          NULLIF(btrim(COALESCE(s.service_level, '')), ''),
          NULLIF(btrim(COALESCE(s.metadata->>'service_level_key', '')), ''),
          'standard'
        )
      ) AS shipment_service_level,
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
  ),
  candidate_base AS (
    SELECT
      ss.shipment_id,
      ss.client_id,
      ss.effective_zone_id AS zone_id,
      COALESCE(ss.metadata_branch_id, public.resolve_branch_id_for_zone_at(ss.effective_zone_id, v_planned_reference_at)) AS effective_branch_id,
      ss.shipment_service_level,
      ss.promised_delivery_date,
      ss.promised_window_start_at,
      ss.promised_window_end_at,
      ss.priority_score,
      ss.tracking_number,
      ss.created_at
    FROM shipment_scope ss
    WHERE ss.effective_zone_id IS NOT NULL
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
  'Compute due delivery-wave candidates for a branch/planned_date using row-driven shipment_status eligibility, shipment promises, service-offering lineage, branch coverage, and branch capacity readiness.';

REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_delivery_wave_candidates_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605071610_route_plan_candidate_status_policy_v1'));

COMMIT;
