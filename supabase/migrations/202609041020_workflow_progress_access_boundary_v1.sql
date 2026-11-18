-- Migration: harden workflow progression access and canonical template scopes
-- Purpose:
--  - Authorize exposed workflow progression against the run's exact lineage before execution.
--  - Keep passive polling read-only at the capability boundary and gate explicit wake input as write.
--  - Fail closed on malformed template scopes and private worker entrypoint privileges.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('202609041020_workflow_progress_access_boundary_v1'));

LOCK TABLE public.workflow_templates IN SHARE ROW EXCLUSIVE MODE;

DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE (
      (wt.scope_type = 'global' AND wt.scope_id IS NULL)
      OR (wt.scope_type IN ('tenant', 'client', 'sender') AND wt.scope_id IS NOT NULL)
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'workflow_templates contains invalid legacy scope rows'
      USING ERRCODE = '23514';
  END IF;
END;
$audit$;

ALTER TABLE public.workflow_templates
  ADD CONSTRAINT workflow_templates_scope_type_id_shape_ck
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR (scope_type IN ('tenant', 'client', 'sender') AND scope_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.workflow_template_scope_allowed(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_org UUID := public.current_user_org_id();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_client_id UUID := public.current_user_client_id();
BEGIN
  IF (
    (p_scope_type = 'global' AND p_scope_id IS NULL)
    OR (p_scope_type IN ('tenant', 'client', 'sender') AND p_scope_id IS NOT NULL)
  ) IS NOT TRUE THEN
    RETURN FALSE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_org IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_scope_type = 'global' THEN
    RETURN TRUE;
  END IF;

  IF p_scope_type = 'tenant' THEN
    RETURN v_scope_type = 'tenant' AND p_scope_id = v_org;
  END IF;

  IF p_scope_type = 'client' THEN
    IF v_scope_type = 'tenant' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = p_scope_id
          AND c.organization_id = v_org
      );
    END IF;

    IF v_scope_type = 'client' THEN
      RETURN p_scope_id = v_scope_id;
    END IF;

    RETURN FALSE;
  END IF;

  IF v_scope_type = 'tenant' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = p_scope_id
        AND c.organization_id = v_org
    );
  END IF;

  IF v_scope_type = 'client' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.senders s
      WHERE s.id = p_scope_id
        AND s.client_id = v_client_id
    );
  END IF;

  IF v_scope_type = 'sender' THEN
    RETURN p_scope_id = v_scope_id;
  END IF;

  RETURN FALSE;
END;
$function$;

COMMENT ON FUNCTION public.workflow_template_scope_allowed(TEXT, UUID)
  IS 'Return TRUE only for exact canonical global/tenant/client/sender scope inputs visible to the current authenticated user hierarchy.';

