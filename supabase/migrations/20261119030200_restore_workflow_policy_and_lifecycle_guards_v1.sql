BEGIN;
SET LOCAL lock_timeout = '10s';

DO $geocoding$
DECLARE
  v_definition text := pg_get_functiondef(
    'workflow_handlers.geocoding_resolve_policy_for_run(public.workflow_runs)'::regprocedure
  );
  v_before CONSTANT text := $before$  FROM public.geocoding_extract_context(p_run);

  IF v_ctx.sender_id IS NOT NULL THEN$before$;
  v_after CONSTANT text := $after$  FROM public.geocoding_extract_policy_context_v1(p_run);

  IF v_ctx.webhook_source_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.webhook_sources ws
      LEFT JOIN public.senders s ON s.id = ws.sender_id
      WHERE ws.id = v_ctx.webhook_source_id
        AND ws.organization_id = v_ctx.organization_id
        AND (ws.sender_id IS NULL OR ws.sender_id = v_ctx.sender_id)
        AND (s.client_id IS NULL OR s.client_id = v_ctx.client_id)
    ) THEN
      RAISE EXCEPTION 'Webhook source is outside the geocoding workflow scope' USING ERRCODE = '23514';
    END IF;

    SELECT r.policy INTO v_policy
    FROM public.geocoding_resolve_policy(
      v_ctx.organization_id, v_ctx.client_id, v_ctx.sender_id, v_ctx.webhook_source_id
    ) r;
    RETURN COALESCE(v_policy, '{}'::jsonb);
  ELSIF v_ctx.sender_id IS NOT NULL THEN$after$;
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_before, '')) <> length(v_before) THEN
    RAISE EXCEPTION 'Unexpected workflow geocoding policy resolver definition';
  END IF;
  EXECUTE replace(v_definition, v_before, v_after);
END;
$geocoding$;

DO $settlement$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.prevent_stale_settlement_task_completion_v1()'::regprocedure
  );
  v_before CONSTANT text := $before$  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'completed'
     OR NEW.resource_type IS DISTINCT FROM 'settlement_batch' THEN
    RETURN NEW;
  END IF;$before$;
  v_after CONSTANT text := $after$  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.resource_type IS DISTINCT FROM 'settlement_batch'
     OR lower(NEW.status) IN ('canceled', 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'completed' AND NOT EXISTS (
    SELECT 1
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'task_status'
      AND lower(lv.value) = lower(NEW.status)
      AND lv.metadata->'is_terminal' = 'true'::jsonb
  ) THEN
    RETURN NEW;
  END IF;$after$;
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_before, '')) <> length(v_before) THEN
    RAISE EXCEPTION 'Unexpected stale settlement task guard definition';
  END IF;
  EXECUTE replace(v_definition, v_before, v_after);
END;
$settlement$;

DO $wait$
DECLARE
  v_definition text := pg_get_functiondef(
    'workflow_handlers.execute_wait_for_shipment_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  );
  v_before CONSTANT text := $before$  IF p_step.operation_started_at IS NOT NULL THEN
    v_elapsed_seconds := GREATEST(0, (extract(epoch FROM (v_now - p_step.operation_started_at)))::INT);
  END IF;$before$;
  v_after CONSTANT text := $after$  v_elapsed_seconds := GREATEST(0, (extract(epoch FROM (
    v_now - COALESCE(p_step.operation_started_at, p_step.enqueued_at, p_step.created_at, p_step.updated_at)
  )))::INT);$after$;
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_before, '')) <> length(v_before) THEN
    RAISE EXCEPTION 'Unexpected shipment wait timeout definition';
  END IF;
  EXECUTE replace(v_definition, v_before, v_after);
END;
$wait$;

COMMIT;
