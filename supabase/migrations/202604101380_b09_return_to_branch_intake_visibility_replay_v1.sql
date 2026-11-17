-- Plan: Batch 9 Exception, reattempt & returns loop
-- Migration: return-to-branch intake + visibility closure replay v1
-- Date: 2026-04-10
--
-- Purpose:
--   - Keep Field Ops return intake on the canonical scan ledger by adding a
--     dedicated `return_to_branch_intake` scan type to `scan_policy`.
--   - Persist returned-to-branch intake side effects exactly once through
--     `scan_events` -> `inventory_movements` + `shipment_actions` + shipment
--     metadata, without widening app-side branching.
--   - Expose returned-to-branch inventory lanes through one canonical API view
--     plus filtered `ui_read_registry` resources for reattempt, customer pickup,
--     sender return, and hold.
--   - Keep next-action segregation row-driven by extending `ndr_policy.action_map`
--     with `branch_next_action` buckets and resolving them through a helper.

-- Replay the canonical migration under a unique version because `202604101130`
-- already exists in the base chain for a different migration version key.
BEGIN;
SELECT pg_advisory_lock(hashtext('202604101380_b09_return_to_branch_intake_visibility_replay_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- 1) scan_type lookup + scan_policy + ndr_policy: additive row-driven contract updates
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'return_to_branch_intake',
  'Return To Branch Intake',
  'Scan event that books an undelivered shipment back into branch inventory.',
  65,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'scan_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_types JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'scan_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_types := COALESCE(v_current->'accepted_scan_types', '[]'::jsonb);
    IF jsonb_typeof(v_types) IS DISTINCT FROM 'array' THEN
      v_types := '[]'::jsonb;
    END IF;

    IF NOT (v_types ? 'return_to_branch_intake') THEN
      v_types := v_types || jsonb_build_array('return_to_branch_intake');
    END IF;

    v_next := jsonb_set(v_current, '{accepted_scan_types}', v_types, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Allow return_to_branch_intake scans in scan_policy.',
             approved_at = COALESCE(approved_at, workflow_now()),
             effective_from = COALESCE(effective_from, workflow_now())
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_action_map JSONB := '{}'::jsonb;
  v_patch JSONB := jsonb_build_object(
    'reattempt', jsonb_build_object('branch_next_action', 'reattempt'),
    'reschedule', jsonb_build_object('branch_next_action', 'reattempt'),
    'return_to_sender', jsonb_build_object('branch_next_action', 'sender_return'),
    'hold_at_branch', jsonb_build_object('branch_next_action', 'customer_pickup'),
    'cancel', jsonb_build_object('branch_next_action', 'hold')
  );
  v_key TEXT;
  v_value JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ndr_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_action_map := COALESCE(v_current->'action_map', '{}'::jsonb);
    IF jsonb_typeof(v_action_map) IS DISTINCT FROM 'object' THEN
      v_action_map := '{}'::jsonb;
    END IF;

    FOR v_key, v_value IN
      SELECT key, value
      FROM jsonb_each(v_patch)
    LOOP
      v_action_map := jsonb_set(
        v_action_map,
        ARRAY[v_key],
        public.jsonb_deep_merge(COALESCE(v_action_map->v_key, '{}'::jsonb), v_value),
        TRUE
      );
    END LOOP;

    v_next := jsonb_set(v_current, '{action_map}', v_action_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Add branch_next_action buckets to ndr_policy action_map.',
             approved_at = COALESCE(approved_at, workflow_now()),
             effective_from = COALESCE(effective_from, workflow_now())
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 2) Helpers: inventory item bootstrap, default branch location, next-action
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_inventory_item_system_v1(
  p_organization_id UUID,
  p_key TEXT,
  p_name TEXT,
  p_unit TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_key, '')), ''));
  v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb);
  v_id UUID := NULL;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_item_system_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_item_system_v1 requires key' USING ERRCODE = '23514';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_item_system_v1 requires name' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  INSERT INTO public.inventory_items (
    organization_id,
    key,
    name,
    unit,
    metadata
  )
  VALUES (
    p_organization_id,
    v_key,
    v_name,
    NULLIF(btrim(COALESCE(p_unit, '')), ''),
    v_metadata
  )
  ON CONFLICT (organization_id, key)
  DO UPDATE SET
    name = EXCLUDED.name,
    unit = COALESCE(public.inventory_items.unit, EXCLUDED.unit),
    metadata = public.jsonb_deep_merge(COALESCE(public.inventory_items.metadata, '{}'::jsonb), EXCLUDED.metadata),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_inventory_item_system_v1(UUID, TEXT, TEXT, TEXT, JSONB)
  IS 'Service helper that ensures an org-scoped inventory item exists without duplicating bootstrap rows.';
