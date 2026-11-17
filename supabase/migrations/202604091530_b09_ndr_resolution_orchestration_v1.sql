-- Plan: Batch 9 NDR resolution orchestration
-- Migration: dedicated dispatch exception resolution orchestration v1
-- Date: 2026-04-09
--
-- Purpose:
--   - Add a row-driven NDR resolution policy contract keyed by settings rows.
--   - Introduce a dedicated dispatch-exception resolution RPC/workflow path without widening ui_execute_command_v1.
--   - Reuse canonical manual-review + task-completion-effect + shipment-resort workflows for approved reattempts.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604091530_b09_ndr_resolution_orchestration_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- 1) Settings category + schema: ndr_policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'ndr_policy',
  'Policy mapping dispatch exception review resolutions to follow-up orchestration. Supports client-scoped max-attempt, approval, and block rules.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'ndr_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'defaults', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'max_attempts', jsonb_build_object('type', 'integer', 'minimum', 0),
          'approval_required_after_attempt', jsonb_build_object('type', 'integer', 'minimum', 1),
          'manual_review_task_type', jsonb_build_object('type', 'string'),
          'approval_workflow_template_name', jsonb_build_object('type', 'string'),
          'blocked_when_task_metadata_truthy', jsonb_build_object(
            'type', jsonb_build_array('array', 'null'),
            'items', jsonb_build_object('type', 'string')
          ),
          'blocked_when_shipment_metadata_truthy', jsonb_build_object(
            'type', jsonb_build_array('array', 'null'),
            'items', jsonb_build_object('type', 'string')
          )
        )
      ),
      'service_type_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE
      ),
      'reason_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE
      ),
      'action_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE
      )
    )
  ),
  'Dispatch exception resolution policy. Merges defaults + service_type_map + reason_map + action_map to decide whether reattempt/reschedule/RTO/hold actions are ready, blocked, or require approval.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object(
        'max_attempts', 3,
        'approval_required_after_attempt', 2,
        'manual_review_task_type', 'dispatch_reattempt_approval',
        'approval_workflow_template_name', 'dispatch_reattempt_approval_v1',
        'blocked_when_task_metadata_truthy', jsonb_build_array('risk_hold', 'verification_failed'),
        'blocked_when_shipment_metadata_truthy', jsonb_build_array('risk_hold', 'verification_failed')
      ),
      'action_map', jsonb_build_object(
        'reattempt', jsonb_build_object(
          'task_type_key', 'dispatch_reattempt_delivery',
          'schedule_delay_minutes', 0,
          'auto_complete_task', TRUE,
          'auto_resort_on_completion', TRUE
        ),
        'reschedule', jsonb_build_object(
          'task_type_key', 'dispatch_reschedule_delivery',
          'auto_complete_task', FALSE,
          'auto_resort_on_completion', FALSE
        ),
        'return_to_sender', jsonb_build_object(
          'task_type_key', 'dispatch_rto_pickup',
          'auto_complete_task', FALSE,
          'auto_resort_on_completion', FALSE
        ),
        'hold_at_branch', jsonb_build_object(
          'shipment_action_type', 'hold_at_branch',
          'shipment_action_category', 'operational'
        ),
        'cancel', jsonb_build_object(
          'shipment_action_type', 'cancel_requested',
          'shipment_action_category', 'administrative'
        )
      ),
      'service_type_map', jsonb_build_object(
        'delivery', jsonb_build_object(
          'max_attempts', 3,
          'approval_required_after_attempt', 2
        )
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'defaults', jsonb_build_object(
      'max_attempts', 3,
      'approval_required_after_attempt', 2,
      'manual_review_task_type', 'dispatch_reattempt_approval',
      'approval_workflow_template_name', 'dispatch_reattempt_approval_v1',
      'blocked_when_task_metadata_truthy', jsonb_build_array('risk_hold', 'verification_failed'),
      'blocked_when_shipment_metadata_truthy', jsonb_build_array('risk_hold', 'verification_failed')
    ),
    'action_map', jsonb_build_object(
      'reattempt', jsonb_build_object(
        'task_type_key', 'dispatch_reattempt_delivery',
        'schedule_delay_minutes', 0,
        'auto_complete_task', TRUE,
        'auto_resort_on_completion', TRUE
      ),
      'reschedule', jsonb_build_object(
        'task_type_key', 'dispatch_reschedule_delivery',
        'auto_complete_task', FALSE,
        'auto_resort_on_completion', FALSE
      ),
      'return_to_sender', jsonb_build_object(
        'task_type_key', 'dispatch_rto_pickup',
        'auto_complete_task', FALSE,
        'auto_resort_on_completion', FALSE
      ),
      'hold_at_branch', jsonb_build_object(
        'shipment_action_type', 'hold_at_branch',
        'shipment_action_category', 'operational'
      ),
      'cancel', jsonb_build_object(
        'shipment_action_type', 'cancel_requested',
        'shipment_action_category', 'administrative'
      )
    ),
    'service_type_map', jsonb_build_object(
      'delivery', jsonb_build_object(
        'max_attempts', 3,
        'approval_required_after_attempt', 2
      )
    )
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'ndr_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global ndr_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.category = 'ndr_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ndr_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Service-only helpers: transition task + run completion effects
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_task_system_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_actor_system TEXT DEFAULT 'task_system',
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_from_status TEXT := NULL;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_status_reason TEXT := NULLIF(btrim(COALESCE(p_status_reason, '')), '');
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_event_id UUID := gen_random_uuid();
  v_next_version INT;
  v_decision_id UUID := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'transition_task_system_v1 requires service_role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_system_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'transition_task_system_v1 requires to_status';
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   FOR UPDATE;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'transition_task_system_v1 task not found: %', p_task_id;
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT te.id
      INTO v_event_id
      FROM public.task_events te
     WHERE te.task_id = v_task.id
       AND te.idempotency_key = v_idempotency_key
     ORDER BY te.created_at DESC, te.id DESC
     LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'task_id', v_task.id,
        'task_event_id', v_event_id,
        'status', v_task.status,
        'idempotent', TRUE
      );
    END IF;

    v_event_id := gen_random_uuid();
  END IF;

  v_next_version := COALESCE(v_task.version, 0) + 1;
  v_from_status := v_task.status;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = v_status_reason,
         version = v_next_version,
         started_at = CASE
           WHEN v_to_status = 'in_progress' AND started_at IS NULL THEN now()
           ELSE started_at
         END,
         completed_at = CASE
           WHEN v_to_status = 'completed' THEN now()
           ELSE completed_at
         END,
         canceled_at = CASE
           WHEN v_to_status = 'canceled' THEN now()
           ELSE canceled_at
         END,
         updated_at = now()
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_task.organization_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'task_system'),
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', v_status_reason
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.task_events (
    id,
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
    v_event_id,
    v_task.id,
    v_task.organization_id,
    'status_changed',
    v_from_status,
    v_to_status,
    NULL,
    COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'task_system'),
    jsonb_strip_nulls(v_payload || jsonb_build_object(
      'status_reason', v_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency_key,
    v_next_version,
    v_decision_id,
    NULL,
    now()
  );

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'task_event_id', v_event_id,
    'status', v_to_status,
    'idempotent', FALSE
  );
END;
$function$;

COMMENT ON FUNCTION public.transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  IS 'Service-only task status transition helper for workflow/system orchestration. Writes the canonical task row + task_events ledger with actor_system provenance.';

