-- Migration: Warehouse transfer reconcile replay before status guard v1
-- Date: 2026-06-04
--
-- Reconcile can drive a transfer from received to reconciled before the UI sees
-- the response. A repeated same-context click with the same idempotency key must
-- return the canonical replay instead of failing on the now-terminal status.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042138_warehouse_transfer_reconcile_replay_before_status_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := $$IF lower(COALESCE(v_transfer.status, '')) <> 'received' THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_reconcile_v1 only supports received warehouse_transfers (current status %)',
      v_transfer.status
      USING ERRCODE = '23514';
  END IF;

  SELECT t.*
    INTO v_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE t.resource_type = 'warehouse_transfer'
     AND t.resource_id = v_transfer.id
     AND t.organization_id = v_transfer.organization_id
     AND tt.key = 'warehouse_transfer_reconcile'
   ORDER BY
     CASE
       WHEN lower(COALESCE(t.status, '')) IN ('completed', 'canceled', 'exception') THEN 1
       ELSE 0
     END,
     t.created_at DESC
   LIMIT 1
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 no warehouse_transfer_reconcile task found for %', v_transfer.id
      USING ERRCODE = '23503';
  END IF;

  v_requested_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
  v_effective_idempotency_key := COALESCE(
    v_requested_idempotency_key,
    format(
      'ui-warehouse-transfer-reconcile:%s:%s:%s:%s',
      lower(p_action_key),
      lower(p_resource_key),
      v_task.id,
      v_user_id
    )
  );

  SELECT te.id
    INTO v_existing_task_event_id
    FROM public.task_events te
   WHERE te.task_id = v_task.id
     AND te.idempotency_key = v_effective_idempotency_key
   ORDER BY te.created_at DESC
   LIMIT 1;

  $$;
  v_new TEXT := $$SELECT t.*
    INTO v_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE t.resource_type = 'warehouse_transfer'
     AND t.resource_id = v_transfer.id
     AND t.organization_id = v_transfer.organization_id
     AND tt.key = 'warehouse_transfer_reconcile'
   ORDER BY
     CASE
       WHEN lower(COALESCE(t.status, '')) IN ('completed', 'canceled', 'exception') THEN 1
       ELSE 0
     END,
     t.created_at DESC
   LIMIT 1
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 no warehouse_transfer_reconcile task found for %', v_transfer.id
      USING ERRCODE = '23503';
  END IF;

  v_requested_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
  v_effective_idempotency_key := COALESCE(
    v_requested_idempotency_key,
    format(
      'ui-warehouse-transfer-reconcile:%s:%s:%s:%s',
      lower(p_action_key),
      lower(p_resource_key),
      v_task.id,
      v_user_id
    )
  );

  SELECT te.id
    INTO v_existing_task_event_id
    FROM public.task_events te
   WHERE te.task_id = v_task.id
     AND te.idempotency_key = v_effective_idempotency_key
   ORDER BY te.created_at DESC
   LIMIT 1;

  IF v_existing_task_event_id IS NULL
     AND lower(COALESCE(v_transfer.status, '')) <> 'received' THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_reconcile_v1 only supports received warehouse_transfers (current status %)',
      v_transfer.status
      USING ERRCODE = '23514';
  END IF;

  $$;
BEGIN
  SELECT pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    INTO v_def;

  IF position('v_existing_task_event_id IS NULL' IN v_def) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'warehouse reconcile replay-before-status migration could not find status guard block';
    END IF;

    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;
END;
$do$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record destination reconcile task output, replay duplicate same-context reconcile submissions before terminal status guards, wake service-only workflow transitions, and return terminal warehouse transfer readback for no-reload Console UI reconciliation.';

SELECT pg_advisory_unlock(hashtext('202606042138_warehouse_transfer_reconcile_replay_before_status_guard_v1'));
COMMIT;