CREATE OR REPLACE FUNCTION public.progress_workflow_run_until_wait_v1(
  p_workflow_run_id UUID,
  p_operation_result JSONB DEFAULT '{}'::JSONB,
  p_budget_ms INTEGER DEFAULT NULL,
  p_max_steps INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_budget_ms INTEGER := LEAST(GREATEST(COALESCE(p_budget_ms, 150), 25), 5000);
  v_max_steps INTEGER := LEAST(GREATEST(COALESCE(p_max_steps, 3), 1), 50);
  v_started_at TIMESTAMPTZ := clock_timestamp();
  v_elapsed_ms INTEGER := 0;
  v_remaining_ms INTEGER := 0;
  v_steps INTEGER := 0;
  v_waited_ms INTEGER := 0;
  v_last JSONB := jsonb_build_object('workflow_run_id', p_workflow_run_id, 'status', 'idle');
  v_injected_operation_result JSONB := COALESCE(p_operation_result, '{}'::JSONB);
  v_status TEXT := '';
  v_has_step BOOLEAN := FALSE;
  v_next_run_at TIMESTAMPTZ := NULL;
  v_wait_ms INTEGER := 0;
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_until_wait_v1 requires workflow_run_id';
  END IF;

  WHILE v_steps < v_max_steps LOOP
    v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::INTEGER;
    EXIT WHEN v_elapsed_ms >= v_budget_ms;

    v_remaining_ms := GREATEST(v_budget_ms - v_elapsed_ms, 0);
    PERFORM set_config('masarx.workflow_progress_budget_ms', v_budget_ms::TEXT, TRUE);
    PERFORM set_config('masarx.workflow_progress_elapsed_ms', v_elapsed_ms::TEXT, TRUE);
    PERFORM set_config('masarx.workflow_progress_remaining_ms', v_remaining_ms::TEXT, TRUE);

    v_last := public.progress_workflow_run(p_workflow_run_id, v_injected_operation_result);
    v_steps := v_steps + 1;
    v_injected_operation_result := '{}'::JSONB;
    v_status := lower(COALESCE(v_last->>'status', ''));
    v_has_step := NULLIF(v_last->>'step_id', '') IS NOT NULL;
    v_next_run_at := NULL;

    BEGIN
      v_next_run_at := NULLIF(v_last->>'next_run_at', '')::TIMESTAMPTZ;
    EXCEPTION
      WHEN OTHERS THEN
        v_next_run_at := NULL;
    END;

    EXIT WHEN v_status IN ('failed', 'cancelled', 'blocked');
    IF v_status = 'completed' AND NOT v_has_step THEN
      EXIT;
    END IF;

    IF v_status IN ('pending', 'waiting') AND v_next_run_at IS NOT NULL THEN
      v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::INTEGER;
      v_remaining_ms := GREATEST(v_budget_ms - v_elapsed_ms, 0);
      v_wait_ms := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_next_run_at - clock_timestamp())) * 1000.0)::INTEGER, 0);

      IF v_wait_ms = 0 THEN
        CONTINUE;
      END IF;

      IF v_wait_ms <= v_remaining_ms THEN
        PERFORM pg_sleep((v_wait_ms::NUMERIC) / 1000.0);
        v_waited_ms := v_waited_ms + v_wait_ms;
        CONTINUE;
      END IF;
    END IF;

    EXIT WHEN v_status IN ('pending', 'waiting', 'in_progress');
  END LOOP;

  v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::INTEGER;

  RETURN jsonb_strip_nulls(
    COALESCE(v_last, '{}'::JSONB)
    || jsonb_build_object(
      'attempts', v_steps,
      'elapsed_ms', v_elapsed_ms,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps,
      'waited_ms', v_waited_ms
    )
  );
EXCEPTION
  WHEN SQLSTATE '42501' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'status', 'failed',
      'error', SQLERRM,
      'attempts', v_steps,
      'elapsed_ms', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::INTEGER,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps,
      'waited_ms', v_waited_ms
    );
END;
$function$;

COMMENT ON FUNCTION public.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  IS 'Advance immediately available workflow steps within a bounded budget; authorization failures propagate without mutating failure state.';