REVOKE ALL ON FUNCTION public.transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_system_v1(UUID, TEXT, TEXT, JSONB, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.run_task_completion_effects_v1(
  p_task_id UUID,
  p_task_event_id UUID,
  p_actor_system TEXT DEFAULT 'dispatch_exception_resolution',
  p_context_overrides JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_task_event public.task_events%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_step RECORD;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires service_role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL OR p_task_event_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 requires task_id and task_event_id';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   LIMIT 1;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task % not found', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_task_event
    FROM public.task_events te
   WHERE te.id = p_task_event_id
     AND te.task_id = p_task_id
   LIMIT 1;

  IF v_task_event.id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_event % not found for task %', p_task_event_id, p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_type missing for task %', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'task_completion_effects_v1'
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 task_completion_effects_v1 template missing'
      USING ERRCODE = '23503';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_task.organization_id,
        'client_id', v_task.client_id,
        'sender_id', v_task.sender_id,
        'resource_type', COALESCE(NULLIF(btrim(COALESCE(v_task.resource_type, '')), ''), 'task'),
        'resource_id', COALESCE(v_task.resource_id, v_task.id),
        'payload', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_task.organization_id,
          'client_id', v_task.client_id,
          'sender_id', v_task.sender_id,
          'resource_type', v_task.resource_type,
          'resource_id', v_task.resource_id,
          'task_id', v_task.id,
          'task_event_id', v_task_event.id,
          'task_type_key', lower(v_task_type_key),
          'task_event_payload', COALESCE(v_task_event.payload, '{}'::jsonb),
          'task_event_created_at', v_task_event.created_at,
          'actor_user_id', v_task_event.actor_user_id,
          'actor_system', COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'dispatch_exception_resolution')
        ))
      ) || COALESCE(p_context_overrides, '{}'::jsonb)
    )
  );

  v_progress := public.progress_workflow_run(v_workflow_run_id);

  SELECT
    wr.workflow_status,
    wr.last_error,
    wts.operation_result,
    wts.last_error AS step_last_error
  INTO v_step
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_run_steps wts
    ON wts.workflow_run_id = wr.id
  WHERE wr.id = v_workflow_run_id
  ORDER BY wts.sequence_order DESC NULLS LAST
  LIMIT 1;

  IF COALESCE(v_step.workflow_status, '') IN ('failed', 'blocked', 'cancelled') THEN
    RAISE EXCEPTION 'run_task_completion_effects_v1 failed for task %: %',
      p_task_id,
      COALESCE(v_step.step_last_error, v_step.last_error, 'workflow_failed');
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', v_workflow_run_id,
    'workflow_status', v_step.workflow_status,
    'progress_status', v_progress->>'status',
    'operation_result', v_step.operation_result
  ));
END;
$function$;

COMMENT ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB)
  IS 'Service-only helper that starts the canonical task_completion_effects_v1 workflow for a specific completed task event and returns the terminal step result.';

REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) create_task_system_v1: project dispatch exception lineage into review tasks
-------------------------------------------------------------------------------

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
END;
$$;

COMMENT ON FUNCTION public.create_task_system_v1(JSONB)
  IS 'Service-only wrapper to create a task via create_task_v1, preserving task-type assignment defaults and projecting dispatch_exception lineage (reason, service_type, shipment_action_id, evidence_artifact_ids, exception_notes) for dispatch_exception_review tasks.';

WITH dispatch_exception_review_backfill AS (
  SELECT
    t.id AS task_id,
    s.service_type,
    sa.id AS shipment_action_id,
    sa.action_data
  FROM public.tasks t
  JOIN public.task_types tt
    ON tt.id = t.task_type_id
   AND tt.key = 'dispatch_exception_review'
  LEFT JOIN public.shipments s
    ON s.id = t.resource_id
   AND s.client_id = t.client_id
  LEFT JOIN LATERAL (
    SELECT sa.id, sa.action_data
    FROM public.shipment_actions sa
    WHERE sa.id = NULLIF(COALESCE(t.metadata->>'shipment_action_id', ''), '')::uuid
    LIMIT 1
  ) sa ON TRUE
)
UPDATE public.tasks t
   SET metadata = jsonb_strip_nulls(
         COALESCE(t.metadata, '{}'::jsonb)
         || jsonb_strip_nulls(jsonb_build_object(
           'dispatch_exception_reason', COALESCE(
             NULLIF(btrim(COALESCE(t.metadata->>'dispatch_exception_reason', '')), ''),
             NULLIF(btrim(COALESCE(t.status_reason, '')), ''),
             NULLIF(btrim(COALESCE(b.action_data->>'outcome_reason', '')), '')
           ),
           'route_stop_id', NULLIF(b.action_data->>'route_stop_id', '')::uuid,
           'shipment_action_id', NULLIF(
             COALESCE(t.metadata->>'shipment_action_id', b.shipment_action_id::text),
             ''
           )::uuid,
           'service_type', NULLIF(
             btrim(COALESCE(t.metadata->>'service_type', b.service_type, '')),
             ''
           ),
           'exception_notes', NULLIF(btrim(COALESCE(
             t.metadata->>'exception_notes',
             b.action_data->'task_event_payload'->>'exception_notes',
             b.action_data->'task_event_payload'->>'notes',
             ''
           )), ''),
           'evidence_artifact_ids', CASE
             WHEN jsonb_typeof(b.action_data->'artifact_ids') = 'array' THEN b.action_data->'artifact_ids'
             ELSE NULL
           END,
           'allowed_ndr_actions', CASE
             WHEN jsonb_typeof(b.action_data->'task_event_payload'->'allowed_ndr_actions') = 'array'
               THEN b.action_data->'task_event_payload'->'allowed_ndr_actions'
             ELSE NULL
           END
         ))
       ),
       updated_at = now()
  FROM dispatch_exception_review_backfill b
 WHERE b.task_id = t.id;

