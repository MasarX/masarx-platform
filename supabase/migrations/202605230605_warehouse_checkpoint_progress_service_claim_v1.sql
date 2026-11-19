-- Migration: Warehouse checkpoint workflow progress service claim v1
-- Date: 2026-05-23
--
-- Checkpoint UI execution records the scan and completes the active task under
-- the operator identity, then wakes the canonical workflow. The downstream
-- warehouse_transfer handler intentionally calls service-only transition RPCs,
-- so the workflow wake must carry a guarded service_role claim just like the
-- dispatch start wrapper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230605_warehouse_checkpoint_progress_service_claim_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old_decl TEXT := $$v_progress JSONB := '{}'::jsonb;$$;
  v_new_decl TEXT := $$v_progress JSONB := '{}'::jsonb;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_elevated_claims JSONB;$$;
  v_old_progress TEXT := $$v_progress := COALESCE(
    public.progress_workflow_run_until_wait_v1(
      v_workflow_run_id,
      jsonb_build_object(
        'source', 'ui_execute_warehouse_transfer_checkpoint_v1',
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'requested_by', v_user_id::text,
        'warehouse_transfer_id', v_transfer.id::text,
        'task_id', v_task.id::text,
        'task_event_id', v_task_event_id::text,
        'scan_event_id', v_scan_event_id::text,
        'checkpoint_key', v_checkpoint_key
      ),
      750,
      8
    ),
    '{}'::jsonb
  );$$;
  v_new_progress TEXT := $$v_elevated_claims := jsonb_build_object(
    'role', 'service_role',
    'sub', v_user_id::text,
    'organization_id', v_transfer.organization_id::text,
    'access_scope_type', COALESCE(v_scope_type, 'tenant'),
    'origin', 'ui_execute_warehouse_transfer_checkpoint_v1',
    'origin_scope_type', v_scope_type,
    'origin_scope_id', v_scope_id::text,
    'warehouse_transfer_id', v_transfer.id::text,
    'checkpoint_key', v_checkpoint_key
  );

  BEGIN
    PERFORM set_config('request.jwt.claims', v_elevated_claims::text, true);

    v_progress := COALESCE(
      public.progress_workflow_run_until_wait_v1(
        v_workflow_run_id,
        jsonb_build_object(
          'source', 'ui_execute_warehouse_transfer_checkpoint_v1',
          'action_key', p_action_key,
          'resource_key', p_resource_key,
          'requested_by', v_user_id::text,
          'warehouse_transfer_id', v_transfer.id::text,
          'task_id', v_task.id::text,
          'task_event_id', v_task_event_id::text,
          'scan_event_id', v_scan_event_id::text,
          'checkpoint_key', v_checkpoint_key
        ),
        750,
        8
      ),
      '{}'::jsonb
    );

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      RAISE;
  END;$$;
BEGIN
  SELECT pg_get_functiondef('public.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    INTO v_def;

  IF position('origin'', ''ui_execute_warehouse_transfer_checkpoint_v1' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF position(v_old_decl IN v_def) = 0 THEN
    RAISE EXCEPTION 'checkpoint progress migration could not find declaration block';
  END IF;
  IF position(v_old_progress IN v_def) = 0 THEN
    RAISE EXCEPTION 'checkpoint progress migration could not find progress block';
  END IF;

  v_def := replace(v_def, v_old_decl, v_new_decl);
  v_def := replace(v_def, v_old_progress, v_new_progress);
  EXECUTE v_def;
END;
$do$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record warehouse transfer departure/arrival checkpoint scans through canonical scan/task SSOT paths and wake service-only workflow transitions with a guarded service_role claim.';

SELECT pg_advisory_unlock(hashtext('202605230605_warehouse_checkpoint_progress_service_claim_v1'));
COMMIT;