REVOKE ALL ON FUNCTION public.ensure_inventory_item_system_v1(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_inventory_item_system_v1(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_branch_inventory_location_v1(
  p_organization_id UUID,
  p_branch_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_location_id UUID := NULL;
BEGIN
  IF p_organization_id IS NULL OR p_branch_id IS NULL THEN
    RAISE EXCEPTION 'resolve_branch_inventory_location_v1 requires organization_id and branch_id' USING ERRCODE = '23514';
  END IF;

  SELECT wl.id
    INTO v_location_id
    FROM public.warehouse_locations wl
   WHERE wl.organization_id = p_organization_id
     AND wl.branch_id = p_branch_id
     AND COALESCE(wl.is_active, TRUE) IS TRUE
   ORDER BY wl.created_at ASC, wl.id ASC
   LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'resolve_branch_inventory_location_v1: active warehouse location missing for branch %', p_branch_id
      USING ERRCODE = '23503';
  END IF;

  RETURN v_location_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_branch_inventory_location_v1(UUID, UUID)
  IS 'Resolve the canonical default warehouse location for a branch intake by picking the earliest active warehouse_locations row for that branch.';
REVOKE ALL ON FUNCTION public.resolve_branch_inventory_location_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_branch_inventory_location_v1(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_ndr_branch_next_action_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_service_type TEXT DEFAULT NULL,
  p_dispatch_exception_reason TEXT DEFAULT NULL,
  p_resolution_action TEXT DEFAULT NULL,
  p_task_type_key TEXT DEFAULT NULL,
  p_shipment_action_type TEXT DEFAULT NULL,
  p_review_status TEXT DEFAULT NULL,
  p_allowed_ndr_actions JSONB DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy RECORD;
  v_policy_value JSONB := '{}'::jsonb;
  v_action_map JSONB := '{}'::jsonb;
  v_resolution_action TEXT := lower(NULLIF(btrim(COALESCE(p_resolution_action, '')), ''));
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(p_task_type_key, '')), ''));
  v_shipment_action_type TEXT := lower(NULLIF(btrim(COALESCE(p_shipment_action_type, '')), ''));
  v_review_status TEXT := lower(NULLIF(btrim(COALESCE(p_review_status, '')), ''));
  v_candidate TEXT := NULL;
  v_key TEXT;
  v_value JSONB;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN 'hold';
  END IF;

  SELECT *
    INTO v_policy
    FROM public.resolve_settings_row_from_policy_context_v1(
      'ndr_policy',
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', p_organization_id,
        'client_id', p_client_id,
        'sender_id', p_sender_id,
        'service_type', p_service_type,
        'dispatch_exception_reason', p_dispatch_exception_reason
      ))
    )
   LIMIT 1;

  v_policy_value := COALESCE(v_policy.value, '{}'::jsonb);
  v_action_map := COALESCE(v_policy_value->'action_map', '{}'::jsonb);
  IF jsonb_typeof(v_action_map) IS DISTINCT FROM 'object' THEN
    v_action_map := '{}'::jsonb;
  END IF;

  IF v_resolution_action IS NOT NULL AND (v_action_map ? v_resolution_action) THEN
    v_candidate := NULLIF(btrim(COALESCE(v_action_map->v_resolution_action->>'branch_next_action', '')), '');
  END IF;

  IF v_candidate IS NULL AND (v_task_type_key IS NOT NULL OR v_shipment_action_type IS NOT NULL) THEN
    FOR v_key, v_value IN
      SELECT key, value
      FROM jsonb_each(v_action_map)
    LOOP
      IF v_task_type_key IS NOT NULL
         AND lower(NULLIF(btrim(COALESCE(v_value->>'task_type_key', '')), '')) = v_task_type_key THEN
        v_candidate := NULLIF(btrim(COALESCE(v_value->>'branch_next_action', '')), '');
        EXIT;
      END IF;

      IF v_shipment_action_type IS NOT NULL
         AND lower(NULLIF(btrim(COALESCE(v_value->>'shipment_action_type', '')), '')) = v_shipment_action_type THEN
        v_candidate := NULLIF(btrim(COALESCE(v_value->>'branch_next_action', '')), '');
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_candidate IS NOT NULL THEN
    RETURN lower(v_candidate);
  END IF;

  IF v_review_status IN ('open', 'pending', 'blocked', 'pending_review') THEN
    RETURN 'hold';
  END IF;

  IF jsonb_typeof(p_allowed_ndr_actions) = 'array'
     AND (p_allowed_ndr_actions ? 'hold_at_branch')
     AND jsonb_array_length(p_allowed_ndr_actions) = 1 THEN
    RETURN 'customer_pickup';
  END IF;

  RETURN 'hold';
