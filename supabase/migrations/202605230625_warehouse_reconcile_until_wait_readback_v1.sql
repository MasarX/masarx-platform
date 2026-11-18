-- Migration: Warehouse reconcile terminal readback v1
-- Date: 2026-05-23
--
-- Console V2 reconcile proof must not report a stale received state while the
-- workflow finishes asynchronously. Keep the service-claim wake from the prior
-- repair, but drive the workflow to its next wait/terminal point before the UI
-- RPC reads back warehouse_transfers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230625_warehouse_reconcile_until_wait_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old_progress TEXT := $$v_progress := COALESCE(
        public.progress_workflow_run(
          v_workflow_run_id,
          jsonb_build_object(
            'source', 'ui_execute_warehouse_transfer_reconcile_v1',
            'action_key', p_action_key,
            'resource_key', p_resource_key,
            'requested_by', v_user_id::text,
            'warehouse_transfer_id', v_transfer.id::text,
            'task_id', v_task.id::text,
            'task_event_id', v_existing_task_event_id::text
          )
        ),
        '{}'::jsonb
      );$$;
  v_new_progress TEXT := $$v_progress := COALESCE(
        public.progress_workflow_run_until_wait_v1(
          v_workflow_run_id,
          jsonb_build_object(
            'source', 'ui_execute_warehouse_transfer_reconcile_v1',
            'action_key', p_action_key,
            'resource_key', p_resource_key,
            'requested_by', v_user_id::text,
            'warehouse_transfer_id', v_transfer.id::text,
            'task_id', v_task.id::text,
            'task_event_id', v_existing_task_event_id::text
          ),
          12000,
          16
        ),
        '{}'::jsonb
      );$$;
BEGIN
  SELECT pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    INTO v_def;

  IF position('progress_workflow_run_until_wait_v1' IN v_def) = 0 THEN
    IF position(v_old_progress IN v_def) = 0 THEN
      RAISE EXCEPTION 'warehouse reconcile until-wait migration could not find progress block';
    END IF;

    v_def := replace(v_def, v_old_progress, v_new_progress);
    EXECUTE v_def;
  END IF;
END;
$do$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record destination reconcile task output, wake service-only warehouse transfer workflow transitions through progress_workflow_run_until_wait_v1, and return terminal warehouse transfer readback for no-reload Console UI reconciliation.';

SELECT pg_advisory_unlock(hashtext('202605230625_warehouse_reconcile_until_wait_readback_v1'));
COMMIT;