-------------------------------------------------------------------------------
-- 4) Preview/apply helpers: row-driven dispatch exception resolution
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_dispatch_exception_resolution_v1(
  p_task_id UUID,
  p_resolution_action TEXT,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_shipment public.shipments%ROWTYPE;
  v_resolution_action TEXT := lower(NULLIF(btrim(COALESCE(p_resolution_action, '')), ''));
  v_task_metadata JSONB := '{}'::jsonb;
  v_shipment_metadata JSONB := '{}'::jsonb;
  v_dispatch_exception_reason TEXT := NULL;
  v_service_type TEXT := NULL;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_service_policy JSONB := '{}'::jsonb;
  v_reason_policy JSONB := '{}'::jsonb;
  v_effective_policy JSONB := '{}'::jsonb;
  v_action_policy JSONB := '{}'::jsonb;
  v_allowed_actions JSONB := '[]'::jsonb;
  v_task_block_keys JSONB := '[]'::jsonb;
  v_shipment_block_keys JSONB := '[]'::jsonb;
  v_block_key TEXT := NULL;
  v_block_reason TEXT := NULL;
  v_attempt_count INT := 0;
  v_max_attempts INT := NULL;
  v_approval_required_after_attempt INT := NULL;
  v_schedule_delay_minutes INT := 0;
  v_task_type_target TEXT := NULL;
  v_shipment_action_type TEXT := NULL;
  v_shipment_action_category TEXT := NULL;
  v_manual_review_required BOOLEAN := FALSE;
  v_auto_complete_task BOOLEAN := FALSE;
  v_auto_resort_on_completion BOOLEAN := FALSE;
  v_scheduled_for TIMESTAMPTZ := NULL;
  v_settings_resolution_id UUID := NULL;
  v_require_manual_review BOOLEAN := FALSE;
BEGIN
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires task_id';
  END IF;
  IF v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 requires resolution_action';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   LIMIT 1;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 task % not found', p_task_id
      USING ERRCODE = '23503';
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF lower(COALESCE(v_task_type_key, '')) <> 'dispatch_exception_review' THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 task % is not a dispatch_exception_review', p_task_id
      USING ERRCODE = '23514';
  END IF;

  IF lower(COALESCE(v_task.resource_type, '')) <> 'shipment' OR v_task.resource_id IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 task % is not shipment-scoped', p_task_id
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = v_task.resource_id
     AND (v_task.client_id IS NULL OR s.client_id = v_task.client_id)
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'preview_dispatch_exception_resolution_v1 shipment % not found', v_task.resource_id
      USING ERRCODE = '23503';
  END IF;

  v_task_metadata := COALESCE(v_task.metadata, '{}'::jsonb);
  IF jsonb_typeof(v_task_metadata) IS DISTINCT FROM 'object' THEN
    v_task_metadata := '{}'::jsonb;
  END IF;

  v_shipment_metadata := COALESCE(v_shipment.metadata, '{}'::jsonb);
  IF jsonb_typeof(v_shipment_metadata) IS DISTINCT FROM 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_dispatch_exception_reason := NULLIF(
    btrim(
      COALESCE(
        v_task_metadata->>'dispatch_exception_reason',
        v_task.status_reason,
        ''
      )
    ),
    ''
  );
  v_service_type := lower(NULLIF(btrim(COALESCE(
    v_task_metadata->>'service_type',
    v_shipment.service_type,
    ''
  )), ''));

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_task.organization_id,
    'client_id', v_task.client_id,
    'sender_id', v_task.sender_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('ndr_policy', v_policy_ctx)
   LIMIT 1;

  IF v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;
  IF jsonb_typeof(v_policy) IS DISTINCT FROM 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_task.organization_id,
      p_category := 'ndr_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := v_policy_row.version,
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_task.id,
        'resolution_action', v_resolution_action,
        'service_type', v_service_type,
        'dispatch_exception_reason', v_dispatch_exception_reason
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  IF jsonb_typeof(v_defaults) IS DISTINCT FROM 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  IF v_service_type IS NOT NULL AND (v_policy->'service_type_map' ? v_service_type) THEN
    v_service_policy := COALESCE(v_policy->'service_type_map'->v_service_type, '{}'::jsonb);
  END IF;
  IF jsonb_typeof(v_service_policy) IS DISTINCT FROM 'object' THEN
    v_service_policy := '{}'::jsonb;
  END IF;

  IF v_dispatch_exception_reason IS NOT NULL AND (v_policy->'reason_map' ? v_dispatch_exception_reason) THEN
    v_reason_policy := COALESCE(v_policy->'reason_map'->v_dispatch_exception_reason, '{}'::jsonb);
  END IF;
  IF jsonb_typeof(v_reason_policy) IS DISTINCT FROM 'object' THEN
    v_reason_policy := '{}'::jsonb;
  END IF;

  v_effective_policy := public.deep_merge_jsonb(
    v_defaults,
    public.deep_merge_jsonb(v_service_policy, v_reason_policy)
  );
  IF jsonb_typeof(v_effective_policy) IS DISTINCT FROM 'object' THEN
    v_effective_policy := '{}'::jsonb;
  END IF;

  v_action_policy := public.deep_merge_jsonb(
    COALESCE(v_policy->'action_map'->v_resolution_action, '{}'::jsonb),
    public.deep_merge_jsonb(
      COALESCE(v_service_policy->'action_map'->v_resolution_action, '{}'::jsonb),
      COALESCE(v_reason_policy->'action_map'->v_resolution_action, '{}'::jsonb)
    )
  );
  IF jsonb_typeof(v_action_policy) IS DISTINCT FROM 'object' THEN
    v_action_policy := '{}'::jsonb;
  END IF;

  v_allowed_actions := COALESCE(v_task_metadata->'allowed_ndr_actions', '[]'::jsonb);
  IF jsonb_typeof(v_allowed_actions) <> 'array' THEN
    v_allowed_actions := '[]'::jsonb;
  END IF;

  IF jsonb_array_length(v_allowed_actions) > 0 AND NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(v_allowed_actions) AS action_value(value)
     WHERE lower(NULLIF(btrim(COALESCE(action_value.value, '')), '')) = v_resolution_action
  ) THEN
    v_block_reason := 'action_not_allowed';
  END IF;

  SELECT COUNT(*)::int
    INTO v_attempt_count
    FROM (
      SELECT DISTINCT COALESCE(NULLIF(sa.action_data->>'route_stop_id', ''), sa.id::text) AS route_stop_ref
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_shipment.id
         AND sa.organization_id = v_task.organization_id
         AND sa.client_id = v_shipment.client_id
         AND lower(COALESCE(sa.action_data->>'stop_kind', '')) = 'delivery'
    ) AS attempts;

  BEGIN
    v_max_attempts := COALESCE(
      NULLIF(v_action_policy->>'max_attempts', '')::int,
      NULLIF(v_effective_policy->>'max_attempts', '')::int
    );
  EXCEPTION
    WHEN others THEN
      v_max_attempts := NULL;
  END;

  BEGIN
    v_approval_required_after_attempt := COALESCE(
      NULLIF(v_action_policy->>'approval_required_after_attempt', '')::int,
      NULLIF(v_effective_policy->>'approval_required_after_attempt', '')::int
    );
  EXCEPTION
    WHEN others THEN
      v_approval_required_after_attempt := NULL;
  END;

  BEGIN
    v_schedule_delay_minutes := COALESCE(
      NULLIF(v_action_policy->>'schedule_delay_minutes', '')::int,
      NULLIF(v_effective_policy->>'schedule_delay_minutes', '')::int,
      0
    );
  EXCEPTION
    WHEN others THEN
      v_schedule_delay_minutes := 0;
  END;

  BEGIN
    v_require_manual_review := COALESCE((v_action_policy->>'require_manual_review')::boolean, FALSE);
  EXCEPTION
    WHEN others THEN
      v_require_manual_review := FALSE;
  END;
  BEGIN
    v_auto_complete_task := COALESCE((v_action_policy->>'auto_complete_task')::boolean, FALSE);
  EXCEPTION
    WHEN others THEN
      v_auto_complete_task := FALSE;
  END;
  BEGIN
    v_auto_resort_on_completion := COALESCE((v_action_policy->>'auto_resort_on_completion')::boolean, FALSE);
  EXCEPTION
    WHEN others THEN
      v_auto_resort_on_completion := FALSE;
  END;

  v_task_type_target := lower(NULLIF(btrim(COALESCE(v_action_policy->>'task_type_key', '')), ''));
  v_shipment_action_type := lower(NULLIF(btrim(COALESCE(v_action_policy->>'shipment_action_type', '')), ''));
  v_shipment_action_category := lower(NULLIF(btrim(COALESCE(v_action_policy->>'shipment_action_category', 'operational')), ''));

  v_task_block_keys := COALESCE(v_action_policy->'blocked_when_task_metadata_truthy', v_effective_policy->'blocked_when_task_metadata_truthy', '[]'::jsonb);
  IF jsonb_typeof(v_task_block_keys) <> 'array' THEN
    v_task_block_keys := '[]'::jsonb;
  END IF;
  v_shipment_block_keys := COALESCE(v_action_policy->'blocked_when_shipment_metadata_truthy', v_effective_policy->'blocked_when_shipment_metadata_truthy', '[]'::jsonb);
  IF jsonb_typeof(v_shipment_block_keys) <> 'array' THEN
    v_shipment_block_keys := '[]'::jsonb;
  END IF;

  IF v_block_reason IS NULL THEN
    FOR v_block_key IN
      SELECT jsonb_array_elements_text(v_task_block_keys)
    LOOP
      IF lower(COALESCE(v_task_metadata->>v_block_key, 'false')) IN ('true', 't', '1', 'yes', 'y', 'on') THEN
        v_block_reason := format('task_metadata_block:%s', v_block_key);
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_block_reason IS NULL THEN
    FOR v_block_key IN
      SELECT jsonb_array_elements_text(v_shipment_block_keys)
    LOOP
      IF lower(COALESCE(v_shipment_metadata->>v_block_key, 'false')) IN ('true', 't', '1', 'yes', 'y', 'on') THEN
        v_block_reason := format('shipment_metadata_block:%s', v_block_key);
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_block_reason IS NULL
     AND v_resolution_action = 'reattempt'
     AND v_max_attempts IS NOT NULL
     AND v_attempt_count >= v_max_attempts THEN
    v_block_reason := 'max_attempts_reached';
  END IF;

  IF v_block_reason IS NULL
     AND v_task_type_target IS NULL
     AND v_shipment_action_type IS NULL THEN
    v_block_reason := 'unsupported_action';
  END IF;

  IF v_block_reason IS NULL
     AND v_resolution_action = 'reattempt'
     AND (
       v_require_manual_review
       OR (
         v_approval_required_after_attempt IS NOT NULL
         AND v_attempt_count >= v_approval_required_after_attempt
       )
     ) THEN
    v_manual_review_required := TRUE;
  END IF;

  IF v_schedule_delay_minutes > 0 THEN
    v_scheduled_for := now() + make_interval(mins => v_schedule_delay_minutes);
    v_auto_complete_task := FALSE;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'task_id', v_task.id,
    'shipment_id', v_shipment.id,
    'dispatch_exception_reason', v_dispatch_exception_reason,
    'service_type', v_service_type,
    'resolution_action', v_resolution_action,
    'decision_status', CASE
      WHEN v_block_reason IS NOT NULL THEN 'blocked'
      WHEN v_manual_review_required THEN 'manual_review_required'
      ELSE 'ready'
    END,
    'blocked_reason', v_block_reason,
    'manual_review_required', v_manual_review_required,
    'attempt_count', v_attempt_count,
    'max_attempts', v_max_attempts,
    'approval_required_after_attempt', v_approval_required_after_attempt,
    'task_type_key', v_task_type_target,
    'shipment_action_type', v_shipment_action_type,
    'shipment_action_category', v_shipment_action_category,
    'schedule_delay_minutes', v_schedule_delay_minutes,
    'scheduled_for', v_scheduled_for,
    'auto_complete_task', v_auto_complete_task,
    'auto_resort_on_completion', v_auto_resort_on_completion,
    'manual_review_task_type', COALESCE(
      NULLIF(btrim(COALESCE(v_action_policy->>'manual_review_task_type', '')), ''),
      NULLIF(btrim(COALESCE(v_effective_policy->>'manual_review_task_type', '')), '')
    ),
    'approval_workflow_template_name', COALESCE(
      NULLIF(btrim(COALESCE(v_action_policy->>'approval_workflow_template_name', '')), ''),
      NULLIF(btrim(COALESCE(v_effective_policy->>'approval_workflow_template_name', '')), '')
    ),
    'settings_resolution_id', v_settings_resolution_id
  ));
