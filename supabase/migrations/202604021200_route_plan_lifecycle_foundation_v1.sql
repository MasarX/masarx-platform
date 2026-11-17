-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Route plan lifecycle foundation v1
-- Date: 2026-04-02
--
-- Goals:
--   - Make route_plans the canonical planning write path for create/freeze/apply.
--   - Keep route_runs/route_stops as execution projections created from frozen plans.
--   - Preserve workflow-engine-first semantics with a route_plan_apply workflow handler/template.
--   - Fix route_plan_events so multiple lifecycle events may exist for the same plan version.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604021200_route_plan_lifecycle_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Route-plan lifecycle state + event ledger/idempotency hardening
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'frozen',
  'Frozen',
  'Plan is frozen and ready to be applied into execution rows',
  35,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'route_plan_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

ALTER TABLE public.route_plans
  ADD COLUMN IF NOT EXISTS idempotency_hash TEXT;

ALTER TABLE public.route_plans
  DROP CONSTRAINT IF EXISTS route_plans_idempotency_hash_ck;
ALTER TABLE public.route_plans
  ADD CONSTRAINT route_plans_idempotency_hash_ck
  CHECK (idempotency_hash IS NULL OR btrim(idempotency_hash) <> '');

DROP INDEX IF EXISTS public.idx_route_plan_events_plan_version;

CREATE INDEX IF NOT EXISTS idx_route_plan_events_plan_version
  ON public.route_plan_events (route_plan_id, plan_version, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_plan_events_plan_idempotency
  ON public.route_plan_events (route_plan_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_runs_route_plan_id_unique
  ON public.route_runs (route_plan_id)
  WHERE route_plan_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.route_runs_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_vehicle_org UUID;
  v_user_org UUID;
  v_plan_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'route_runs: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT v.organization_id INTO v_vehicle_org
    FROM public.vehicles v
    WHERE v.id = NEW.vehicle_id;

    IF v_vehicle_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
    END IF;

    IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, vehicle org %)', NEW.organization_id, v_vehicle_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.driver_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.driver_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: user % not found', NEW.driver_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.route_plan_id IS NOT NULL THEN
    SELECT rp.organization_id INTO v_plan_org
    FROM public.route_plans rp
    WHERE rp.id = NEW.route_plan_id;

    IF v_plan_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: route_plan % not found', NEW.route_plan_id USING ERRCODE = '23503';
    END IF;

    IF v_plan_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, route_plan org %)', NEW.organization_id, v_plan_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Canonical route-plan service RPCs
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_log_event_v1(
  p_route_plan_id UUID,
  p_event_type TEXT,
  p_from_status TEXT DEFAULT NULL,
  p_to_status TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_system TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan RECORD;
  v_event_id UUID;
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  IF p_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_log_event_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;
  IF NULLIF(btrim(COALESCE(p_event_type, '')), '') IS NULL THEN
    RAISE EXCEPTION 'route_plan_log_event_v1 missing event_type' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT rp.id, rp.organization_id, rp.version
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'route_plan_log_event_v1 route_plan % not found', p_route_plan_id USING ERRCODE = '23503';
  END IF;

  BEGIN
    INSERT INTO public.route_plan_events (
      route_plan_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_user_id,
      actor_system,
      payload,
      idempotency_key,
      plan_version
    )
    VALUES (
      v_plan.id,
      v_plan.organization_id,
      lower(btrim(p_event_type)),
      CASE WHEN p_from_status IS NULL THEN NULL ELSE lower(btrim(p_from_status)) END,
      CASE WHEN p_to_status IS NULL THEN NULL ELSE lower(btrim(p_to_status)) END,
      p_actor_user_id,
      NULLIF(btrim(COALESCE(p_actor_system, '')), ''),
      v_payload,
      NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''),
      v_plan.version
    )
    RETURNING id INTO v_event_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
        RAISE;
      END IF;

      SELECT rpe.id
        INTO v_event_id
        FROM public.route_plan_events rpe
       WHERE rpe.route_plan_id = p_route_plan_id
         AND rpe.idempotency_key = NULLIF(btrim(COALESCE(p_idempotency_key, '')), '')
       ORDER BY rpe.created_at DESC
       LIMIT 1;

      IF v_event_id IS NULL THEN
        RAISE;
      END IF;
  END;

  RETURN v_event_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.route_plan_resolve_stops_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan RECORD;
  v_stops JSONB := '[]'::jsonb;
