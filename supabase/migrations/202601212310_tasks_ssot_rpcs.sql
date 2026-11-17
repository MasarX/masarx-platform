-- Plan: PLAN-202601-tasks-ssot-core / Step: S04
-- Migration: Task SSOT RPCs + resolver wrappers
-- Purpose:
--   - Provide canonical resolver wrappers and write-path RPCs (SECURITY DEFINER).
-- Date: 2026-01-21

BEGIN;

SELECT pg_advisory_lock(hashtext('202601212310_tasks_ssot_rpcs'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Resolver wrappers (avoid ad-hoc ladder selection in business code)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_task_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_context('task_policy', p_context)
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_task_policy(JSONB)
  IS 'Resolve task_policy via canonical ladder context helper (returns winning settings row).';

REVOKE ALL ON FUNCTION public.resolve_task_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_task_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_task_sla_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_context('task_sla_policy', p_context)
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_task_sla_policy(JSONB)
  IS 'Resolve task_sla_policy via canonical ladder context helper (returns winning settings row).';

REVOKE ALL ON FUNCTION public.resolve_task_sla_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_task_sla_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_task_workflow_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_context('task_workflow_policy', p_context)
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_task_workflow_policy(JSONB)
  IS 'Resolve task_workflow_policy via canonical ladder context helper (returns winning settings row).';

REVOKE ALL ON FUNCTION public.resolve_task_workflow_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_task_workflow_policy(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Canonical RPCs (no ad-hoc DML)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_task_v1(
  p_task_type_key TEXT,
  p_context JSONB DEFAULT '{}'::jsonb,
  p_resource_type TEXT DEFAULT NULL,
  p_resource_id UUID DEFAULT NULL,
  p_queue_key TEXT DEFAULT NULL,
  p_priority INT DEFAULT NULL,
  p_sla_minutes INT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID,
  workflow_run_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_now TIMESTAMPTZ := now();

  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);
  v_policy_ctx JSONB;

  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_sender_client_id UUID;

  v_task_type public.task_types%ROWTYPE;

  v_task_policy_row RECORD;
  v_sla_policy_row RECORD;
  v_workflow_policy_row RECORD;

  v_task_policy JSONB := '{}'::jsonb;
  v_sla_policy JSONB := '{}'::jsonb;
  v_workflow_policy JSONB := '{}'::jsonb;

  v_task_policy_resolution_id UUID := NULL;
  v_sla_policy_resolution_id UUID := NULL;
  v_workflow_policy_resolution_id UUID := NULL;

  v_initial_status TEXT;
  v_queue TEXT;
  v_priority_final INT;
  v_sla_minutes_final INT;
  v_sla_due_at TIMESTAMPTZ;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  v_template UUID := NULL;
  v_run UUID := NULL;
  v_decision_id UUID := NULL;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'create_task_v1 requires tenant/platform write scope';
  END IF;

  BEGIN
    v_org_id := NULLIF(v_ctx->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    v_org_id := public.current_user_org_id();
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_task_v1 could not resolve organization_id';
  END IF;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'create_task_v1 cannot target another organization'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_client_id := NULLIF(v_ctx->>'client_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_client_id := NULL;
  END;

  BEGIN
    v_sender_id := NULLIF(v_ctx->>'sender_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_sender_id := NULL;
  END;

  IF v_sender_id IS NOT NULL THEN
    SELECT s.client_id INTO v_sender_client_id
    FROM public.senders s
    WHERE s.id = v_sender_id;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'create_task_v1 sender_id not found: %', v_sender_id;
    END IF;
    IF v_client_id IS NULL THEN
      v_client_id := v_sender_client_id;
    ELSIF v_client_id <> v_sender_client_id THEN
      RAISE EXCEPTION 'create_task_v1 sender_id % does not belong to client_id %', v_sender_id, v_client_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_client_id IS NOT NULL THEN
    PERFORM 1
    FROM public.clients c
    WHERE c.id = v_client_id
      AND c.organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_task_v1 client_id % is outside organization_id %', v_client_id, v_org_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_task_type_key IS NULL OR btrim(p_task_type_key) = '' THEN
    RAISE EXCEPTION 'create_task_v1 requires task_type_key';
  END IF;

  SELECT *
    INTO v_task_type
    FROM public.task_types tt
   WHERE tt.organization_id = v_org_id
     AND tt.key = lower(btrim(p_task_type_key))
     AND tt.enabled = TRUE
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_task_v1 task_type_key not found or disabled: %', p_task_type_key
      USING ERRCODE = '23514';
  END IF;

  -- Resolve policies via ladder (row-driven). Only log provenance if this call inserts a new task.
  v_policy_ctx := jsonb_strip_nulls(
    v_ctx
    || jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )
  );

  SELECT * INTO v_task_policy_row FROM public.resolve_task_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_task_policy_row.value IS NOT NULL THEN
    v_task_policy := v_task_policy_row.value;
  END IF;

  SELECT * INTO v_sla_policy_row FROM public.resolve_task_sla_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_sla_policy_row.value IS NOT NULL THEN
    v_sla_policy := v_sla_policy_row.value;
  END IF;

  SELECT * INTO v_workflow_policy_row FROM public.resolve_task_workflow_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_workflow_policy_row.value IS NOT NULL THEN
    v_workflow_policy := v_workflow_policy_row.value;
  END IF;

  v_initial_status := lower(COALESCE(NULLIF(v_task_policy->>'initial_status', ''), 'open'));

  v_queue := COALESCE(
    NULLIF(btrim(COALESCE(p_queue_key, '')), ''),
    NULLIF(btrim(COALESCE(v_task_policy->>'default_queue_key', '')), ''),
    NULLIF(btrim(COALESCE(v_task_type.default_queue_key, '')), ''),
    NULL
  );

  v_priority_final := COALESCE(
    p_priority,
    NULLIF(v_task_policy->>'default_priority', '')::INT,
    v_task_type.default_priority
  );

  v_sla_minutes_final := COALESCE(
    p_sla_minutes,
    NULLIF(v_sla_policy->>'default_sla_minutes', '')::INT,
    NULL
  );

  IF v_sla_minutes_final IS NOT NULL AND v_sla_minutes_final > 0 THEN
    v_sla_due_at := v_now + make_interval(mins => v_sla_minutes_final);
  ELSE
    v_sla_due_at := NULL;
  END IF;

  -- Insert the projection row. Use idempotency to dedupe concurrent retries without side effects.
  IF v_idempotency IS NOT NULL THEN
    INSERT INTO public.tasks (
      organization_id,
      client_id,
      sender_id,
      task_type_id,
      resource_type,
      resource_id,
      status,
      priority,
      queue_key,
      sla_minutes,
      sla_due_at,
      workflow_run_id,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_client_id,
      v_sender_id,
      v_task_type.id,
      lower(NULLIF(btrim(COALESCE(p_resource_type, '')), '')),
      p_resource_id,
      v_initial_status,
      v_priority_final,
      v_queue,
      v_sla_minutes_final,
      v_sla_due_at,
      NULL,
      v_idempotency,
      1,
      COALESCE(p_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    ON CONFLICT (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
    DO NOTHING
    RETURNING id INTO task_id;

    IF task_id IS NULL THEN
      SELECT t.id, t.workflow_run_id
        INTO task_id, workflow_run_id
        FROM public.tasks t
       WHERE t.organization_id = v_org_id
         AND t.idempotency_key = v_idempotency
       LIMIT 1;

      SELECT te.id
        INTO task_event_id
        FROM public.task_events te
       WHERE te.task_id = task_id
         AND te.idempotency_key = v_idempotency
       LIMIT 1;

      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    INSERT INTO public.tasks (
      organization_id,
      client_id,
      sender_id,
      task_type_id,
      resource_type,
      resource_id,
      status,
      priority,
      queue_key,
      sla_minutes,
      sla_due_at,
      workflow_run_id,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_client_id,
      v_sender_id,
      v_task_type.id,
      lower(NULLIF(btrim(COALESCE(p_resource_type, '')), '')),
      p_resource_id,
      v_initial_status,
      v_priority_final,
      v_queue,
      v_sla_minutes_final,
      v_sla_due_at,
      NULL,
      NULL,
      1,
      COALESCE(p_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    RETURNING id INTO task_id;
  END IF;

  -- Workflow (optional; defaults to NULL). Precedence: task_type default -> workflow_policy.events.created.workflow_template_id.
  v_template := v_task_type.default_workflow_template_id;
  IF v_template IS NULL THEN
    BEGIN
      v_template := NULLIF(v_workflow_policy #>> '{events,created,workflow_template_id}', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_template := NULL;
    END;
  END IF;

  IF v_template IS NOT NULL THEN
    v_run := public.start_workflow_run(
      v_template,
      jsonb_strip_nulls(jsonb_build_object(
        'task_id', task_id::text,
        'task_type_key', v_task_type.key,
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'resource_type', lower(NULLIF(p_resource_type, '')),
        'resource_id', p_resource_id,
        'trigger_source', 'task'
      ))
    );

    UPDATE public.tasks
       SET workflow_run_id = v_run
     WHERE id = task_id;
  END IF;

  workflow_run_id := v_run;

  -- Provenance (only for newly-created tasks).
  IF v_task_policy_row.value IS NOT NULL THEN
    v_task_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'task_policy',
      p_winning_scope_type := v_task_policy_row.scope_type,
      p_winning_scope_id := v_task_policy_row.scope_id,
      p_winning_settings_id := v_task_policy_row.settings_id,
      p_winning_settings_version_id := v_task_policy_row.settings_version_id,
      p_winning_version := v_task_policy_row.version,
      p_scope_path := v_task_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type.key,
        'resource_type', p_resource_type
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_sla_policy_row.value IS NOT NULL THEN
    v_sla_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'task_sla_policy',
      p_winning_scope_type := v_sla_policy_row.scope_type,
      p_winning_scope_id := v_sla_policy_row.scope_id,
      p_winning_settings_id := v_sla_policy_row.settings_id,
      p_winning_settings_version_id := v_sla_policy_row.settings_version_id,
      p_winning_version := v_sla_policy_row.version,
      p_scope_path := v_sla_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type.key
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_workflow_policy_row.value IS NOT NULL THEN
    v_workflow_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'task_workflow_policy',
      p_winning_scope_type := v_workflow_policy_row.scope_type,
      p_winning_scope_id := v_workflow_policy_row.scope_id,
      p_winning_settings_id := v_workflow_policy_row.settings_id,
      p_winning_settings_version_id := v_workflow_policy_row.settings_version_id,
      p_winning_version := v_workflow_policy_row.version,
      p_scope_path := v_workflow_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type.key,
        'event_type', 'created'
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := task_id,
    p_decision_point := 'create',
    p_decision_outcome := 'created',
    p_performed_by_system := 'create_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'task_type_key', v_task_type.key,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'resource_type', lower(NULLIF(p_resource_type, '')),
      'resource_id', p_resource_id,
      'queue_key', v_queue,
      'priority', v_priority_final,
      'sla_minutes', v_sla_minutes_final,
      'workflow_run_id', v_run,
      'task_policy_settings_resolution_id', v_task_policy_resolution_id,
      'task_sla_settings_resolution_id', v_sla_policy_resolution_id,
      'task_workflow_settings_resolution_id', v_workflow_policy_resolution_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_task_policy_resolution_id
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
    created_at
  )
  VALUES (
    task_id,
    v_org_id,
    'created',
    NULL,
    v_initial_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'queue_key', v_queue,
      'priority', v_priority_final,
      'sla_minutes', v_sla_minutes_final,
      'sla_due_at', v_sla_due_at,
      'workflow_run_id', v_run,
      'correlation_id', public.current_correlation_id(),
      'task_policy_settings_resolution_id', v_task_policy_resolution_id,
      'task_sla_settings_resolution_id', v_sla_policy_resolution_id,
      'task_workflow_settings_resolution_id', v_workflow_policy_resolution_id
    )),
    v_idempotency,
    1,
    v_decision_id,
    v_task_policy_resolution_id,
    v_now
  )
  RETURNING id INTO task_event_id;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.create_task_v1(TEXT, JSONB, TEXT, UUID, TEXT, INT, INT, TEXT, JSONB)
  IS 'Create a task (projection + event ledger) via canonical RPC. Resolves task policy via ladder and logs provenance.';

REVOKE ALL ON FUNCTION public.create_task_v1(TEXT, JSONB, TEXT, UUID, TEXT, INT, INT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_task_v1(TEXT, JSONB, TEXT, UUID, TEXT, INT, INT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_task_v1(TEXT, JSONB, TEXT, UUID, TEXT, INT, INT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_task_v1(TEXT, JSONB, TEXT, UUID, TEXT, INT, INT, TEXT, JSONB) TO authenticated, service_role;

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
  IS 'Assign a task to a user (projection update + ledger event).';

REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

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
  IS 'Transition a task status (projection update + ledger event).';

REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601212310_tasks_ssot_rpcs'));

COMMIT;
