-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Task RPC RBAC guardrails v1 (assign/transition)
-- Date: 2026-01-30
--
-- Goal:
--   Harden task mutation RPCs so tenant users can only perform task mutations when RBAC allows it.
--   This avoids relying on user_type branching while keeping the system row-driven.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300080_task_rpc_rbac_guardrails_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) assign_task_v1: require tasks.write permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_task_v1(
  p_task_id UUID,
  p_assigned_to UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_task public.tasks%ROWTYPE;
  v_org_id UUID;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'assign_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'assign_task_v1 requires tenant/platform write scope';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'assign_task_v1 requires task_id';
  END IF;
  IF p_assigned_to IS NULL THEN
    RAISE EXCEPTION 'assign_task_v1 requires assigned_to';
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assign_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'assign_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.write', v_org_id) THEN
    RAISE EXCEPTION 'assign_task_v1 requires tasks.write permission' USING ERRCODE = '42501';
  END IF;

  -- Idempotency short-circuit (must happen after locking the task row).
  IF v_idempotency IS NOT NULL THEN
    SELECT te.id INTO task_event_id
    FROM public.task_events te
    WHERE te.task_id = v_task.id
      AND te.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  PERFORM 1
  FROM public.users u
  WHERE u.id = p_assigned_to
    AND u.organization_id = v_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assign_task_v1 assigned_to user % is outside organization_id %', p_assigned_to, v_org_id
      USING ERRCODE = '42501';
  END IF;

  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET assigned_to = p_assigned_to,
         assigned_at = now(),
         version = v_next_version
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'assign',
    p_decision_outcome := 'assigned',
    p_performed_by_system := 'assign_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'assigned_to', p_assigned_to,
      'notes', p_notes
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

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
  VALUES (
    v_task.id,
    v_org_id,
    'assigned',
    v_task.status,
    v_task.status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'assigned_to', p_assigned_to,
      'notes', p_notes,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT)
  IS 'Assign a task to a user (projection update + ledger event). Enforces RBAC tasks.write permission.';

REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) transition_task_v1: require tasks.complete permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_task_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_task public.tasks%ROWTYPE;
  v_org_id UUID;
  v_from_status TEXT;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'transition_task_v1 requires to_status';
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'transition_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org_id) THEN
    RAISE EXCEPTION 'transition_task_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  -- Idempotency short-circuit (must happen after locking the task row).
  IF v_idempotency IS NOT NULL THEN
    SELECT te.id INTO task_event_id
    FROM public.task_events te
    WHERE te.task_id = v_task.id
      AND te.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_from_status := v_task.status;
  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = p_status_reason,
         version = v_next_version,
         started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN v_to_status = 'completed' THEN now() ELSE completed_at END,
         canceled_at = CASE WHEN v_to_status = 'canceled' THEN now() ELSE canceled_at END
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', p_status_reason
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

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
  VALUES (
    v_task.id,
    v_org_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
      'status_reason', p_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'Transition a task status (projection update + ledger event). Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601300080_task_rpc_rbac_guardrails_v1'));
COMMIT;

