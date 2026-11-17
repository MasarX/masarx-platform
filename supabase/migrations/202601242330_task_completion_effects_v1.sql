-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Task completion effects v1 (row-driven follow-up task -> shipment effects)
-- Date: 2026-01-24
--
-- Goals:
--   - Keep the system task-driven: human completes follow-up tasks; engine applies state changes.
--   - Row-driven: effects are resolved via settings ladder (global/tenant/client/sender/source as allowed).
--   - Single source of truth: shipment state transitions are emitted via shipment_actions + shipments.status projection.
--   - Idempotent and auditable: completion produces exactly-once shipment action keyed by task_event_id.
--
-- Scope:
--   - New settings category: task_completion_effects_policy (maps task_type_key -> shipment effects).
--   - New workflow template: task_completion_effects_v1 (single-step).
--   - Wire domain_event_policy for selected task.completed.* events to the template (non-stomping).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242330_task_completion_effects_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category + schema: task_completion_effects_policy
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
  'task_completion_effects_policy',
  'Policy mapping task completion (task_type_key) to resource effects (e.g., shipment status/action). Ladder-resolved; used by workflow handlers.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'task_completion_effects_policy',
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
          'action_type', jsonb_build_object('type', 'string'),
          'action_category', jsonb_build_object('type', 'string')
        )
      ),
      'task_type_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'description', 'Map of task_type_key -> effects spec',
        'properties', jsonb_build_object()
      )
    )
  ),
  'Task completion effects policy. Defines how task completion should update domain resources (initially: shipments).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object('action_type', 'exception', 'action_category', 'administrative'),
      'task_type_map', jsonb_build_object(
        'dispatch_reschedule_delivery', jsonb_build_object('shipment_status', 'pending'),
        'dispatch_reattempt_delivery', jsonb_build_object('shipment_status', 'pending'),
        'dispatch_rto_pickup', jsonb_build_object('shipment_status', 'return_to_origin')
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

-- Seed global default (insert-only).
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'defaults', jsonb_build_object(
      'action_type', 'exception',
      'action_category', 'administrative'
    ),
    'task_type_map', jsonb_build_object(
      'dispatch_reschedule_delivery', jsonb_build_object('shipment_status', 'pending'),
      'dispatch_reattempt_delivery', jsonb_build_object('shipment_status', 'pending'),
      'dispatch_rto_pickup', jsonb_build_object('shipment_status', 'return_to_origin')
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
    'task_completion_effects_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_completion_effects_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_completion_effects_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_completion_effects_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Workflow handler: task_completion_effects (apply effects for shipment tasks)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
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

  v_existing BOOLEAN := FALSE;
  v_action_id UUID := NULL;

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

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

  -- Resolve effects policy via ladder.
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

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  v_effect := COALESCE(v_policy#>ARRAY['task_type_map', v_task_type_key], '{}'::jsonb);
  IF jsonb_typeof(v_effect) IS DISTINCT FROM 'object' THEN
    v_effect := '{}'::jsonb;
  END IF;

  IF jsonb_object_length(v_effect) = 0 THEN
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

  -- Load shipment (partition-safe when client_id is present).
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

  -- Idempotency: if this task_event already emitted a shipment action, do nothing.
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
      'shipment_action_id', v_action_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status,
    'shipment_action_id', v_action_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status,
      'shipment_action_id', v_action_id
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Operation handler registry: task_completion_effects -> v1
-------------------------------------------------------------------------------

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
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
  'task_completion_effects',
  'workflow_handlers',
  'execute_task_completion_effects_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply task completion effects via task_completion_effects_policy (ladder-resolved). Initial scope: shipment status/actions. Idempotent by task_event_id.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-------------------------------------------------------------------------------
-- 4) Workflow template: task_completion_effects_v1
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'task_completion_effects_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    INSERT INTO public.workflow_templates (
      name,
      description,
      version,
      status,
      scope_type,
      scope_id,
      created_at,
      published_at
    ) VALUES (
      'task_completion_effects_v1',
      'Apply row-driven task completion effects (task_type_key -> resource effects).',
      1,
      'active',
      'global',
      NULL::uuid,
      now(),
      now()
    )
    RETURNING id INTO v_template_id;
  END IF;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects_v1 template missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    WHERE wts.workflow_template_id = v_template_id
      AND wts.sequence_order = 1
  ) THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      next_operation_name,
      next_operation_priority,
      next_operation_delay_seconds,
      manual_action_required,
      metadata,
      enabled,
      handler_key,
      handler_version,
      created_at,
      updated_at
    ) VALUES (
      v_template_id,
      1,
      'task_completion_effects',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'task_effects'
      ),
      TRUE,
      'task_completion_effects',
      'v1',
      now(),
      now()
    );
  END IF;
