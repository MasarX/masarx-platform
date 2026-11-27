BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;

-- These callers have already checked the workflow or import run's authority.
CREATE FUNCTION workflow_handlers.enqueue_system_task_v1(p_payload jsonb)
RETURNS TABLE (task_id uuid, task_event_id uuid, workflow_run_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_prev_claims text := COALESCE(current_setting('request.jwt.claims', true), '');
  v_claims jsonb := COALESCE(NULLIF(v_prev_claims, '')::jsonb, '{}'::jsonb);
BEGIN
  PERFORM set_config('request.jwt.claims', (v_claims || '{"role":"service_role"}'::jsonb)::text, true);
  RETURN QUERY SELECT * FROM public.create_task_system_v1(p_payload);
  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
EXCEPTION WHEN OTHERS THEN
  -- The PL/pgSQL subtransaction also rolls back the temporary claims on error.
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION workflow_handlers.enqueue_system_task_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.enqueue_system_task_v1(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.create_task_v1(p_task_type_key text, p_context jsonb DEFAULT '{}'::jsonb, p_resource_type text DEFAULT NULL::text, p_resource_id uuid DEFAULT NULL::uuid, p_queue_key text DEFAULT NULL::text, p_priority integer DEFAULT NULL::integer, p_sla_minutes integer DEFAULT NULL::integer, p_idempotency_key text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(task_id uuid, task_event_id uuid, workflow_run_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
        'trigger_source', 'task',
        'trigger_type', 'task'
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
    COALESCE(v_user_id, CASE WHEN v_jwt_role = 'service_role' THEN (
      SELECT u.id FROM public.users u
      WHERE u.id = NULLIF(current_setting('app.actor_user_id', true), '')::uuid
        AND (u.organization_id = v_org_id OR u.access_scope_type = 'platform')
    ) END),
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
$function$;

CREATE OR REPLACE FUNCTION public.create_task_system_v1(p_payload jsonb)
 RETURNS TABLE(task_id uuid, task_event_id uuid, workflow_run_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
  v_dispatch_exception_reason TEXT := NULL;
  v_followup_action_id UUID := NULL;
  v_followup_action RECORD;
  v_followup_action_data JSONB := '{}'::jsonb;
  v_followup_action_service_type TEXT := NULL;
  v_service_type TEXT := NULL;
  v_exception_notes TEXT := NULL;
  v_evidence_artifact_ids JSONB := NULL;
  v_allowed_ndr_actions JSONB := NULL;
  v_route_stop_id UUID := NULL;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_prev_actor_user_id TEXT := COALESCE(current_setting('app.actor_user_id', true), '');
  v_org_id UUID := NULL;
  v_task_type RECORD;
  v_assignment_defaults JSONB := '{}'::jsonb;
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
  BEGIN
    v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_resource_id := NULL;
  END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN
    v_priority := NULLIF(v_input->>'priority', '')::int;
  EXCEPTION
    WHEN others THEN
      v_priority := NULL;
  END;
  BEGIN
    v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int;
  EXCEPTION
    WHEN others THEN
      v_sla_minutes := NULL;
  END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  IF v_org_id IS NOT NULL THEN
    PERFORM public.ensure_task_type_from_catalog_v1(v_org_id, v_task_type_key, v_context);

    SELECT
      tt.id,
      tt.default_queue_key,
      tt.metadata
      INTO v_task_type
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_task_type_key
     LIMIT 1;

    IF jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)) = 'object'
       AND jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults') = 'object' THEN
      v_assignment_defaults := COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults';
    END IF;

    IF v_queue_key IS NULL THEN
      v_queue_key := NULLIF(btrim(COALESCE(v_assignment_defaults->>'queue_key', '')), '');
    END IF;

    IF v_sla_minutes IS NULL THEN
      BEGIN
        v_sla_minutes := NULLIF(v_assignment_defaults->>'sla_minutes', '')::int;
      EXCEPTION
        WHEN others THEN
          v_sla_minutes := NULL;
      END;
    END IF;

    IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
      v_metadata := '{}'::jsonb;
    END IF;

    IF jsonb_typeof(COALESCE(v_metadata->'assignment_defaults', 'null'::jsonb)) IS DISTINCT FROM 'object'
       AND jsonb_typeof(v_assignment_defaults) = 'object'
       AND v_assignment_defaults <> '{}'::jsonb THEN
      v_metadata := jsonb_set(v_metadata, '{assignment_defaults}', v_assignment_defaults, TRUE);
    END IF;
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_task_type_key = 'dispatch_exception_review' THEN
    v_dispatch_exception_reason := NULLIF(
      btrim(
        COALESCE(
          v_metadata->>'dispatch_exception_reason',
          v_context->>'dispatch_exception_reason',
          v_context->>'outcome_reason',
          v_input->>'status_reason',
          ''
        )
      ),
      ''
    );

    BEGIN
      v_followup_action_id := COALESCE(
        NULLIF(v_metadata->>'shipment_action_id', '')::uuid,
        NULLIF(v_context->>'shipment_action_id', '')::uuid
      );
    EXCEPTION
      WHEN others THEN
        v_followup_action_id := NULL;
    END;

    BEGIN
      v_route_stop_id := COALESCE(
        NULLIF(v_metadata->>'route_stop_id', '')::uuid,
        NULLIF(v_context->>'route_stop_id', '')::uuid
      );
    EXCEPTION
      WHEN others THEN
        v_route_stop_id := NULL;
    END;

    IF v_followup_action_id IS NOT NULL THEN
      SELECT
        sa.id AS shipment_action_id,
        sa.action_data,
        s.service_type
        INTO v_followup_action
       FROM public.shipment_actions sa
       LEFT JOIN public.shipments s
         ON s.id = sa.shipment_id
        AND s.client_id = sa.client_id
       WHERE sa.id = v_followup_action_id
       LIMIT 1;

      v_followup_action_data := COALESCE(v_followup_action.action_data, '{}'::jsonb);
      v_followup_action_service_type := v_followup_action.service_type;
    END IF;

    v_service_type := NULLIF(
      btrim(
        COALESCE(
          v_metadata->>'service_type',
          v_context->>'service_type',
          v_followup_action_data->'task_event_payload'->>'service_type',
          v_followup_action_service_type,
          ''
        )
      ),
      ''
    );
    v_exception_notes := NULLIF(
      btrim(
        COALESCE(
          v_metadata->>'exception_notes',
          v_context->>'exception_notes',
          v_followup_action_data->'task_event_payload'->>'exception_notes',
          v_followup_action_data->'task_event_payload'->>'notes',
          ''
        )
      ),
      ''
    );
    v_evidence_artifact_ids := COALESCE(
      v_metadata->'evidence_artifact_ids',
      v_context->'evidence_artifact_ids',
      v_followup_action_data->'artifact_ids'
    );
    v_allowed_ndr_actions := COALESCE(
      v_metadata->'allowed_ndr_actions',
      v_context->'allowed_ndr_actions',
      v_followup_action_data->'task_event_payload'->'allowed_ndr_actions'
    );

    IF v_dispatch_exception_reason IS NOT NULL THEN
      v_metadata := v_metadata || jsonb_build_object('dispatch_exception_reason', v_dispatch_exception_reason);
    END IF;
    IF v_followup_action_id IS NOT NULL THEN
      v_metadata := v_metadata || jsonb_build_object('shipment_action_id', v_followup_action_id);
    END IF;
    IF v_route_stop_id IS NULL THEN
      BEGIN
        v_route_stop_id := NULLIF(v_followup_action_data->>'route_stop_id', '')::uuid;
      EXCEPTION
        WHEN others THEN
          v_route_stop_id := NULL;
      END;
    END IF;
    IF v_route_stop_id IS NOT NULL THEN
      v_metadata := v_metadata || jsonb_build_object('route_stop_id', v_route_stop_id);
    END IF;
    IF v_service_type IS NOT NULL THEN
      v_metadata := v_metadata || jsonb_build_object('service_type', v_service_type);
    END IF;
    IF v_exception_notes IS NOT NULL THEN
      v_metadata := v_metadata || jsonb_build_object('exception_notes', v_exception_notes);
    END IF;
    IF jsonb_typeof(v_evidence_artifact_ids) = 'array' THEN
      v_metadata := v_metadata || jsonb_build_object('evidence_artifact_ids', v_evidence_artifact_ids);
    END IF;
    IF jsonb_typeof(v_allowed_ndr_actions) = 'array' THEN
      v_metadata := v_metadata || jsonb_build_object('allowed_ndr_actions', v_allowed_ndr_actions);
    END IF;
    v_metadata := jsonb_strip_nulls(v_metadata);
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  BEGIN
    PERFORM set_config('app.actor_user_id', COALESCE(
      NULLIF(v_prev_sub, ''), NULLIF(v_claims->>'sub', ''), v_prev_actor_user_id
    ), true);
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
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  PERFORM set_config('app.actor_user_id', v_prev_actor_user_id, true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_start_tabular_import_run_v1(p_run_id uuid, p_save_profile jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_save_profile JSONB := COALESCE(p_save_profile, '{}'::jsonb);
  v_profile_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_save_profile->>'mode', '')), ''), 'none'));
  v_profile_name TEXT := NULLIF(btrim(COALESCE(v_save_profile->>'profile_name', '')), '');
  v_profile_id UUID := public.mapping_studio_try_uuid_v1(v_save_profile->>'profile_id');
  v_profile_slug TEXT;
  v_mapping_key TEXT;
  v_mapping_result JSONB;
  v_summary JSONB := '{}'::jsonb;
  v_resolved_rules JSONB := '[]'::jsonb;
  v_unresolved_targets JSONB := '[]'::jsonb;
  v_task RECORD;
  v_task_context JSONB := '{}'::jsonb;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 cannot start another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  IF v_run.status IN ('queued', 'processing') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;
  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % is already terminal (%).', v_run.id, v_run.status;
  END IF;
  IF v_run.total_rows <= 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % has no staged rows', v_run.id;
  END IF;
  IF v_run.blocked_count > 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % still has blocked rows', v_run.id;
  END IF;

  v_summary := COALESCE(v_run.summary, '{}'::jsonb);
  v_resolved_rules := COALESCE(v_summary->'resolved_rules', '[]'::jsonb);
  v_unresolved_targets := COALESCE(v_summary->'unresolved_targets', '[]'::jsonb);

  IF jsonb_typeof(v_unresolved_targets) = 'array' AND jsonb_array_length(v_unresolved_targets) > 0 THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 run % still has unresolved targets', v_run.id;
  END IF;

  IF v_profile_mode IN ('new', 'update') THEN
    v_profile_name := COALESCE(v_profile_name, v_run.profile_name, format('%s import', v_run.resource_key));
    v_profile_slug := public.tabular_import_slug_v1(v_profile_name);
    v_mapping_key := format(
      'tabular_import::%s::%s::%s',
      public.mapping_studio_normalize_key_v1(v_run.resource_key),
      v_profile_slug,
      v_run.organization_id
    );

    v_mapping_result := public.ui_upsert_mapping_artifact_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact', 'tabular_import',
          'organization_id', v_run.organization_id,
          'mapping_config_id', CASE WHEN v_profile_mode = 'update' THEN v_profile_id ELSE NULL END,
          'mapping_key', v_mapping_key,
          'target_resource_key', v_run.resource_key,
          'notes', format('Tabular import profile saved from run %s', v_run.id),
          'mapping_config', jsonb_build_object(
            'resource_key', v_run.resource_key,
            'profile_name', v_profile_name,
            'profile_slug', v_profile_slug,
            'header_fingerprint', v_run.header_fingerprint,
            'sheet_hint', v_run.sheet_name,
            'write_mode', v_run.write_mode,
            'field_rules', COALESCE(v_resolved_rules, '[]'::jsonb)
          )
        )
      )
    );

    UPDATE public.tabular_import_runs
       SET profile_name = v_profile_name,
           updated_at = now()
     WHERE id = v_run.id;
  END IF;

  v_task_context := jsonb_build_object(
    'organization_id', v_run.organization_id,
    'client_id', v_run.client_id,
    'sender_id', v_run.sender_id,
    'resource_key', v_run.resource_key,
    'run_id', v_run.id
  );

  IF auth.uid() IS NULL THEN
    IF NULLIF(btrim(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role'), '') IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'create_task_v1 requires an authenticated user or service_role context';
    END IF;
  ELSIF COALESCE(public.user_can_write(), FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'ui_start_tabular_import_run_v1 requires tenant/platform write scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT v_task
  FROM workflow_handlers.enqueue_system_task_v1(jsonb_build_object(
    'task_type_key', 'tabular_import.process',
    'context', v_task_context,
    'resource_type', 'tabular_import_run',
    'resource_id', v_run.id,
    'queue_key', 'imports',
    'priority', 60,
    'idempotency_key', format('tabular_import_process:%s', v_run.id),
    'actor_system', 'resource_import_studio',
    'metadata', jsonb_build_object(
      'operation_kind', 'tabular_import_execution',
      'profile_name', COALESCE(v_profile_name, v_run.profile_name),
      'resource_key', v_run.resource_key
    )
  ));

  UPDATE public.tabular_import_runs
     SET status = 'queued',
         task_id = v_task.task_id,
         updated_at = now(),
         updated_by = COALESCE(auth.uid(), updated_by)
   WHERE id = v_run.id;

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_v2(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'task_type_key', '')), ''));
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task');
  v_task_context_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'task_context_path', '')), '');
  v_resource_id_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'resource_id_path', '')), '');

  v_when_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'when_path', '')), '');
  v_when_value JSONB := NULL;
  v_should_run BOOLEAN := TRUE;

  v_task_context JSONB := '{}'::jsonb;
  v_task_metadata JSONB := COALESCE(v_meta->'task_metadata', '{}'::jsonb);

  v_org_id UUID := NULL;
  v_resource_type TEXT := NULLIF(btrim(COALESCE(v_meta->>'resource_type', '')), '');
  v_resource_id UUID := NULL;

  v_queue_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'queue_key', '')), '');
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_resource_id_json JSONB := NULL;
  v_task_context_json JSONB := NULL;

  v_created RECORD;
  v_resp workflow_handler_response;
