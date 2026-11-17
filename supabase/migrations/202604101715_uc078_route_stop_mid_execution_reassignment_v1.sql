-- Migration: UC078 route stop mid-execution reassignment v1
-- Purpose:
--   - Add a canonical task unassign path for explicit executor handoff.
--   - Split selected route_stops into a new route_run for mid-execution reassignment.
--   - Keep route-level partner takeover explicit through a dedicated handoff prep helper.
--   - Expose stop-level reassignment through a browser-safe UI RPC and row-driven command registry.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101715_uc078_route_stop_mid_execution_reassignment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Tasks SSOT: explicit unassign helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.unassign_task_v1(
  p_task_id UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := NULL;
  v_claims JSONB := NULL;
  v_jwt_role TEXT := NULL;
  v_is_platform BOOLEAN := FALSE;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(current_setting('app.actor_system', true), '')), '');
  v_task public.tasks%ROWTYPE;
  v_org_id UUID := NULL;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID := NULL;
  v_next_version INT := 0;
  v_previous_assigned_to UUID := NULL;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_jwt_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF v_user_id IS NULL THEN
    IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'unassign_task_v1 requires an authenticated user or service_role context';
    END IF;
  ELSE
    v_is_platform := public.is_platform_user();

    IF NOT public.user_can_write() THEN
      RAISE EXCEPTION 'unassign_task_v1 requires tenant/platform write scope';
    END IF;
  END IF;

  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'unassign_task_v1 requires task_id';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unassign_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF v_user_id IS NOT NULL
     AND COALESCE(v_is_platform, FALSE) IS NOT TRUE
     AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'unassign_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF v_user_id IS NOT NULL AND NOT public.user_has_permission_v1('tasks.write', v_org_id) THEN
    RAISE EXCEPTION 'unassign_task_v1 requires tasks.write permission' USING ERRCODE = '42501';
  END IF;

  IF v_idempotency IS NOT NULL THEN
    SELECT te.id
      INTO task_event_id
      FROM public.task_events te
     WHERE te.task_id = v_task.id
       AND te.idempotency_key = v_idempotency
     LIMIT 1;

    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_task.assigned_to IS NULL THEN
    task_id := v_task.id;
    task_event_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  v_previous_assigned_to := v_task.assigned_to;
  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET assigned_to = NULL,
         assigned_at = NULL,
         version = v_next_version
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'unassign',
    p_decision_outcome := 'unassigned',
    p_performed_by_system := COALESCE(v_actor_system, 'unassign_task_v1'),
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(
      jsonb_build_object(
        'previous_assigned_to', v_previous_assigned_to,
        'notes', p_notes
      )
    ),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    task_version,
    decision_log_id,
    settings_resolution_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'unassigned',
    v_task.status,
    v_task.status,
    v_user_id,
    v_actor_system,
    jsonb_strip_nulls(
      jsonb_build_object(
        'previous_assigned_to', v_previous_assigned_to,
        'notes', p_notes,
        'correlation_id', public.current_correlation_id()
      )
    ),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.unassign_task_v1(UUID, TEXT, TEXT)
  IS 'Clear task ownership through the Tasks SSOT with audit + ledger evidence. Authenticated calls enforce tenant RBAC; service_role callers may stamp actor_system provenance.';

