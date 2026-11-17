-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch route run workflow v1 fix (route_runs idempotency ON CONFLICT)
-- Date: 2026-01-23
--
-- Fix:
--   - The prior migration created a partial unique index on (organization_id, idempotency_key).
--   - Postgres requires a matching UNIQUE constraint/index for ON CONFLICT (col, col) inference;
--     partial indexes are not inferred unless the ON CONFLICT target includes a matching WHERE.
--   - Standardize on a non-partial unique index; NULL keys remain allowed (Postgres UNIQUE allows multiple NULLs).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601231310_dispatch_route_run_workflow_v1_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP INDEX IF EXISTS public.idx_route_runs_org_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_runs_org_idempotency
  ON public.route_runs (organization_id, idempotency_key);

-- Recreate the function so the ON CONFLICT target is planned against the correct uniqueness.
CREATE OR REPLACE FUNCTION public.create_route_run_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_created BOOLEAN := TRUE;

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;

  v_status TEXT := NULL;
  v_planned_date DATE := NULL;
  v_planned_start_at TIMESTAMPTZ := NULL;
  v_planned_end_at TIMESTAMPTZ := NULL;

  v_idempotency_key TEXT := NULL;
  v_idempotency_hash TEXT := NULL;
  v_existing_hash TEXT := NULL;

  v_metadata JSONB := '{}'::jsonb;
  v_stops JSONB := '[]'::jsonb;

  v_run_id UUID := NULL;
  v_stop_ids UUID[] := '{}'::uuid[];

  v_item JSONB;
  v_seq INT := 0;

  v_client_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_stop_kind TEXT := NULL;
  v_sequence_order INT := NULL;
  v_win_start TIMESTAMPTZ := NULL;
  v_win_end TIMESTAMPTZ := NULL;
  v_stop_metadata JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_route_run_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::UUID; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::UUID; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  v_status := lower(NULLIF(btrim(COALESCE(v_input->>'status', '')), ''));
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_start_at := NULLIF(v_input->>'planned_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_start_at := NULL; END;
  BEGIN v_planned_end_at := NULLIF(v_input->>'planned_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_end_at := NULL; END;

  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  v_stops := COALESCE(v_input->'stops', '[]'::jsonb);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_route_run_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_stops) <> 'array' THEN
    RAISE EXCEPTION 'create_route_run_v1 expects stops as JSON array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'create_route_run_v1 requires at least one stop' USING ERRCODE = '23514';
  END IF;

  v_idempotency_hash := encode(digest(v_input::text, 'sha256'), 'hex');

  IF v_idempotency_key IS NOT NULL THEN
    INSERT INTO public.route_runs (
      organization_id,
      branch_id,
      driver_user_id,
      vehicle_id,
      status,
      planned_date,
      planned_start_at,
      planned_end_at,
      metadata,
      idempotency_key,
      idempotency_hash
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_driver_user_id,
      v_vehicle_id,
      COALESCE(v_status, 'planned'),
      v_planned_date,
      v_planned_start_at,
      v_planned_end_at,
      v_metadata,
      v_idempotency_key,
      v_idempotency_hash
    )
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_run_id;

    IF v_run_id IS NULL THEN
      SELECT rr.id, rr.idempotency_hash
        INTO v_run_id, v_existing_hash
        FROM public.route_runs rr
       WHERE rr.organization_id = v_org_id
         AND rr.idempotency_key = v_idempotency_key
       LIMIT 1;

      IF v_run_id IS NULL THEN
        RAISE EXCEPTION 'create_route_run_v1 idempotency_key collision but row missing (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      IF v_existing_hash IS DISTINCT FROM v_idempotency_hash THEN
        RAISE EXCEPTION 'create_route_run_v1 idempotency_key reuse with different payload (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      v_created := FALSE;
    END IF;
  ELSE
    INSERT INTO public.route_runs (
      organization_id,
      branch_id,
      driver_user_id,
      vehicle_id,
      status,
      planned_date,
      planned_start_at,
      planned_end_at,
      metadata
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_driver_user_id,
      v_vehicle_id,
      COALESCE(v_status, 'planned'),
      v_planned_date,
      v_planned_start_at,
      v_planned_end_at,
      v_metadata
    )
    RETURNING id INTO v_run_id;
  END IF;

  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'create_route_run_v1 failed to create route_run' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_stops) AS t(value)
  LOOP
    v_seq := v_seq + 1;
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'create_route_run_v1 stop at index % must be JSON object', v_seq USING ERRCODE = '23514';
    END IF;

    BEGIN v_client_id := NULLIF(v_item->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
    BEGIN v_shipment_id := NULLIF(v_item->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
    v_stop_kind := lower(NULLIF(btrim(COALESCE(v_item->>'stop_kind', '')), ''));
    BEGIN v_sequence_order := NULLIF(v_item->>'sequence_order', '')::int; EXCEPTION WHEN others THEN v_sequence_order := NULL; END;
    BEGIN v_win_start := NULLIF(v_item->>'planned_window_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_win_start := NULL; END;
    BEGIN v_win_end := NULLIF(v_item->>'planned_window_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_win_end := NULL; END;
    v_stop_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_stop_metadata) <> 'object' THEN
      v_stop_metadata := '{}'::jsonb;
    END IF;

    IF v_client_id IS NULL THEN
      RAISE EXCEPTION 'create_route_run_v1 stop % missing client_id', v_seq USING ERRCODE = '23514';
    END IF;
    IF v_shipment_id IS NULL THEN
      RAISE EXCEPTION 'create_route_run_v1 stop % missing shipment_id', v_seq USING ERRCODE = '23514';
    END IF;
    IF v_stop_kind IS NULL THEN
      v_stop_kind := 'delivery';
    END IF;
    IF v_sequence_order IS NULL OR v_sequence_order < 1 THEN
      v_sequence_order := v_seq;
    END IF;

    INSERT INTO public.route_stops (
      organization_id,
      route_run_id,
      client_id,
      shipment_id,
      stop_kind,
      sequence_order,
      planned_window_start_at,
      planned_window_end_at,
      metadata
    ) VALUES (
      v_org_id,
      v_run_id,
      v_client_id,
      v_shipment_id,
      v_stop_kind,
      v_sequence_order,
      v_win_start,
      v_win_end,
      v_stop_metadata
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT COALESCE(array_agg(rs.id ORDER BY rs.sequence_order), '{}'::uuid[])
    INTO v_stop_ids
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_run_id;

  route_run_id := v_run_id;
  stop_ids := v_stop_ids;
  created := v_created;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_route_run_v1(JSONB) IS
  'Service write-path: create a route_run and its route_stops (idempotent by organization_id + idempotency_key).';

REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_route_run_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601231310_dispatch_route_run_workflow_v1_fix'));
COMMIT;

