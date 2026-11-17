-- Plan: PLAN-202603-b03-branch-intake-wave1 / Step: S04
-- Migration: Warehouse transfer intake controls v1
-- Date: 2026-03-19
--
-- Goals:
--   - Add row-driven intake policy for branch/hub receive and reconcile.
--   - Capture actual receive/reconcile counts on warehouse_transfers without duplicating manifest truth.
--   - Gate unmanifested intake through an exception-hold task and discrepancy closure through supervisor approval.
--   - Keep all behavior workflow-driven through the canonical warehouse_transfer handler.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191140_warehouse_transfer_intake_controls_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category + schema: warehouse_transfer_policy
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
  'warehouse_transfer_policy',
  'Receive/reconcile policy for warehouse transfers, including variance tolerance, supervisor approval, and unmanifested hold rules.',
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
    resource_scope_rel = EXCLUDED.resource_scope_rel,
    updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'warehouse_transfer_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Warehouse Transfer Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
      'receive', jsonb_build_object(
        'type', jsonb_build_array('object', 'null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'require_hold_for_unmanifested', jsonb_build_object('type', jsonb_build_array('boolean', 'null'))
        )
      ),
      'reconcile', jsonb_build_object(
        'type', jsonb_build_array('object', 'null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'allowed_variance_count', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 0),
          'require_supervisor_approval', jsonb_build_object('type', jsonb_build_array('boolean', 'null'))
        )
      )
    )
  ),
  'Policy resolved through the settings ladder for branch receive/reconcile handling of warehouse transfers.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'receive', jsonb_build_object(
        'require_hold_for_unmanifested', TRUE
      ),
      'reconcile', jsonb_build_object(
        'allowed_variance_count', 0,
        'require_supervisor_approval', TRUE
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
    'enabled', TRUE,
    'receive', jsonb_build_object(
      'require_hold_for_unmanifested', TRUE
    ),
    'reconcile', jsonb_build_object(
      'allowed_variance_count', 0,
      'require_supervisor_approval', TRUE
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
    'warehouse_transfer_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global warehouse_transfer_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'warehouse_transfer_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'warehouse_transfer_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

CREATE OR REPLACE FUNCTION public.resolve_warehouse_transfer_policy(
  p_context JSONB
)
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
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('warehouse_transfer_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_warehouse_transfer_policy(JSONB) IS
  'Resolve warehouse_transfer_policy through the canonical settings policy context ladder.';

REVOKE ALL ON FUNCTION public.resolve_warehouse_transfer_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_warehouse_transfer_policy(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_warehouse_transfer_policy(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_warehouse_transfer_policy(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 2) task_type_catalog: add warehouse_supervisor_approval (global default; additive)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_types JSONB := '[]'::jsonb;
  v_prev_task_types JSONB := '[]'::jsonb;
  v_item JSONB := jsonb_build_object(
    'key', 'warehouse_supervisor_approval',
    'name', 'Warehouse Supervisor Approval',
    'description', 'Supervisor review for warehouse intake discrepancies or correction requests.',
    'default_priority', 60,
    'default_queue_key', 'warehouse',
    'enabled', TRUE
  );
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    RAISE EXCEPTION 'warehouse_transfer_intake_controls_v1: global task_type_catalog settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_existing->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;
  v_prev_task_types := v_task_types;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_task_types) e
    WHERE lower(NULLIF(btrim(COALESCE(e->>'key', '')), '')) = 'warehouse_supervisor_approval'
  ) THEN
    v_task_types := v_task_types || jsonb_build_array(v_item);
  END IF;

  IF v_task_types IS NOT DISTINCT FROM v_prev_task_types THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_existing, '{task_types}', v_task_types, TRUE);

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add warehouse_supervisor_approval to task_type_catalog',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) Schema: actual intake counts on warehouse_transfers
-------------------------------------------------------------------------------

ALTER TABLE public.warehouse_transfers
  ADD COLUMN IF NOT EXISTS received_shipment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_shipment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS missing_shipment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unmanifested_shipment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.warehouse_transfers
  DROP CONSTRAINT IF EXISTS warehouse_transfers_received_shipment_count_ck;
ALTER TABLE public.warehouse_transfers
  DROP CONSTRAINT IF EXISTS warehouse_transfers_damaged_shipment_count_ck;
ALTER TABLE public.warehouse_transfers
  DROP CONSTRAINT IF EXISTS warehouse_transfers_missing_shipment_count_ck;
ALTER TABLE public.warehouse_transfers
  DROP CONSTRAINT IF EXISTS warehouse_transfers_unmanifested_shipment_count_ck;

ALTER TABLE public.warehouse_transfers
  ADD CONSTRAINT warehouse_transfers_received_shipment_count_ck CHECK (received_shipment_count >= 0),
  ADD CONSTRAINT warehouse_transfers_damaged_shipment_count_ck CHECK (damaged_shipment_count >= 0),
  ADD CONSTRAINT warehouse_transfers_missing_shipment_count_ck CHECK (missing_shipment_count >= 0),
  ADD CONSTRAINT warehouse_transfers_unmanifested_shipment_count_ck CHECK (unmanifested_shipment_count >= 0);

-------------------------------------------------------------------------------
-- 4) Service RPC: transition_warehouse_transfer_v1(jsonb) captures phase summary
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_warehouse_transfer_v1(
  p_input JSONB
)
RETURNS TABLE (
  warehouse_transfer_id UUID,
  updated BOOLEAN,
  status TEXT,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_in JSONB := COALESCE(p_input, '{}'::jsonb);
  v_transfer_id UUID := NULL;
  v_org_id UUID := NULL;
  v_to_status TEXT := NULL;
  v_from_status TEXT := NULL;

  v_effective_at TIMESTAMPTZ := NULL;
  v_set_dispatched BOOLEAN := FALSE;
  v_set_received BOOLEAN := FALSE;
  v_set_reconciled BOOLEAN := FALSE;

  v_vehicle_id UUID := NULL;
  v_driver_user_id UUID := NULL;

  v_capture_phase TEXT := lower(NULLIF(btrim(COALESCE(v_in->>'capture_phase', '')), ''));
  v_phase_summary JSONB := NULL;
  v_settings_resolution_id UUID := NULL;

  v_received_count INTEGER := NULL;
  v_damaged_count INTEGER := NULL;
  v_missing_count INTEGER := NULL;
  v_unmanifested_count INTEGER := NULL;

  v_before public.warehouse_transfers%ROWTYPE;
  v_should_update BOOLEAN := FALSE;
  v_updated BOOLEAN := FALSE;
  v_metadata_next JSONB := '{}'::jsonb;
BEGIN
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
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires service_role context';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_transfer_id := NULLIF(btrim(COALESCE(v_in->>'warehouse_transfer_id', v_in->>'transfer_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;
  BEGIN v_org_id := NULLIF(btrim(COALESCE(v_in->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  v_to_status := lower(NULLIF(btrim(COALESCE(v_in->>'to_status', '')), ''));
  v_from_status := lower(NULLIF(btrim(COALESCE(v_in->>'from_status', '')), ''));

  BEGIN v_effective_at := NULLIF(btrim(COALESCE(v_in->>'effective_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
  v_effective_at := COALESCE(v_effective_at, now());

  BEGIN v_set_dispatched := COALESCE((v_in->>'set_dispatched_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_dispatched := FALSE; END;
  BEGIN v_set_received := COALESCE((v_in->>'set_received_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_received := FALSE; END;
  BEGIN v_set_reconciled := COALESCE((v_in->>'set_reconciled_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_reconciled := FALSE; END;

  BEGIN v_vehicle_id := NULLIF(btrim(COALESCE(v_in->>'vehicle_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(btrim(COALESCE(v_in->>'driver_user_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_settings_resolution_id := NULLIF(btrim(COALESCE(v_in->>'settings_resolution_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_settings_resolution_id := NULL; END;

  v_phase_summary := COALESCE(v_in->'phase_summary', '{}'::jsonb);
  IF jsonb_typeof(v_phase_summary) IS DISTINCT FROM 'object' THEN
    v_phase_summary := '{}'::jsonb;
  END IF;
  IF v_capture_phase NOT IN ('receive', 'reconcile') THEN
    v_capture_phase := NULL;
    v_phase_summary := '{}'::jsonb;
  END IF;

  BEGIN v_received_count := NULLIF(btrim(COALESCE(v_phase_summary->>'received_shipment_count', v_phase_summary#>>'{counts,received_shipment_count}', v_phase_summary->>'actual_received_count', v_phase_summary#>>'{counts,actual_received_count}', v_phase_summary->>'actual_count', v_phase_summary#>>'{counts,actual_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_received_count := NULL; END;
  BEGIN v_damaged_count := NULLIF(btrim(COALESCE(v_phase_summary->>'damaged_shipment_count', v_phase_summary#>>'{counts,damaged_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_damaged_count := NULL; END;
  BEGIN v_missing_count := NULLIF(btrim(COALESCE(v_phase_summary->>'missing_shipment_count', v_phase_summary#>>'{counts,missing_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_missing_count := NULL; END;
  BEGIN v_unmanifested_count := NULLIF(btrim(COALESCE(v_phase_summary->>'unmanifested_shipment_count', v_phase_summary#>>'{counts,unmanifested_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_unmanifested_count := NULL; END;

  IF COALESCE(v_received_count, 0) < 0
     OR COALESCE(v_damaged_count, 0) < 0
     OR COALESCE(v_missing_count, 0) < 0
     OR COALESCE(v_unmanifested_count, 0) < 0 THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 phase counts must be >= 0' USING ERRCODE = '23514';
  END IF;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires warehouse_transfer_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires to_status' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'warehouse_transfer_status'
    AND lv.value = v_to_status
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_before
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_transfer_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 warehouse_transfer not found: %', v_transfer_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_before.organization_id);
  IF v_org_id IS DISTINCT FROM v_before.organization_id THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1: organization mismatch (input org %, transfer org %)', v_org_id, v_before.organization_id
      USING ERRCODE = '23514';
  END IF;

  IF lower(v_before.status) IS DISTINCT FROM v_to_status THEN
    IF v_from_status IS NOT NULL AND lower(v_before.status) IS DISTINCT FROM v_from_status THEN
      RAISE EXCEPTION 'transition_warehouse_transfer_v1: from_status mismatch (expected %, current %)', v_from_status, v_before.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_metadata_next := COALESCE(v_before.metadata, '{}'::jsonb);
  IF v_capture_phase IS NOT NULL THEN
    v_metadata_next := public.jsonb_deep_merge(
      v_metadata_next,
      jsonb_build_object(v_capture_phase, v_phase_summary)
    );
  END IF;

  v_should_update := (
    lower(v_before.status) IS DISTINCT FROM v_to_status
    OR (v_set_dispatched IS TRUE AND v_before.dispatched_at IS NULL)
    OR (v_set_received IS TRUE AND v_before.received_at IS NULL)
    OR (v_set_reconciled IS TRUE AND v_before.reconciled_at IS NULL)
    OR (v_vehicle_id IS NOT NULL AND v_before.vehicle_id IS NULL)
    OR (v_driver_user_id IS NOT NULL AND v_before.driver_user_id IS NULL)
    OR (v_received_count IS NOT NULL AND v_before.received_shipment_count IS DISTINCT FROM v_received_count)
    OR (v_damaged_count IS NOT NULL AND v_before.damaged_shipment_count IS DISTINCT FROM v_damaged_count)
    OR (v_missing_count IS NOT NULL AND v_before.missing_shipment_count IS DISTINCT FROM v_missing_count)
    OR (v_unmanifested_count IS NOT NULL AND v_before.unmanifested_shipment_count IS DISTINCT FROM v_unmanifested_count)
    OR v_metadata_next IS DISTINCT FROM COALESCE(v_before.metadata, '{}'::jsonb)
  );

  IF v_should_update IS TRUE THEN
    UPDATE public.warehouse_transfers wt
       SET status = v_to_status,
           dispatched_at = CASE WHEN v_set_dispatched IS TRUE THEN COALESCE(wt.dispatched_at, v_effective_at) ELSE wt.dispatched_at END,
           received_at = CASE WHEN v_set_received IS TRUE THEN COALESCE(wt.received_at, v_effective_at) ELSE wt.received_at END,
           reconciled_at = CASE WHEN v_set_reconciled IS TRUE THEN COALESCE(wt.reconciled_at, v_effective_at) ELSE wt.reconciled_at END,
           vehicle_id = CASE WHEN v_vehicle_id IS NOT NULL AND wt.vehicle_id IS NULL THEN v_vehicle_id ELSE wt.vehicle_id END,
           driver_user_id = CASE WHEN v_driver_user_id IS NOT NULL AND wt.driver_user_id IS NULL THEN v_driver_user_id ELSE wt.driver_user_id END,
           received_shipment_count = COALESCE(v_received_count, wt.received_shipment_count),
           damaged_shipment_count = COALESCE(v_damaged_count, wt.damaged_shipment_count),
           missing_shipment_count = COALESCE(v_missing_count, wt.missing_shipment_count),
           unmanifested_shipment_count = COALESCE(v_unmanifested_count, wt.unmanifested_shipment_count),
           metadata = v_metadata_next,
           updated_at = now()
     WHERE wt.id = v_transfer_id
     RETURNING wt.id, wt.status, wt.dispatched_at, wt.received_at
      INTO warehouse_transfer_id, status, dispatched_at, received_at;

    v_updated := TRUE;
  ELSE
    warehouse_transfer_id := v_before.id;
    status := v_before.status;
    dispatched_at := v_before.dispatched_at;
    received_at := v_before.received_at;
    v_updated := FALSE;
  END IF;

  updated := v_updated;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'warehouse',
    p_resource_type := 'warehouse_transfer',
    p_resource_id := v_transfer_id,
    p_decision_point := COALESCE(v_capture_phase, 'transition'),
    p_decision_outcome := CASE WHEN v_updated IS TRUE THEN 'applied' ELSE 'noop' END,
    p_performed_by_system := 'transition_warehouse_transfer_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'warehouse_transfer_id', v_transfer_id,
      'from_status', v_from_status,
      'to_status', v_to_status,
      'effective_at', v_effective_at,
      'set_dispatched_at', v_set_dispatched,
      'set_received_at', v_set_received,
      'set_reconciled_at', v_set_reconciled,
      'vehicle_id', v_vehicle_id,
      'driver_user_id', v_driver_user_id,
      'capture_phase', v_capture_phase,
      'phase_summary', CASE WHEN v_capture_phase IS NOT NULL THEN v_phase_summary ELSE NULL END
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 5) Workflow handler: warehouse_transfer captures receive/reconcile summaries
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_warehouse_transfer_v1(
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

  v_action TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'action', '')), ''));
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'warehouse_transfer');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_default_idempotency TEXT := format('workflow_run:%s:step:%s', p_run.id, p_step.id);

  v_effective_at_context_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'effective_at_context_key', '')), '');
  v_task_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'task_context_key', '')), ''), v_effective_at_context_key);
  v_capture_phase TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'capture_phase', '')), ''));
  v_effective_at TIMESTAMPTZ := NULL;

  v_input JSONB := '{}'::jsonb;
  v_to_status TEXT := NULLIF(btrim(COALESCE(v_meta->>'to_status', '')), '');
  v_from_status TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'from_status', '')), ''));
  v_set_dispatched BOOLEAN := FALSE;
  v_set_received BOOLEAN := FALSE;
  v_set_reconciled BOOLEAN := FALSE;

  v_transfer_id UUID := NULL;
  v_org_id UUID := NULL;
  v_expected_manifest_count INTEGER := 0;
  v_received_count INTEGER := NULL;
  v_damaged_count INTEGER := NULL;
  v_missing_count INTEGER := NULL;
  v_unmanifested_count INTEGER := NULL;
  v_abs_variance_count INTEGER := 0;
  v_allowed_variance_count INTEGER := 0;
  v_has_discrepancy BOOLEAN := FALSE;
  v_has_unmanifested_hold BOOLEAN := FALSE;
  v_requires_supervisor_approval BOOLEAN := FALSE;
  v_notes TEXT := NULL;

  v_transfer public.warehouse_transfers%ROWTYPE;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_policy_settings_resolution_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_event public.task_events%ROWTYPE;
  v_task_payload JSONB := '{}'::jsonb;
  v_phase_summary JSONB := '{}'::jsonb;
  v_existing_context_value JSONB := '{}'::jsonb;
  v_context_value JSONB := '{}'::jsonb;

  v_out RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  IF v_action IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: missing metadata.action (expected transition) (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_action IS DISTINCT FROM 'transition' THEN
    RAISE EXCEPTION 'warehouse_transfer: unsupported action % (expected transition)', v_action
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_ctx) IS DISTINCT FROM 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  BEGIN v_transfer_id := NULLIF(btrim(COALESCE(v_ctx->>'warehouse_transfer_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;
  BEGIN v_org_id := NULLIF(btrim(COALESCE(v_ctx->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: warehouse_transfer_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_transfer_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_transfer: warehouse_transfer_id % not found', v_transfer_id USING ERRCODE = '23503';
  END IF;

  BEGIN v_set_dispatched := COALESCE((v_meta->>'set_dispatched_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_dispatched := FALSE; END;
  BEGIN v_set_received := COALESCE((v_meta->>'set_received_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_received := FALSE; END;
  BEGIN v_set_reconciled := COALESCE((v_meta->>'set_reconciled_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_reconciled := FALSE; END;

  IF v_effective_at_context_key IS NOT NULL AND jsonb_typeof(v_ctx->v_effective_at_context_key) = 'object' THEN
    BEGIN v_effective_at := NULLIF(btrim(COALESCE((v_ctx->v_effective_at_context_key)#>>'{last_event,created_at}', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
    IF v_effective_at IS NULL THEN
      BEGIN v_effective_at := NULLIF(btrim(COALESCE((v_ctx->v_effective_at_context_key)#>>'{completed_at}', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
    END IF;
  END IF;
  v_effective_at := COALESCE(v_effective_at, now());

  IF v_capture_phase IN ('receive', 'reconcile') THEN
    SELECT COUNT(*)::integer
      INTO v_expected_manifest_count
      FROM public.warehouse_transfer_items wti
     WHERE wti.transfer_id = v_transfer_id;

    v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'resource_id', v_transfer.to_branch_id
    ));

    SELECT *
      INTO v_policy_row
      FROM public.resolve_warehouse_transfer_policy(v_policy_ctx)
      LIMIT 1;

    IF FOUND AND v_policy_row.value IS NOT NULL THEN
      v_policy_value := v_policy_row.value;
      v_policy_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org_id,
        p_category := 'warehouse_transfer_policy',
        p_winning_scope_type := v_policy_row.scope_type,
        p_winning_scope_id := v_policy_row.scope_id,
        p_winning_settings_id := v_policy_row.settings_id,
        p_winning_settings_version_id := v_policy_row.settings_version_id,
        p_winning_version := v_policy_row.version,
        p_scope_path := v_policy_row.scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'warehouse_transfer_id', v_transfer_id,
          'capture_phase', v_capture_phase,
          'expected_manifest_count', v_expected_manifest_count
        )),
        p_merge_notes := NULL
      );
    END IF;

    IF v_task_context_key IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfer: task_context_key/effective_at_context_key required for capture_phase=%', v_capture_phase
        USING ERRCODE = '23514';
    END IF;

    BEGIN
      v_task_id := NULLIF(btrim(COALESCE((v_ctx->v_task_context_key)->>'task_id', '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_task_id := NULL;
    END;
    IF v_task_id IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfer: task_id missing from context key % for capture_phase=%', v_task_context_key, v_capture_phase
        USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO v_task_event
      FROM public.task_events te
     WHERE te.task_id = v_task_id
     ORDER BY te.task_version DESC
     LIMIT 1;

    v_task_payload := COALESCE(v_task_event.payload, '{}'::jsonb);

    BEGIN v_received_count := NULLIF(btrim(COALESCE(v_task_payload->>'received_shipment_count', v_task_payload#>>'{counts,received_shipment_count}', v_task_payload->>'actual_received_count', v_task_payload#>>'{counts,actual_received_count}', v_task_payload->>'actual_count', v_task_payload#>>'{counts,actual_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_received_count := NULL; END;
    BEGIN v_damaged_count := NULLIF(btrim(COALESCE(v_task_payload->>'damaged_shipment_count', v_task_payload#>>'{counts,damaged_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_damaged_count := NULL; END;
    BEGIN v_missing_count := NULLIF(btrim(COALESCE(v_task_payload->>'missing_shipment_count', v_task_payload#>>'{counts,missing_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_missing_count := NULL; END;
    BEGIN v_unmanifested_count := NULLIF(btrim(COALESCE(v_task_payload->>'unmanifested_shipment_count', v_task_payload#>>'{counts,unmanifested_shipment_count}', '')), '')::integer; EXCEPTION WHEN others THEN v_unmanifested_count := NULL; END;

    IF v_received_count IS NULL THEN
      IF v_missing_count IS NOT NULL OR v_unmanifested_count IS NOT NULL THEN
        v_received_count := GREATEST(v_expected_manifest_count - COALESCE(v_missing_count, 0), 0) + COALESCE(v_unmanifested_count, 0);
      ELSIF v_capture_phase = 'reconcile' THEN
        v_received_count := NULLIF(v_transfer.received_shipment_count, 0);
      END IF;
    END IF;
    IF v_received_count IS NULL THEN
      v_received_count := v_expected_manifest_count;
    END IF;

    v_damaged_count := COALESCE(v_damaged_count, CASE WHEN v_capture_phase = 'reconcile' THEN v_transfer.damaged_shipment_count ELSE 0 END, 0);
    v_missing_count := COALESCE(v_missing_count, GREATEST(v_expected_manifest_count - v_received_count, 0), 0);
    v_unmanifested_count := COALESCE(v_unmanifested_count, GREATEST(v_received_count - v_expected_manifest_count, 0), 0);

    IF v_received_count < 0 OR v_damaged_count < 0 OR v_missing_count < 0 OR v_unmanifested_count < 0 THEN
      RAISE EXCEPTION 'warehouse_transfer: capture counts must be >= 0 for phase %', v_capture_phase USING ERRCODE = '23514';
    END IF;

    BEGIN v_allowed_variance_count := GREATEST(COALESCE(NULLIF(btrim(COALESCE(v_policy_value #>> '{reconcile,allowed_variance_count}', '')), '')::integer, 0), 0); EXCEPTION WHEN others THEN v_allowed_variance_count := 0; END;
    BEGIN v_requires_supervisor_approval := COALESCE((v_policy_value #>> '{reconcile,require_supervisor_approval}')::boolean, FALSE); EXCEPTION WHEN others THEN v_requires_supervisor_approval := FALSE; END;
    BEGIN v_has_unmanifested_hold := COALESCE((v_policy_value #>> '{receive,require_hold_for_unmanifested}')::boolean, FALSE); EXCEPTION WHEN others THEN v_has_unmanifested_hold := FALSE; END;

    v_abs_variance_count := abs(v_expected_manifest_count - v_received_count);
    v_has_discrepancy := (
      v_abs_variance_count > 0
      OR v_damaged_count > 0
      OR v_missing_count > 0
      OR v_unmanifested_count > 0
    );
    v_has_unmanifested_hold := v_has_unmanifested_hold AND v_unmanifested_count > 0;
    v_requires_supervisor_approval := (
      v_capture_phase = 'reconcile'
      AND v_requires_supervisor_approval IS TRUE
      AND (
        v_abs_variance_count > v_allowed_variance_count
        OR v_damaged_count > 0
        OR v_missing_count > 0
        OR v_unmanifested_count > 0
      )
    );

    v_notes := NULLIF(
      btrim(
        COALESCE(
          v_task_payload->>'notes',
          v_task_payload->>'exception_notes',
          v_task_payload->>'reconcile_notes',
          v_task_payload#>>'{counts,notes}',
          ''
        )
      ),
      ''
    );

    v_phase_summary := jsonb_strip_nulls(jsonb_build_object(
      'phase', v_capture_phase,
      'task_id', v_task_id,
      'task_event_id', v_task_event.id,
      'effective_at', v_effective_at,
      'expected_manifest_count', v_expected_manifest_count,
      'received_shipment_count', v_received_count,
      'damaged_shipment_count', v_damaged_count,
      'missing_shipment_count', v_missing_count,
      'unmanifested_shipment_count', v_unmanifested_count,
      'variance_shipment_count', v_expected_manifest_count - v_received_count,
      'abs_variance_count', v_abs_variance_count,
      'allowed_variance_count', v_allowed_variance_count,
      'has_discrepancy', v_has_discrepancy,
      'has_unmanifested_hold', CASE WHEN v_capture_phase = 'receive' THEN v_has_unmanifested_hold ELSE NULL END,
      'requires_supervisor_approval', CASE WHEN v_capture_phase = 'reconcile' THEN v_requires_supervisor_approval ELSE NULL END,
      'notes', v_notes,
      'damaged_shipments', CASE WHEN jsonb_typeof(v_task_payload->'damaged_shipments') = 'array' THEN v_task_payload->'damaged_shipments' ELSE NULL END,
      'missing_shipments', CASE WHEN jsonb_typeof(v_task_payload->'missing_shipments') = 'array' THEN v_task_payload->'missing_shipments' ELSE NULL END,
      'unmanifested_shipments', CASE WHEN jsonb_typeof(v_task_payload->'unmanifested_shipments') = 'array' THEN v_task_payload->'unmanifested_shipments' ELSE NULL END,
      'settings_resolution_id', v_policy_settings_resolution_id
    ));
  END IF;

  v_input := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'warehouse_transfer_id', v_transfer_id,
    'from_status', v_from_status,
    'to_status', lower(btrim(COALESCE(v_to_status, ''))),
    'effective_at', v_effective_at,
    'set_dispatched_at', v_set_dispatched,
    'set_received_at', v_set_received,
    'set_reconciled_at', v_set_reconciled,
    'capture_phase', v_capture_phase,
    'phase_summary', CASE WHEN v_capture_phase IS NOT NULL THEN v_phase_summary ELSE NULL END,
    'settings_resolution_id', v_policy_settings_resolution_id,
    'idempotency_key', v_default_idempotency,
    'actor_system', v_actor_system
  ));

  SELECT *
    INTO v_out
    FROM public.transition_warehouse_transfer_v1(v_input)
   LIMIT 1;

  IF jsonb_typeof(v_ctx->v_context_key) = 'object' THEN
    v_existing_context_value := v_ctx->v_context_key;
  END IF;

  v_context_value := jsonb_strip_nulls(jsonb_build_object(
    'warehouse_transfer_id', v_out.warehouse_transfer_id,
    'updated', v_out.updated,
    'status', v_out.status,
    'dispatched_at', v_out.dispatched_at,
    'received_at', v_out.received_at,
    'effective_at', v_effective_at
  ));
  IF v_capture_phase IS NOT NULL THEN
    v_context_value := public.jsonb_deep_merge(
      v_context_value,
      jsonb_build_object(v_capture_phase, v_phase_summary)
    );
  END IF;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'action', v_action,
    'warehouse_transfer_id', v_out.warehouse_transfer_id,
    'updated', v_out.updated,
    'status', v_out.status,
    'dispatched_at', v_out.dispatched_at,
    'received_at', v_out.received_at,
    'capture_phase', v_capture_phase,
    'phase_summary', CASE WHEN v_capture_phase IS NOT NULL THEN v_phase_summary ELSE NULL END,
    'settings_resolution_id', v_policy_settings_resolution_id
  ));
  v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
    v_context_key,
    public.jsonb_deep_merge(v_existing_context_value, v_context_value)
  ));
  RETURN v_resp;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_warehouse_transfer_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 6) Workflow template: receive -> hold -> reconcile -> approval -> finalize
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'warehouse_transfer_execute_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 template id missing';
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
  ) VALUES
    (
      v_template_id,
      1,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_pack',
        'task_type_key', 'warehouse_transfer_pack',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      2,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_pack',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      3,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_dispatch',
        'task_type_key', 'warehouse_transfer_dispatch',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      4,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_dispatch',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      5,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'in_transit',
        'set_dispatched_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_dispatch',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      6,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_receive',
        'task_type_key', 'warehouse_transfer_receive',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      7,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_receive',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      8,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'received',
        'from_status', 'in_transit',
        'set_received_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_receive',
        'task_context_key', 'warehouse_transfer_receive',
        'capture_phase', 'receive',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      9,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_hold',
        'task_type_key', 'warehouse_exception_hold',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse',
        'when_path', '$.context.warehouse_transfer.receive.has_unmanifested_hold'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      10,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_hold',
        'poll_interval_seconds', 60,
        'allow_missing_task', TRUE,
        'when_path', '$.context.warehouse_transfer.receive.has_unmanifested_hold'
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      11,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_reconcile',
        'task_type_key', 'warehouse_transfer_reconcile',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      12,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_reconcile',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      13,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'received',
        'from_status', 'received',
        'effective_at_context_key', 'warehouse_transfer_reconcile',
        'task_context_key', 'warehouse_transfer_reconcile',
        'capture_phase', 'reconcile',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      14,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_supervisor_approval',
        'task_type_key', 'warehouse_supervisor_approval',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse',
        'when_path', '$.context.warehouse_transfer.reconcile.requires_supervisor_approval'
      ),
      TRUE,
      'task_enqueue',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      15,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_supervisor_approval',
        'poll_interval_seconds', 60,
        'allow_missing_task', TRUE,
        'when_path', '$.context.warehouse_transfer.reconcile.requires_supervisor_approval'
      ),
      TRUE,
      'task_wait',
      'v2',
      now(),
      now()
    ),
    (
      v_template_id,
      16,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'reconciled',
        'from_status', 'received',
        'set_reconciled_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_reconcile',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603191140_warehouse_transfer_intake_controls_v1'));
COMMIT;
