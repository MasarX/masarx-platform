-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Tasks: allow service_role create + actor_system capture (append-only)
-- Date: 2026-01-21
--
-- Why:
--   - Workflow engine runs under service_role and must be able to create tasks as a SSOT unit of work.
--   - Task event ledger should capture system provenance (actor_system) when set by workflow/worker code.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601212890_tasks_actor_system_service_create'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_claims JSONB := NULL;
  v_jwt_role TEXT := NULL;
  v_is_platform BOOLEAN := FALSE;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(current_setting('app.actor_system', true), '')), '');
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
  v_existing_task_id UUID := NULL;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_jwt_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF v_user_id IS NULL THEN
    IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'create_task_v1 requires an authenticated user or service_role context';
    END IF;
  ELSE
    v_is_platform := public.is_platform_user();

    IF COALESCE(public.user_can_write(), FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'create_task_v1 requires tenant/platform write scope';
    END IF;
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
  IF v_user_id IS NOT NULL
     AND COALESCE(v_is_platform, FALSE) IS NOT TRUE
     AND v_org_id <> public.current_user_org_id() THEN
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

      v_existing_task_id := task_id;

      SELECT te.id
        INTO task_event_id
        FROM public.task_events te
       WHERE te.task_id = v_existing_task_id
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
    v_actor_system,
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

CREATE OR REPLACE FUNCTION public.create_task_system_v1(
  p_payload JSONB
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
  v_input JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_task_type_key TEXT := NULL;
  v_context JSONB := '{}'::jsonb;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_actor_system TEXT := NULL;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_task_system_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'create_task_system_v1 requires service_role context';
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_input->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'create_task_system_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  v_context := COALESCE(v_input->'context', '{}'::jsonb);
  v_resource_type := NULLIF(btrim(COALESCE(v_input->>'resource_type', '')), '');
  BEGIN v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(v_input->>'priority', '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  BEGIN
    RETURN QUERY
    SELECT *
    FROM public.create_task_v1(
      v_task_type_key,
      v_context,
      v_resource_type,
      v_resource_id,
      v_queue_key,
      v_priority,
      v_sla_minutes,
      v_idempotency_key,
      v_metadata
    );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$$;

COMMENT ON FUNCTION public.create_task_system_v1(JSONB)
  IS 'Service-only wrapper to create a task via create_task_v1, optionally setting actor_system for the task_events ledger.';

REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_task_system_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212890_tasks_actor_system_service_create'));
COMMIT;