END;
$function$;

COMMENT ON FUNCTION public.preview_dispatch_exception_resolution_v1(UUID, TEXT, JSONB)
  IS 'Resolve the row-driven ndr_policy decision for a dispatch_exception_review task and selected resolution action.';

CREATE OR REPLACE FUNCTION public.apply_dispatch_exception_resolution_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_task_id UUID := NULL;
  v_review_task public.tasks%ROWTYPE;
  v_resolution_action TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'resolution_action', '')), ''));
  v_resolution_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'resolution_notes', '')), '');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'dispatch_exception_resolution_apply');
  v_approval_granted BOOLEAN := FALSE;
  v_invoked_from_workflow BOOLEAN := FALSE;
  v_schedule_for TIMESTAMPTZ := NULL;
  v_schedule_workflow_run_id UUID := NULL;
  v_schedule_workflow_template_name TEXT := 'dispatch_reattempt_delivery_schedule_v1';
  v_template_id UUID := NULL;
  v_preview JSONB := '{}'::jsonb;
  v_transition JSONB := '{}'::jsonb;
  v_completion JSONB := '{}'::jsonb;
  v_created RECORD;
  v_created_task_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_direct_action_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'apply_dispatch_exception_resolution_v1 expects JSON object input';
  END IF;

  BEGIN
    v_task_id := NULLIF(v_input->>'task_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_id := NULL;
  END;
  BEGIN
    v_approval_granted := COALESCE((v_input->>'approval_granted')::boolean, FALSE);
  EXCEPTION
    WHEN others THEN
      v_approval_granted := FALSE;
  END;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'apply_dispatch_exception_resolution_v1 requires task_id';
  END IF;
  IF v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'apply_dispatch_exception_resolution_v1 requires resolution_action';
  END IF;

  SELECT *
    INTO v_review_task
    FROM public.tasks t
   WHERE t.id = v_task_id
   FOR UPDATE;

  IF v_review_task.id IS NULL THEN
    RAISE EXCEPTION 'apply_dispatch_exception_resolution_v1 task % not found', v_task_id
      USING ERRCODE = '23503';
  END IF;

  v_preview := public.preview_dispatch_exception_resolution_v1(v_task_id, v_resolution_action, v_input);

  IF COALESCE(v_preview->>'decision_status', '') = 'blocked' THEN
    RETURN jsonb_build_object(
      'status', 'blocked',
      'task_id', v_task_id,
      'resolution_action', v_resolution_action,
      'blocked_reason', v_preview->>'blocked_reason',
      'preview', v_preview
    );
  END IF;

  IF COALESCE(v_preview->>'decision_status', '') = 'manual_review_required' AND v_approval_granted IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'status', 'pending_review',
      'task_id', v_task_id,
      'resolution_action', v_resolution_action,
      'preview', v_preview
    );
  END IF;

  BEGIN
    v_schedule_for := NULLIF(v_preview->>'scheduled_for', '')::timestamptz;
  EXCEPTION
    WHEN others THEN
      v_schedule_for := NULL;
  END;
  v_invoked_from_workflow := NULLIF(btrim(COALESCE(v_input->>'workflow_run_id', '')), '') IS NOT NULL;

  IF COALESCE(v_preview->>'task_type_key', '') <> '' THEN
    IF v_schedule_for IS NOT NULL AND v_invoked_from_workflow IS FALSE THEN
      SELECT wt.id
        INTO v_template_id
        FROM public.workflow_templates wt
       WHERE wt.name = v_schedule_workflow_template_name
         AND wt.status = 'active'
       ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
       LIMIT 1;

      IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'apply_dispatch_exception_resolution_v1 workflow template missing %', v_schedule_workflow_template_name
          USING ERRCODE = '23503';
      END IF;

      v_schedule_workflow_run_id := public.start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_review_task.organization_id,
          'client_id', v_review_task.client_id,
          'sender_id', v_review_task.sender_id,
          'resource_type', 'task',
          'resource_id', v_task_id,
          'dispatch_exception_review_task_id', v_task_id,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'scheduled_for', v_schedule_for,
          'payload', jsonb_strip_nulls(jsonb_build_object(
            'dispatch_exception_review_task_id', v_task_id,
            'resolution_action', v_resolution_action,
            'resolution_notes', v_resolution_notes,
            'scheduled_for', v_schedule_for
          ))
        ))
      );

      UPDATE public.workflow_run_steps
         SET run_at = v_schedule_for,
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'scheduled_for', v_schedule_for
             )),
             updated_at = now()
       WHERE workflow_run_id = v_schedule_workflow_run_id
         AND sequence_order = 1;

      UPDATE public.workflow_runs
         SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
               'scheduled_for', v_schedule_for
             )),
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'scheduled_for', v_schedule_for
             )),
             updated_at = now()
       WHERE id = v_schedule_workflow_run_id;

      UPDATE public.tasks
         SET metadata = jsonb_strip_nulls(
               COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object(
                 'resolution_action', v_resolution_action,
                 'resolution_notes', v_resolution_notes,
                 'resolution_status', 'scheduled',
                 'resolution_workflow_run_id', v_schedule_workflow_run_id,
                 'resolution_scheduled_for', v_schedule_for,
                 'scheduled_for', v_schedule_for
               )
             ),
             updated_at = now()
       WHERE id = v_task_id;

      RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', 'scheduled',
        'task_id', v_task_id,
        'resolution_action', v_resolution_action,
        'scheduled_for', v_schedule_for,
        'workflow_run_id', v_schedule_workflow_run_id,
        'preview', v_preview
      ));
    END IF;
    SELECT *
      INTO v_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_preview->>'task_type_key',
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_review_task.organization_id,
            'client_id', v_review_task.client_id,
            'sender_id', v_review_task.sender_id,
            'shipment_id', v_review_task.resource_id,
            'route_stop_id', NULLIF(v_review_task.metadata->>'route_stop_id', '')::uuid,
            'shipment_action_id', NULLIF(v_review_task.metadata->>'shipment_action_id', '')::uuid,
            'dispatch_exception_reason', v_preview->>'dispatch_exception_reason',
            'service_type', v_preview->>'service_type'
          )),
          'resource_type', 'shipment',
          'resource_id', v_review_task.resource_id,
          'idempotency_key', format('dispatch_exception_resolution:%s:%s', v_task_id, v_resolution_action),
          'metadata', jsonb_strip_nulls(jsonb_build_object(
            'parent_review_task_id', v_task_id,
            'dispatch_exception_reason', v_preview->>'dispatch_exception_reason',
            'shipment_action_id', NULLIF(v_review_task.metadata->>'shipment_action_id', '')::uuid,
            'resolution_action', v_resolution_action,
            'resolution_notes', v_resolution_notes,
            'service_type', v_preview->>'service_type',
            'scheduled_for', NULLIF(v_preview->>'scheduled_for', '')::timestamptz,
            'auto_resort_on_completion', CASE
              WHEN COALESCE((v_preview->>'auto_resort_on_completion')::boolean, FALSE) THEN TRUE
              ELSE NULL
            END
          )),
          'actor_system', 'dispatch_exception_resolution'
        ))
      )
     LIMIT 1;

    v_created_task_id := v_created.task_id;

    IF COALESCE((v_preview->>'auto_complete_task')::boolean, FALSE) IS TRUE AND v_created_task_id IS NOT NULL THEN
      v_transition := public.transition_task_system_v1(
        v_created_task_id,
        'completed',
        NULL,
        jsonb_strip_nulls(jsonb_build_object(
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'auto_resort_on_completion', COALESCE((v_preview->>'auto_resort_on_completion')::boolean, FALSE)
        )),
        'dispatch_exception_resolution',
        format('dispatch_exception_resolution:auto-complete:%s:%s', v_task_id, v_resolution_action)
      );
      BEGIN
        v_task_event_id := NULLIF(v_transition->>'task_event_id', '')::uuid;
      EXCEPTION
        WHEN others THEN
          v_task_event_id := NULL;
      END;

      IF v_task_event_id IS NOT NULL THEN
        v_completion := public.run_task_completion_effects_v1(
          v_created_task_id,
          v_task_event_id,
          'dispatch_exception_resolution'
        );
      END IF;
    END IF;
  ELSIF COALESCE(v_preview->>'shipment_action_type', '') <> '' THEN
    SELECT sa.id
      INTO v_direct_action_id
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_review_task.resource_id
       AND sa.organization_id = v_review_task.organization_id
       AND sa.client_id = v_review_task.client_id
       AND sa.action_type = v_preview->>'shipment_action_type'
       AND COALESCE(sa.action_data->>'source_review_task_id', '') = v_task_id::text
     ORDER BY sa.created_at DESC, sa.id DESC
     LIMIT 1;

    IF v_direct_action_id IS NULL THEN
      INSERT INTO public.shipment_actions (
        shipment_id,
        organization_id,
        client_id,
        action_type,
        action_category,
        canonical_status,
        performed_by_user_id,
        performed_by_system,
        action_data,
        timestamp
      )
      VALUES (
        v_review_task.resource_id,
        v_review_task.organization_id,
        v_review_task.client_id,
        v_preview->>'shipment_action_type',
        v_preview->>'shipment_action_category',
        NULL,
        auth.uid(),
        v_actor_system,
        jsonb_strip_nulls(jsonb_build_object(
          'source_review_task_id', v_task_id,
          'shipment_action_id', NULLIF(v_review_task.metadata->>'shipment_action_id', '')::uuid,
          'route_stop_id', NULLIF(v_review_task.metadata->>'route_stop_id', '')::uuid,
          'dispatch_exception_reason', v_preview->>'dispatch_exception_reason',
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes
        )),
        now()
      )
      RETURNING id INTO v_direct_action_id;
    END IF;
  END IF;

  UPDATE public.tasks
     SET metadata = jsonb_strip_nulls(
           COALESCE(metadata, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
             'resolution_action', v_resolution_action,
             'resolution_notes', v_resolution_notes,
             'resolution_status', 'completed',
             'resolution_applied_at', now(),
             'resolution_task_id', v_created_task_id,
             'resolution_task_event_id', v_task_event_id,
             'resolution_direct_shipment_action_id', v_direct_action_id,
             'resolution_completion_effects', CASE
               WHEN jsonb_typeof(v_completion) = 'object' THEN v_completion
               ELSE NULL
             END
           ))
         ),
         updated_at = now()
   WHERE id = v_task_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 'completed',
    'task_id', v_task_id,
    'resolution_action', v_resolution_action,
    'downstream_task_id', v_created_task_id,
    'downstream_task_event_id', v_task_event_id,
    'shipment_action_id', v_direct_action_id,
    'completion_effects', CASE
      WHEN jsonb_typeof(v_completion) = 'object' THEN v_completion
      ELSE NULL
    END,
    'preview', v_preview
  ));