BEGIN
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: missing metadata.task_type_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  -- Conditional execution: when_path (row-driven).
  IF v_when_path IS NOT NULL THEN
    v_when_value := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_when_path
    );
    IF v_when_value IS NULL THEN
      v_should_run := FALSE;
    ELSIF jsonb_typeof(v_when_value) = 'boolean' THEN
      v_should_run := (v_when_value)::boolean;
    ELSIF jsonb_typeof(v_when_value) = 'number' THEN
      v_should_run := (COALESCE(NULLIF(btrim(v_when_value #>> '{}'), ''), '0')::numeric <> 0);
    ELSE
      v_should_run := (lower(btrim(COALESCE(v_when_value #>> '{}', ''))) IN ('true', '1', 'yes', 'y', 'on'));
    END IF;
  END IF;

  IF v_should_run IS NOT TRUE THEN
    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'skipped',
      'skipped', TRUE,
      'reason', 'when_path_false',
      'task_type_key', v_task_type_key,
      'context_key', v_context_key
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'status', 'skipped',
        'skipped', TRUE,
        'reason', 'when_path_false',
        'task_type_key', v_task_type_key
      ))
    );
    RETURN v_resp;
  END IF;

  -- task_context: default to full workflow context; can be overridden by jsonpath.
  v_task_context := v_ctx;
  IF v_task_context_path IS NOT NULL THEN
    v_task_context_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_task_context_path
    );
    IF v_task_context_json IS NOT NULL AND jsonb_typeof(v_task_context_json) = 'object' THEN
      v_task_context := v_task_context_json;
    END IF;
  END IF;

  -- organization_id must be present for service-driven calls.
  BEGIN
    v_org_id := NULLIF(COALESCE(v_task_context->>'organization_id', v_ctx->>'organization_id'), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  IF v_org_id IS DISTINCT FROM public.resolve_workflow_context_org_id(v_ctx, p_run.workflow_template_id) THEN
    RAISE EXCEPTION 'task_enqueue: task organization is outside the workflow run scope'
      USING ERRCODE = '42501';
  END IF;

  -- resource_id: optional; resolved from jsonpath when configured.
  IF v_resource_id_path IS NOT NULL THEN
    v_resource_id_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_resource_id_path
    );
    BEGIN
      v_resource_id := NULLIF(btrim(COALESCE(v_resource_id_json #>> '{}', '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_resource_id := NULL;
    END;
  ELSE
    BEGIN
      v_resource_id := NULLIF(btrim(COALESCE(v_meta->>'resource_id', '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_resource_id := NULL;
    END;
  END IF;

  BEGIN v_priority := NULLIF(btrim(COALESCE(v_meta->>'priority', '')), '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(btrim(COALESCE(v_meta->>'sla_minutes', '')), '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;

  -- Ensure task metadata carries parent workflow linkage (avoid confusion with tasks.workflow_run_id child workflows).
  v_task_metadata := public.jsonb_deep_merge(
    COALESCE(v_task_metadata, '{}'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'parent_workflow_run_id', p_run.id,
      'parent_workflow_step_id', p_step.id
    ))
  );

  SELECT *
    INTO v_created
    FROM workflow_handlers.enqueue_system_task_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'context', public.jsonb_deep_merge(v_task_context, jsonb_build_object('organization_id', v_org_id)),
        'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
        'resource_id', v_resource_id,
        'queue_key', v_queue_key,
        'priority', v_priority,
        'sla_minutes', v_sla_minutes,
        'idempotency_key', v_idempotency_key,
        'metadata', v_task_metadata,
        'actor_system', v_actor_system
      ))
    )
    LIMIT 1;

  IF v_created.task_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: create_task_system_v1 returned NULL task_id (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'task_id', v_created.task_id,
    'task_event_id', v_created.task_event_id,
    'task_workflow_run_id', v_created.workflow_run_id,
    'task_type_key', v_task_type_key,
    'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
    'resource_id', v_resource_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_created.task_id,
      'task_event_id', v_created.task_event_id,
      'task_workflow_run_id', v_created.workflow_run_id,
      'task_type_key', v_task_type_key,
      'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
      'resource_id', v_resource_id
    ))
  );
  RETURN v_resp;
END;
$function$;

REVOKE ALL ON FUNCTION workflow_handlers.execute_task_enqueue_v2(public.workflow_run_steps, public.workflow_runs, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_task_enqueue_v2(public.workflow_run_steps, public.workflow_runs, jsonb)
  TO service_role;

COMMIT;
