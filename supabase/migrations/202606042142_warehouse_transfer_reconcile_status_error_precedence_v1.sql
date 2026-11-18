-- Migration: Warehouse transfer reconcile status error precedence v1
-- Date: 2026-06-04
--
-- Keep replay-before-status behavior for duplicate submissions, but preserve the
-- operator-facing status error for new reconcile attempts before the receive step
-- has created a reconcile task.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042142_warehouse_transfer_reconcile_status_error_precedence_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := $$IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 no warehouse_transfer_reconcile task found for %', v_transfer.id
      USING ERRCODE = '23503';
  END IF;$$;
  v_new TEXT := $$IF NOT FOUND THEN
    IF lower(COALESCE(v_transfer.status, '')) <> 'received' THEN
      RAISE EXCEPTION
        'ui_execute_warehouse_transfer_reconcile_v1 only supports received warehouse_transfers (current status %)',
        v_transfer.status
        USING ERRCODE = '23514';
    END IF;

    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 no warehouse_transfer_reconcile task found for %', v_transfer.id
      USING ERRCODE = '23503';
  END IF;$$;
BEGIN
  SELECT pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    INTO v_def;

  IF position('new reconcile attempts before the receive step' IN COALESCE(obj_description('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure), '')) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'warehouse reconcile status precedence migration could not find missing-task guard';
    END IF;

    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;
END;
$do$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record destination reconcile task output, replay duplicate same-context reconcile submissions before terminal status guards, preserve status-first validation for new reconcile attempts before the receive step creates a task, wake service-only workflow transitions, and return terminal warehouse transfer readback for no-reload Console UI reconciliation.';

SELECT pg_advisory_unlock(hashtext('202606042142_warehouse_transfer_reconcile_status_error_precedence_v1'));
COMMIT;
