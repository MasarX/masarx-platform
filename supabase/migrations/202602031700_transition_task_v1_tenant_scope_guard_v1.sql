-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: transition_task_v1 tenant scope guard fix v1
-- Purpose:
-- - transition_task_v1 is a tenant operational RPC (drivers/warehouse/ops) and is already guarded by:
--   - org scope (current_user_org_id)
--   - RBAC permission (tasks.complete)
--   - task_ops_session_policy enforcement (when configured)
-- - user_can_write() maps to access_control_policy capability system.write which is fail-closed for new tenant user_types
--   (e.g., driver). Using it here blocks intended operational flows and prevents ops_session policy checks from running.
-- - Replace the early user_can_write gate with an explicit tenant/platform scope guard (least privilege).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602031700_transition_task_v1_tenant_scope_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_task_type_key TEXT := NULL;
  v_branch_id UUID := NULL;

  v_org_id UUID;
  v_from_status TEXT;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;

  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);

  -- Policy: task_ops_session_policy (ladder-resolved)
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_task_policy JSONB := '{}'::jsonb;
  v_required_session_type TEXT := NULL;
  v_required_on_statuses JSONB := '["completed"]'::jsonb;
  v_require_branch_match BOOLEAN := FALSE;
  v_requires_session BOOLEAN := FALSE;

  -- Session linkage (optional unless policy requires)
  v_ops_session_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_actor UUID := NULL;
  v_ops_session_status TEXT := NULL;
  v_ops_session_type TEXT := NULL;
  v_ops_session_branch UUID := NULL;
  v_ops_session_is_final BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires an authenticated user';
  END IF;

  -- Guardrails:
  -- - Do not couple task transitions to generic write capability (system.write).
  -- - Only tenant (or platform) scopes may transition tasks; task_ops_session_policy and RBAC enforce the rest.
  IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
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

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  -- Task type key (needed to resolve task_ops_session_policy).
  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id;

  IF v_task_type_key IS NULL OR btrim(v_task_type_key) = '' THEN
    v_task_type_key := COALESCE(v_task.task_type_key, NULL);
  END IF;

  -- Optional: branch context (for branch_match enforcement).
  v_branch_id := COALESCE(
    NULLIF((v_task.payload->>'branch_id')::uuid, NULL),
    NULLIF((v_task.metadata->>'branch_id')::uuid, NULL),
    NULL
  );

  -- Resolve task_ops_session_policy via ladder.
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'resource_id', v_branch_id,
    'task_type_key', v_task_type_key
  ));

  SELECT
    p.value AS policy,
    p.settings_resolution_id
  INTO v_policy_row
  FROM public.resolve_task_ops_session_policy(v_policy_ctx) p
  LIMIT 1;

  v_policy := COALESCE(v_policy_row.policy, '{}'::jsonb);
  v_task_policy := COALESCE(v_policy->'tasks'->v_task_type_key, '{}'::jsonb);

  -- Policy keys (all optional):
  -- - required_session_type: a session type key (e.g., driver_shift)
  -- - required_on_statuses: json array of statuses where session is required (default: ["completed"])
  -- - require_branch_match: boolean, enforce ops_session.branch_id matches task branch (if task branch is known)
  v_required_session_type := NULLIF(btrim(COALESCE(v_task_policy->>'required_session_type', '')), '');
  v_required_on_statuses := COALESCE(v_task_policy->'required_on_statuses', v_required_on_statuses);
  v_require_branch_match := COALESCE((v_task_policy->>'require_branch_match')::boolean, v_require_branch_match);

  v_requires_session := COALESCE(
    jsonb_typeof(v_required_on_statuses) = 'array'
    AND v_to_status IN (SELECT jsonb_array_elements_text(v_required_on_statuses)),
    FALSE
  );

  -- Extract ops_session_id from payload (support multiple keys for backwards compatibility).
  v_ops_session_id := COALESCE(
    NULLIF((v_payload->>'ops_session_id')::uuid, NULL),
    NULLIF((v_payload->>'session_id')::uuid, NULL),
    NULL
  );

  IF v_requires_session IS TRUE THEN
    IF v_ops_session_id IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 requires ops_session_id'
        USING ERRCODE = '23514',
              DETAIL = jsonb_build_object(
                'task_type_key', v_task_type_key,
                'required_session_type', v_required_session_type,
                'required_on_statuses', v_required_on_statuses
              )::text;
    END IF;

    SELECT
      s.organization_id,
      s.actor_user_id,
      s.status,
      s.session_type,
      s.branch_id,
      s.is_final
    INTO
      v_ops_session_org,
      v_ops_session_actor,
      v_ops_session_status,
      v_ops_session_type,
      v_ops_session_branch,
      v_ops_session_is_final
    FROM public.ops_sessions s
    WHERE s.id = v_ops_session_id
    LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 invalid ops_session_id: %', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_is_platform AND v_ops_session_org <> v_org_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is outside current tenant scope' USING ERRCODE = '42501';
    END IF;

    -- Tenant actors can only use their own sessions (platform bypass).
    IF NOT v_is_platform AND v_ops_session_actor IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session actor mismatch' USING ERRCODE = '42501';
    END IF;

    IF COALESCE(v_ops_session_is_final, FALSE) IS TRUE THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is final' USING ERRCODE = '23514';
    END IF;

    -- Enforce expected session_type when policy declares it.
    IF v_required_session_type IS NOT NULL AND lower(COALESCE(v_ops_session_type, '')) IS DISTINCT FROM v_required_session_type THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session type mismatch (required %, got %)', v_required_session_type, v_ops_session_type
        USING ERRCODE = '23514';
    END IF;

    -- Enforce branch match when configured.
    IF COALESCE(v_require_branch_match, FALSE) IS TRUE AND v_branch_id IS NOT NULL THEN
      IF v_ops_session_branch IS DISTINCT FROM v_branch_id THEN
        RAISE EXCEPTION 'transition_task_v1 ops_session branch mismatch (required %, got %)', v_branch_id, v_ops_session_branch
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Avoid redundant storage: keep session link in the dedicated column.
  v_payload := (v_payload - 'ops_session_id' - 'session_id');

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
      'status_reason', p_status_reason,
      'ops_session_id', v_ops_session_id
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
    settings_resolution_id,
    ops_session_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(v_payload || jsonb_build_object(
      'status_reason', p_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL,
    v_ops_session_id
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'Transition a task status (projection update + ledger event). Supports optional ops_session_id linkage and policy-driven session requirements via task_ops_session_policy. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602031700_transition_task_v1_tenant_scope_guard_v1'));
COMMIT;