REVOKE ALL ON FUNCTION public.unassign_task_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unassign_task_v1(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.unassign_task_v1(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unassign_task_v1(UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unassign_task_system_v1(
  p_task_id UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_actor_system TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'task_system');
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'unassign_task_system_v1 requires service_role context';
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', v_actor_system, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  BEGIN
    RETURN QUERY
    SELECT *
      FROM public.unassign_task_v1(
        p_task_id,
        p_idempotency_key,
        p_notes
      );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$function$;

COMMENT ON FUNCTION public.unassign_task_system_v1(UUID, TEXT, TEXT, TEXT)
  IS 'Service-only wrapper over unassign_task_v1 for workflow/system contexts. Forces service_role claims locally and stamps actor_system provenance.';

REVOKE ALL ON FUNCTION public.unassign_task_system_v1(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unassign_task_system_v1(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.unassign_task_system_v1(UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unassign_task_system_v1(UUID, TEXT, TEXT, TEXT) TO service_role;

-------------------------------------------------------------------------------
-- 2) Append-only stop reassignment ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_stop_reassignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_stop_id UUID NOT NULL REFERENCES public.route_stops(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,
  source_route_run_id UUID NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  target_route_run_id UUID NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  source_route_run_assignment_id UUID REFERENCES public.route_run_assignments(id) ON DELETE SET NULL,
  target_route_run_assignment_id UUID REFERENCES public.route_run_assignments(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL DEFAULT 'reassigned',
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,
  notes TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  decision_log_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_stop_reassignment_events_type_ck CHECK (btrim(event_type) <> ''),
  CONSTRAINT route_stop_reassignment_events_payload_object_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT route_stop_reassignment_events_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT route_stop_reassignment_events_route_split_ck CHECK (source_route_run_id IS DISTINCT FROM target_route_run_id)
);

CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events_org_created
  ON public.route_stop_reassignment_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events_source_created
  ON public.route_stop_reassignment_events (source_route_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events_target_created
  ON public.route_stop_reassignment_events (target_route_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_stop_reassignment_events_route_stop_created
  ON public.route_stop_reassignment_events (route_stop_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_stop_reassignment_events_stop_idempotency
  ON public.route_stop_reassignment_events (route_stop_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

ALTER TABLE public.route_stop_reassignment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_stop_reassignment_events_service_policy ON public.route_stop_reassignment_events;
CREATE POLICY route_stop_reassignment_events_service_policy
  ON public.route_stop_reassignment_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

REVOKE ALL ON TABLE public.route_stop_reassignment_events FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stop_reassignment_events FROM anon;
REVOKE ALL ON TABLE public.route_stop_reassignment_events FROM authenticated;
GRANT ALL ON TABLE public.route_stop_reassignment_events TO service_role;

-------------------------------------------------------------------------------
-- 3) Explicit partner handoff prep for active route-stop tasks
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_prepare_partner_handoff_v1(
  p_route_run_id UUID,
  p_route_stop_ids UUID[] DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_actor_system TEXT DEFAULT NULL
)
RETURNS TABLE (
  route_run_id UUID,
  unassigned_task_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_current_org_id UUID := NULL;
  v_is_service BOOLEAN := FALSE;
  v_is_platform BOOLEAN := FALSE;
  v_actor_user_id UUID := auth.uid();
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'route_partner_handoff');
  v_route_run public.route_runs%ROWTYPE;
  v_route_stop_ids UUID[] := COALESCE(p_route_stop_ids, ARRAY[]::uuid[]);
  v_selected_count INT := 0;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_task RECORD;
  v_task_unassign RECORD;
BEGIN
  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  v_is_service := session_user IN ('postgres', 'supabase_admin') OR v_role = 'service_role';
  v_is_platform := public.is_platform_user();
  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();
  v_current_org_id := public.current_user_org_id();

  IF NOT v_is_service THEN
    IF v_actor_user_id IS NULL THEN
      RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 requires authenticated user'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_scope_id) THEN
      RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 requires routes.write capability'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform THEN
      IF v_scope_type IS DISTINCT FROM 'tenant' THEN
        RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 requires tenant scope'
          USING ERRCODE = '42501';
      END IF;
      IF v_current_org_id IS NULL THEN
        RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 requires organization context'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF public.ui_get_resource_v1('routes', p_route_run_id) IS NULL THEN
      RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 route % is not visible to the current actor', p_route_run_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   FOR UPDATE;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', p_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_service AND NOT v_is_platform AND v_route_run.organization_id IS DISTINCT FROM v_current_org_id THEN
    RAISE EXCEPTION 'route_run % is outside the current organization', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF array_length(v_route_stop_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*)::int
      INTO v_selected_count
      FROM public.route_stops rs
     WHERE rs.route_run_id = p_route_run_id
       AND rs.id = ANY(v_route_stop_ids);

    IF v_selected_count <> array_length(v_route_stop_ids, 1) THEN
      RAISE EXCEPTION 'route_run_prepare_partner_handoff_v1 route_stop_ids must belong to route_run %', p_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', v_actor_system, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  BEGIN
    unassigned_task_count := 0;

    FOR v_task IN
      SELECT
        t.id,
        rs.id AS route_stop_id
      FROM public.route_stops rs
      JOIN public.tasks t
        ON t.resource_type = 'route_stop'
       AND t.resource_id = rs.id
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE rs.route_run_id = p_route_run_id
       AND (
         array_length(v_route_stop_ids, 1) IS NULL
         OR rs.id = ANY(v_route_stop_ids)
       )
       AND tt.organization_id = v_route_run.organization_id
       AND tt.key = 'route_stop_execute'
       AND t.assigned_to IS NOT NULL
       AND COALESCE(t.status, '') NOT IN ('completed', 'canceled')
     ORDER BY rs.sequence_order, rs.created_at, rs.id
    LOOP
      SELECT *
        INTO v_task_unassign
        FROM public.unassign_task_v1(
          v_task.id,
          format('route-partner-handoff:%s:%s', p_route_run_id, v_task.id),
          p_notes
        )
       LIMIT 1;

      IF v_task_unassign.task_event_id IS NOT NULL THEN
        unassigned_task_count := unassigned_task_count + 1;
      END IF;
    END LOOP;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);

  route_run_id := p_route_run_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.route_run_prepare_partner_handoff_v1(UUID, UUID[], TEXT, TEXT)
  IS 'Explicitly clear active route_stop_execute task ownership through the Tasks SSOT before partner-fleet takeover. Supports whole-route or selected-stop handoff preparation.';

REVOKE ALL ON FUNCTION public.route_run_prepare_partner_handoff_v1(UUID, UUID[], TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_prepare_partner_handoff_v1(UUID, UUID[], TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_prepare_partner_handoff_v1(UUID, UUID[], TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_prepare_partner_handoff_v1(UUID, UUID[], TEXT, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Canonical selected-stop reassignment
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reassign_route_stops_v1(
  p_input JSONB
)
RETURNS TABLE (
  source_route_run_id UUID,
  target_route_run_id UUID,
  target_route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_mode TEXT,
  assignment_version INT,
  driver_user_id UUID,
  vehicle_id UUID,
  partner JSONB,
  moved_stop_count INT,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_current_org_id UUID := NULL;
  v_is_service BOOLEAN := FALSE;
  v_is_platform BOOLEAN := FALSE;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_route_stop_ids_json JSONB := '[]'::jsonb;
  v_route_stop_ids UUID[] := ARRAY[]::uuid[];
  v_requested_driver_user_id UUID := NULL;
  v_requested_vehicle_id UUID := NULL;
  v_requested_partner JSONB := NULL;
  v_requested_mode TEXT := NULL;
  v_requested_notes TEXT := NULL;
  v_requested_metadata JSONB := '{}'::jsonb;
  v_reassignment_reason TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_target_route_idempotency TEXT := NULL;
  v_selected_count INT := 0;
  v_selected_org_count INT := 0;
  v_selected_org_id UUID := NULL;
  v_current_route_count INT := 0;
  v_ordered_route_stop_ids UUID[] := ARRAY[]::uuid[];
  v_source_route_run public.route_runs%ROWTYPE;
  v_source_route_stop_count INT := 0;
  v_target_route public.route_runs%ROWTYPE;
  v_source_assignment public.route_run_assignments%ROWTYPE;
  v_source_assignment_payload JSONB := NULL;
  v_target_assignment RECORD;
  v_target_assignment_payload JSONB := NULL;
  v_prepare_result RECORD;
  v_decision_id UUID := NULL;
  v_existing_source_route_run_id UUID := NULL;
  v_existing_assignment public.route_run_assignments%ROWTYPE;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  v_is_service := session_user IN ('postgres', 'supabase_admin') OR v_role = 'service_role';
  v_is_platform := public.is_platform_user();
  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();
  v_current_org_id := public.current_user_org_id();

  BEGIN
    v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_stop_reassignment');

  BEGIN
    v_requested_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_driver_user_id := NULL;
  END;

  BEGIN
    v_requested_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_vehicle_id := NULL;
  END;

  v_requested_partner := COALESCE(v_input->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_requested_partner) IS DISTINCT FROM 'object' THEN
    v_requested_partner := '{}'::jsonb;
  END IF;
  v_requested_partner := jsonb_strip_nulls(
    v_requested_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_input->>'partner_id', ''),
      'partner_name', NULLIF(v_input->>'partner_name', '')
    )
  );
  IF v_requested_partner = '{}'::jsonb THEN
    v_requested_partner := NULL;
  END IF;

  v_requested_notes := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_requested_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_requested_metadata) IS DISTINCT FROM 'object' THEN
    v_requested_metadata := '{}'::jsonb;
  END IF;
  v_reassignment_reason := NULLIF(btrim(COALESCE(v_input->>'reassignment_reason', '')), '');
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_target_route_idempotency := CASE
    WHEN v_idempotency_key IS NULL THEN NULL
    ELSE format('route-stop-reassign:create-route:%s', v_idempotency_key)
  END;

  IF v_requested_driver_user_id IS NOT NULL AND v_requested_partner IS NOT NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 accepts either internal driver or partner payload, not both'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_driver_user_id IS NULL AND v_requested_partner IS NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 requires driver_user_id or partner payload'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_partner IS NOT NULL AND v_requested_vehicle_id IS NOT NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 partner reassignment cannot set vehicle_id directly'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_partner IS NOT NULL THEN
    v_requested_mode := 'partner_fleet';
    v_requested_driver_user_id := NULL;
    v_requested_vehicle_id := NULL;
  ELSE
    v_requested_mode := 'internal_driver';
  END IF;

  v_route_stop_ids_json := COALESCE(v_input->'route_stop_ids', '[]'::jsonb);
  IF jsonb_typeof(v_route_stop_ids_json) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 requires route_stop_ids array'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[])
      INTO v_route_stop_ids
      FROM jsonb_array_elements_text(v_route_stop_ids_json) AS item(value);
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'reassign_route_stops_v1 route_stop_ids must be UUID strings'
        USING ERRCODE = '23514';
  END;

  IF array_length(v_route_stop_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 requires at least one route_stop_id'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'reassign_route_stops_v1 requires authenticated user'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_scope_id) THEN
      RAISE EXCEPTION 'reassign_route_stops_v1 requires routes.write capability'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform THEN
      IF v_scope_type IS DISTINCT FROM 'tenant' THEN
        RAISE EXCEPTION 'reassign_route_stops_v1 requires tenant scope'
          USING ERRCODE = '42501';
      END IF;
      IF v_current_org_id IS NULL THEN
        RAISE EXCEPTION 'reassign_route_stops_v1 requires organization context'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_actor_user_id := COALESCE(v_actor_user_id, auth.uid());
  ELSIF v_actor_user_id IS NULL THEN
    BEGIN
      v_actor_user_id := NULLIF(v_claims->>'sub', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_actor_user_id := NULL;
    END;
  END IF;

  SELECT
    COUNT(*)::int,
    COUNT(DISTINCT rs.organization_id)::int,
    MIN(rs.organization_id::text)::uuid
    INTO v_selected_count,
         v_selected_org_count,
         v_selected_org_id
    FROM public.route_stops rs
   WHERE rs.id = ANY(v_route_stop_ids);

  IF v_selected_count <> array_length(v_route_stop_ids, 1) THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 route_stop_ids must reference visible existing stops'
      USING ERRCODE = '23514';
  END IF;

  IF v_selected_org_count <> 1 OR v_selected_org_id IS NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 route_stop_ids must belong to one organization'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_is_service AND NOT v_is_platform AND v_selected_org_id IS DISTINCT FROM v_current_org_id THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 route_stop_ids are outside the current organization'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_service THEN
    PERFORM 1
      FROM unnest(v_route_stop_ids) AS selected_id
     WHERE public.ui_get_resource_v1('route_stops', selected_id) IS NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'reassign_route_stops_v1 route_stop selection includes records not visible to the current actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_target_route_idempotency IS NOT NULL THEN
    SELECT *
      INTO v_target_route
      FROM public.route_runs rr
     WHERE rr.organization_id = v_selected_org_id
       AND rr.idempotency_key = v_target_route_idempotency
     LIMIT 1;

    IF v_target_route.id IS NOT NULL THEN
      BEGIN
        v_existing_source_route_run_id := NULLIF(v_target_route.metadata#>>'{stop_reassignment,source_route_run_id}', '')::uuid;
      EXCEPTION
        WHEN others THEN
          v_existing_source_route_run_id := NULL;
      END;

      SELECT *
        INTO v_existing_assignment
        FROM public.route_run_assignments rra
       WHERE rra.route_run_id = v_target_route.id
       LIMIT 1;

      SELECT COUNT(*)::int
        INTO moved_stop_count
        FROM public.route_stops rs
       WHERE rs.route_run_id = v_target_route.id
         AND rs.id = ANY(v_route_stop_ids);

      source_route_run_id := v_existing_source_route_run_id;
      target_route_run_id := v_target_route.id;
      target_route_run_assignment_id := v_existing_assignment.id;
      assignment_status := v_existing_assignment.assignment_status;
      assignment_mode := v_existing_assignment.assignment_mode;
      assignment_version := v_existing_assignment.assignment_version;
      driver_user_id := v_existing_assignment.driver_user_id;
      vehicle_id := v_existing_assignment.vehicle_id;
      partner := COALESCE(v_existing_assignment.partner, '{}'::jsonb);
      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT
    COUNT(DISTINCT rs.route_run_id)::int,
    MIN(rs.route_run_id::text)::uuid,
    COALESCE(array_agg(rs.id ORDER BY rs.sequence_order, rs.created_at, rs.id), ARRAY[]::uuid[])
    INTO v_current_route_count,
         source_route_run_id,
         v_ordered_route_stop_ids
    FROM public.route_stops rs
   WHERE rs.id = ANY(v_route_stop_ids);

  IF v_current_route_count <> 1 OR source_route_run_id IS NULL THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 route_stop_ids must belong to one source route_run'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_source_route_run
    FROM public.route_runs rr
   WHERE rr.id = source_route_run_id
   FOR UPDATE;

  IF v_source_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', source_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF v_source_route_run.status IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 cannot mutate terminal route_run status %', v_source_route_run.status
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.route_stops rs
   WHERE rs.id = ANY(v_ordered_route_stop_ids)
   FOR UPDATE;

  SELECT COUNT(*)::int
    INTO v_source_route_stop_count
    FROM public.route_stops rs
   WHERE rs.route_run_id = source_route_run_id;

  IF v_selected_count >= v_source_route_stop_count THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 requires a subset of stops; use routes.reassign for whole-route takeover'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.route_stops rs
    LEFT JOIN LATERAL (
      SELECT t.status
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND t.resource_id = rs.id
         AND tt.organization_id = v_source_route_run.organization_id
         AND tt.key = 'route_stop_execute'
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1
    ) task_state ON TRUE
   WHERE rs.id = ANY(v_ordered_route_stop_ids)
     AND (
       NULLIF(btrim(COALESCE(rs.metadata->>'shipment_action', '')), '') IS NOT NULL
       OR COALESCE(task_state.status, '') IN ('completed', 'canceled')
     );
  IF FOUND THEN
    RAISE EXCEPTION 'reassign_route_stops_v1 cannot move completed route stops'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_source_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = source_route_run_id
   LIMIT 1;

  v_source_assignment_payload := public.route_run_assignment_projection_v1(source_route_run_id);

  BEGIN
    INSERT INTO public.route_runs (
      organization_id,
      branch_id,
      driver_user_id,
      vehicle_id,
      status,
      planned_date,
      planned_start_at,
      planned_end_at,
      started_at,
      ended_at,
      metadata,
      route_plan_id,
      idempotency_key,
      idempotency_hash
    )
    VALUES (
      v_source_route_run.organization_id,
      v_source_route_run.branch_id,
      NULL,
      NULL,
      v_source_route_run.status,
      v_source_route_run.planned_date,
      v_source_route_run.planned_start_at,
      v_source_route_run.planned_end_at,
      CASE
        WHEN v_source_route_run.status = 'in_progress'
          THEN COALESCE(v_source_route_run.started_at, now())
        ELSE NULL
      END,
      NULL,
      jsonb_strip_nulls(
        (COALESCE(v_source_route_run.metadata, '{}'::jsonb) - 'route_assignment' - 'route_execution_manifest')
        || jsonb_build_object(
          'stop_reassignment',
          jsonb_strip_nulls(
            jsonb_build_object(
              'source_route_run_id', source_route_run_id,
              'route_stop_ids', to_jsonb(v_ordered_route_stop_ids),
              'reassignment_reason', v_reassignment_reason,
              'source_assignment', NULLIF(v_source_assignment_payload, '{}'::jsonb),
              'request_metadata', NULLIF(v_requested_metadata, '{}'::jsonb),
              'actor_user_id', v_actor_user_id,
              'actor_system', v_actor_system,
              'idempotency_key', v_idempotency_key,
              'created_at', now()
            )
          )
        )
      ),
      v_source_route_run.route_plan_id,
      v_target_route_idempotency,
      NULL
    )
    RETURNING *
      INTO v_target_route;
  EXCEPTION
    WHEN unique_violation THEN
      IF v_target_route_idempotency IS NULL THEN
        RAISE;
      END IF;

      SELECT *
        INTO v_target_route
        FROM public.route_runs rr
       WHERE rr.organization_id = v_source_route_run.organization_id
         AND rr.idempotency_key = v_target_route_idempotency
       LIMIT 1;

      IF v_target_route.id IS NULL THEN
        RAISE;
      END IF;
  END;

  WITH selected AS (
    SELECT
      rs.id,
      row_number() OVER (ORDER BY rs.sequence_order, rs.created_at, rs.id) AS next_sequence
    FROM public.route_stops rs
    WHERE rs.id = ANY(v_ordered_route_stop_ids)
  )
  UPDATE public.route_stops rs
     SET route_run_id = v_target_route.id,
         sequence_order = selected.next_sequence
    FROM selected
   WHERE rs.id = selected.id;

  WITH remaining AS (
    SELECT
      rs.id,
      row_number() OVER (ORDER BY rs.sequence_order, rs.created_at, rs.id) AS next_sequence
    FROM public.route_stops rs
    WHERE rs.route_run_id = source_route_run_id
  )
  UPDATE public.route_stops rs
     SET sequence_order = remaining.next_sequence
    FROM remaining
   WHERE rs.id = remaining.id
     AND rs.sequence_order IS DISTINCT FROM remaining.next_sequence;

  IF v_requested_mode = 'partner_fleet' THEN
    SELECT *
      INTO v_prepare_result
      FROM public.route_run_prepare_partner_handoff_v1(
        v_target_route.id,
        NULL,
        v_requested_notes,
        v_actor_system
      )
     LIMIT 1;
  END IF;

  SELECT *
    INTO v_target_assignment
    FROM public.assign_route_run_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'action_key', 'route_stops.reassign',
          'route_run_id', v_target_route.id,
          'driver_user_id', v_requested_driver_user_id,
          'vehicle_id', v_requested_vehicle_id,
          'partner', CASE WHEN v_requested_partner IS NULL THEN NULL ELSE v_requested_partner END,
          'notes', v_requested_notes,
          'idempotency_key', CASE
            WHEN v_idempotency_key IS NULL THEN NULL
            ELSE format('route-stop-reassign:assign:%s', v_idempotency_key)
          END,
          'metadata',
            jsonb_strip_nulls(
              v_requested_metadata
              || jsonb_build_object(
                'reassignment_reason', v_reassignment_reason,
                'source_route_run_id', source_route_run_id,
                'source_assignment', NULLIF(v_source_assignment_payload, '{}'::jsonb),
                'moved_route_stop_ids', to_jsonb(v_ordered_route_stop_ids)
              )
            ),
          'actor_user_id', v_actor_user_id,
          'actor_system', v_actor_system
        )
      )
    )
   LIMIT 1;

  v_target_assignment_payload := public.route_run_assignment_projection_v1(v_target_route.id);

  v_decision_id := public.log_decision(
    p_organization_id := v_source_route_run.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'route_run',
    p_resource_id := source_route_run_id,
    p_decision_point := 'reassign_stops',
    p_decision_outcome := 'reassigned',
    p_performed_by_system := v_actor_system,
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(
      jsonb_build_object(
        'source_route_run_id', source_route_run_id,
        'target_route_run_id', v_target_route.id,
        'route_stop_ids', to_jsonb(v_ordered_route_stop_ids),
        'assignment_mode', v_target_assignment.assignment_mode,
        'driver_user_id', v_target_assignment.driver_user_id,
        'vehicle_id', v_target_assignment.vehicle_id,
        'partner', NULLIF(v_target_assignment.partner, '{}'::jsonb),
        'reassignment_reason', v_reassignment_reason,
        'metadata', NULLIF(v_requested_metadata, '{}'::jsonb)
      )
    ),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.route_stop_reassignment_events (
    organization_id,
    route_stop_id,
    client_id,
    shipment_id,
    source_route_run_id,
    target_route_run_id,
    source_route_run_assignment_id,
    target_route_run_assignment_id,
    event_type,
    actor_user_id,
    actor_system,
    notes,
    payload,
    idempotency_key,
    decision_log_id
  )
  SELECT
    rs.organization_id,
    rs.id,
    rs.client_id,
    rs.shipment_id,
    source_route_run_id,
    v_target_route.id,
    v_source_assignment.id,
    v_target_assignment.route_run_assignment_id,
    'reassigned',
    v_actor_user_id,
    v_actor_system,
    v_requested_notes,
    jsonb_strip_nulls(
      jsonb_build_object(
        'reassignment_reason', v_reassignment_reason,
        'source_assignment', NULLIF(v_source_assignment_payload, '{}'::jsonb),
        'target_assignment', NULLIF(v_target_assignment_payload, '{}'::jsonb),
        'metadata', NULLIF(v_requested_metadata, '{}'::jsonb),
        'correlation_id', public.current_correlation_id()
      )
    ),
    CASE
      WHEN v_idempotency_key IS NULL THEN NULL
      ELSE format('route-stop-reassign:event:%s:%s', v_idempotency_key, rs.id)
    END,
    v_decision_id
  FROM public.route_stops rs
  WHERE rs.id = ANY(v_ordered_route_stop_ids);

  target_route_run_id := v_target_route.id;
  target_route_run_assignment_id := v_target_assignment.route_run_assignment_id;
  assignment_status := v_target_assignment.assignment_status;
  assignment_mode := v_target_assignment.assignment_mode;
  assignment_version := v_target_assignment.assignment_version;
  driver_user_id := v_target_assignment.driver_user_id;
  vehicle_id := v_target_assignment.vehicle_id;
  partner := COALESCE(v_target_assignment.partner, '{}'::jsonb);
  moved_stop_count := array_length(v_ordered_route_stop_ids, 1);
  created := TRUE;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.reassign_route_stops_v1(JSONB)
  IS 'Canonical selected-stop reassignment path. Splits selected route_stops into a new route_run, preserves append-only reassignment evidence, and delegates target ownership to assign_route_run_v1.';

REVOKE ALL ON FUNCTION public.reassign_route_stops_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_route_stops_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.reassign_route_stops_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Browser-safe UI executors + command registry
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_route_run_assign_v1(
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
  v_ctx RECORD;
  v_registry JSONB := public.resolve_settings_merged(
    'ui_command_registry',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );
  v_command JSONB := NULL;
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_count INT := 0;
  v_route_run_id UUID := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_prepare_result RECORD;
  v_result RECORD;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_run_actor_context_v1('write')
   LIMIT 1;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection above maximum %', v_max;
  END IF;

  BEGIN
    v_route_run_id := NULLIF(COALESCE(v_id, v_ids[1]), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 invalid route id %', COALESCE(v_id, v_ids[1], '')
      USING ERRCODE = '23514';
  END IF;

  IF public.ui_get_resource_v1(p_resource_key, v_route_run_id) IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 route % is not visible in resource %', v_route_run_id, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  v_partner := COALESCE(v_params->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_partner := jsonb_strip_nulls(
    v_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_params->>'partner_id', ''),
      'partner_name', NULLIF(v_params->>'partner_name', '')
    )
  );

  v_metadata := COALESCE(v_params->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  v_metadata := jsonb_strip_nulls(
    v_metadata
    || jsonb_build_object(
      'reassignment_reason', NULLIF(v_params->>'reassignment_reason', '')
    )
  );

  IF v_partner <> '{}'::jsonb THEN
    SELECT *
      INTO v_prepare_result
      FROM public.route_run_prepare_partner_handoff_v1(
        v_route_run_id,
        NULL,
        NULLIF(v_params->>'notes', ''),
        'route_assignment_ui'
      )
     LIMIT 1;
  END IF;

  SELECT *
    INTO v_result
    FROM public.assign_route_run_v1(
      jsonb_strip_nulls(
        v_params
        || jsonb_build_object(
          'action_key', p_action_key,
          'route_run_id', v_route_run_id,
          'driver_user_id', NULLIF(v_params->>'driver_user_id', ''),
          'vehicle_id', NULLIF(v_params->>'vehicle_id', ''),
          'partner', CASE WHEN v_partner = '{}'::jsonb THEN NULL ELSE v_partner END,
          'partner_id', NULLIF(v_params->>'partner_id', ''),
          'partner_name', NULLIF(v_params->>'partner_name', ''),
          'notes', NULLIF(v_params->>'notes', ''),
          'idempotency_key', NULLIF(v_params->>'idempotency_key', ''),
          'metadata', v_metadata,
          'actor_user_id', v_ctx.user_id,
          'actor_system', 'route_assignment_ui'
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'assigned',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_run_id', v_result.route_run_id,
          'route_run_assignment_id', v_result.route_run_assignment_id,
          'assignment_status', v_result.assignment_status,
          'assignment_mode', v_result.assignment_mode,
          'assignment_version', v_result.assignment_version,
          'driver_user_id', v_result.driver_user_id,
          'vehicle_id', v_result.vehicle_id,
          'partner', v_result.partner,
          'stop_task_count', v_result.stop_task_count,
          'assigned_task_count', v_result.assigned_task_count,
          'created', v_result.created
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated UI command executor for route assignment and reassignment. Partner-fleet takeover routes through route_run_prepare_partner_handoff_v1 before assign_route_run_v1 so task ownership changes stay explicit.';

REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_run_assign_v1(
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
AS $function$
  SELECT public.ui_execute_route_run_assign_v1($1, $2, $3, $4, $5, $6);
$function$;

REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_execute_route_stop_reassign_v1(
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
  v_ctx RECORD;
  v_registry JSONB := public.resolve_settings_merged(
    'ui_command_registry',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );
  v_command JSONB := NULL;
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_count INT := 0;
  v_route_stop_ids JSONB := '[]'::jsonb;
  v_result RECORD;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_run_actor_context_v1('write')
   LIMIT 1;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 selection above maximum %', v_max;
  END IF;

  IF array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_stop_reassign_v1 requires selected route_stop ids'
      USING ERRCODE = '23514';
  END IF;

  v_route_stop_ids := to_jsonb(v_ids);

  SELECT *
    INTO v_result
    FROM public.reassign_route_stops_v1(
      jsonb_strip_nulls(
        v_params
        || jsonb_build_object(
          'action_key', p_action_key,
          'route_stop_ids', v_route_stop_ids,
          'driver_user_id', NULLIF(v_params->>'driver_user_id', ''),
          'vehicle_id', NULLIF(v_params->>'vehicle_id', ''),
          'partner_id', NULLIF(v_params->>'partner_id', ''),
          'partner_name', NULLIF(v_params->>'partner_name', ''),
          'notes', NULLIF(v_params->>'notes', ''),
          'reassignment_reason', NULLIF(v_params->>'reassignment_reason', ''),
          'idempotency_key', NULLIF(v_params->>'idempotency_key', ''),
          'metadata', COALESCE(v_params->'metadata', '{}'::jsonb),
          'actor_user_id', v_ctx.user_id,
          'actor_system', 'route_assignment_ui'
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'assigned',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', v_result.moved_stop_count,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'source_route_run_id', v_result.source_route_run_id,
          'target_route_run_id', v_result.target_route_run_id,
          'route_run_assignment_id', v_result.target_route_run_assignment_id,
          'assignment_status', v_result.assignment_status,
          'assignment_mode', v_result.assignment_mode,
          'assignment_version', v_result.assignment_version,
          'driver_user_id', v_result.driver_user_id,
          'vehicle_id', v_result.vehicle_id,
          'partner', v_result.partner,
          'moved_stop_count', v_result.moved_stop_count,
          'created', v_result.created
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated UI command executor for selected route-stop reassignment. Splits the selected stops into a new route_run and preserves append-only reassignment evidence.';

REVOKE ALL ON FUNCTION public.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_stop_reassign_v1(
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
AS $function$
  SELECT public.ui_execute_route_stop_reassign_v1($1, $2, $3, $4, $5, $6);
$function$;

REVOKE ALL ON FUNCTION api.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_stop_reassign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.settings_version_id,
      sv.version,
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

    v_commands := (
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      FROM jsonb_array_elements(v_commands) AS value
      WHERE value->>'key' <> 'route_stops.reassign'
    );

    v_commands := v_commands || jsonb_build_array(
      jsonb_build_object(
        'key', 'route_stops.reassign',
        'label', 'Reassign selected stops',
        'schema_category', 'resource:route_stops',
        'capability', 'routes.write',
        'selection', jsonb_build_object('mode', 'any', 'min_count', 1),
        'execution', jsonb_build_object(
          'type', 'rpc',
          'rpc', 'ui_execute_route_stop_reassign_v1'
        ),
        'input_schema', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'driver_user_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'vehicle_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
            'partner_id', jsonb_build_object('type', 'string'),
            'partner_name', jsonb_build_object('type', 'string'),
            'notes', jsonb_build_object('type', 'string'),
            'reassignment_reason', jsonb_build_object('type', 'string')
          )
        )
      )
    );

    v_next := jsonb_set(v_current, '{commands}', v_commands, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604101715_uc078_route_stop_mid_execution_reassignment_v1'));
COMMIT;