CREATE OR REPLACE FUNCTION api.progress_workflow_run_until_wait_v1(
  p_workflow_run_id UUID,
  p_operation_result JSONB DEFAULT '{}'::JSONB,
  p_budget_ms INTEGER DEFAULT NULL,
  p_max_steps INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_context JSONB;
  v_template_scope_type TEXT;
  v_template_scope_id UUID;
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_lineage_org_id UUID;
  v_lineage_client_id UUID;
  v_target_type TEXT;
  v_target_id UUID;
BEGIN
  SELECT wr.context, wt.scope_type, wt.scope_id
    INTO v_context, v_template_scope_type, v_template_scope_id
    FROM public.workflow_runs wr
    JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
   WHERE wr.id = p_workflow_run_id
   FOR UPDATE OF wr;

  IF NOT FOUND AND NOT v_is_service THEN
    RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_service THEN
    IF NOT public.workflow_template_scope_allowed(v_template_scope_type, v_template_scope_id) THEN
      RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
    END IF;

    IF v_is_platform THEN
      IF COALESCE(p_operation_result, '{}'::JSONB) = '{}'::JSONB THEN
        PERFORM public.assert_capability_v1(
          'workflow_runs.read',
          public.get_root_scope_type_key_v1(),
          NULL
        );
      ELSE
        PERFORM public.assert_capability_v1(
          'workflow_runs.write',
          public.get_root_scope_type_key_v1(),
          NULL
        );
      END IF;
    ELSE
      IF v_context IS NULL OR jsonb_typeof(v_context) <> 'object' THEN
        RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
      END IF;

      BEGIN
      v_org_id := NULLIF(v_context->>'organization_id', '')::UUID;
      v_client_id := NULLIF(v_context->>'client_id', '')::UUID;
      v_sender_id := NULLIF(v_context->>'sender_id', '')::UUID;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
    END;

    IF v_sender_id IS NOT NULL THEN
      SELECT s.client_id, c.organization_id
        INTO v_lineage_client_id, v_lineage_org_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;

      IF NOT FOUND
         OR (v_client_id IS NOT NULL AND v_client_id IS DISTINCT FROM v_lineage_client_id)
         OR (v_org_id IS NOT NULL AND v_org_id IS DISTINCT FROM v_lineage_org_id) THEN
        RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
      END IF;

      v_client_id := v_lineage_client_id;
      v_org_id := v_lineage_org_id;
    ELSIF v_client_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_lineage_org_id
        FROM public.clients c
       WHERE c.id = v_client_id;

      IF NOT FOUND
         OR (v_org_id IS NOT NULL AND v_org_id IS DISTINCT FROM v_lineage_org_id) THEN
        RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
      END IF;

      v_org_id := v_lineage_org_id;
    ELSIF v_org_id IS NOT NULL THEN
      PERFORM 1
        FROM public.organizations o
       WHERE o.id = v_org_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
    END IF;

    IF v_sender_id IS NOT NULL THEN
      v_target_type := 'sender';
      v_target_id := v_sender_id;
    ELSIF v_client_id IS NOT NULL THEN
      v_target_type := 'client';
      v_target_id := v_client_id;
    ELSE
      v_target_type := 'tenant';
      v_target_id := v_org_id;
    END IF;

    IF NOT public.workflow_template_scope_allowed(v_target_type, v_target_id) THEN
      RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';
    END IF;

      IF COALESCE(p_operation_result, '{}'::JSONB) = '{}'::JSONB THEN
        PERFORM public.assert_capability_v1('workflow_runs.read', v_target_type, v_target_id);
      ELSE
        PERFORM public.assert_capability_v1('workflow_runs.write', v_target_type, v_target_id);
      END IF;
    END IF;
  END IF;

  RETURN public.progress_workflow_run_until_wait_v1(
    p_workflow_run_id,
    p_operation_result,
    p_budget_ms,
    p_max_steps
  );
END;
$function$;

COMMENT ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  IS 'Authenticated API boundary for scoped workflow progression: passive polls require workflow_runs.read; explicit operation results require workflow_runs.write; claim-aware service callers are preserved.';

-- Keep authenticated UI producers aligned with the progression boundary.
CREATE OR REPLACE FUNCTION public.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_require_active BOOLEAN := COALESCE(p_require_active, TRUE);
  v_context JSONB;
  v_run_id UUID;
BEGIN
  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  IF NOT v_is_service AND NOT EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.id = p_workflow_template_id
      AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
  ) THEN
    RAISE EXCEPTION 'workflow template access denied' USING ERRCODE = '42501';
  END IF;

  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  ) || jsonb_strip_nulls(jsonb_build_object(
    'client_id', public.current_user_client_id(),
    'sender_id', public.current_user_sender_id()
  ));

  v_run_id := start_workflow_run(p_workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_id', p_workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_execute_command_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_execution JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_handler TEXT;
  v_static_params JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_template_scope_type TEXT;
  v_template_scope_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;
  v_workflow_start JSONB := '{}'::jsonb;
  v_inline_kick_enabled BOOLEAN := FALSE;
  v_inline_kick_max_attempts INT := 0;
  v_inline_kick_budget_ms INT := 0;
  v_inline_kick_poll_ms INT := 0;
  v_inline_attempts INT := 0;
  v_inline_elapsed_ms INT := 0;
  v_inline_progress JSONB := '{}'::jsonb;
  v_inline_status TEXT := NULL;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_enabled_raw TEXT := '';
  v_inline_max_raw TEXT := '';
  v_inline_budget_raw TEXT := '';
  v_inline_poll_raw TEXT := '';

  v_requested_to_status TEXT;
  v_requested_status_reason TEXT;
  v_idempotency_key TEXT;
  v_transition_payload JSONB;
  v_transition_row RECORD;
  v_task RECORD;
  v_policy_row RECORD;
  v_exception_reason TEXT;
  v_reason_required BOOLEAN;
  v_effective_to_status TEXT;
  v_effective_status_reason TEXT;
  v_task_type_key TEXT;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_command_v1 requires action key';
  END IF;

  SELECT value INTO v_command
    FROM jsonb_array_elements(v_registry->'commands') AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_command_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := v_command->'selection';
  v_mode := lower(COALESCE(v_selection->>'mode', ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_static_params := COALESCE(v_execution->'params', '{}'::jsonb);
  v_params := v_static_params || COALESCE(p_params, '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(v_params->>'handler', ''), ''));
  v_patch := COALESCE(v_params->'patch', '{}'::jsonb);

  IF COALESCE(v_command->>'workflow_key', '') <> ''
     OR (v_execution->>'type') = 'workflow'
     OR (v_execution->>'type') = 'print' THEN
    IF COALESCE(v_command->>'workflow_key', '') = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow key missing for %', p_action_key;
    END IF;

    SELECT wt.id, wt.scope_type, wt.scope_id
      INTO v_template_id, v_template_scope_type, v_template_scope_id
      FROM public.workflow_templates wt
     WHERE wt.name = v_command->>'workflow_key'
       AND wt.status = 'active'
     ORDER BY wt.version DESC
     LIMIT 1;

    IF v_template_id IS NULL AND v_is_service THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    IF v_template_id IS NULL OR (
      NOT v_is_service
      AND NOT public.workflow_template_scope_allowed(v_template_scope_type, v_template_scope_id)
    ) THEN
      RAISE EXCEPTION 'workflow template access denied' USING ERRCODE = '42501';
    END IF;

    v_payload_key := NULLIF(v_params->>'payload_key', '');
    v_selection_key := NULLIF(v_params->>'selection_id_key', '');
    IF v_payload_key IS NULL THEN
      v_payload_key := 'selections';
    END IF;
    IF v_selection_key IS NULL THEN
      v_selection_key := 'id';
    END IF;

    v_payload := jsonb_build_object(
      v_payload_key,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(v_selection_key, value)) FROM unnest(v_ids) AS value),
        '[]'::jsonb
      ),
      'selection_ids', to_jsonb(v_ids),
      'selection_id', v_id,
      'selection_count', v_count,
      'resource_key', p_resource_key,
      'organization_id', public.current_user_org_id()
    );

    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    ) || jsonb_strip_nulls(jsonb_build_object(
      'client_id', public.current_user_client_id(),
      'sender_id', public.current_user_sender_id()
    ));

    v_run_id := public.start_workflow_run(v_template_id, v_context);

    v_workflow_start := COALESCE(v_params->'workflow_start', '{}'::jsonb);
    IF jsonb_typeof(v_workflow_start) IS DISTINCT FROM 'object' THEN
      v_workflow_start := '{}'::jsonb;
    END IF;

    v_inline_enabled_raw := lower(COALESCE(NULLIF(v_workflow_start->>'inline_kick_enabled', ''), ''));
    v_inline_kick_enabled := v_inline_enabled_raw IN ('1', 't', 'true', 'y', 'yes', 'on');

    IF v_inline_kick_enabled THEN
      v_inline_max_raw := COALESCE(v_workflow_start->>'inline_kick_max_attempts', '');
      v_inline_budget_raw := COALESCE(v_workflow_start->>'inline_kick_budget_ms', '');
      v_inline_poll_raw := COALESCE(v_workflow_start->>'inline_kick_poll_ms', '');

      IF v_inline_max_raw ~ '^\d+$' THEN
        v_inline_kick_max_attempts := LEAST(GREATEST(v_inline_max_raw::INT, 1), 20);
      ELSE
        v_inline_kick_max_attempts := 1;
      END IF;

      IF v_inline_budget_raw ~ '^\d+$' THEN
        v_inline_kick_budget_ms := LEAST(GREATEST(v_inline_budget_raw::INT, 25), 5000);
      ELSE
        v_inline_kick_budget_ms := 150;
      END IF;

      IF v_inline_poll_raw ~ '^\d+$' THEN
        v_inline_kick_poll_ms := LEAST(GREATEST(v_inline_poll_raw::INT, 10), 500);
      ELSE
        v_inline_kick_poll_ms := 40;
      END IF;

      BEGIN
        v_inline_progress := public.progress_workflow_run_until_wait_v1(
          v_run_id,
          jsonb_build_object(
            'source', 'ui_execute_command_inline',
            'action_key', p_action_key
          ),
          v_inline_kick_budget_ms,
          v_inline_kick_max_attempts
        );
        v_inline_attempts := COALESCE(NULLIF(v_inline_progress->>'attempts', '')::INT, 0);
        v_inline_elapsed_ms := COALESCE(NULLIF(v_inline_progress->>'elapsed_ms', '')::INT, 0);
        v_inline_status := NULLIF(v_inline_progress->>'status', '');

        BEGIN
          v_inline_next_run_at := NULLIF(v_inline_progress->>'next_run_at', '')::TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
          v_inline_next_run_at := NULL;
        END;
      EXCEPTION WHEN OTHERS THEN
        v_inline_error := SQLERRM;
      END;
    END IF;

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id,
      'workflow_inline_kick', jsonb_strip_nulls(jsonb_build_object(
        'enabled', v_inline_kick_enabled,
        'attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_attempts ELSE NULL END,
        'max_attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_max_attempts ELSE NULL END,
        'budget_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_budget_ms ELSE NULL END,
        'poll_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_poll_ms ELSE NULL END,
        'elapsed_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_elapsed_ms ELSE NULL END,
        'status', CASE WHEN v_inline_kick_enabled THEN v_inline_status ELSE NULL END,
        'next_run_at', CASE WHEN v_inline_kick_enabled THEN v_inline_next_run_at ELSE NULL END,
        'error', CASE WHEN v_inline_kick_enabled THEN v_inline_error ELSE NULL END
      ))
    );
  END IF;

  IF v_handler = 'resource_update' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 patch must be object';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_update_resource_v1(p_resource_key, v_id, v_patch);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'updated',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'resource_delete' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_delete_resource_v1(p_resource_key, v_id);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'deleted',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'task_transition' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    v_requested_to_status := lower(COALESCE(NULLIF(v_params->>'to_status', ''), ''));
    IF v_requested_to_status = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 task_transition requires to_status';
    END IF;

    v_requested_status_reason := NULLIF(COALESCE(v_params->>'status_reason', ''), '');
    v_transition_payload := COALESCE(v_params->'payload', '{}'::jsonb);

    FOREACH v_id IN ARRAY v_ids LOOP
      v_effective_to_status := v_requested_to_status;
      v_effective_status_reason := v_requested_status_reason;
      v_task_type_key := NULL;

      IF v_requested_to_status = 'exception' THEN
        SELECT
          t.id,
          t.organization_id,
          t.client_id,
          t.sender_id,
          t.resource_type,
          t.resource_id,
          lower(NULLIF(btrim(COALESCE(tt.key, '')), '')) AS task_type_key
          INTO v_task
          FROM public.tasks t
          LEFT JOIN public.task_types tt
            ON tt.id = t.task_type_id
         WHERE t.id = v_id::uuid
         LIMIT 1;

        IF v_task.id IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 task_transition task not found: %', v_id USING ERRCODE = '23503';
        END IF;

        v_task_type_key := v_task.task_type_key;

        SELECT *
          INTO v_policy_row
          FROM public.resolve_pod_policy(
            jsonb_strip_nulls(
              jsonb_build_object(
                'organization_id', v_task.organization_id,
                'client_id', v_task.client_id,
                'sender_id', v_task.sender_id,
                'resource_type', v_task.resource_type,
                'resource_id', v_task.resource_id
              )
            )
          )
        LIMIT 1;

        v_reason_required := COALESCE(
          (v_policy_row.value->'requirements'->'exception'->>'exception_reason_required')::boolean,
          TRUE
        );

        v_exception_reason := lower(NULLIF(btrim(COALESCE(v_transition_payload->>'exception_reason', '')), ''));

        IF v_reason_required AND v_exception_reason IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 exception transition requires payload.exception_reason' USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL
           AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_exception_reason, TRUE) IS FALSE THEN
          RAISE EXCEPTION 'ui_execute_command_v1 invalid exception_reason: %', v_exception_reason USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL THEN
          v_transition_payload := jsonb_set(v_transition_payload, '{exception_reason}', to_jsonb(v_exception_reason), TRUE);
        END IF;

        IF v_task_type_key = 'route_stop_execute' THEN
          v_effective_to_status := 'completed';
          v_effective_status_reason := COALESCE(v_exception_reason, v_requested_status_reason, 'other');
        END IF;
      END IF;

      v_idempotency_key := encode(
        digest(
          format('%s|%s|%s|%s', p_action_key, v_effective_to_status, v_id, v_transition_payload::text),
          'sha256'
        ),
        'hex'
      );

      SELECT * INTO v_transition_row
      FROM public.transition_task_v1(
        p_task_id := v_id::uuid,
        p_to_status := v_effective_to_status,
        p_status_reason := v_effective_status_reason,
        p_payload := v_transition_payload,
        p_idempotency_key := v_idempotency_key
      )
      LIMIT 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'task_id', v_transition_row.task_id,
          'task_event_id', v_transition_row.task_event_id,
          'to_status', v_effective_to_status,
          'status_reason', v_effective_status_reason
        )
      );
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'task_transitioned',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'to_status', v_requested_to_status,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'route_closeout' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.close_route_run_v1(
        jsonb_strip_nulls(
          COALESCE(v_params, '{}'::jsonb)
          || jsonb_build_object('task_id', v_id)
        )
      );
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'route_closed_out',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$$;

COMMENT ON COLUMN public.workflow_templates.scope_type
  IS 'Canonical values: global, tenant, client, sender.';

REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
      TO edge_label_renderer_role;
  END IF;
END;
$grant$;

REVOKE ALL ON FUNCTION public.run_workflow_engine_worker()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
