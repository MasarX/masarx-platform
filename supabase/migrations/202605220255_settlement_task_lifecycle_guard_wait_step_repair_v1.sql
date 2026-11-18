-- Migration: repair pending workflow wait steps after stale settlement task cleanup.
--
-- The lifecycle guard cancels stale settlement human tasks. This companion
-- keeps workflow run-step truth aligned when the pending wait step references
-- the cancelled task rather than the enqueue step stored on task metadata.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605220255_settlement_task_lifecycle_guard_wait_step_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH stale_task_events AS (
  SELECT
    te.task_id,
    te.organization_id,
    te.payload->>'settlement_batch_id' AS settlement_batch_id,
    te.payload->>'settlement_status' AS settlement_status
  FROM public.task_events te
  WHERE te.actor_system = 'settlement_task_lifecycle_guard_v1'
    AND te.to_status = 'cancelled'
),
failed_steps AS (
  UPDATE public.workflow_run_steps wrs
     SET step_status = 'failed',
         last_error = format(
           'Stale settlement task %s auto-cancelled because settlement batch %s is %s',
           e.task_id,
           e.settlement_batch_id,
           e.settlement_status
         ),
         operation_result = public.jsonb_deep_merge(
           COALESCE(wrs.operation_result, '{}'::jsonb),
           jsonb_build_object(
             'stale_task_id', e.task_id,
             'settlement_batch_id', e.settlement_batch_id,
             'settlement_status', e.settlement_status,
             'auto_cancelled_task', TRUE
           )
         ),
         updated_at = now()
    FROM stale_task_events e
   WHERE wrs.step_status NOT IN ('completed', 'failed', 'canceled', 'cancelled', 'skipped')
     AND wrs.operation_result->>'task_id' = e.task_id::text
  RETURNING wrs.workflow_run_id, wrs.id AS workflow_run_step_id
)
UPDATE public.workflow_runs wr
   SET workflow_status = 'failed',
       failure_reason = 'stale_settlement_task_auto_cancelled',
       last_error = public.jsonb_deep_merge(
         COALESCE(wr.last_error, '{}'::jsonb),
         jsonb_build_object(
           'error', 'stale_settlement_task_auto_cancelled',
           'workflow_run_step_id', fs.workflow_run_step_id
         )
       ),
       updated_at = now()
  FROM failed_steps fs
 WHERE wr.id = fs.workflow_run_id
   AND wr.workflow_status NOT IN ('completed', 'failed', 'canceled', 'cancelled');

SELECT pg_advisory_unlock(hashtext('202605220255_settlement_task_lifecycle_guard_wait_step_repair_v1'));

COMMIT;