END;
$function$;

COMMENT ON FUNCTION public.apply_dispatch_exception_resolution_v1(JSONB)
  IS 'Apply a row-driven dispatch exception resolution by creating follow-up tasks or direct shipment actions, and auto-running completion effects for immediate approved reattempts.';

-------------------------------------------------------------------------------
-- 5) Manual review resume + approval workflow handler/template
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.manual_review_tasks_resume_workflow_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_workflow_run_id UUID := NULL;
  v_payload JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') <> 'resolved' OR COALESCE(OLD.status, '') = 'resolved' THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.metadata->>'workflow_resume_on_resolve', 'false')) NOT IN ('true', 't', '1', 'yes', 'y', 'on') THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_workflow_run_id := NULLIF(COALESCE(NEW.metadata->>'workflow_run_id', ''), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  IF v_workflow_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'manual_review_task_id', NEW.id,
    'resolution_outcome', lower(NEW.resolution_outcome),
    'resolution_notes', NEW.resolution_notes,
    'resolved_by', NEW.resolved_by,
    'resolved_at', NEW.resolved_at
  ));

  BEGIN
    PERFORM public.progress_workflow_run(v_workflow_run_id, v_payload);
    PERFORM public.progress_workflow_run(v_workflow_run_id, v_payload);
  EXCEPTION
    WHEN others THEN
      UPDATE public.manual_review_tasks
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'workflow_progress_error', SQLERRM
             )),
             updated_at = now()
       WHERE id = NEW.id;
  END;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.manual_review_tasks_resume_workflow_v1()
  IS 'Resume a workflow-engine manual_review_wait step when a manual_review_tasks row marked workflow_resume_on_resolve=true is resolved.';

DROP TRIGGER IF EXISTS trg_manual_review_tasks_resume_workflow_v1 ON public.manual_review_tasks;
CREATE TRIGGER trg_manual_review_tasks_resume_workflow_v1
  AFTER UPDATE OF status, resolution_outcome, resolution_notes, resolved_at, resolved_by
  ON public.manual_review_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.manual_review_tasks_resume_workflow_v1();

CREATE OR REPLACE FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := CASE
    WHEN jsonb_typeof(v_ctx->'payload') = 'object' THEN COALESCE(v_ctx->'payload', '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_task_id UUID := NULL;
  v_resolution_action TEXT := NULL;
  v_resolution_notes TEXT := NULL;
  v_result JSONB := '{}'::jsonb;
  v_resp public.workflow_handler_response;
BEGIN
  BEGIN
    v_task_id := COALESCE(
      NULLIF(v_ctx->>'dispatch_exception_review_task_id', '')::uuid,
      NULLIF(v_payload->>'dispatch_exception_review_task_id', '')::uuid,
      CASE
        WHEN lower(COALESCE(v_ctx->>'resource_type', '')) = 'task'
          THEN NULLIF(v_ctx->>'resource_id', '')::uuid
        ELSE NULL
      END
    );
  EXCEPTION
    WHEN others THEN
      v_task_id := NULL;
  END;

  v_resolution_action := lower(NULLIF(btrim(COALESCE(
    p_operation_result->>'resolution_action',
    v_ctx->>'resolution_action',
    v_payload->>'resolution_action',
    ''
  )), ''));
  v_resolution_notes := NULLIF(btrim(COALESCE(
    p_operation_result->>'resolution_notes',
    v_ctx->>'resolution_notes',
    v_payload->>'resolution_notes',
    ''
  )), '');

  IF v_task_id IS NULL OR v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'dispatch_exception_resolution_apply: missing task_id or resolution_action (workflow_run_id=%)', p_run.id;
  END IF;

  v_result := public.apply_dispatch_exception_resolution_v1(
    jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id,
      'resolution_action', v_resolution_action,
      'resolution_notes', v_resolution_notes,
      'approval_granted', TRUE,
      'actor_system', 'dispatch_exception_resolution_apply',
      'workflow_run_id', p_run.id
    ))
  );

  v_resp.status := 'completed';
  v_resp.operation_result := v_result;
  v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'dispatch_exception_resolution', v_result
  ));
  RETURN v_resp;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(workflow_run_steps, workflow_runs, JSONB)
  IS 'Workflow handler that applies an approved dispatch exception resolution after manual review wait completes.';

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'dispatch_exception_resolution_apply',
  'workflow_handlers',
  'execute_dispatch_exception_resolution_apply_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply an approved dispatch exception resolution after manual review or direct ready-state execution.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url;

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'manual_review_task_type'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  'dispatch_reattempt_approval',
  'Dispatch Reattempt Approval',
  'Manual review task for dispatch-exception reattempt requests that exceed the auto-approval threshold.',
  40,
  FALSE,
  '{}'::jsonb
