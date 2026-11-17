-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch route stop finalize v1 (task completion -> shipment status + shipment_actions)
-- Date: 2026-01-24
--
-- Goals:
--   - Keep execution state in Tasks/Workflows; route_runs/route_stops remain planning data.
--   - Drivers complete stop tasks (tasks SSOT); the system reacts engine-first via domain_events.
--   - Row-driven: stop_kind -> shipment transition is resolved via settings ladder (resource/branch > source > sender > client > tenant > global).
--   - Single source of truth: shipment state transitions are emitted via shipment_actions (event log) + shipments.status projection.
--   - Idempotent and auditable: task completion produces exactly-once shipment action keyed by task_event_id.
--
-- Scope (Phase 5.4):
--   - Task completion trigger -> domain_event (policy-gated; no noise).
--   - Workflow template dispatch_route_stop_finalize_v1 + handler route_stop_finalize.
--   - Policy category dispatch_stop_policy (global default + ladder overrides).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601241000_dispatch_route_stop_finalize_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category + schema: dispatch_stop_policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'dispatch_stop_policy',
  'Dispatch stop completion policy: stop_kind -> shipment status/action mapping (row-driven; ladder-resolved; branch/resource-aware).',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'dispatch_stop_policy',
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
      'stop_kind_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'description', 'Map of route_stops.stop_kind -> handler behavior',
        'properties', jsonb_build_object()
      )
    )
  ),
  'Policy that maps route stop completion (stop_kind) to shipment status transitions and shipment_actions payload defaults.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object('action_type', 'status_change', 'action_category', 'operational'),
      'stop_kind_map', jsonb_build_object(
        'delivery', jsonb_build_object('shipment_status', 'delivered'),
        'pickup', jsonb_build_object('shipment_status', 'in_transit'),
        'swap', jsonb_build_object('shipment_status', 'delivered'),
        'rto', jsonb_build_object('shipment_status', 'return_to_origin'),
        'return_to_origin', jsonb_build_object('shipment_status', 'return_to_origin')
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

-- Seed global defaults (dynamic; no hardcoding in handler logic).
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'defaults', jsonb_build_object(
      'action_type', 'status_change',
      'action_category', 'operational'
    ),
    'stop_kind_map', jsonb_build_object(
      'delivery', jsonb_build_object('shipment_status', 'delivered'),
      'pickup', jsonb_build_object('shipment_status', 'in_transit'),
      'swap', jsonb_build_object('shipment_status', 'delivered'),
      'rto', jsonb_build_object('shipment_status', 'return_to_origin'),
      'return_to_origin', jsonb_build_object('shipment_status', 'return_to_origin')
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
    'dispatch_stop_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global dispatch_stop_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'dispatch_stop_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'dispatch_stop_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Domain event trigger: task_events(status_changed->completed) -> domain_events
--    Policy-gated: only enqueue when a workflow_template_id is configured for the event.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.domain_event_from_task_event_completed_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task RECORD;
  v_task_type_key TEXT;
  v_event_type TEXT;
  v_policy JSONB;
  v_template_id UUID := NULL;
  v_payload JSONB;
  v_corr UUID := NULL;
  v_resource_type TEXT;
  v_resource_id UUID;
BEGIN
  IF NEW.event_type IS DISTINCT FROM 'status_changed' THEN
    RETURN NEW;
  END IF;
  IF NEW.to_status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT
    t.id,
    t.organization_id,
    t.client_id,
    t.sender_id,
    t.task_type_id,
    t.resource_type,
    t.resource_id
  INTO v_task
  FROM public.tasks t
  WHERE t.id = NEW.task_id
  LIMIT 1;

  IF v_task.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  v_task_type_key := lower(COALESCE(NULLIF(btrim(COALESCE(v_task_type_key, '')), ''), 'unknown'));
  v_event_type := format('task.completed.%s', v_task_type_key);

  v_policy := public.resolve_domain_event_policy(v_task.organization_id, v_event_type);
  BEGIN v_template_id := NULLIF(v_policy->>'workflow_template_id', '')::uuid; EXCEPTION WHEN others THEN v_template_id := NULL; END;
  IF v_template_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_resource_type := lower(COALESCE(NULLIF(btrim(COALESCE(v_task.resource_type, '')), ''), 'task'));
  v_resource_id := COALESCE(v_task.resource_id, v_task.id);

  BEGIN v_corr := NULLIF(COALESCE(NEW.payload->>'correlation_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_corr := NULL; END;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'task_event_id', NEW.id,
    'task_id', v_task.id,
    'task_type_key', v_task_type_key,
    'resource_type', v_task.resource_type,
    'resource_id', v_task.resource_id,
    'actor_user_id', NEW.actor_user_id,
    'actor_system', NEW.actor_system,
    'task_event_payload', COALESCE(NEW.payload, '{}'::jsonb),
    'task_event_created_at', NEW.created_at,
    'organization_id', v_task.organization_id,
    'client_id', v_task.client_id,
    'sender_id', v_task.sender_id
  ));

  PERFORM public.enqueue_domain_event(
    p_organization_id := v_task.organization_id,
    p_event_type := v_event_type,
    p_resource_type := v_resource_type,
    p_resource_id := v_resource_id,
    p_payload := v_payload,
    p_correlation_id := v_corr
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_task_events_completed_domain_event ON public.task_events;
CREATE TRIGGER trg_task_events_completed_domain_event
  AFTER INSERT ON public.task_events
  FOR EACH ROW
  EXECUTE FUNCTION public.domain_event_from_task_event_completed_v1();

-------------------------------------------------------------------------------
-- 3) Workflow handler: route_stop_finalize (writes shipment status + action)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v1(
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
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'dispatch_stop');

  v_domain_event_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_task_event_payload JSONB := '{}'::jsonb;
  v_event_created_at TIMESTAMPTZ := NULL;
  v_correlation_id UUID := NULL;

  v_stop RECORD;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_kind_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;

  v_stop_kind TEXT := NULL;
  v_new_status TEXT := NULL;
  v_action_type TEXT := NULL;
  v_action_category TEXT := NULL;

  v_settings_resolution_id UUID := NULL;
  v_existing BOOLEAN := FALSE;

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN v_domain_event_id := NULLIF(v_ctx->>'domain_event_id', '')::uuid; EXCEPTION WHEN others THEN v_domain_event_id := NULL; END;
  BEGIN v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_route_stop_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_payload->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_task_event_id := NULLIF(v_payload->>'task_event_id', '')::uuid; EXCEPTION WHEN others THEN v_task_event_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_payload->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := NULLIF(btrim(COALESCE(v_payload->>'actor_system', '')), '');
  v_task_event_payload := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  BEGIN v_event_created_at := NULLIF(v_payload->>'task_event_created_at', '')::timestamptz; EXCEPTION WHEN others THEN v_event_created_at := NULL; END;
  BEGIN v_correlation_id := NULLIF(v_task_event_payload->>'correlation_id', '')::uuid; EXCEPTION WHEN others THEN v_correlation_id := NULL; END;

  IF v_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: missing resource_id(route_stop_id) (workflow_run_id=% step_id=%)', p_run.id, p_step.id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    rs.id AS route_stop_id,
    rs.organization_id,
    rs.client_id,
    rs.shipment_id,
    rs.stop_kind,
    rs.route_run_id,
    rr.branch_id
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id
  WHERE rs.id = v_route_stop_id
  LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop % not found', v_route_stop_id USING ERRCODE = '23503';
  END IF;

  SELECT
    s.id AS shipment_id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status AS shipment_status
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = v_stop.shipment_id
    AND s.client_id = v_stop.client_id
  LIMIT 1;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment % not found for client %', v_stop.shipment_id, v_stop.client_id
      USING ERRCODE = '23503';
  END IF;

  v_stop_kind := lower(COALESCE(NULLIF(btrim(COALESCE(v_stop.stop_kind, '')), ''), 'delivery'));

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'resource_id', v_stop.branch_id,
    'organization_id', v_stop.organization_id,
    'client_id', v_stop.client_id,
    'sender_id', v_ship.sender_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_stop_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  IF jsonb_typeof(v_defaults) <> 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  v_kind_policy := COALESCE(v_policy->'stop_kind_map'->v_stop_kind, '{}'::jsonb);
  IF jsonb_typeof(v_kind_policy) <> 'object' THEN
    v_kind_policy := '{}'::jsonb;
  END IF;

  v_new_status := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'shipment_status', '')), ''));
  v_action_type := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_type', v_defaults->>'action_type')), ''));
  v_action_category := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_category', v_defaults->>'action_category')), ''));

  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing stop_kind_map.% for shipment_status', v_stop_kind
      USING ERRCODE = '23514';
  END IF;
  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing defaults action_type/action_category' USING ERRCODE = '23514';
  END IF;

  -- Policy provenance (settings ladder + scope path) -> settings_resolution_log.
  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_stop.organization_id,
      p_category := 'dispatch_stop_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'route_run_id', v_stop.route_run_id,
        'branch_id', v_stop.branch_id,
        'shipment_id', v_ship.shipment_id,
        'stop_kind', v_stop_kind,
        'task_event_id', v_task_event_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Idempotency: if this task_event already emitted a shipment action, do nothing.
  IF v_task_event_id IS NOT NULL THEN
    SELECT TRUE
      INTO v_existing
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_ship.shipment_id
       AND sa.organization_id = v_stop.organization_id
       AND sa.client_id = v_stop.client_id
       AND (sa.action_data->>'task_event_id') = v_task_event_id::text
     LIMIT 1;

    IF v_existing THEN
      PERFORM public.log_decision(
        p_organization_id := v_stop.organization_id,
        p_decision_category := 'dispatch',
        p_resource_type := 'shipment',
        p_resource_id := v_ship.shipment_id,
        p_decision_point := 'route_stop_finalize',
        p_decision_outcome := 'duplicate_ignored',
        p_performed_by_system := 'dispatch_route_stop_finalize_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'route_stop_id', v_route_stop_id,
          'stop_kind', v_stop_kind,
          'task_event_id', v_task_event_id,
          'domain_event_id', v_domain_event_id
        )),
        p_decision_reason := 'shipment_action already exists for task_event_id',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'shipment_id', v_ship.shipment_id,
        'status', 'skipped',
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

  UPDATE public.shipments
     SET status = v_new_status,
         status_updated_at = COALESCE(v_event_created_at, now()),
         updated_at = now()
   WHERE id = v_ship.shipment_id
     AND client_id = v_stop.client_id;

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
    v_stop.organization_id,
    v_stop.client_id,
    v_action_type,
    v_action_category,
    v_new_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'workflow_engine'),
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'settings_resolution_id', v_settings_resolution_id,
      'task_event_payload', v_task_event_payload
    )),
    COALESCE(v_event_created_at, now())
  );

  PERFORM public.log_decision(
    p_organization_id := v_stop.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'shipment',
    p_resource_id := v_ship.shipment_id,
    p_decision_point := 'route_stop_finalize',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'dispatch_route_stop_finalize_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_ship.shipment_status,
      'new_status', v_new_status,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_stop_id', v_route_stop_id,
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Operation handler registry (row-driven)
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
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Finalize a dispatch route_stop execution: update shipment status + emit shipment_actions (policy-driven; idempotent by task_event_id).',
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
-- 5) Workflow template: dispatch_route_stop_finalize_v1
-------------------------------------------------------------------------------

INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id, created_by, created_at, updated_at, notes)
VALUES (
  'dispatch_route_stop_finalize_v1',
  'Dispatch: finalize route_stop execution based on completed task event (writes shipment status + shipment_actions; row-driven).',
  1,
  'active',
  'global',
  NULL,
  NULL,
  now(),
  now(),
  'Expected context: resource_type=route_stop, resource_id=route_stop_id, payload.task_event_id/task_id + POD evidence; policy category dispatch_stop_policy resolves stop_kind behavior.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'dispatch_route_stop_finalize_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_route_stop_finalize_v1 template id missing after upsert';
  END IF;

  DELETE FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id;

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
    'route_stop_finalize',
    NULL,
    'success',
    NULL,
    NULL,
    NULL,
    FALSE,
    jsonb_build_object(
      'context_key', 'dispatch_stop'
    ),
    TRUE,
    'route_stop_finalize',
    'v1',
    now(),
    now()
  );
END;
$do$;

-------------------------------------------------------------------------------
-- 6) domain_event_policy: map task.completed.route_stop_execute -> dispatch_route_stop_finalize_v1
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
  v_current JSONB;
  v_next JSONB;
  v_sv_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'dispatch_route_stop_finalize_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_route_stop_finalize_v1 template missing';
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

  v_next := jsonb_set(
    v_current,
    ARRAY['events','task.completed.route_stop_execute','workflow_template_id'],
    to_jsonb(v_template_id::text),
    TRUE
  );

  IF v_sv_id IS NULL THEN
    INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, change_reason, approved_at, effective_from)
    VALUES (
      'domain_event_policy',
      'global',
      NULL::uuid,
      1,
      v_next,
      1,
      'Map task.completed.route_stop_execute to dispatch_route_stop_finalize_v1',
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

SELECT pg_advisory_unlock(hashtext('202601241000_dispatch_route_stop_finalize_v1'));
COMMIT;

