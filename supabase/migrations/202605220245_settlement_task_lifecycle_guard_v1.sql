-- Migration: guard settlement workflow task lifecycle against stale resource state.
--
-- Live first-tenant proof found an open COD cashier-count task whose settlement
-- batch had already advanced to approved. The task could still be completed
-- from Review Queue, and the service settlement transition path did not share
-- the row-driven transition matrix used by the Console wrapper.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605220245_settlement_task_lifecycle_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH action_def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'settlement_batch_transition_action' LIMIT 1
),
rows(value, label, description, sort_order, metadata) AS (
  VALUES
    (
      'approve',
      'Approve',
      'Workflow/internal transition from locked to approved.',
      30,
      '{"from_status":"locked","to_status":"approved","console_visible":false}'::jsonb
    ),
    (
      'cancel_open',
      'Cancel open',
      'Cancel an open settlement batch.',
      40,
      '{"from_status":"open","to_status":"canceled","console_visible":false}'::jsonb
    ),
    (
      'cancel_locked',
      'Cancel locked',
      'Cancel a locked settlement batch.',
      50,
      '{"from_status":"locked","to_status":"canceled","console_visible":false}'::jsonb
    )
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT action_def.id, rows.value, rows.label, rows.description, rows.sort_order, FALSE, 'active', rows.metadata
FROM action_def
CROSS JOIN rows
WHERE action_def.id IS NOT NULL
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

UPDATE public.task_types
   SET metadata = public.jsonb_deep_merge(
         COALESCE(metadata, '{}'::jsonb),
         jsonb_build_object('settlement_batch_action_statuses', jsonb_build_array('open'))
       ),
       updated_at = now()
 WHERE key IN (
   'cod_cash_handover',
   'cod_cashier_count',
   'bank_deposit_slip_create'
 );

UPDATE public.task_types
   SET metadata = public.jsonb_deep_merge(
         COALESCE(metadata, '{}'::jsonb),
         jsonb_build_object('settlement_batch_action_statuses', jsonb_build_array('locked'))
       ),
       updated_at = now()
 WHERE key IN (
   'cod_manager_approval',
   'bank_deposit_manager_approval'
 );

CREATE OR REPLACE FUNCTION public.enforce_settlement_status_transition_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_allowed boolean := FALSE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv
          ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'settlement_batch_transition_action'
         AND lv.status = 'active'
         AND lower(COALESCE(lv.metadata->>'from_status', '')) = lower(COALESCE(OLD.status, ''))
         AND lower(COALESCE(lv.metadata->>'to_status', '')) = lower(COALESCE(NEW.status, ''))
    )
      INTO v_allowed;

    IF COALESCE(v_allowed, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'settlement status transition from % to % is not configured', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_batches_enforce_status_transition
  ON public.settlement_batches;

CREATE TRIGGER settlement_batches_enforce_status_transition
BEFORE UPDATE OF status ON public.settlement_batches
FOR EACH ROW
EXECUTE FUNCTION public.enforce_settlement_status_transition_v1();

COMMENT ON FUNCTION public.enforce_settlement_status_transition_v1() IS
  'Fail-closed settlement status transition guard. Reads settlement_batch_transition_action lookup rows so service and UI status movement cannot drift.';

CREATE OR REPLACE FUNCTION public.prevent_stale_settlement_task_completion_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_type_key text := NULL;
  v_allowed_statuses jsonb := NULL;
  v_settlement_status text := NULL;
  v_new_status_terminal boolean := FALSE;
  v_allowed boolean := TRUE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.resource_type = 'settlement_batch'
     AND NEW.resource_id IS NOT NULL THEN
    SELECT COALESCE((lv.metadata->>'is_terminal')::boolean, FALSE)
      INTO v_new_status_terminal
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'task_status'
       AND lower(lv.value) = lower(COALESCE(NEW.status, ''))
     LIMIT 1;

    IF COALESCE(v_new_status_terminal, FALSE) IS NOT TRUE
       OR lower(COALESCE(NEW.status, '')) IN ('canceled', 'cancelled') THEN
      RETURN NEW;
    END IF;

    SELECT tt.key, tt.metadata->'settlement_batch_action_statuses'
      INTO v_task_type_key, v_allowed_statuses
      FROM public.task_types tt
     WHERE tt.id = NEW.task_type_id
     LIMIT 1;

    IF jsonb_typeof(v_allowed_statuses) = 'array' THEN
      SELECT sb.status
        INTO v_settlement_status
        FROM public.settlement_batches sb
       WHERE sb.id = NEW.resource_id
         AND sb.organization_id = NEW.organization_id
       LIMIT 1;

      SELECT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(v_allowed_statuses) AS allowed(status)
         WHERE lower(allowed.status) = lower(COALESCE(v_settlement_status, ''))
      )
        INTO v_allowed;

      IF COALESCE(v_allowed, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'transition_task_v1 settlement task % is stale for settlement status % (task_type %, allowed statuses %)',
          NEW.id, COALESCE(v_settlement_status, 'missing'), COALESCE(v_task_type_key, 'unknown'), v_allowed_statuses
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_prevent_stale_settlement_task_completion
  ON public.tasks;

CREATE TRIGGER tasks_prevent_stale_settlement_task_completion
BEFORE UPDATE OF status ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.prevent_stale_settlement_task_completion_v1();

COMMENT ON FUNCTION public.prevent_stale_settlement_task_completion_v1() IS
  'Blocks terminal completion/rejection of settlement workflow human tasks when the settlement batch has already advanced beyond the task type action window.';

CREATE OR REPLACE FUNCTION public.reconcile_stale_settlement_tasks_v1(
  p_settlement_batch_id uuid,
  p_actor_system text DEFAULT 'settlement_task_lifecycle_guard_v1'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_reconciled_count integer := 0;
BEGIN
  WITH stale AS (
    SELECT
      t.id AS task_id,
      t.organization_id,
      t.status AS old_status,
      t.version AS old_version,
      t.resource_id AS settlement_batch_id,
      sb.status AS settlement_status,
      NULLIF(t.metadata->>'parent_workflow_run_id', '')::uuid AS parent_workflow_run_id,
      tt.key AS task_type_key,
      tt.metadata->'settlement_batch_action_statuses' AS allowed_statuses
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
    JOIN public.settlement_batches sb
      ON sb.id = t.resource_id
     AND sb.organization_id = t.organization_id
    LEFT JOIN public.lookup_definitions task_status_def
      ON task_status_def.category = 'task_status'
    LEFT JOIN public.lookup_values task_status_value
      ON task_status_value.lookup_definition_id = task_status_def.id
     AND lower(task_status_value.value) = lower(t.status)
    WHERE t.resource_type = 'settlement_batch'
      AND t.resource_id = p_settlement_batch_id
      AND jsonb_typeof(tt.metadata->'settlement_batch_action_statuses') = 'array'
      AND COALESCE((task_status_value.metadata->>'is_terminal')::boolean, FALSE) IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(tt.metadata->'settlement_batch_action_statuses') AS allowed(status)
         WHERE lower(allowed.status) = lower(sb.status)
      )
  ),
  updated_tasks AS (
    UPDATE public.tasks t
       SET status = 'cancelled',
           status_reason = format(
             'Auto-cancelled stale settlement task: settlement batch is %s; allowed task statuses are %s',
             s.settlement_status,
             s.allowed_statuses::text
           ),
           version = t.version + 1,
           canceled_at = COALESCE(t.canceled_at, now()),
           updated_at = now()
      FROM stale s
     WHERE t.id = s.task_id
    RETURNING
      t.id AS task_id,
      t.organization_id,
      t.version AS task_version,
      s.old_status,
      s.old_version,
      s.settlement_batch_id,
      s.settlement_status,
      s.parent_workflow_run_id,
      s.task_type_key,
      s.allowed_statuses
  ),
  inserted_events AS (
    INSERT INTO public.task_events (
      task_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_user_id,
      actor_system,
      payload,
      idempotency_key,
      task_version,
      decision_log_id,
      settings_resolution_id,
      ops_session_id
    )
    SELECT
      u.task_id,
      u.organization_id,
      'status_changed',
      u.old_status,
      'cancelled',
      NULL,
      COALESCE(NULLIF(p_actor_system, ''), 'settlement_task_lifecycle_guard_v1'),
      jsonb_build_object(
        'status_reason', format(
          'Auto-cancelled stale settlement task: settlement batch is %s; allowed task statuses are %s',
          u.settlement_status,
          u.allowed_statuses::text
        ),
        'settlement_batch_id', u.settlement_batch_id,
        'settlement_status', u.settlement_status,
        'allowed_statuses', u.allowed_statuses,
        'task_type_key', u.task_type_key,
        'correlation_id', gen_random_uuid()
      ),
      'settlement-task-lifecycle-guard:' || u.task_id::text || ':' || u.settlement_status,
      u.task_version,
      NULL,
      NULL,
      NULL
    FROM updated_tasks u
    ON CONFLICT DO NOTHING
    RETURNING task_id
  ),
  failed_steps AS (
    UPDATE public.workflow_run_steps wrs
       SET step_status = 'failed',
           last_error = format(
             'Stale settlement task %s auto-cancelled because settlement batch %s is %s',
             u.task_id,
             u.settlement_batch_id,
             u.settlement_status
           ),
           operation_result = public.jsonb_deep_merge(
             COALESCE(wrs.operation_result, '{}'::jsonb),
             jsonb_build_object(
               'stale_task_id', u.task_id,
               'settlement_batch_id', u.settlement_batch_id,
               'settlement_status', u.settlement_status,
               'auto_cancelled_task', TRUE
             )
           ),
           updated_at = now()
      FROM updated_tasks u
     WHERE wrs.step_status NOT IN ('completed', 'failed', 'canceled', 'cancelled', 'skipped')
       AND wrs.operation_result->>'task_id' = u.task_id::text
    RETURNING wrs.workflow_run_id, wrs.id AS workflow_run_step_id
  ),
  failed_runs_from_steps AS (
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
       AND wr.workflow_status NOT IN ('completed', 'failed', 'canceled', 'cancelled')
    RETURNING wr.id
  ),
  failed_runs_from_tasks AS (
    UPDATE public.workflow_runs wr
       SET workflow_status = 'failed',
           failure_reason = 'stale_settlement_task_auto_cancelled',
           last_error = public.jsonb_deep_merge(
             COALESCE(wr.last_error, '{}'::jsonb),
             jsonb_build_object(
               'error', 'stale_settlement_task_auto_cancelled',
               'task_id', u.task_id,
               'settlement_batch_id', u.settlement_batch_id,
               'settlement_status', u.settlement_status
             )
           ),
           updated_at = now()
      FROM updated_tasks u
     WHERE wr.id = u.parent_workflow_run_id
       AND wr.workflow_status NOT IN ('completed', 'failed', 'canceled', 'cancelled')
    RETURNING wr.id
  )
  SELECT COUNT(*)::integer
    INTO v_reconciled_count
    FROM updated_tasks;

  RETURN COALESCE(v_reconciled_count, 0);
END;
$$;

COMMENT ON FUNCTION public.reconcile_stale_settlement_tasks_v1(uuid, text) IS
  'Cancels non-terminal settlement workflow human tasks whose task-type action window no longer matches the settlement batch status, records task-event lineage, and aligns pending wait steps/workflow runs.';

CREATE OR REPLACE FUNCTION public.reconcile_stale_settlement_tasks_after_status_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.reconcile_stale_settlement_tasks_v1(
      NEW.id,
      'settlement_task_lifecycle_guard_v1'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_batches_reconcile_stale_tasks_after_status
  ON public.settlement_batches;

CREATE TRIGGER settlement_batches_reconcile_stale_tasks_after_status
AFTER UPDATE OF status ON public.settlement_batches
FOR EACH ROW
EXECUTE FUNCTION public.reconcile_stale_settlement_tasks_after_status_v1();

COMMENT ON FUNCTION public.reconcile_stale_settlement_tasks_after_status_v1() IS
  'Keeps future settlement status changes from leaving stale human tasks open/actionable.';

SELECT public.reconcile_stale_settlement_tasks_v1(
  sb.id,
  'settlement_task_lifecycle_guard_v1'
)
FROM public.settlement_batches sb;

SELECT pg_advisory_unlock(hashtext('202605220245_settlement_task_lifecycle_guard_v1'));

COMMIT;