FROM def
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $do$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000590120'::uuid;
BEGIN
  INSERT INTO public.workflow_templates AS wt (
    id,
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  )
  VALUES (
    v_template_id,
    'dispatch_reattempt_approval_v1',
    'Manual-review approval workflow for dispatch exception reattempts that exceed the auto-approval threshold.',
    'active',
    1,
    'global',
    NULL,
    'Batch 9 dispatch exception approval workflow',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         notes = EXCLUDED.notes,
         updated_at = now();

  DELETE FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND sequence_order IN (1, 2, 3);

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled,
    created_at,
    updated_at
  )
  VALUES
    (
      v_template_id,
      1,
      'manual_review',
      'approval',
      'always',
      'manual_review',
      'v1',
      jsonb_build_object(
        'task_type', 'dispatch_reattempt_approval',
        'queue_assignment', 'dispatch',
        'decision_log_event', 'dispatch_exception.review_requested'
      ),
      TRUE,
      now(),
      now()
    ),
    (
      v_template_id,
      2,
      'manual_review_wait',
      'approval',
      'always',
      'manual_review_wait',
      'v1',
      jsonb_build_object(
        'poll_interval_seconds', 30,
        'decision_log_event', 'dispatch_exception.review_wait'
      ),
      TRUE,
      now(),
      now()
    ),
    (
      v_template_id,
      3,
      'dispatch_exception_resolution_apply',
      'approval',
      'always',
      'dispatch_exception_resolution_apply',
      'v1',
      jsonb_build_object(
        'decision_log_event', 'dispatch_exception.apply'
      ),
      TRUE,
      now(),
      now()
    );
END;
$do$;

DO $do$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000590121'::uuid;
BEGIN
  INSERT INTO public.workflow_templates AS wt (
    id,
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  )
  VALUES (
    v_template_id,
    'dispatch_reattempt_delivery_schedule_v1',
    'Deferred execution workflow for scheduled dispatch exception reattempts.',
    'active',
    1,
    'global',
    NULL,
    'Batch 9 dispatch exception scheduled execution workflow',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         notes = EXCLUDED.notes,
         updated_at = now();

  DELETE FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND sequence_order = 1;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled,
    created_at,
    updated_at
  )
  VALUES (
    v_template_id,
    1,
    'dispatch_exception_resolution_apply',
    'dispatch_exception',
    'always',
    'dispatch_exception_resolution_apply',
    'v1',
    jsonb_build_object(
      'decision_log_event', 'dispatch_exception.scheduled_apply'
    ),
    TRUE,
    now(),
    now()
  );
END;
$do$;
-------------------------------------------------------------------------------
-- 7) task_completion_effects: auto-resort approved reattempt tasks
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task_effects');

  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);

  v_domain_event_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_payload->>'task_type_key', '')), ''));

  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;

  v_resource_type TEXT := lower(NULLIF(btrim(COALESCE(v_payload->>'resource_type', '')), ''));
  v_resource_id UUID := NULL;

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_payload->>'actor_system', '')), '');
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  v_task_event_created_at TIMESTAMPTZ := NULL;

  v_task public.tasks%ROWTYPE;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_effect JSONB := '{}'::jsonb;

  v_settings_resolution_id UUID := NULL;

  v_new_status TEXT := NULL;
  v_action_type TEXT := NULL;
  v_action_category TEXT := NULL;
  v_auto_resort_on_completion BOOLEAN := FALSE;

  v_existing BOOLEAN := FALSE;
  v_action_id UUID := NULL;
  v_resort_result RECORD;
  v_resort_payload JSONB := NULL;

  v_resp public.workflow_handler_response;
