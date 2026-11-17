-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 NDR SLA sweeper + reporting v1
-- Date: 2026-04-03
--
-- Purpose:
--   - Mark overdue dispatch exception review tasks through the canonical ops sweeper.
--   - Emit task-event and decision-log evidence when an NDR SLA breach is first observed.
--   - Expose reporting views for backlog and breach visibility through the api schema boundary.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032245_uc114_ndr_sla_sweeper_reporting_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ops_sweeper_dispatch_exception_review_sla_breaches(
  p_args JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := statement_timestamp();
  v_limit INT := LEAST(GREATEST(COALESCE(NULLIF(p_args->>'limit', '')::INT, 200), 1), 1000);
  v_task_type_key TEXT := lower(COALESCE(NULLIF(p_args->>'task_type_key', ''), 'dispatch_exception_review'));
  v_actor_system TEXT := 'ops_sweeper_dispatch_exception_review_sla_breaches';
  v_marked_count INT := 0;
BEGIN
  WITH due_tasks AS (
    SELECT
      t.id,
      t.organization_id,
      t.status,
      t.sla_due_at,
      t.version
    FROM public.tasks t
    WHERE t.task_type_key = v_task_type_key
      AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'exception')
      AND t.sla_due_at IS NOT NULL
      AND t.sla_due_at <= v_now
      AND t.sla_breached_at IS NULL
    ORDER BY t.sla_due_at ASC, t.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.tasks t
       SET sla_breached_at = v_now,
           updated_at = v_now,
           version = t.version + 1
      FROM due_tasks d
     WHERE t.id = d.id
     RETURNING
       t.id,
       t.organization_id,
       t.status,
       t.sla_due_at,
       t.version,
       GREATEST(CEIL(EXTRACT(EPOCH FROM (v_now - t.sla_due_at)) / 60.0)::INT, 0) AS overdue_minutes
  ),
  decisions AS (
    SELECT
      u.*,
      public.log_decision(
        p_organization_id := u.organization_id,
        p_decision_category := 'task',
        p_resource_type := 'task',
        p_resource_id := u.id,
        p_decision_point := 'sla_breach',
        p_decision_outcome := 'breached',
        p_performed_by_system := v_actor_system,
        p_correlation_id := public.current_correlation_id(),
        p_decision_inputs := jsonb_build_object(
          'task_type_key', v_task_type_key,
          'sla_due_at', u.sla_due_at,
          'sla_breached_at', v_now,
          'overdue_minutes', u.overdue_minutes
        ),
        p_decision_reason := 'dispatch_exception_review_sla_due',
        p_settings_resolution_id := NULL
      ) AS decision_log_id
    FROM updated u
  )
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
    settings_resolution_id
  )
  SELECT
    d.id,
    d.organization_id,
    'sla_breached',
    d.status,
    d.status,
    NULL,
    v_actor_system,
    jsonb_build_object(
      'task_type_key', v_task_type_key,
      'sla_due_at', d.sla_due_at,
      'sla_breached_at', v_now,
      'overdue_minutes', d.overdue_minutes,
      'correlation_id', public.current_correlation_id()
    ),
    format('task-sla-breach:%s:%s', d.id, v_now::date),
    d.version,
    d.decision_log_id,
    NULL
  FROM decisions d;

  GET DIAGNOSTICS v_marked_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'status', 'completed',
    'task_type_key', v_task_type_key,
    'marked_count', COALESCE(v_marked_count, 0),
    'detected_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.ops_sweeper_dispatch_exception_review_sla_breaches(JSONB)
  IS 'Ops sweeper handler that stamps tasks.sla_breached_at once for overdue dispatch_exception_review tasks and emits task-event + decision-log evidence.';

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  created_by,
  notes,
  doc_url
)
VALUES (
  'ops_sweeper_dispatch_exception_review_sla_breaches',
  'public',
  'ops_sweeper_dispatch_exception_review_sla_breaches',
  '(jsonb)',
  'v1',
  TRUE,
  NULL,
  'Mark overdue dispatch exception review tasks as SLA breached and emit audit evidence.',
  'docs/ops/runbooks/tasks_ssot_runbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings RECORD;
  v_current JSONB;
  v_tasks JSONB;
  v_next_tasks JSONB := '[]'::jsonb;
  v_task JSONB;
  v_has_task BOOLEAN := FALSE;
  v_target_task JSONB := jsonb_build_object(
    'task_key', 'dispatch_exception_review_sla_breach_scan',
    'enabled', TRUE,
    'handler_key', 'ops_sweeper_dispatch_exception_review_sla_breaches',
    'arguments', jsonb_build_object(
      'task_type_key', 'dispatch_exception_review',
      'limit', 200
    )
  );
  v_next JSONB;
  v_prev_version INT := 0;
  v_new_version INT := 1;
  v_new_version_id UUID;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings
    FROM public.settings s
   WHERE s.category = 'ops_sweeper_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   ORDER BY s.last_updated DESC
   LIMIT 1;

  IF v_settings.settings_version_id IS NULL THEN
    RETURN;
  END IF;

  v_current := COALESCE(v_settings.cached_value, '{}'::jsonb);
  v_tasks := CASE WHEN jsonb_typeof(v_current->'tasks') = 'array' THEN v_current->'tasks' ELSE '[]'::jsonb END;

  FOR v_task IN SELECT value FROM jsonb_array_elements(v_tasks) LOOP
    IF COALESCE(v_task->>'task_key', '') = 'dispatch_exception_review_sla_breach_scan'
       OR COALESCE(v_task->>'handler_key', '') = 'ops_sweeper_dispatch_exception_review_sla_breaches' THEN
      v_task := public.deep_merge_jsonb(v_target_task, v_task);
      v_has_task := TRUE;
    END IF;
    v_next_tasks := v_next_tasks || jsonb_build_array(v_task);
  END LOOP;

  IF NOT v_has_task THEN
    v_next_tasks := v_next_tasks || jsonb_build_array(v_target_task);
  END IF;

  v_next := jsonb_set(v_current, '{tasks}', v_next_tasks, TRUE);
  IF v_next = v_current THEN
    RETURN;
  END IF;

  SELECT COALESCE(sv.version, 0)
    INTO v_prev_version
    FROM public.settings_versions sv
   WHERE sv.id = v_settings.settings_version_id
   LIMIT 1;

  v_new_version := GREATEST(v_prev_version, 0) + 1;
  v_new_version_id := gen_random_uuid();

  UPDATE public.settings_versions sv
     SET effective_until = now()
   WHERE sv.id = v_settings.settings_version_id
     AND sv.scope_hash = v_scope_hash
     AND sv.effective_until IS NULL;

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  VALUES (
    v_new_version_id,
    'ops_sweeper_policy',
    'global',
    NULL,
    v_scope_hash,
    v_new_version,
    v_next,
    1,
    'Add UC114 dispatch exception SLA breach sweep to ops_sweeper_policy',
    now(),
    now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'ops_sweeper_policy',
    'global',
    NULL,
    v_scope_hash,
    v_new_version_id,
    v_next,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END;
$do$;

CREATE OR REPLACE VIEW public.dispatch_exception_review_backlog_v
WITH (security_invoker = true) AS
SELECT
  t.organization_id,
  COUNT(*)::INT AS open_count,
  COUNT(*) FILTER (WHERE t.assigned_to IS NOT NULL)::INT AS assigned_count,
  COUNT(*) FILTER (WHERE t.assigned_to IS NULL)::INT AS unassigned_count,
  COUNT(*) FILTER (WHERE t.sla_due_at IS NOT NULL AND t.sla_due_at <= now())::INT AS overdue_count,
  COUNT(*) FILTER (WHERE t.sla_breached_at IS NOT NULL)::INT AS breached_count,
  MIN(t.sla_due_at) AS oldest_sla_due_at,
  MAX(t.sla_breached_at) AS latest_sla_breached_at,
  MAX(t.updated_at) AS updated_at
FROM public.tasks t
WHERE t.task_type_key = 'dispatch_exception_review'
  AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'exception')
GROUP BY t.organization_id;

CREATE OR REPLACE VIEW public.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.organization_id,
  t.client_id,
  t.sender_id,
  t.resource_type,
  t.resource_id,
  t.status,
  t.queue_key,
  t.assigned_to,
  t.assigned_at,
  t.sla_minutes,
  t.sla_due_at,
  t.sla_breached_at,
  GREATEST(CEIL(EXTRACT(EPOCH FROM (COALESCE(t.sla_breached_at, now()) - t.sla_due_at)) / 60.0)::INT, 0) AS overdue_minutes,
  t.created_at,
  t.updated_at
FROM public.tasks t
WHERE t.task_type_key = 'dispatch_exception_review'
  AND t.sla_due_at IS NOT NULL
  AND t.sla_breached_at IS NOT NULL;

CREATE OR REPLACE VIEW api.dispatch_exception_review_backlog_v
WITH (security_invoker = true) AS
SELECT *
FROM public.dispatch_exception_review_backlog_v;

CREATE OR REPLACE VIEW api.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT *
FROM public.dispatch_exception_review_sla_breaches_v;

REVOKE ALL ON api.dispatch_exception_review_backlog_v FROM PUBLIC;
REVOKE ALL ON api.dispatch_exception_review_backlog_v FROM anon;
REVOKE ALL ON api.dispatch_exception_review_backlog_v FROM authenticated;
GRANT SELECT ON api.dispatch_exception_review_backlog_v TO authenticated, service_role;

REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM PUBLIC;
REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM anon;
REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM authenticated;
GRANT SELECT ON api.dispatch_exception_review_sla_breaches_v TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604032245_uc114_ndr_sla_sweeper_reporting_v1'));
COMMIT;
