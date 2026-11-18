-- Migration: route partner-handoff assignment epoch v1
-- Purpose: keep repeated internal-to-partner handoffs idempotent within one
-- task assignment epoch without replaying an event from an older assignment.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260919004000_route_partner_handoff_epoch_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_is_service := COALESCE(v_role = 'service_role', FALSE);
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
        t.version,
        t.assigned_to,
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
     ORDER BY rs.sequence_order, rs.created_at, rs.id, t.id
     FOR UPDATE OF t
    LOOP
      SELECT *
        INTO v_task_unassign
        FROM public.unassign_task_v1(
          v_task.id,
          format(
            'route-partner-handoff:%s:%s:v%s:%s',
            p_route_run_id,
            v_task.id,
            v_task.version,
            v_task.assigned_to
          ),
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

SELECT pg_advisory_unlock(hashtext('20260919004000_route_partner_handoff_epoch_v1'));
COMMIT;
