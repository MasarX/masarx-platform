BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.run_workflow_run_triggers_worker()
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_trigger RECORD;
  v_fire RECORD;
  v_source_run RECORD;
  v_scan_from TIMESTAMPTZ;
  v_max_completed_at TIMESTAMPTZ;
  v_context_payload JSONB;
  v_target_run_id UUID;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_run_triggers_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('workflow_run_triggers_worker');

  -- 1) Insert missing fires for eligible terminal runs (no backfill; scan from created_at/watermark).
  FOR v_trigger IN
    SELECT *
    FROM public.workflow_run_triggers
    WHERE enabled = TRUE
    ORDER BY updated_at ASC, id ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    v_scan_from := COALESCE(v_trigger.last_scanned_completed_at, v_trigger.created_at);
    v_max_completed_at := NULL;

    WITH eligible AS (
      SELECT
        wr.id,
        wr.completed_at
      FROM public.workflow_runs wr
      WHERE wr.workflow_template_id = v_trigger.source_workflow_template_id
        AND wr.completed_at IS NOT NULL
        AND wr.completed_at > v_scan_from
        AND wr.workflow_status = ANY(v_trigger.source_statuses)
      ORDER BY wr.completed_at ASC, wr.id ASC
      LIMIT 250
    ),
    ins AS (
      INSERT INTO public.workflow_trigger_fires (
        organization_id,
        workflow_run_trigger_id,
        source_workflow_run_id,
        fire_status,
        created_at,
        updated_at
      )
      SELECT
        v_trigger.organization_id,
        v_trigger.id,
        e.id,
        'pending',
        now(),
        now()
      FROM eligible e
      ON CONFLICT (workflow_run_trigger_id, source_workflow_run_id) DO NOTHING
      RETURNING source_workflow_run_id
    )
    SELECT max(completed_at) INTO v_max_completed_at FROM eligible;

    IF v_max_completed_at IS NOT NULL THEN
      UPDATE public.workflow_run_triggers
      SET
        last_scanned_completed_at = v_max_completed_at,
        updated_at = now()
      WHERE id = v_trigger.id;
    END IF;
  END LOOP;

  -- 2) Claim and process pending fires.
  FOR v_fire IN
    SELECT f.*
    FROM public.workflow_trigger_fires f
    JOIN public.workflow_run_triggers t ON t.id = f.workflow_run_trigger_id
    WHERE f.fire_status = 'pending'
      AND t.enabled = TRUE
    ORDER BY f.created_at ASC, f.id ASC
    LIMIT LEAST(v_throttle.batch_size, 200)
    FOR UPDATE OF f SKIP LOCKED
  LOOP
    v_items_processed := v_items_processed + 1;
    BEGIN
      UPDATE public.workflow_trigger_fires
      SET
        fire_status = 'claimed',
        claimed_at = v_now,
        claimed_by = 'workflow_run_triggers_worker',
        attempts = attempts + 1,
        last_error = NULL,
        updated_at = now()
      WHERE id = v_fire.id;

      SELECT * INTO v_trigger
      FROM public.workflow_run_triggers
      WHERE id = v_fire.workflow_run_trigger_id
      LIMIT 1;

      SELECT workflow_status, completed_at, context INTO v_source_run
      FROM public.workflow_runs
      WHERE id = v_fire.source_workflow_run_id
      LIMIT 1;

      v_context_payload := COALESCE(v_trigger.context_patch, '{}'::jsonb) || jsonb_build_object(
        'trigger_source', 'workflow_run_trigger',
        'trigger_type', 'workflow_run_trigger',
        'idempotency_key', format('wrt:%s:src_run:%s', v_trigger.id, v_fire.source_workflow_run_id),
        'organization_id', v_trigger.organization_id,
        'workflow_run_trigger_id', v_trigger.id,
        'workflow_trigger_fire_id', v_fire.id,
        'scope_type', v_trigger.scope_type,
        'scope_id', v_trigger.scope_id,
        'performed_by_system', 'workflow_run_triggers_worker',
        'request_context_id', v_context,
        'source', jsonb_build_object(
          'workflow_run_id', v_fire.source_workflow_run_id,
          'workflow_template_id', v_trigger.source_workflow_template_id,
          'workflow_status', v_source_run.workflow_status,
          'completed_at', v_source_run.completed_at
        ),
        'source_context', COALESCE(v_source_run.context, '{}'::jsonb)
      );

      v_target_run_id := public.start_workflow_run(v_trigger.target_workflow_template_id, v_context_payload);

      UPDATE public.workflow_trigger_fires
      SET
        fire_status = 'started',
        target_workflow_run_id = v_target_run_id,
        updated_at = now()
      WHERE id = v_fire.id;

      PERFORM public.log_decision(
        v_trigger.organization_id,
        'workflow_trigger',
        'workflow_trigger_fire',
        v_fire.id,
        'fire',
        'started',
        'workflow_run_triggers_worker',
        v_context,
        jsonb_build_object(
          'workflow_run_trigger_id', v_trigger.id,
          'source_workflow_run_id', v_fire.source_workflow_run_id,
          'target_workflow_run_id', v_target_run_id
        ),
        NULL
      );
    EXCEPTION
      WHEN others THEN
        v_error := TRUE;
        UPDATE public.workflow_trigger_fires
        SET
          fire_status = 'error',
          last_error = SQLERRM,
          updated_at = now()
        WHERE id = v_fire.id;

        PERFORM public.log_decision(
          v_fire.organization_id,
          'workflow_trigger',
          'workflow_trigger_fire',
          v_fire.id,
          'fire',
          'error',
          'workflow_run_triggers_worker',
          v_context,
          jsonb_build_object(
            'workflow_run_trigger_id', v_fire.workflow_run_trigger_id,
            'source_workflow_run_id', v_fire.source_workflow_run_id
          ),
          SQLERRM
        );
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
  PERFORM public.update_cron_config('workflow_run_triggers_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error', v_error
  );
END;
$function$;

COMMIT;
