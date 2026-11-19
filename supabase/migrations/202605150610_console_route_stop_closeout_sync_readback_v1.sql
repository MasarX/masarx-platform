-- Plan: First-tenant Console V2 production readiness
-- Step: route-stop closeout browser readback
--
-- Console V2 route-stop closeout must not ask the operator to refresh while the
-- canonical workflow projection catches up. This wrapper keeps the existing
-- task -> domain_event -> workflow -> shipment_actions path intact, but gives
-- the browser mutation a bounded backend-backed readback gate for the specific
-- route_stop_execute task event it just created.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605150610_console_route_stop_closeout_sync_readback_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_finalize_route_stop_closeout_event_v1(
  p_task_event_id UUID,
  p_max_iterations INTEGER DEFAULT 50
)
RETURNS TABLE (
  task_event_id UUID,
  workflow_run_id UUID,
  workflow_status TEXT,
  shipment_action_id UUID,
  shipment_id UUID,
  route_stop_id UUID
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_task_event public.task_events%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_task_type_key TEXT;
  v_domain_event_id UUID;
  v_workflow_run_id UUID;
  v_workflow_status TEXT;
  v_shipment_action_id UUID;
  v_shipment_id UUID;
  v_route_stop_id UUID;
  v_iter INTEGER;
  v_max_iterations INTEGER := LEAST(GREATEST(COALESCE(p_max_iterations, 50), 1), 100);
  v_last_error TEXT;
BEGIN
  IF p_task_event_id IS NULL THEN
    RAISE EXCEPTION 'ui_finalize_route_stop_closeout_event_v1 requires task_event_id';
  END IF;

  SELECT *
    INTO v_task_event
    FROM public.task_events te
   WHERE te.id = p_task_event_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route-stop closeout task_event % not found', p_task_event_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = v_task_event.task_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route-stop closeout task % not found', v_task_event.task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS DISTINCT FROM 'route_stop_execute'
     OR v_task.resource_type IS DISTINCT FROM 'route_stop'
     OR v_task.resource_id IS NULL THEN
    RAISE EXCEPTION 'task_event % is not a route_stop_execute closeout event', p_task_event_id
      USING ERRCODE = '23514';
  END IF;

  IF lower(COALESCE(v_task_event.to_status, '')) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'task_event % is not a completed route-stop closeout', p_task_event_id
      USING ERRCODE = '23514';
  END IF;

  IF public.ui_get_resource_v1('tasks', v_task.id) IS NULL THEN
    RAISE EXCEPTION 'route-stop closeout task % is not visible to the current operator', v_task.id
      USING ERRCODE = '42501';
  END IF;

  v_route_stop_id := v_task.resource_id;
  SELECT rs.shipment_id
    INTO v_shipment_id
    FROM public.route_stops rs
   WHERE rs.id = v_route_stop_id
     AND rs.organization_id = v_task.organization_id
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'route-stop closeout shipment readback unavailable for stop %', v_route_stop_id
      USING ERRCODE = '23503';
  END IF;

  FOR v_iter IN 1..v_max_iterations LOOP
    SELECT de.id, de.workflow_run_id
      INTO v_domain_event_id, v_workflow_run_id
      FROM public.domain_events de
     WHERE de.organization_id = v_task.organization_id
       AND de.event_type = 'task.completed.route_stop_execute'
       AND de.payload->>'task_event_id' = p_task_event_id::text
     ORDER BY de.created_at DESC
     LIMIT 1;

    EXIT WHEN v_workflow_run_id IS NOT NULL;

    UPDATE public.cron_config
       SET last_run_at = NULL
     WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
  END LOOP;

  IF v_domain_event_id IS NULL THEN
    RAISE EXCEPTION 'route-stop closeout domain event readback unavailable for task_event %', p_task_event_id
      USING ERRCODE = '23503';
  END IF;

  IF v_workflow_run_id IS NULL THEN
    SELECT de.workflow_run_id
      INTO v_workflow_run_id
      FROM public.domain_events de
     WHERE de.id = v_domain_event_id
     LIMIT 1;
  END IF;

  IF v_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'route-stop closeout workflow run readback unavailable for task_event %', p_task_event_id
      USING ERRCODE = '23503';
  END IF;

  FOR v_iter IN 1..v_max_iterations LOOP
    SELECT wr.workflow_status
      INTO v_workflow_status
      FROM public.workflow_runs wr
     WHERE wr.id = v_workflow_run_id
     LIMIT 1;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled', 'canceled');

    PERFORM public.progress_workflow_run(v_workflow_run_id, '{}'::jsonb);
  END LOOP;

  IF v_workflow_status IS DISTINCT FROM 'completed' THEN
    SELECT wrs.last_error
      INTO v_last_error
      FROM public.workflow_run_steps wrs
     WHERE wrs.workflow_run_id = v_workflow_run_id
       AND wrs.status = 'failed'
     ORDER BY wrs.sequence_order
     LIMIT 1;

    RAISE EXCEPTION 'route-stop closeout workflow did not complete for task_event %: % %',
      p_task_event_id,
      COALESCE(v_workflow_status, 'missing'),
      COALESCE(v_last_error, '')
      USING ERRCODE = '23514';
  END IF;

  SELECT sa.id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_id
     AND sa.organization_id = v_task.organization_id
     AND sa.action_data->>'task_event_id' = p_task_event_id::text
   ORDER BY sa.timestamp DESC, sa.created_at DESC
   LIMIT 1;

  IF v_shipment_action_id IS NULL THEN
    RAISE EXCEPTION 'route-stop closeout shipment_action readback unavailable for task_event %', p_task_event_id
      USING ERRCODE = '23503';
  END IF;

  task_event_id := p_task_event_id;
  workflow_run_id := v_workflow_run_id;
  workflow_status := v_workflow_status;
  shipment_action_id := v_shipment_action_id;
  shipment_id := v_shipment_id;
  route_stop_id := v_route_stop_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION api.ui_finalize_route_stop_closeout_event_v1(UUID, INTEGER)
  IS 'Console V2 browser-safe route-stop closeout readback gate: dispatches/progresses the canonical task.completed.route_stop_execute workflow for one task_event and returns shipment_action proof.';

REVOKE ALL ON FUNCTION api.ui_finalize_route_stop_closeout_event_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_finalize_route_stop_closeout_event_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_finalize_route_stop_closeout_event_v1(UUID, INTEGER) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605150610_console_route_stop_closeout_sync_readback_v1'));

COMMIT;