END;
$function$;

COMMENT ON FUNCTION public.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  IS 'Resolve the returned-to-branch next-action bucket from ndr_policy.action_map and the latest review/task/action context.';
REVOKE ALL ON FUNCTION public.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) scan_events intake side effects: inventory ledger + shipment trail
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.scan_events_process_return_to_branch_intake_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_shipment RECORD;
  v_inventory_item_id UUID := NULL;
  v_inventory_location_id UUID := NULL;
  v_inventory_movement_id UUID := NULL;
  v_decision_id UUID := NULL;
  v_shipment_action_id UUID := NULL;
  v_inventory_idempotency_key TEXT := format('return_to_branch_intake:%s', NEW.id);
BEGIN
  IF TG_OP <> 'INSERT' OR lower(COALESCE(NEW.scan_type, '')) <> 'return_to_branch_intake' THEN
    RETURN NEW;
  END IF;

  IF NEW.shipment_id IS NULL OR NEW.client_id IS NULL THEN
    RAISE EXCEPTION 'return_to_branch_intake scan requires shipment_id and client_id' USING ERRCODE = '23514';
  END IF;
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'return_to_branch_intake scan requires branch_id' USING ERRCODE = '23514';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.service_type,
    s.status,
    COALESCE(s.metadata, '{}'::jsonb) AS metadata
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = NEW.shipment_id
     AND s.client_id = NEW.client_id
     AND s.organization_id = NEW.organization_id
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'return_to_branch_intake scan shipment % not found for org/client', NEW.shipment_id
      USING ERRCODE = '23503';
  END IF;

  IF lower(COALESCE(v_shipment.status, '')) IN ('delivered', 'canceled') THEN
    RAISE EXCEPTION 'return_to_branch_intake scan shipment status % is not eligible', v_shipment.status
      USING ERRCODE = '23514';
  END IF;

  v_inventory_location_id := public.resolve_branch_inventory_location_v1(NEW.organization_id, NEW.branch_id);
  v_inventory_item_id := public.ensure_inventory_item_system_v1(
    NEW.organization_id,
    'shipment_package',
    'Shipment Package',
    'shipment',
    jsonb_build_object(
      'system_managed', TRUE,
      'source', 'return_to_branch_intake'
    )
  );

  v_decision_id := public.log_decision(
    p_organization_id := NEW.organization_id,
    p_decision_category := 'warehouse',
    p_resource_type := 'shipment',
    p_resource_id := NEW.shipment_id,
    p_decision_point := 'return_to_branch_intake',
    p_decision_outcome := 'accepted',
    p_performed_by_system := 'scan_events_process_return_to_branch_intake_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'scan_event_id', NEW.id,
      'scan_type', NEW.scan_type,
      'actor_user_id', NEW.actor_user_id,
      'branch_id', NEW.branch_id,
      'route_stop_id', NEW.route_stop_id,
      'ops_session_id', NEW.ops_session_id,
      'barcode', NEW.barcode,
      'inventory_location_id', v_inventory_location_id
    )),
    p_decision_reason := NULL
  );

  SELECT im.id
    INTO v_inventory_movement_id
    FROM public.inventory_movements im
   WHERE im.organization_id = NEW.organization_id
     AND im.idempotency_key = v_inventory_idempotency_key
   LIMIT 1;

  IF v_inventory_movement_id IS NULL THEN
    INSERT INTO public.inventory_movements (
      organization_id,
      item_id,
      from_location_id,
      to_location_id,
      movement_type,
      quantity,
      unit,
      occurred_at,
      actor_user_id,
      actor_system,
      related_scan_event_id,
      idempotency_key,
      metadata
    )
    VALUES (
      NEW.organization_id,
      v_inventory_item_id,
      NULL,
      v_inventory_location_id,
      'receive',
      1,
      'shipment',
      COALESCE(NEW.captured_at, NEW.created_at, now()),
      NEW.actor_user_id,
      'return_to_branch_intake',
      NEW.id,
      v_inventory_idempotency_key,
      jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', NEW.shipment_id,
        'client_id', NEW.client_id,
        'branch_id', NEW.branch_id,
        'route_stop_id', NEW.route_stop_id,
        'ops_session_id', NEW.ops_session_id,
        'scan_type', NEW.scan_type,
        'decision_log_id', v_decision_id
      ))
    )
    RETURNING id INTO v_inventory_movement_id;
  END IF;

  SELECT sa.id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = NEW.shipment_id
     AND sa.organization_id = NEW.organization_id
     AND sa.client_id = NEW.client_id
     AND sa.action_type = 'scan'
     AND COALESCE(sa.action_data->>'source_scan_event_id', '') = NEW.id::text
   ORDER BY sa.created_at DESC, sa.id DESC
   LIMIT 1;

  IF v_shipment_action_id IS NULL THEN
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
      NEW.shipment_id,
      NEW.organization_id,
      NEW.client_id,
      'scan',
      'operational',
      v_shipment.status,
      NEW.actor_user_id,
      'return_to_branch_intake',
      jsonb_strip_nulls(jsonb_build_object(
        'scan_type', NEW.scan_type,
        'source_scan_event_id', NEW.id,
        'inventory_movement_id', v_inventory_movement_id,
        'inventory_location_id', v_inventory_location_id,
        'branch_id', NEW.branch_id,
        'route_stop_id', NEW.route_stop_id,
        'ops_session_id', NEW.ops_session_id,
        'decision_log_id', v_decision_id
      )),
      COALESCE(NEW.captured_at, NEW.created_at, now())
    )
    RETURNING id INTO v_shipment_action_id;
  END IF;

  UPDATE public.shipments
     SET metadata = public.jsonb_deep_merge(
           COALESCE(metadata, '{}'::jsonb),
           jsonb_build_object(
             'return_to_branch', jsonb_strip_nulls(jsonb_build_object(
               'scan_event_id', NEW.id,
               'inventory_movement_id', v_inventory_movement_id,
               'shipment_action_id', v_shipment_action_id,
               'inventory_location_id', v_inventory_location_id,
               'branch_id', NEW.branch_id,
               'route_stop_id', NEW.route_stop_id,
               'ops_session_id', NEW.ops_session_id,
               'captured_at', COALESCE(NEW.captured_at, NEW.created_at, now()),
               'scan_type', NEW.scan_type,
               'decision_log_id', v_decision_id
             ))
           )
         ),
         updated_at = now()
   WHERE id = NEW.shipment_id
     AND client_id = NEW.client_id
     AND organization_id = NEW.organization_id;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.scan_events_process_return_to_branch_intake_v1()
  IS 'Append-only trigger handler that projects return_to_branch_intake scans into inventory_movements, shipment_actions, decision_log, and shipment metadata once.';