BEGIN
  BEGIN v_domain_event_id := NULLIF(v_ctx->>'domain_event_id', '')::uuid; EXCEPTION WHEN others THEN v_domain_event_id := NULL; END;
  BEGIN v_task_event_id := NULLIF(v_payload->>'task_event_id', '')::uuid; EXCEPTION WHEN others THEN v_task_event_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_payload->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_resource_id := NULLIF(v_payload->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_payload->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_task_event_created_at := NULLIF(v_payload->>'task_event_created_at', '')::timestamptz; EXCEPTION WHEN others THEN v_task_event_created_at := NULL; END;

  BEGIN v_org_id := NULLIF(v_payload->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_payload->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_payload->>'sender_id', '')::uuid; EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: missing payload.task_id (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = v_task_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_completion_effects: task not found: %', v_task_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_task.organization_id);
  v_client_id := COALESCE(v_client_id, v_task.client_id);
  v_sender_id := COALESCE(v_sender_id, v_task.sender_id);
  v_resource_type := COALESCE(v_resource_type, lower(NULLIF(btrim(COALESCE(v_task.resource_type, '')), '')));
  v_resource_id := COALESCE(v_resource_id, v_task.resource_id);

  IF jsonb_typeof(v_task_event_payload) IS DISTINCT FROM 'object' THEN
    v_task_event_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_auto_resort_on_completion := COALESCE(
      (v_task_event_payload->>'auto_resort_on_completion')::boolean,
      (v_task.metadata->>'auto_resort_on_completion')::boolean,
      FALSE
    );
  EXCEPTION
    WHEN others THEN
      v_auto_resort_on_completion := FALSE;
  END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: organization_id missing (task_id=%)', v_task_id;
  END IF;

  IF v_task_type_key IS NULL THEN
    SELECT tt.key INTO v_task_type_key
    FROM public.task_types tt
    WHERE tt.id = v_task.task_type_id
    LIMIT 1;
    v_task_type_key := lower(NULLIF(btrim(COALESCE(v_task_type_key, '')), ''));
  END IF;
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: task_type_key missing (task_id=%)', v_task_id;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id
  ));

  SELECT * INTO v_policy_row
  FROM public.resolve_settings_row_from_policy_context_v1('task_completion_effects_policy', v_policy_ctx)
  LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'task_completion_effects_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := v_policy_row.version,
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_defaults := jsonb_strip_nulls(COALESCE(v_policy->'defaults', '{}'::jsonb));
  v_effect := COALESCE(v_policy#>ARRAY['task_type_map', v_task_type_key], '{}'::jsonb);
  IF jsonb_typeof(v_effect) IS DISTINCT FROM 'object' THEN
    v_effect := '{}'::jsonb;
  END IF;
  v_effect := jsonb_strip_nulls(v_effect);

  IF v_effect = '{}'::jsonb THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'task',
      p_resource_type := 'task',
      p_resource_id := v_task_id,
      p_decision_point := 'completion_effects',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'task_completion_effects_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'task_event_id', v_task_event_id,
        'domain_event_id', v_domain_event_id
      )),
      p_decision_reason := 'no_effect_spec',
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'applied', FALSE,
      'reason', 'no_effect_spec'
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'applied', FALSE,
        'reason', 'no_effect_spec'
      ))
    );
    RETURN v_resp;
  END IF;

  v_new_status := lower(NULLIF(btrim(COALESCE(v_effect->>'shipment_status', '')), ''));
  v_action_type := lower(NULLIF(btrim(COALESCE(v_effect->>'action_type', v_defaults->>'action_type', '')), ''));
  v_action_category := lower(NULLIF(btrim(COALESCE(v_effect->>'action_category', v_defaults->>'action_category', '')), ''));

  IF v_resource_type IS DISTINCT FROM 'shipment' OR v_resource_id IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'task',
      p_resource_type := 'task',
      p_resource_id := v_task_id,
      p_decision_point := 'completion_effects',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'task_completion_effects_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'task_event_id', v_task_event_id,
        'domain_event_id', v_domain_event_id
      )),
      p_decision_reason := 'unsupported_resource',
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'applied', FALSE,
      'reason', 'unsupported_resource'
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'applied', FALSE,
        'reason', 'unsupported_resource'
      ))
    );
    RETURN v_resp;
  END IF;

  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: missing action_type/action_category for task_type_key=%', v_task_type_key
      USING ERRCODE = '23514';
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT s.id AS shipment_id,
           s.client_id,
           s.organization_id,
           s.status AS shipment_status
      INTO v_ship
      FROM public.shipments s
     WHERE s.id = v_resource_id
       AND s.client_id = v_client_id
     LIMIT 1;
  ELSE
    SELECT s.id AS shipment_id,
           s.client_id,
           s.organization_id,
           s.status AS shipment_status
      INTO v_ship
      FROM public.shipments s
     WHERE s.id = v_resource_id
     LIMIT 1;
  END IF;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: shipment not found: %', v_resource_id USING ERRCODE = '23503';
  END IF;

  IF v_ship.organization_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'task_completion_effects: shipment org mismatch (shipment org %, task org %)', v_ship.organization_id, v_org_id
      USING ERRCODE = '23514';
  END IF;

  IF v_task_event_id IS NOT NULL THEN
    SELECT TRUE
      INTO v_existing
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_ship.shipment_id
       AND sa.organization_id = v_org_id
       AND sa.client_id = v_ship.client_id
       AND (sa.action_data->>'task_event_id') = v_task_event_id::text
     LIMIT 1;

    IF v_existing THEN
      PERFORM public.log_decision(
        p_organization_id := v_org_id,
        p_decision_category := 'task',
        p_resource_type := 'shipment',
        p_resource_id := v_ship.shipment_id,
        p_decision_point := 'completion_effects',
        p_decision_outcome := 'duplicate_ignored',
        p_performed_by_system := 'task_completion_effects_v1',
        p_correlation_id := public.current_correlation_id(),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'task_id', v_task_id,
          'task_type_key', v_task_type_key,
          'task_event_id', v_task_event_id,
          'domain_event_id', v_domain_event_id,
          'workflow_run_id', p_run.id
        )),
        p_decision_reason := 'shipment_action already exists for task_event_id',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_ship.shipment_id,
        'applied', FALSE,
        'reason', 'duplicate_task_event'
      ));
      v_resp.context_patch := jsonb_build_object(
        v_context_key,
        jsonb_strip_nulls(jsonb_build_object(
          'shipment_id', v_ship.shipment_id,
          'applied', FALSE,
          'reason', 'duplicate_task_event'
        ))
      );
      RETURN v_resp;
    END IF;
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE public.shipments
       SET status = v_new_status,
           status_updated_at = COALESCE(v_task_event_created_at, now()),
           updated_at = now()
     WHERE id = v_ship.shipment_id
       AND client_id = v_ship.client_id;
  END IF;

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  ) VALUES (
    v_ship.shipment_id,
    v_org_id,
    v_ship.client_id,
    v_action_type,
    v_action_category,
    v_new_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'workflow_engine'),
    jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'task_type_key', v_task_type_key,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'settings_resolution_id', v_settings_resolution_id,
      'task_event_payload', v_task_event_payload
    )),
    COALESCE(v_task_event_created_at, now())
  )
  RETURNING id INTO v_action_id;

  IF v_task_type_key = 'dispatch_reattempt_delivery' AND COALESCE(v_auto_resort_on_completion, FALSE) IS TRUE THEN
    SELECT *
      INTO v_resort_result
      FROM public.resort_shipment_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'shipment_id', v_ship.shipment_id,
          'client_id', v_ship.client_id,
          'actor_user_id', v_actor_user_id,
          'actor_system', 'task_completion_effects'
        ))
      )
     LIMIT 1;

    v_resort_payload := jsonb_strip_nulls(jsonb_build_object(
      'status', v_resort_result.status,
      'workflow_run_id', v_resort_result.workflow_run_id,
      'previous_basket_id', v_resort_result.previous_basket_id,
      'basket_id', v_resort_result.basket_id,
      'basket_item_id', v_resort_result.basket_item_id,
      'reason', v_resort_result.reason,
      'settings_resolution_id', v_resort_result.settings_resolution_id
    ));

    UPDATE public.shipment_actions
       SET action_data = jsonb_strip_nulls(COALESCE(action_data, '{}'::jsonb) || jsonb_build_object(
             'shipment_resort', v_resort_payload
           ))
     WHERE id = v_action_id;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'shipment',
    p_resource_id := v_ship.shipment_id,
    p_decision_point := 'completion_effects',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'task_completion_effects_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_ship.shipment_status,
      'new_status', v_new_status,
      'task_id', v_task_id,
      'task_type_key', v_task_type_key,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'shipment_action_id', v_action_id,
      'shipment_resort', v_resort_payload
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status,
    'shipment_action_id', v_action_id,
    'shipment_resort', v_resort_payload
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status,
      'shipment_action_id', v_action_id,
      'shipment_resort', v_resort_payload
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Dedicated UI/API RPC + command-registry rewrite
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_dispatch_exception_resolution_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_mode TEXT := '';
  v_min INTEGER := 0;
  v_max INTEGER := NULL;
  v_ids TEXT[] := COALESCE(
    p_selection_ids,
    CASE
      WHEN p_selection_id IS NULL OR btrim(p_selection_id) = '' THEN ARRAY[]::TEXT[]
      ELSE ARRAY[p_selection_id]
    END
  );
  v_count INTEGER := COALESCE(p_selection_count, COALESCE(array_length(v_ids, 1), 0));
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_resolution_action TEXT := NULL;
  v_resolution_notes TEXT := NULL;
  v_visible_task JSONB := NULL;
  v_preview JSONB := '{}'::jsonb;
  v_apply_result JSONB := '{}'::jsonb;
  v_task public.tasks%ROWTYPE;
  v_transition RECORD;
  v_workflow_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_manual_review_task_id UUID := NULL;
  v_results JSONB := '[]'::jsonb;
  v_pending_review_count INTEGER := 0;
  v_scheduled_count INTEGER := 0;
  v_completed_count INTEGER := 0;
  v_blocked_count INTEGER := 0;
  v_apply_status TEXT := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_params, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    p_params := '{}'::jsonb;
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires action key';
  END IF;

  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires resource key';
  END IF;

  v_resolution_action := lower(NULLIF(btrim(COALESCE(
    p_params->>'resolution_action',
    p_params->>'ndr_action',
    ''
  )), ''));
  v_resolution_notes := NULLIF(btrim(COALESCE(p_params->>'resolution_notes', '')), '');

  IF v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires resolution_action';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'ndr_action'
       AND lv.value = v_resolution_action
       AND lv.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 unsupported resolution_action %', v_resolution_action
      USING ERRCODE = '23514';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 selection above maximum %', v_max;
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 invalid task id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    v_visible_task := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
    IF v_visible_task IS NULL THEN
      RAISE EXCEPTION
        'ui_execute_dispatch_exception_resolution_v1 task % is not visible in resource %',
        v_selection_uuid,
        p_resource_key
        USING ERRCODE = '42501';
    END IF;

    v_preview := public.preview_dispatch_exception_resolution_v1(
      v_selection_uuid,
      v_resolution_action,
      p_params
    );

    IF COALESCE(v_preview->>'decision_status', '') = 'blocked' THEN
      v_blocked_count := v_blocked_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_selection_uuid,
        'status', 'blocked',
        'blocked_reason', v_preview->>'blocked_reason',
        'preview', v_preview
      )));
      CONTINUE;
    END IF;

    SELECT *
      INTO v_task
      FROM public.tasks t
     WHERE t.id = v_selection_uuid
     LIMIT 1;

    SELECT *
      INTO v_transition
      FROM public.transition_task_v1(
        v_selection_uuid,
        'completed',
        NULLIF(v_preview->>'dispatch_exception_reason', ''),
        jsonb_strip_nulls(jsonb_build_object(
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'decision_status', v_preview->>'decision_status'
        )),
        format('dispatch_exception_review:resolve:%s:%s', v_selection_uuid, v_resolution_action)
      )
     LIMIT 1;

    IF COALESCE(v_preview->>'decision_status', '') = 'manual_review_required' THEN
      v_workflow_template_name := COALESCE(
        NULLIF(v_preview->>'approval_workflow_template_name', ''),
        'dispatch_reattempt_approval_v1'
      );

      SELECT wt.id
        INTO v_template_id
        FROM public.workflow_templates wt
       WHERE wt.name = v_workflow_template_name
         AND wt.status = 'active'
       ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
       LIMIT 1;

      IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 workflow template missing %', v_workflow_template_name
          USING ERRCODE = '23503';
      END IF;

      v_workflow_run_id := public.start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_task.organization_id,
          'client_id', v_task.client_id,
          'sender_id', v_task.sender_id,
          'resource_type', 'task',
          'resource_id', v_selection_uuid,
          'dispatch_exception_review_task_id', v_selection_uuid,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'payload', jsonb_strip_nulls(jsonb_build_object(
            'dispatch_exception_review_task_id', v_selection_uuid,
            'resolution_action', v_resolution_action,
            'resolution_notes', v_resolution_notes
          ))
        ))
      );

      PERFORM public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_strip_nulls(jsonb_build_object(
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes
        ))
      );

      SELECT mrt.id
        INTO v_manual_review_task_id
        FROM public.manual_review_tasks mrt
       WHERE mrt.metadata->>'workflow_run_id' = v_workflow_run_id::text
       ORDER BY mrt.created_at DESC, mrt.id DESC
       LIMIT 1;

      IF v_manual_review_task_id IS NULL THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 failed to create manual review task for workflow_run_id %',
          v_workflow_run_id;
      END IF;

      UPDATE public.manual_review_tasks
         SET reason = COALESCE(v_resolution_notes, reason, NULLIF(v_preview->>'dispatch_exception_reason', '')),
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'workflow_resume_on_resolve', TRUE,
               'dispatch_exception_review_task_id', v_selection_uuid,
               'resolution_action', v_resolution_action,
               'resolution_notes', v_resolution_notes
             )),
             updated_at = now()
       WHERE id = v_manual_review_task_id;

      PERFORM public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_manual_review_task_id,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes
        ))
      );

      UPDATE public.tasks
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'resolution_action', v_resolution_action,
               'resolution_notes', v_resolution_notes,
               'resolution_status', 'pending_review',
               'resolution_workflow_run_id', v_workflow_run_id,
               'resolution_manual_review_task_id', v_manual_review_task_id
             )),
             updated_at = now()
       WHERE id = v_selection_uuid;

      v_pending_review_count := v_pending_review_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_selection_uuid,
        'status', 'pending_review',
        'workflow_run_id', v_workflow_run_id,
        'manual_review_task_id', v_manual_review_task_id,
        'preview', v_preview
      )));
    ELSE
      v_apply_result := public.apply_dispatch_exception_resolution_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_id', v_selection_uuid,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'actor_system', 'ui_execute_dispatch_exception_resolution_v1'
        ))
      );

      v_apply_status := lower(NULLIF(btrim(COALESCE(v_apply_result->>'status', '')), ''));
      IF v_apply_status IN ('scheduled', 'pending', 'queued') THEN
        v_scheduled_count := v_scheduled_count + 1;
      ELSIF v_apply_status = 'blocked' THEN
        v_blocked_count := v_blocked_count + 1;
      ELSIF v_apply_status = 'pending_review' THEN
        v_pending_review_count := v_pending_review_count + 1;
      ELSE
        v_completed_count := v_completed_count + 1;
      END IF;
      v_results := v_results || jsonb_build_array(
        jsonb_strip_nulls(COALESCE(v_apply_result, '{}'::jsonb) || jsonb_build_object('task_id', v_selection_uuid))
      );
    END IF;
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', CASE
      WHEN v_pending_review_count > 0 AND v_completed_count = 0 AND v_blocked_count = 0 THEN 'pending_review'
      WHEN v_scheduled_count > 0 AND v_pending_review_count = 0 AND v_completed_count = 0 AND v_blocked_count = 0 THEN 'scheduled'
      WHEN v_completed_count > 0 AND v_pending_review_count = 0 AND v_blocked_count = 0 THEN 'completed'
      WHEN v_blocked_count > 0 AND v_pending_review_count = 0 AND v_completed_count = 0 THEN 'blocked'
      ELSE 'mixed'
    END,
    'count', COALESCE(jsonb_array_length(v_results), 0),
    'pending_review_count', v_pending_review_count,
    'scheduled_count', v_scheduled_count,
    'completed_count', v_completed_count,
    'blocked_count', v_blocked_count,
    'items', v_results
  ));
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Resolve visible dispatch exception review tasks through the dedicated row-driven NDR policy path without widening ui_execute_command_v1.';

