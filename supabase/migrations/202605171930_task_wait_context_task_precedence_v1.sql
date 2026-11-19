BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
DECLARE
  v_definition text;
  v_old text := $old$
  v_task_id_text TEXT := COALESCE(
    NULLIF(btrim(COALESCE(p_step.operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'task_id', '')), ''),
    CASE
      WHEN jsonb_typeof(v_ctx->v_context_key) = 'object' THEN NULLIF(btrim(COALESCE((v_ctx->v_context_key)->>'task_id', '')), '')
      ELSE NULL
    END,
    NULLIF(btrim(COALESCE(p_operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'task_id', '')), '')
  );
$old$;
  v_branch_current text := $current$
  v_task_id_text TEXT := COALESCE(
    NULLIF(btrim(COALESCE(p_operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(p_step.operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'task_id', '')), ''),
    CASE
      WHEN jsonb_typeof(v_ctx->v_context_key) = 'object' THEN NULLIF(btrim(COALESCE((v_ctx->v_context_key)->>'task_id', '')), '')
      ELSE NULL
    END,
    NULLIF(btrim(COALESCE(v_ctx->>'task_id', '')), '')
  );
$current$;
  v_new text := $new$
  v_task_id_text TEXT := COALESCE(
    CASE
      WHEN jsonb_typeof(v_ctx->v_context_key) = 'object' THEN NULLIF(btrim(COALESCE((v_ctx->v_context_key)->>'task_id', '')), '')
      ELSE NULL
    END,
    NULLIF(btrim(COALESCE(p_step.operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(p_operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(p_operation_result->>'completed_task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'task_id', '')), '')
  );
$new$;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_task_wait_v2(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
    INTO v_definition;

  IF position(v_new IN v_definition) > 0 THEN
    RETURN;
  ELSIF position(v_old IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_old, v_new);
  ELSIF position(v_branch_current IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_branch_current, v_new);
  ELSE
    RAISE EXCEPTION 'execute_task_wait_v2 task id precedence block not found';
  END IF;
END $$;

COMMIT;