DROP TRIGGER IF EXISTS trg_scan_events_process_return_to_branch_intake ON public.scan_events;
CREATE TRIGGER trg_scan_events_process_return_to_branch_intake
  AFTER INSERT ON public.scan_events
  FOR EACH ROW
  EXECUTE FUNCTION public.scan_events_process_return_to_branch_intake_v1();

-------------------------------------------------------------------------------
-- 4) Returned-to-branch projection
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.return_to_branch_shipments_v1
WITH (security_invoker = true) AS
WITH latest_intake AS (
  SELECT
    s.organization_id,
    s.client_id,
    s.id AS shipment_id,
    NULLIF(s.metadata#>>'{return_to_branch,scan_event_id}', '')::uuid AS intake_scan_event_id,
    NULLIF(s.metadata#>>'{return_to_branch,branch_id}', '')::uuid AS branch_id,
    NULLIF(s.metadata#>>'{return_to_branch,route_stop_id}', '')::uuid AS route_stop_id,
    NULLIF(s.metadata#>>'{return_to_branch,ops_session_id}', '')::uuid AS ops_session_id,
    COALESCE(
      NULLIF(s.metadata#>>'{return_to_branch,captured_at}', '')::timestamptz,
      s.updated_at,
      s.created_at,
      now()
    ) AS intake_captured_at,
    COALESCE(s.updated_at, s.created_at, now()) AS intake_created_at
  FROM public.shipments s
  WHERE NULLIF(s.metadata#>>'{return_to_branch,scan_event_id}', '') IS NOT NULL
),
latest_review AS (
  SELECT DISTINCT ON (t.resource_id)
    t.id AS dispatch_exception_review_task_id,
    t.organization_id,
    t.resource_id AS shipment_id,
    t.status AS review_status,
    t.status_reason AS review_status_reason,
    COALESCE(t.metadata, '{}'::jsonb) AS review_metadata,
    t.created_at AS review_created_at,
    t.updated_at AS review_updated_at
  FROM public.tasks t
  WHERE t.resource_type = 'shipment'
    AND t.task_type_key = 'dispatch_exception_review'
  ORDER BY t.resource_id, t.created_at DESC, t.id DESC
),
latest_next_task AS (
  SELECT DISTINCT ON (t.resource_id)
    t.id AS next_task_id,
    t.organization_id,
    t.resource_id AS shipment_id,
    t.task_type_key,
    t.status AS task_status,
    COALESCE(t.metadata, '{}'::jsonb) AS task_metadata,
    t.created_at,
    t.updated_at
  FROM public.tasks t
  WHERE t.resource_type = 'shipment'
    AND t.task_type_key IN (
      'dispatch_reattempt_delivery',
      'dispatch_reschedule_delivery',
      'dispatch_rto_pickup'
    )
    AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'exception')
  ORDER BY t.resource_id, t.created_at DESC, t.id DESC
),
latest_hold_action AS (
  SELECT DISTINCT ON (sa.shipment_id)
    sa.id AS shipment_action_id,
    sa.organization_id,
    sa.shipment_id,
    sa.action_type,
    sa.action_category,
    COALESCE(sa.action_data, '{}'::jsonb) AS action_data,
    sa.timestamp,
    sa.created_at
  FROM public.shipment_actions sa
  WHERE sa.action_type IN ('hold_at_branch', 'cancel_requested')
  ORDER BY sa.shipment_id, sa.timestamp DESC, sa.created_at DESC, sa.id DESC
)
SELECT
  s.id,
  s.organization_id,
  s.client_id,
  s.sender_id,
  s.id AS shipment_id,
  s.tracking_number,
  s.service_type,
  s.status AS shipment_status,
  li.branch_id,
  li.intake_scan_event_id,
  NULLIF(s.metadata#>>'{return_to_branch,inventory_movement_id}', '')::uuid AS inventory_movement_id,
  NULLIF(s.metadata#>>'{return_to_branch,inventory_location_id}', '')::uuid AS inventory_location_id,
  li.route_stop_id,
  li.ops_session_id,
  lr.dispatch_exception_review_task_id,
  COALESCE(
    NULLIF(btrim(COALESCE(lr.review_metadata->>'dispatch_exception_reason', '')), ''),
    NULLIF(btrim(COALESCE(lr.review_status_reason, '')), '')
  ) AS dispatch_exception_reason,
  NULLIF(btrim(COALESCE(lr.review_metadata->>'resolution_action', '')), '') AS resolution_action,
  lr.review_status,
  public.resolve_ndr_branch_next_action_v1(
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.service_type,
    COALESCE(
      NULLIF(btrim(COALESCE(lr.review_metadata->>'dispatch_exception_reason', '')), ''),
      NULLIF(btrim(COALESCE(lr.review_status_reason, '')), '')
    ),
    NULLIF(btrim(COALESCE(lr.review_metadata->>'resolution_action', '')), ''),
    lnt.task_type_key,
    lha.action_type,
    COALESCE(lr.review_metadata->>'resolution_status', lr.review_status),
    lr.review_metadata->'allowed_ndr_actions'
  ) AS next_action,
  CASE
    WHEN NULLIF(btrim(COALESCE(lr.review_metadata->>'resolution_action', '')), '') IS NOT NULL THEN 'dispatch_exception_resolution'
    WHEN lnt.next_task_id IS NOT NULL THEN 'followup_task'
    WHEN lha.shipment_action_id IS NOT NULL THEN 'shipment_action'
    WHEN lr.dispatch_exception_review_task_id IS NOT NULL THEN 'dispatch_exception_review'
    ELSE 'default_hold'
  END AS next_action_source,
  COALESCE(
    NULLIF(btrim(COALESCE(lr.review_metadata->>'resolution_notes', '')), ''),
    NULLIF(btrim(COALESCE(lr.review_metadata->>'exception_notes', '')), '')
  ) AS notes,
  CASE
    WHEN jsonb_typeof(lr.review_metadata->'evidence_artifact_ids') = 'array' THEN lr.review_metadata->'evidence_artifact_ids'
    ELSE '[]'::jsonb
  END AS evidence_artifact_ids,
  CASE
    WHEN jsonb_typeof(lr.review_metadata->'allowed_ndr_actions') = 'array' THEN lr.review_metadata->'allowed_ndr_actions'
    ELSE '[]'::jsonb
  END AS allowed_ndr_actions,
  li.intake_captured_at,
  GREATEST(
    COALESCE(li.intake_created_at, li.intake_captured_at, now()),
    COALESCE(lr.review_updated_at, lr.review_created_at, li.intake_created_at, now()),
    COALESCE(lnt.updated_at, lnt.created_at, li.intake_created_at, now()),
    COALESCE(lha.created_at, lha.timestamp, li.intake_created_at, now()),
    COALESCE(s.updated_at, s.created_at, now())
  ) AS updated_at
FROM latest_intake li
JOIN public.shipments s
  ON s.id = li.shipment_id
 AND s.client_id = li.client_id
 AND s.organization_id = li.organization_id
LEFT JOIN latest_review lr
  ON lr.shipment_id = s.id
 AND lr.organization_id = s.organization_id
LEFT JOIN latest_next_task lnt
  ON lnt.shipment_id = s.id
 AND lnt.organization_id = s.organization_id
LEFT JOIN latest_hold_action lha
  ON lha.shipment_id = s.id
 AND lha.organization_id = s.organization_id;

CREATE OR REPLACE VIEW api.return_to_branch_shipments_v1
WITH (security_invoker = true) AS
SELECT *
FROM public.return_to_branch_shipments_v1;

REVOKE ALL ON api.return_to_branch_shipments_v1 FROM PUBLIC;
REVOKE ALL ON api.return_to_branch_shipments_v1 FROM anon;
REVOKE ALL ON api.return_to_branch_shipments_v1 FROM authenticated;
GRANT SELECT ON api.return_to_branch_shipments_v1 TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Access control + ui_read_registry + ui_navigation
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resource_map JSONB := '{}'::jsonb;
  v_keys TEXT[] := ARRAY[
    'return_to_branch_shipments',
    'return_to_branch_reattempt',
    'return_to_branch_customer_pickup',
    'return_to_branch_sender_return',
    'return_to_branch_hold'
  ];
  v_key TEXT;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    FOREACH v_key IN ARRAY v_keys LOOP
      v_resource_map := jsonb_set(
        v_resource_map,
        ARRAY[v_key],
        public.jsonb_deep_merge(
          jsonb_build_object(
            'read', 'shipments.read',
            'write', 'shipments.write'
          ),
          COALESCE(v_resource_map->v_key, '{}'::jsonb)
        ),
        TRUE
      );
    END LOOP;

    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose returned-to-branch resources through shipments capabilities.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_base_resource JSONB := jsonb_build_object(
    'key', 'return_to_branch_shipments',
    'label', 'Returned To Branch',
    'description', 'Returned-to-branch shipment intake ledger with next-action segmentation.',
    'relation', 'api.return_to_branch_shipments_v1',
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'shipments.read',
    'capability_write', 'shipments.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'client_id',
      'sender_id',
      'shipment_id',
      'tracking_number',
      'service_type',
      'shipment_status',
      'branch_id',
      'intake_scan_event_id',
      'inventory_movement_id',
      'inventory_location_id',
      'route_stop_id',
      'ops_session_id',
      'dispatch_exception_review_task_id',
      'dispatch_exception_reason',
      'resolution_action',
      'review_status',
      'next_action',
      'next_action_source',
      'notes',
      'evidence_artifact_ids',
      'allowed_ndr_actions',
      'intake_captured_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
      jsonb_build_object('key', 'service_type', 'column', 'service_type', 'op', 'eq'),
      jsonb_build_object('key', 'dispatch_exception_reason', 'column', 'dispatch_exception_reason', 'op', 'eq'),
      jsonb_build_object('key', 'next_action', 'column', 'next_action', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'tracking_number', 'label', 'Tracking'),
      jsonb_build_object('key', 'branch_id', 'label', 'Branch'),
      jsonb_build_object('key', 'dispatch_exception_reason', 'label', 'Exception reason'),
      jsonb_build_object('key', 'next_action', 'label', 'Next action'),
      jsonb_build_object('key', 'notes', 'label', 'Notes'),
      jsonb_build_object('key', 'intake_captured_at', 'label', 'Returned at')
    ),
    'column_labels', jsonb_build_object(
      'tracking_number', 'Tracking',
      'shipment_status', 'Shipment status',
      'branch_id', 'Branch',
      'dispatch_exception_reason', 'Exception reason',
      'resolution_action', 'Resolution action',
      'review_status', 'Review status',
      'next_action', 'Next action',
      'next_action_source', 'Next action source',
      'notes', 'Notes',
      'evidence_artifact_ids', 'Evidence',
      'allowed_ndr_actions', 'Allowed actions',
      'intake_captured_at', 'Returned at',
      'updated_at', 'Updated at'
    ),
    'default_sort', jsonb_build_object('column', 'intake_captured_at', 'direction', 'desc')
  );
  v_variants JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'return_to_branch_reattempt',
      'label', 'Returned For Reattempt',
      'description', 'Returned-to-branch shipments waiting for reattempt planning.',
      'base_filter', jsonb_build_object(
        'op', 'and',
        'rules', jsonb_build_array(
          jsonb_build_object('key', 'next_action', 'op', 'eq', 'value', 'reattempt')
        )
      )
    ),
    jsonb_build_object(
      'key', 'return_to_branch_customer_pickup',
      'label', 'Returned For Customer Pickup',
      'description', 'Returned-to-branch shipments held for customer pickup.',
      'base_filter', jsonb_build_object(
        'op', 'and',
        'rules', jsonb_build_array(
          jsonb_build_object('key', 'next_action', 'op', 'eq', 'value', 'customer_pickup')
        )
      )
    ),
    jsonb_build_object(
      'key', 'return_to_branch_sender_return',
      'label', 'Returned For Sender Return',
      'description', 'Returned-to-branch shipments queued for sender return.',
      'base_filter', jsonb_build_object(
        'op', 'and',
        'rules', jsonb_build_array(
          jsonb_build_object('key', 'next_action', 'op', 'eq', 'value', 'sender_return')
        )
      )
    ),
    jsonb_build_object(
      'key', 'return_to_branch_hold',
      'label', 'Returned On Hold',
      'description', 'Returned-to-branch shipments held for manual intervention.',
      'base_filter', jsonb_build_object(
        'op', 'and',
        'rules', jsonb_build_array(
          jsonb_build_object('key', 'next_action', 'op', 'eq', 'value', 'hold')
        )
      )
    )
  );
  v_variant JSONB;
  v_key TEXT;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');

      IF v_key = 'return_to_branch_shipments' THEN
        v_resource := public.jsonb_deep_merge(v_base_resource, v_resource);
      ELSE
        FOR v_variant IN
          SELECT value
          FROM jsonb_array_elements(v_variants) AS value
        LOOP
          IF v_key = v_variant->>'key' THEN
            v_resource := public.jsonb_deep_merge(v_base_resource, v_variant || v_resource);
            EXIT;
          END IF;
        END LOOP;
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_resources) AS item
      WHERE item->>'key' = 'return_to_branch_shipments'
    ) THEN
      v_next_resources := v_next_resources || jsonb_build_array(v_base_resource);
    END IF;

    FOR v_variant IN
      SELECT value
      FROM jsonb_array_elements(v_variants) AS value
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_next_resources) AS item
        WHERE item->>'key' = v_variant->>'key'
      ) THEN
        v_next_resources := v_next_resources || jsonb_build_array(
          public.jsonb_deep_merge(v_base_resource, v_variant)
        );
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose returned-to-branch resource lanes through ui_read_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_console_sections JSONB := '[]'::jsonb;
  v_portal_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_next_console JSONB := '[]'::jsonb;
  v_next_portal JSONB := '[]'::jsonb;
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-return-to-branch',
    'label', 'Returned To Branch',
    'href', '/console/resources/return_to_branch_shipments',
    'resource', 'return_to_branch_shipments',
    'capability', 'shipments.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-return-to-branch',
    'label', 'Returned To Branch',
    'href', '/portal/resources/return_to_branch_shipments',
    'resource', 'return_to_branch_shipments',
    'capability', 'shipments.read'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_console_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_console_sections) IS DISTINCT FROM 'array' THEN
      v_console_sections := '[]'::jsonb;
    END IF;

    v_next_console := '[]'::jsonb;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_console_sections) AS value
    LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      IF v_section->>'id' = 'operations' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM (
            SELECT item
            FROM jsonb_array_elements(v_items) AS item
            WHERE item->>'id' <> 'console-return-to-branch'
            UNION ALL
            SELECT v_console_item
          ) dedup(item);
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      v_next_console := v_next_console || jsonb_build_array(v_section);
    END LOOP;

    v_portal_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_portal_sections) IS DISTINCT FROM 'array' THEN
      v_portal_sections := '[]'::jsonb;
    END IF;

    v_next_portal := '[]'::jsonb;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_portal_sections) AS value
    LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      IF v_section->>'id' = 'operations' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM (
            SELECT item
            FROM jsonb_array_elements(v_items) AS item
            WHERE item->>'id' <> 'portal-return-to-branch'
            UNION ALL
            SELECT v_portal_item
          ) dedup(item);
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      v_next_portal := v_next_portal || jsonb_build_array(v_section);
    END LOOP;

    v_next := v_current;
    v_next := jsonb_set(v_next, '{apps,console,sections}', v_next_console, TRUE);
    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_next_portal, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Add returned-to-branch navigation entry to Console and Portal operations.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604101380_b09_return_to_branch_intake_visibility_replay_v1'));
COMMIT;