END;
$do$;

-------------------------------------------------------------------------------
-- 5) domain_event_policy: map selected task.completed.* events to template (global)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
  v_current JSONB;
  v_next JSONB;
  v_sv_id UUID;
  v_updated BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'task_completion_effects_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects_v1 template missing';
  END IF;

  SELECT sv.id, sv.value
    INTO v_sv_id, v_current
    FROM public.settings_versions sv
   WHERE sv.category = 'domain_event_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
   ORDER BY sv.approved_at DESC
   LIMIT 1;

  v_current := COALESCE(v_current, '{"events":{}}'::jsonb);
  IF jsonb_typeof(v_current) <> 'object' THEN
    v_current := '{"events":{}}'::jsonb;
  END IF;
  IF NOT (v_current ? 'events') OR jsonb_typeof(v_current->'events') <> 'object' THEN
    v_current := jsonb_set(v_current, '{events}', '{}'::jsonb, TRUE);
  END IF;

  v_next := v_current;

  -- Set only when missing (non-stomping).
  IF COALESCE(v_next #>> '{events,task.completed.dispatch_reschedule_delivery,workflow_template_id}', '') = '' THEN
    v_next := jsonb_set(
      v_next,
      '{events,task.completed.dispatch_reschedule_delivery,workflow_template_id}',
      to_jsonb(v_template_id::text),
      TRUE
    );
    v_updated := TRUE;
  END IF;

  IF COALESCE(v_next #>> '{events,task.completed.dispatch_reattempt_delivery,workflow_template_id}', '') = '' THEN
    v_next := jsonb_set(
      v_next,
      '{events,task.completed.dispatch_reattempt_delivery,workflow_template_id}',
      to_jsonb(v_template_id::text),
      TRUE
    );
    v_updated := TRUE;
  END IF;

  IF COALESCE(v_next #>> '{events,task.completed.dispatch_rto_pickup,workflow_template_id}', '') = '' THEN
    v_next := jsonb_set(
      v_next,
      '{events,task.completed.dispatch_rto_pickup,workflow_template_id}',
      to_jsonb(v_template_id::text),
      TRUE
    );
    v_updated := TRUE;
  END IF;

  IF NOT v_updated THEN
    RETURN;
  END IF;

  IF v_sv_id IS NULL THEN
    INSERT INTO public.settings_versions (
      category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from
    )
    VALUES (
      'domain_event_policy',
      'global',
      NULL::uuid,
      1,
      v_next,
      1,
      'Map task.completed.dispatch_* follow-up tasks to task_completion_effects_v1',
      now(),
      now()
    )
    RETURNING id INTO v_sv_id;
  ELSE
    UPDATE public.settings_versions
       SET value = v_next,
           approved_at = now()
     WHERE id = v_sv_id;
  END IF;

  UPDATE public.settings s
     SET settings_version_id = v_sv_id,
         cached_value = v_next,
         last_updated = now()
   WHERE s.category = 'domain_event_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242330_task_completion_effects_v1'));
COMMIT;