BEGIN
  IF p_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_resolve_stops_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.inputs, rp.solution
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.inputs IS NULL AND v_plan.solution IS NULL THEN
    RAISE EXCEPTION 'route_plan_resolve_stops_v1 route_plan % not found', p_route_plan_id USING ERRCODE = '23503';
  END IF;

  IF jsonb_typeof(COALESCE(v_plan.solution->'stops', 'null'::jsonb)) = 'array' THEN
    v_stops := v_plan.solution->'stops';
  ELSIF jsonb_typeof(COALESCE(v_plan.inputs->'stops', 'null'::jsonb)) = 'array' THEN
    v_stops := v_plan.inputs->'stops';
  END IF;

  RETURN COALESCE(v_stops, '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  created BOOLEAN,
  status TEXT,
  version INT
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
  v_requested_by_user_id UUID := NULL;
  v_planned_date DATE := NULL;
  v_status TEXT := 'created';

  v_inputs JSONB := '{}'::jsonb;
  v_constraints JSONB := '{}'::jsonb;
  v_solution JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;

  v_idempotency_key TEXT := NULL;
  v_idempotency_hash TEXT := NULL;
  v_existing_hash TEXT := NULL;

  v_plan RECORD;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_requested_by_user_id := NULLIF(v_input->>'requested_by_user_id', '')::uuid; EXCEPTION WHEN others THEN v_requested_by_user_id := NULL; END;
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;

  v_status := lower(COALESCE(NULLIF(btrim(COALESCE(v_input->>'status', '')), ''), 'created'));
  IF v_status NOT IN ('created', 'submitted', 'solved') THEN
    RAISE EXCEPTION 'create_route_plan_v1 invalid initial status %', v_status USING ERRCODE = '23514';
  END IF;

  v_inputs := COALESCE(v_input->'inputs', '{}'::jsonb);
  v_constraints := COALESCE(v_input->'constraints', '{}'::jsonb);
  v_solution := COALESCE(v_input->'solution', '{}'::jsonb);
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');

  IF jsonb_typeof(v_inputs) <> 'object' THEN v_inputs := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_constraints) <> 'object' THEN v_constraints := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_solution) <> 'object' THEN v_solution := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN v_metadata := '{}'::jsonb; END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_route_plan_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;

  v_idempotency_hash := encode(digest(v_input::text, 'sha256'), 'hex');

  IF v_idempotency_key IS NOT NULL THEN
    INSERT INTO public.route_plans (
      organization_id,
      branch_id,
      planned_date,
      status,
      requested_by_user_id,
      requested_at,
      solved_at,
      inputs,
      constraints,
      solution,
      idempotency_key,
      idempotency_hash,
      metadata
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_planned_date,
      v_status,
      v_requested_by_user_id,
      now(),
      CASE WHEN v_status IN ('solved') THEN now() ELSE NULL END,
      v_inputs,
      v_constraints,
      v_solution,
      v_idempotency_key,
      v_idempotency_hash,
      v_metadata
    )
    ON CONFLICT (organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
      DO NOTHING
    RETURNING
      public.route_plans.id,
      public.route_plans.status,
      public.route_plans.version
    INTO v_plan;

    IF v_plan.id IS NULL THEN
      SELECT rp.id, rp.status, rp.version, rp.idempotency_hash
        INTO v_plan.id, v_plan.status, v_plan.version, v_existing_hash
        FROM public.route_plans rp
       WHERE rp.organization_id = v_org_id
         AND rp.idempotency_key = v_idempotency_key
       LIMIT 1;

      IF v_plan.id IS NULL THEN
        RAISE EXCEPTION 'create_route_plan_v1 idempotency_key collision but row missing (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      IF v_existing_hash IS DISTINCT FROM v_idempotency_hash THEN
        RAISE EXCEPTION 'create_route_plan_v1 idempotency_key reuse with different payload (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      v_created := FALSE;
    END IF;
  ELSE
    INSERT INTO public.route_plans (
      organization_id,
      branch_id,
      planned_date,
      status,
      requested_by_user_id,
      requested_at,
      solved_at,
      inputs,
      constraints,
      solution,
      metadata
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_planned_date,
      v_status,
      v_requested_by_user_id,
      now(),
      CASE WHEN v_status IN ('solved') THEN now() ELSE NULL END,
      v_inputs,
      v_constraints,
      v_solution,
      v_metadata
    )
    RETURNING
      public.route_plans.id,
      public.route_plans.status,
      public.route_plans.version
    INTO v_plan;
  END IF;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'create_route_plan_v1 failed to create route_plan' USING ERRCODE = '23514';
  END IF;

  IF v_created THEN
    PERFORM public.route_plan_log_event_v1(
      v_plan.id,
      'created',
      NULL,
      v_plan.status,
      jsonb_strip_nulls(jsonb_build_object(
        'planned_date', v_planned_date,
        'requested_by_user_id', v_requested_by_user_id
      )),
      v_requested_by_user_id,
      'route_plan_service',
      format('route-plan:%s:create', v_plan.id)
    );
  END IF;

  route_plan_id := v_plan.id;
  created := v_created;
  status := v_plan.status;
  version := v_plan.version;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.freeze_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  stop_count INT
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
  v_stops JSONB := '[]'::jsonb;
  v_stop_count INT := 0;
  v_from_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.status
    INTO v_from_status
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  IF v_from_status NOT IN ('created', 'submitted', 'solved', 'frozen') THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires route_plan in created/submitted/solved/frozen state (got %)', v_from_status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires stops array on route_plan %', v_route_plan_id USING ERRCODE = '23514';
  END IF;

  v_stop_count := jsonb_array_length(v_stops);
  IF v_stop_count < 1 THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires at least one stop on route_plan %', v_route_plan_id USING ERRCODE = '23514';
  END IF;

  IF v_from_status <> 'frozen' THEN
    UPDATE public.route_plans
       SET status = 'frozen',
           solved_at = COALESCE(solved_at, now()),
           updated_at = now()
     WHERE id = v_route_plan_id;

    PERFORM public.route_plan_log_event_v1(
      v_route_plan_id,
      'frozen',
      v_from_status,
      'frozen',
      jsonb_build_object('stop_count', v_stop_count),
      v_actor_user_id,
      v_actor_system,
      COALESCE(v_idempotency_key, format('route-plan:%s:freeze', v_route_plan_id))
    );
  END IF;

  route_plan_id := v_route_plan_id;
  status := 'frozen';
  stop_count := v_stop_count;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
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

  v_plan RECORD;
  v_stops JSONB := '[]'::jsonb;
  v_create_result RECORD;
  v_existing_route_run_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_from_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:apply', v_route_plan_id)
  );

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.*
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_from_status := v_plan.status;

  SELECT rr.id
    INTO v_existing_route_run_id
    FROM public.route_runs rr
   WHERE rr.route_plan_id = v_route_plan_id
   LIMIT 1;

  IF v_plan.status = 'applied' AND v_existing_route_run_id IS NOT NULL THEN
    route_plan_id := v_route_plan_id;
    route_run_id := v_existing_route_run_id;
    stop_ids := ARRAY(
      SELECT rs.id
      FROM public.route_stops rs
      WHERE rs.route_run_id = v_existing_route_run_id
      ORDER BY rs.sequence_order
    );
    created := FALSE;
    status := 'applied';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_plan.status <> 'frozen' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires route_plan % to be frozen (got %)', v_route_plan_id, v_plan.status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' OR jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires a frozen route_plan with at least one stop' USING ERRCODE = '23514';
  END IF;

  BEGIN v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  SELECT *
    INTO v_create_result
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_plan.organization_id,
        'branch_id', v_plan.branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'planned_date', v_plan.planned_date,
        'status', 'planned',
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata',
          COALESCE(v_plan.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'route_plan_id', v_plan.id,
            'route_plan_version', v_plan.version
          )
      ))
    )
    LIMIT 1;

  UPDATE public.route_runs
     SET route_plan_id = v_route_plan_id,
         updated_at = now()
   WHERE id = v_create_result.route_run_id
     AND (
       public.route_runs.route_plan_id IS NULL
       OR public.route_runs.route_plan_id = v_route_plan_id
     );

  IF NOT EXISTS (
    SELECT 1
    FROM public.route_runs rr
    WHERE rr.id = v_create_result.route_run_id
      AND rr.route_plan_id = v_route_plan_id
  ) THEN
    RAISE EXCEPTION 'apply_route_plan_v1 could not link route_run % to route_plan %', v_create_result.route_run_id, v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.route_plans
     SET status = 'applied',
         applied_at = COALESCE(applied_at, now()),
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'applied',
    v_from_status,
    'applied',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_create_result.route_run_id,
      'stop_ids', to_jsonb(v_create_result.stop_ids)
    )),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  route_run_id := v_create_result.route_run_id;
  stop_ids := v_create_result.stop_ids;
  created := COALESCE(v_create_result.created, FALSE);
  status := 'applied';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_route_plan_v1(JSONB) IS
  'Service write-path: create a route_plan projection + created event (idempotent by organization_id + idempotency_key).';