CREATE OR REPLACE FUNCTION api.ui_execute_dispatch_exception_resolution_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_dispatch_exception_resolution_v1($1, $2, $3, $4, $5, $6);
$function$;

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_global JSONB := NULL;
  v_tasks_complete JSONB := NULL;
  v_canonical_commands JSONB := '{}'::jsonb;
  v_current JSONB := '{}'::jsonb;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
  v_target_key TEXT := NULL;
  v_row RECORD;
BEGIN
  SELECT s.cached_value
    INTO v_global
    FROM public.settings s
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_global IS NULL OR jsonb_typeof(v_global) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ndr_resolution_orchestration_v1: ui_command_registry global settings missing';
  END IF;

  SELECT item
    INTO v_tasks_complete
    FROM jsonb_array_elements(COALESCE(v_global->'commands', '[]'::jsonb)) AS item
   WHERE item->>'key' = 'tasks.complete'
   LIMIT 1;

  IF v_tasks_complete IS NULL THEN
    RAISE EXCEPTION 'ndr_resolution_orchestration_v1: tasks.complete command missing from ui_command_registry';
  END IF;

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['dispatch_exception_review.complete'],
    public.deep_merge_jsonb(
      v_tasks_complete,
      jsonb_build_object(
        'key', 'dispatch_exception_review.complete',
        'label', 'Resolve exception',
        'description', 'Resolve the selected dispatch exception review task.',
        'schema_category', 'resource:dispatch_exception_review',
        'confirm', jsonb_build_object(
          'title', 'Resolve exception',
          'message', 'Choose the resolution action for the selected dispatch exception review.'
        ),
        'execution', jsonb_build_object(
          'type', 'rpc',
          'rpc', 'ui_execute_dispatch_exception_resolution_v1',
          'input_schema', jsonb_build_object(
            'version', 1,
            'fields', jsonb_build_array(
              jsonb_build_object(
                'key', 'resolution_action',
                'label', 'Resolution action',
                'type', 'lookup',
                'lookup_category', 'ndr_action',
                'required', TRUE,
                'placeholder', 'Select a resolution action'
              ),
              jsonb_build_object(
                'key', 'resolution_notes',
                'label', 'Resolution notes',
                'type', 'textarea',
                'required', FALSE,
                'placeholder', 'Optional notes'
              )
            )
          )
        )
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['dispatch_exception_review_mine.complete'],
    public.deep_merge_jsonb(
      v_canonical_commands->'dispatch_exception_review.complete',
      jsonb_build_object(
        'key', 'dispatch_exception_review_mine.complete',
        'description', 'Resolve the selected dispatch exception review from my queue.',
        'schema_category', 'resource:dispatch_exception_review_mine'
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['sla_deadline_alerts.complete'],
    public.deep_merge_jsonb(
      v_canonical_commands->'dispatch_exception_review.complete',
      jsonb_build_object(
        'key', 'sla_deadline_alerts.complete',
        'description', 'Resolve the selected overdue dispatch exception review.',
        'schema_category', 'resource:sla_deadline_alerts'
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
        FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key IS NOT NULL AND (v_canonical_commands ? v_command_key) THEN
        v_command := public.deep_merge_jsonb(v_command, v_canonical_commands->v_command_key);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    FOREACH v_target_key IN ARRAY ARRAY[
      'dispatch_exception_review.complete',
      'dispatch_exception_review_mine.complete',
      'sla_deadline_alerts.complete'
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_next_commands) AS item
         WHERE COALESCE(item->>'key', '') = v_target_key
      ) THEN
        v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->v_target_key);
      END IF;
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_row.version + 1,
           change_reason = 'Route dispatch exception review completion through ui_execute_dispatch_exception_resolution_v1.',
           approved_at = workflow_now(),
           effective_from = workflow_now()
     WHERE id = v_row.settings_version_id
       AND v_current IS DISTINCT FROM v_row.value;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = workflow_now()
     WHERE id = v_row.settings_id
       AND v_current IS DISTINCT FROM v_row.value;
  END LOOP;
END;
$do$;

REVOKE ALL ON FUNCTION public.preview_dispatch_exception_resolution_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_dispatch_exception_resolution_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.preview_dispatch_exception_resolution_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.preview_dispatch_exception_resolution_v1(UUID, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.apply_dispatch_exception_resolution_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_dispatch_exception_resolution_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.apply_dispatch_exception_resolution_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_dispatch_exception_resolution_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM anon;
REVOKE ALL ON FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_dispatch_exception_resolution_apply_v1(workflow_run_steps, workflow_runs, JSONB) TO service_role;

REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(workflow_run_steps, workflow_runs, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(workflow_run_steps, workflow_runs, JSONB) FROM anon;
REVOKE ALL ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(workflow_run_steps, workflow_runs, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_task_completion_effects_v1(workflow_run_steps, workflow_runs, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202604091530_b09_ndr_resolution_orchestration_v1'));
COMMIT;