COMMENT ON FUNCTION public.freeze_route_plan_v1(JSONB) IS
  'Service write-path: validate stops and freeze a route_plan before execution rows are materialized.';
COMMENT ON FUNCTION public.apply_route_plan_v1(JSONB) IS
  'Service write-path: apply a frozen route_plan into route_runs/route_stops via create_route_run_v1.';

CREATE OR REPLACE FUNCTION public.start_route_plan_apply_workflow_v1(
  p_input JSONB
)
RETURNS JSONB
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
  v_template_id UUID := NULL;
  v_plan RECORD;
  v_workflow_run_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'start_route_plan_apply_workflow_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan-apply-workflow:%s', v_route_plan_id)
  );

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'start_route_plan_apply_workflow_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT
    rp.id,
    rp.organization_id,
    rp.branch_id,
    rp.status
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'start_route_plan_apply_workflow_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'route_plan_apply_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'start_route_plan_apply_workflow_v1 template route_plan_apply_v1 missing' USING ERRCODE = '23514';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'trigger_source', 'manual',
      'organization_id', v_plan.organization_id,
      'branch_id', v_plan.branch_id,
      'route_plan_id', v_plan.id,
      'resource_type', 'route_plan',
      'resource_id', v_plan.id,
      'workflow_reason', 'route_plan_apply',
      'actor_user_id', v_actor_user_id,
      'actor_system', v_actor_system,
      'idempotency_key', v_idempotency_key
    ))
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_name', 'route_plan_apply_v1',
    'workflow_run_id', v_workflow_run_id,
    'route_plan_id', v_plan.id,
    'route_plan_status', v_plan.status
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.route_plan_log_event_v1(UUID, TEXT, TEXT, TEXT, JSONB, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_log_event_v1(UUID, TEXT, TEXT, TEXT, JSONB, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_log_event_v1(UUID, TEXT, TEXT, TEXT, JSONB, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_log_event_v1(UUID, TEXT, TEXT, TEXT, JSONB, UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.route_plan_resolve_stops_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_resolve_stops_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_resolve_stops_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_resolve_stops_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.create_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_route_plan_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.freeze_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.freeze_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_route_plan_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.apply_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.apply_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_route_plan_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.start_route_plan_apply_workflow_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_route_plan_apply_workflow_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.start_route_plan_apply_workflow_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_route_plan_apply_workflow_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Workflow handler + template for canonical apply
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_plan_apply_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'route_plan_apply');
  v_route_plan_id_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'route_plan_id_jsonpath', '')), ''), '$.route_plan_id');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_idempotency_key TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_route_plan_id UUID := NULL;
  v_created RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  BEGIN
    v_route_plan_id := NULLIF(trim(both '"' FROM COALESCE(public.safe_jsonpath_query_first(v_ctx, v_route_plan_id_path)::text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_apply: route_plan_id missing from workflow context (workflow_run_id=% step_id=% path=%)', p_run.id, p_step.id, v_route_plan_id_path;
  END IF;

  SELECT *
    INTO v_created
    FROM public.apply_route_plan_v1(
      jsonb_build_object(
        'route_plan_id', v_route_plan_id,
        'actor_system', v_actor_system,
        'idempotency_key', v_idempotency_key
      )
    )
    LIMIT 1;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_plan_id', v_created.route_plan_id,
    'route_run_id', v_created.route_run_id,
    'stop_ids', to_jsonb(v_created.stop_ids),
    'created', v_created.created,
    'status', v_created.status
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'route_plan_id', v_created.route_plan_id,
      'route_run_id', v_created.route_run_id,
      'stop_ids', to_jsonb(v_created.stop_ids),
      'created', v_created.created,
      'status', v_created.status
    ))
  );

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES
  (
    'route_plan_apply',
    'workflow_handlers',
    'execute_route_plan_apply_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Apply a frozen route_plan into route_runs + route_stops through the canonical service RPC.',
    'docs/product/guides/handlers-cookbook.md'
  )
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id, created_by, created_at, updated_at, notes)
VALUES (
  'route_plan_apply_v1',
  'Dispatch: apply a frozen route_plan into route_runs + route_stops via workflow-engine canonical path.',
  1,
  'active',
  'global',
  NULL,
  NULL,
  now(),
  now(),
  'Use public.start_route_plan_apply_workflow_v1(jsonb) for the canonical starter; direct workflow context must include organization_id, resource identity, and route_plan_id.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'route_plan_apply_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_apply_v1 template id missing after upsert';
  END IF;

  DELETE FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    handler_key,
    handler_version,
    created_at,
    updated_at
  )
  VALUES (
    v_template_id,
    1,
    'route_plan_apply',
    NULL,
    'success',
    NULL,
    NULL,
    NULL,
    FALSE,
    jsonb_build_object(
      'context_key', 'route_plan_apply',
      'route_plan_id_jsonpath', '$.route_plan_id'
    ),
    TRUE,
    'route_plan_apply',
    'v1',
    now(),
    now()
  );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604021200_route_plan_lifecycle_foundation_v1'));
COMMIT;
