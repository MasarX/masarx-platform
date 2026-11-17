-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S01
-- Migration: Delivery slots (list + reserve) + shared shipment promise apply helper
-- Date: 2026-01-29

-- Goals:
--   - Provide policy-driven delivery slot offering and reservation primitives without introducing a mutable slot ledger table.
--   - Keep behavior fully row-driven (shipment_promise_policy + branch_capacity_windows + calendar_events).
--   - Reduce redundancy by centralizing shipment promise persistence + shipment_actions emission.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601292215_delivery_slots_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Shared persistence helper: apply shipment promise fields + emit shipment_actions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_shipment_promise_v1(
  p_shipment_id UUID,
  p_client_id UUID,
  p_branch_id UUID,
  p_promised_delivery_date DATE,
  p_promised_delivery_at TIMESTAMPTZ,
  p_promised_window_start_at TIMESTAMPTZ,
  p_promised_window_end_at TIMESTAMPTZ,
  p_promise_computed_at TIMESTAMPTZ DEFAULT NULL,
  p_promise_settings_resolution_id UUID DEFAULT NULL,
  p_set_promised_delivery_date_mode TEXT DEFAULT 'set_if_null', -- set_if_null | force
  p_action_type TEXT DEFAULT 'promise_assigned',
  p_action_category TEXT DEFAULT 'operational',
  p_action_data JSONB DEFAULT '{}'::jsonb,
  p_performed_by_system TEXT DEFAULT 'workflow_engine'
)
RETURNS TABLE (
  updated BOOLEAN,
  action_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_promise_computed_at, public.workflow_now());
  v_set_mode TEXT := lower(COALESCE(NULLIF(p_set_promised_delivery_date_mode, ''), 'set_if_null'));
  v_org_id UUID;
  v_existing_promised_date DATE;
  v_new_promised_date DATE;
  v_updated INT := 0;
  v_action_id UUID := NULL;
BEGIN
  IF p_shipment_id IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'apply_shipment_promise_v1: shipment_id and client_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF v_set_mode NOT IN ('set_if_null','force') THEN
    v_set_mode := 'set_if_null';
  END IF;

  SELECT s.organization_id, s.promised_delivery_date
    INTO v_org_id, v_existing_promised_date
    FROM public.shipments s
   WHERE s.id = p_shipment_id
     AND s.client_id = p_client_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_shipment_promise_v1: shipment not found (shipment_id %, client_id %)', p_shipment_id, p_client_id
      USING ERRCODE = 'P0002';
  END IF;

  v_new_promised_date := CASE
    WHEN v_set_mode = 'force' THEN p_promised_delivery_date
    ELSE COALESCE(v_existing_promised_date, p_promised_delivery_date)
  END;

  UPDATE public.shipments s
  SET branch_id = p_branch_id,
      promised_delivery_date = CASE
        WHEN v_set_mode = 'force' THEN p_promised_delivery_date
        ELSE COALESCE(s.promised_delivery_date, p_promised_delivery_date)
      END,
      promised_delivery_at = p_promised_delivery_at,
      promised_window_start_at = p_promised_window_start_at,
      promised_window_end_at = p_promised_window_end_at,
      promise_computed_at = v_now,
      promise_settings_resolution_id = p_promise_settings_resolution_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = p_shipment_id
    AND s.client_id = p_client_id
    AND (
      s.branch_id IS DISTINCT FROM p_branch_id
      OR s.promised_delivery_at IS DISTINCT FROM p_promised_delivery_at
      OR s.promised_window_start_at IS DISTINCT FROM p_promised_window_start_at
      OR s.promised_window_end_at IS DISTINCT FROM p_promised_window_end_at
      OR s.promise_settings_resolution_id IS DISTINCT FROM p_promise_settings_resolution_id
      OR (
        (v_set_mode = 'force' AND s.promised_delivery_date IS DISTINCT FROM p_promised_delivery_date)
        OR (v_set_mode <> 'force' AND s.promised_delivery_date IS NULL AND p_promised_delivery_date IS NOT NULL)
      )
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    v_action_id := gen_random_uuid();

    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      v_action_id,
      p_shipment_id,
      v_org_id,
      p_client_id,
      COALESCE(NULLIF(p_action_type, ''), 'promise_assigned'),
      COALESCE(NULLIF(p_action_category, ''), 'operational'),
      jsonb_strip_nulls(
        jsonb_build_object(
          'branch_id', p_branch_id,
          'promised_delivery_date', v_new_promised_date,
          'promised_delivery_at', p_promised_delivery_at,
          'promised_window_start_at', p_promised_window_start_at,
          'promised_window_end_at', p_promised_window_end_at,
          'settings_resolution_id', p_promise_settings_resolution_id
        ) || COALESCE(p_action_data, '{}'::jsonb)
      ),
      v_now,
      v_now,
      COALESCE(NULLIF(p_performed_by_system, ''), 'workflow_engine')
    );
  END IF;

  updated := (v_updated > 0);
  action_id := v_action_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.apply_shipment_promise_v1(
  UUID,
  UUID,
  UUID,
  DATE,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TEXT
) IS
  'Shared helper to persist shipment promise fields and emit a shipment_actions record when changes occur (idempotent). Supports promised_delivery_date modes: set_if_null | force.';

REVOKE ALL ON FUNCTION public.apply_shipment_promise_v1(
  UUID,
  UUID,
  UUID,
  DATE,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_shipment_promise_v1(
  UUID,
  UUID,
  UUID,
  DATE,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.apply_shipment_promise_v1(
  UUID,
  UUID,
  UUID,
  DATE,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_shipment_promise_v1(
  UUID,
  UUID,
  UUID,
  DATE,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TEXT
) TO service_role;

-------------------------------------------------------------------------------
-- 2) Slot compute: determine availability for a single slot
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_delivery_slot_v1(
  p_input JSONB
)
RETURNS TABLE (
  slot_date DATE,
  slot_start_at TIMESTAMPTZ,
  slot_end_at TIMESTAMPTZ,
  timezone TEXT,
  is_available BOOLEAN,
  reason TEXT,
  is_blackout BOOLEAN,
  calendar_event_id UUID,
  capacity_window_id UUID,
  capacity_limit NUMERIC,
  capacity_used NUMERIC,
  capacity_remaining NUMERIC,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
  v_client_id UUID;
  v_webhook_source_id UUID;
  v_window_start_text TEXT;
  v_window_end_text TEXT;
  v_window_start_local TIME;
  v_window_end_local TIME;

  v_org_id UUID;
  v_sender_id UUID;
  v_zone_id UUID;
  v_city_id UUID := NULL;
  v_branch_id UUID;
  v_service_level TEXT;
  v_service_type TEXT;
  v_service_level_id UUID := NULL;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_has_policy_row BOOLEAN := FALSE;
  v_enabled BOOLEAN := TRUE;

  v_branch_tz TEXT := NULL;
  v_tz TEXT := 'UTC';

  v_calendar_enabled BOOLEAN := FALSE;
  v_calendar_types TEXT[] := ARRAY[]::TEXT[];

  v_capacity_enabled BOOLEAN := FALSE;
  v_capacity_behavior TEXT := NULL;
  v_capacity_limit_key TEXT := NULL;
  v_capacity_demand NUMERIC := 1;

  v_local_dow INT := NULL;
  v_local_t TIME := NULL;

  v_cap JSONB := NULL;
  v_cap_window_start TIME := NULL;
  v_cap_window_end TIME := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'compute_delivery_slot_v1: input must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN slot_date := NULLIF(v_input->>'slot_date', '')::DATE; EXCEPTION WHEN others THEN slot_date := NULL; END;
  BEGIN v_webhook_source_id := NULLIF(v_input->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_webhook_source_id := NULL; END;

  v_window_start_text := NULLIF(v_input->>'window_start_local', '');
  v_window_end_text := NULLIF(v_input->>'window_end_local', '');

  BEGIN v_window_start_local := CASE WHEN v_window_start_text IS NULL THEN NULL ELSE v_window_start_text::time END; EXCEPTION WHEN others THEN v_window_start_local := NULL; END;
  BEGIN v_window_end_local := CASE WHEN v_window_end_text IS NULL THEN NULL ELSE v_window_end_text::time END; EXCEPTION WHEN others THEN v_window_end_local := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR slot_date IS NULL THEN
    RAISE EXCEPTION 'compute_delivery_slot_v1: shipment_id, client_id, slot_date are required'
      USING ERRCODE = '22023';
  END IF;

  IF v_window_start_local IS NULL OR v_window_end_local IS NULL OR v_window_end_local <= v_window_start_local THEN
    slot_start_at := NULL;
    slot_end_at := NULL;
    timezone := NULL;
    is_available := FALSE;
    reason := 'invalid_window';
    is_blackout := FALSE;
    calendar_event_id := NULL;
    capacity_window_id := NULL;
    capacity_limit := NULL;
    capacity_used := NULL;
    capacity_remaining := NULL;
    debug := jsonb_strip_nulls(jsonb_build_object(
      'status', 'invalid',
      'window_start_local', v_window_start_text,
      'window_end_local', v_window_end_text
    ));
    RETURN NEXT;
    RETURN;
  END IF;

  -- Load shipment context and derive branch_id when missing.
  SELECT
    s.organization_id,
    s.sender_id,
    s.zone_id,
    s.service_type,
    s.service_level,
    COALESCE(s.branch_id, public.resolve_branch_id_for_zone(s.zone_id)) AS derived_branch_id
  INTO v_org_id, v_sender_id, v_zone_id, v_service_type, v_service_level, v_branch_id
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_delivery_slot_v1: shipment not found (shipment_id %, client_id %)', v_shipment_id, v_client_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_branch_id IS NULL THEN
    timezone := NULL;
    is_available := FALSE;
    reason := 'branch_unmapped';
    is_blackout := FALSE;
    calendar_event_id := NULL;
    capacity_window_id := NULL;
    capacity_limit := NULL;
    capacity_used := NULL;
    capacity_remaining := NULL;
    debug := jsonb_strip_nulls(jsonb_build_object(
      'status', 'invalid',
      'organization_id', v_org_id,
      'zone_id', v_zone_id,
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'reason', 'branch_unmapped'
    ));
    RETURN NEXT;
    RETURN;
  END IF;

  -- Best-effort city_id for richer calendar matching (zone_districts -> canonical_districts).
  BEGIN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = v_zone_id
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_city_id := NULL;
  END;

  -- Resolve policy with ladder precedence (resource branch -> source -> sender -> client -> tenant -> global).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_shipment_promise_policy(v_policy_ctx)
   LIMIT 1;

  v_has_policy_row := FOUND;
  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_enabled := TRUE; END;
  IF NOT v_enabled THEN
    timezone := NULL;
    is_available := FALSE;
    reason := 'policy_disabled';
    is_blackout := FALSE;
    calendar_event_id := NULL;
    capacity_window_id := NULL;
    capacity_limit := NULL;
    capacity_used := NULL;
    capacity_remaining := NULL;
    debug := jsonb_strip_nulls(jsonb_build_object(
      'status', 'disabled',
      'policy_context', v_policy_ctx
    ));
    RETURN NEXT;
    RETURN;
  END IF;

  -- Timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  v_branch_tz := NULL;
  BEGIN
    IF COALESCE((v_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone INTO v_branch_tz FROM public.branches b WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_branch_tz := NULL;
  END;

  v_tz := COALESCE(NULLIF(v_branch_tz, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');
  timezone := v_tz;

  slot_start_at := (slot_date::timestamp + v_window_start_local) AT TIME ZONE v_tz;
  slot_end_at := (slot_date::timestamp + v_window_end_local) AT TIME ZONE v_tz;

  -- Calendar blackout check (slot interval overlap).
  BEGIN v_calendar_enabled := COALESCE((v_policy->>'calendar_enabled')::BOOLEAN, FALSE); EXCEPTION WHEN others THEN v_calendar_enabled := FALSE; END;
  IF v_calendar_enabled AND v_org_id IS NOT NULL AND jsonb_typeof(v_policy->'calendar_blackout_event_types') = 'array' THEN
    SELECT COALESCE(array_agg(lower(t)), ARRAY[]::TEXT[])
      INTO v_calendar_types
      FROM (
        SELECT NULLIF(btrim(value), '') AS t
        FROM jsonb_array_elements_text(v_policy->'calendar_blackout_event_types') AS value
      ) x
     WHERE x.t IS NOT NULL;
  END IF;

  calendar_event_id := NULL;
  is_blackout := FALSE;
  IF v_calendar_enabled AND COALESCE(array_length(v_calendar_types, 1), 0) > 0 THEN
    SELECT ce.id
      INTO calendar_event_id
      FROM public.calendar_events ce
     WHERE ce.organization_id = v_org_id
       AND ce.is_active IS TRUE
       AND ce.event_type = ANY(v_calendar_types)
       AND (ce.branch_id IS NULL OR ce.branch_id = v_branch_id)
       AND (ce.zone_id IS NULL OR (v_zone_id IS NOT NULL AND ce.zone_id = v_zone_id))
       AND (ce.city_id IS NULL OR (v_city_id IS NOT NULL AND ce.city_id = v_city_id))
       AND ce.starts_at < slot_end_at
       AND ce.ends_at > slot_start_at
     ORDER BY
       (ce.branch_id IS NOT NULL) DESC,
       (ce.zone_id IS NOT NULL) DESC,
       (ce.city_id IS NOT NULL) DESC,
       ce.starts_at DESC
     LIMIT 1;

    IF calendar_event_id IS NOT NULL THEN
      is_blackout := TRUE;
    END IF;
  END IF;

  -- Capacity window selection + usage (optional).
  BEGIN v_capacity_enabled := COALESCE((v_policy->>'capacity_enabled')::BOOLEAN, FALSE); EXCEPTION WHEN others THEN v_capacity_enabled := FALSE; END;
  v_capacity_behavior := lower(NULLIF(v_policy->>'capacity_behavior', ''));
  IF v_capacity_behavior IS NULL OR v_capacity_behavior NOT IN ('shift','ignore') THEN
    v_capacity_behavior := 'shift';
  END IF;
  v_capacity_limit_key := NULLIF(v_policy->>'capacity_limit_key', '');
  BEGIN v_capacity_demand := COALESCE(NULLIF(v_policy->>'capacity_demand', '')::NUMERIC, 1); EXCEPTION WHEN others THEN v_capacity_demand := 1; END;

  -- Resolve service_level_id for capacity matching when possible.
  IF v_org_id IS NOT NULL AND v_service_level IS NOT NULL THEN
    SELECT sl.id
      INTO v_service_level_id
      FROM public.service_levels sl
     WHERE sl.organization_id = v_org_id
       AND sl.key = lower(v_service_level)
     LIMIT 1;
  END IF;

  v_local_dow := EXTRACT(DOW FROM (slot_start_at AT TIME ZONE v_tz))::INT;
  v_local_t := (slot_start_at AT TIME ZONE v_tz)::time;

  capacity_window_id := NULL;
  v_cap := NULL;
  v_cap_window_start := NULL;
  v_cap_window_end := NULL;
  SELECT bcw.id, bcw.capacity, bcw.window_start_local, bcw.window_end_local
    INTO capacity_window_id, v_cap, v_cap_window_start, v_cap_window_end
    FROM public.branch_capacity_windows bcw
   WHERE bcw.branch_id = v_branch_id
     AND bcw.is_active IS TRUE
     AND bcw.effective_from <= slot_start_at
     AND (bcw.effective_to IS NULL OR bcw.effective_to > slot_start_at)
     AND (bcw.zone_id IS NULL OR (v_zone_id IS NOT NULL AND bcw.zone_id = v_zone_id))
     AND (bcw.service_level_id IS NULL OR (v_service_level_id IS NOT NULL AND bcw.service_level_id = v_service_level_id))
     AND (bcw.day_of_week IS NULL OR bcw.day_of_week = v_local_dow)
     AND (
       bcw.window_start_local IS NULL
       OR (v_local_t >= bcw.window_start_local AND v_local_t < bcw.window_end_local)
     )
   ORDER BY
     bcw.priority DESC,
     (bcw.zone_id IS NOT NULL) DESC,
     (bcw.service_level_id IS NOT NULL) DESC,
     (bcw.day_of_week IS NOT NULL) DESC,
     (bcw.window_start_local IS NOT NULL) DESC,
     bcw.effective_from DESC,
     bcw.created_at DESC
   LIMIT 1;

  capacity_limit := NULL;
  capacity_used := NULL;
  capacity_remaining := NULL;

  IF v_capacity_enabled AND v_capacity_behavior <> 'ignore' AND v_capacity_limit_key IS NOT NULL AND capacity_window_id IS NOT NULL AND jsonb_typeof(v_cap) = 'object' THEN
    BEGIN capacity_limit := NULLIF(v_cap->>v_capacity_limit_key, '')::NUMERIC; EXCEPTION WHEN others THEN capacity_limit := NULL; END;
  END IF;

  IF capacity_limit IS NOT NULL AND capacity_limit > 0 THEN
    IF v_cap_window_start IS NULL THEN
      SELECT COUNT(*)::NUMERIC
        INTO capacity_used
        FROM public.shipments s
       WHERE s.organization_id = v_org_id
         AND s.branch_id = v_branch_id
         AND s.promised_delivery_date = slot_date
         AND s.id IS DISTINCT FROM v_shipment_id;
    ELSE
      SELECT COUNT(*)::NUMERIC
        INTO capacity_used
        FROM public.shipments s
       WHERE s.organization_id = v_org_id
         AND s.branch_id = v_branch_id
         AND s.promised_delivery_date = slot_date
         AND s.id IS DISTINCT FROM v_shipment_id
         AND (
           s.promised_window_start_at IS NULL
           OR (s.promised_window_start_at >= slot_start_at AND s.promised_window_start_at < slot_end_at)
         );
    END IF;

    capacity_remaining := GREATEST(capacity_limit - COALESCE(capacity_used, 0), 0);
  END IF;

  IF is_blackout THEN
    is_available := FALSE;
    reason := 'blackout';
  ELSIF capacity_limit IS NOT NULL AND capacity_limit > 0 AND (COALESCE(capacity_used, 0) + COALESCE(v_capacity_demand, 0) > capacity_limit) THEN
    is_available := FALSE;
    reason := 'capacity_exceeded';
  ELSE
    is_available := TRUE;
    reason := NULL;
  END IF;

  debug := jsonb_strip_nulls(jsonb_build_object(
    'status', 'computed',
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'sender_id', v_sender_id,
    'branch_id', v_branch_id,
    'zone_id', v_zone_id,
    'city_id', v_city_id,
    'service_type', v_service_type,
    'service_level', v_service_level,
    'service_level_id', v_service_level_id,
    'window_start_local', v_window_start_text,
    'window_end_local', v_window_end_text,
    'calendar_enabled', CASE WHEN v_calendar_enabled THEN TRUE ELSE NULL END,
    'capacity_enabled', CASE WHEN v_capacity_enabled THEN TRUE ELSE NULL END,
    'capacity_behavior', CASE WHEN v_capacity_enabled THEN v_capacity_behavior ELSE NULL END,
    'capacity_limit_key', CASE WHEN v_capacity_enabled THEN v_capacity_limit_key ELSE NULL END,
    'capacity_demand', CASE WHEN v_capacity_enabled THEN v_capacity_demand ELSE NULL END,
    'capacity_window_start_local', v_cap_window_start,
    'capacity_window_end_local', v_cap_window_end,
    'policy_settings_id', CASE WHEN v_has_policy_row THEN v_policy_row.settings_id ELSE NULL END,
    'policy_settings_version_id', CASE WHEN v_has_policy_row THEN v_policy_row.settings_version_id ELSE NULL END,
    'policy_scope_type', CASE WHEN v_has_policy_row THEN v_policy_row.scope_type ELSE NULL END,
    'policy_scope_id', CASE WHEN v_has_policy_row THEN v_policy_row.scope_id ELSE NULL END,
    'policy_version', CASE WHEN v_has_policy_row THEN v_policy_row.version ELSE NULL END,
    'policy_scope_path', CASE WHEN v_has_policy_row THEN v_policy_row.scope_path ELSE NULL END
  ));

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_delivery_slot_v1(JSONB) IS
  'Compute a single delivery slot availability for a shipment using ladder-resolved shipment_promise_policy plus calendar_events and branch_capacity_windows (row-driven).';

REVOKE ALL ON FUNCTION public.compute_delivery_slot_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_delivery_slot_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.compute_delivery_slot_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compute_delivery_slot_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Slot listing: offer slots over a date range (pure compute)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_delivery_slots_v1(
  p_input JSONB
)
RETURNS TABLE (
  slot_date DATE,
  window_start_local TEXT,
  window_end_local TEXT,
  slot_start_at TIMESTAMPTZ,
  slot_end_at TIMESTAMPTZ,
  timezone TEXT,
  is_available BOOLEAN,
  reason TEXT,
  is_blackout BOOLEAN,
  calendar_event_id UUID,
  capacity_window_id UUID,
  capacity_limit NUMERIC,
  capacity_used NUMERIC,
  capacity_remaining NUMERIC,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
  v_client_id UUID;
  v_webhook_source_id UUID;
  v_include_unavailable BOOLEAN := TRUE;

  v_org_id UUID;
  v_sender_id UUID;
  v_zone_id UUID;
  v_branch_id UUID;
  v_service_level TEXT;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;

  v_branch_tz TEXT := NULL;
  v_tz TEXT := 'UTC';

  v_policy_window_start_text TEXT := NULL;
  v_policy_window_end_text TEXT := NULL;
  v_policy_window_start TIME := NULL;
  v_policy_window_end TIME := NULL;

  v_start_date DATE := NULL;
  v_days INT := NULL;
  v_calendar_max_shift_days INT := NULL;
  v_capacity_max_shift_days INT := NULL;

  v_service_level_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'list_delivery_slots_v1: input must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_webhook_source_id := NULLIF(v_input->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_webhook_source_id := NULL; END;
  BEGIN v_start_date := NULLIF(v_input->>'start_date', '')::DATE; EXCEPTION WHEN others THEN v_start_date := NULL; END;
  BEGIN v_days := NULLIF(v_input->>'days', '')::INT; EXCEPTION WHEN others THEN v_days := NULL; END;
  BEGIN v_include_unavailable := COALESCE((v_input->>'include_unavailable')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_include_unavailable := TRUE; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL THEN
    RAISE EXCEPTION 'list_delivery_slots_v1: shipment_id and client_id are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    s.organization_id,
    s.sender_id,
    s.zone_id,
    COALESCE(s.branch_id, public.resolve_branch_id_for_zone(s.zone_id)) AS derived_branch_id,
    s.service_level
  INTO v_org_id, v_sender_id, v_zone_id, v_branch_id, v_service_level
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'list_delivery_slots_v1: shipment not found (shipment_id %, client_id %)', v_shipment_id, v_client_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_branch_id IS NULL THEN
    RETURN;
  END IF;

  -- Resolve policy once (for default horizon + fallback window times).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_shipment_promise_policy(v_policy_ctx)
   LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  -- Timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  v_branch_tz := NULL;
  BEGIN
    IF COALESCE((v_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone INTO v_branch_tz FROM public.branches b WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_branch_tz := NULL;
  END;

  v_tz := COALESCE(NULLIF(v_branch_tz, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');

  v_policy_window_start_text := NULLIF(v_policy->>'delivery_window_start', '');
  v_policy_window_end_text := NULLIF(v_policy->>'delivery_window_end', '');

  BEGIN v_policy_window_start := CASE WHEN v_policy_window_start_text IS NULL THEN NULL ELSE v_policy_window_start_text::time END; EXCEPTION WHEN others THEN v_policy_window_start := NULL; END;
  BEGIN v_policy_window_end := CASE WHEN v_policy_window_end_text IS NULL THEN NULL ELSE v_policy_window_end_text::time END; EXCEPTION WHEN others THEN v_policy_window_end := NULL; END;

  -- Default horizon uses the policy shift limits (row-driven; avoids hardcoded listing horizons).
  BEGIN v_calendar_max_shift_days := COALESCE(NULLIF(v_policy->>'calendar_max_shift_days', '')::INT, 0); EXCEPTION WHEN others THEN v_calendar_max_shift_days := 0; END;
  BEGIN v_capacity_max_shift_days := COALESCE(NULLIF(v_policy->>'capacity_max_shift_days', '')::INT, 0); EXCEPTION WHEN others THEN v_capacity_max_shift_days := 0; END;

  IF v_days IS NULL OR v_days <= 0 THEN
    v_days := GREATEST(COALESCE(v_calendar_max_shift_days, 0), COALESCE(v_capacity_max_shift_days, 0), 0) + 1;
  END IF;

  IF v_start_date IS NULL THEN
    v_start_date := (public.workflow_now() AT TIME ZONE v_tz)::date;
  END IF;

  -- Resolve service_level_id for capacity window matching in candidate slot generation.
  IF v_org_id IS NOT NULL AND v_service_level IS NOT NULL THEN
    SELECT sl.id
      INTO v_service_level_id
      FROM public.service_levels sl
     WHERE sl.organization_id = v_org_id
       AND sl.key = lower(v_service_level)
     LIMIT 1;
  END IF;

  RETURN QUERY
  WITH dates AS (
    SELECT (v_start_date + gs)::date AS slot_date
    FROM generate_series(0, v_days - 1) AS gs
  ),
  raw_windows AS (
    SELECT
      d.slot_date,
      bcw.window_start_local,
      bcw.window_end_local,
      bcw.priority,
      bcw.zone_id,
      bcw.service_level_id,
      bcw.day_of_week,
      bcw.effective_from,
      bcw.created_at
    FROM dates d
    JOIN public.branch_capacity_windows bcw
      ON bcw.branch_id = v_branch_id
     AND bcw.is_active IS TRUE
     AND bcw.window_start_local IS NOT NULL
     AND bcw.window_end_local IS NOT NULL
     AND bcw.effective_from <= ((d.slot_date::timestamp + bcw.window_start_local) AT TIME ZONE v_tz)
     AND (bcw.effective_to IS NULL OR bcw.effective_to > ((d.slot_date::timestamp + bcw.window_start_local) AT TIME ZONE v_tz))
     AND (bcw.zone_id IS NULL OR (v_zone_id IS NOT NULL AND bcw.zone_id = v_zone_id))
     AND (bcw.service_level_id IS NULL OR (v_service_level_id IS NOT NULL AND bcw.service_level_id = v_service_level_id))
     AND (bcw.day_of_week IS NULL OR bcw.day_of_week = EXTRACT(DOW FROM d.slot_date)::INT)
  ),
  best_windows AS (
    SELECT DISTINCT ON (rw.slot_date, rw.window_start_local, rw.window_end_local)
      rw.slot_date,
      rw.window_start_local,
      rw.window_end_local
    FROM raw_windows rw
    ORDER BY
      rw.slot_date,
      rw.window_start_local,
      rw.window_end_local,
      rw.priority DESC,
      (rw.zone_id IS NOT NULL) DESC,
      (rw.service_level_id IS NOT NULL) DESC,
      (rw.day_of_week IS NOT NULL) DESC,
      (rw.window_start_local IS NOT NULL) DESC,
      rw.effective_from DESC,
      rw.created_at DESC
  ),
  fallback_windows AS (
    SELECT
      d.slot_date,
      v_policy_window_start AS window_start_local,
      v_policy_window_end AS window_end_local
    FROM dates d
    WHERE NOT EXISTS (
      SELECT 1 FROM best_windows bw WHERE bw.slot_date = d.slot_date
    )
  ),
  slot_inputs AS (
    SELECT bw.slot_date, bw.window_start_local, bw.window_end_local
    FROM best_windows bw
    UNION ALL
    SELECT fw.slot_date, fw.window_start_local, fw.window_end_local
    FROM fallback_windows fw
    WHERE fw.window_start_local IS NOT NULL AND fw.window_end_local IS NOT NULL
  ),
  computed AS (
    SELECT
      si.slot_date,
      si.window_start_local,
      si.window_end_local,
      r.slot_start_at,
      r.slot_end_at,
      r.timezone,
      r.is_available,
      r.reason,
      r.is_blackout,
      r.calendar_event_id,
      r.capacity_window_id,
      r.capacity_limit,
      r.capacity_used,
      r.capacity_remaining,
      r.debug
    FROM slot_inputs si
    JOIN LATERAL public.compute_delivery_slot_v1(jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'webhook_source_id', v_webhook_source_id,
      'slot_date', si.slot_date,
      'window_start_local', si.window_start_local::text,
      'window_end_local', si.window_end_local::text
    ))) r ON TRUE
  )
  SELECT
    c.slot_date,
    c.window_start_local::text,
    c.window_end_local::text,
    c.slot_start_at,
    c.slot_end_at,
    c.timezone,
    c.is_available,
    c.reason,
    c.is_blackout,
    c.calendar_event_id,
    c.capacity_window_id,
    c.capacity_limit,
    c.capacity_used,
    c.capacity_remaining,
    c.debug
  FROM computed c
  WHERE v_include_unavailable IS TRUE OR c.is_available IS TRUE
  ORDER BY c.slot_start_at ASC;
END;
$function$;

COMMENT ON FUNCTION public.list_delivery_slots_v1(JSONB) IS
  'List delivery slots (pure compute) for a shipment over a date range using row-driven inputs (shipment_promise_policy + branch_capacity_windows + calendar_events).';

REVOKE ALL ON FUNCTION public.list_delivery_slots_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_delivery_slots_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.list_delivery_slots_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.list_delivery_slots_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 4) Slot reservation: capacity-aware, idempotent (no slot ledger table)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_delivery_slot_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID;
  v_client_id UUID;
  v_slot_date DATE;
  v_branch_id UUID;

  v_performed_by_system TEXT := NULL;
  v_slot RECORD;

  v_settings_resolution_id UUID := NULL;
  v_policy_settings_id UUID := NULL;
  v_policy_settings_version_id UUID := NULL;
  v_policy_scope_type TEXT := NULL;
  v_policy_scope_id UUID := NULL;
  v_policy_version INT := NULL;
  v_policy_scope_path JSONB := NULL;

  v_apply RECORD;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1: input must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_slot_date := NULLIF(v_input->>'slot_date', '')::DATE; EXCEPTION WHEN others THEN v_slot_date := NULL; END;
  v_performed_by_system := NULLIF(v_input->>'performed_by_system', '');

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_slot_date IS NULL THEN
    RAISE EXCEPTION 'reserve_delivery_slot_v1: shipment_id, client_id, slot_date are required'
      USING ERRCODE = '22023';
  END IF;

  -- Determine branch_id for lock scope (shipment.branch_id or derived from zone).
  SELECT COALESCE(s.branch_id, public.resolve_branch_id_for_zone(s.zone_id))
    INTO v_branch_id
    FROM public.shipments s
   WHERE s.id = v_shipment_id
     AND s.client_id = v_client_id
   LIMIT 1;

  IF v_branch_id IS NULL THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'reserved', FALSE,
      'reason', 'branch_unmapped',
      'shipment_id', v_shipment_id,
      'client_id', v_client_id
    ));
  END IF;

  -- Serialize reservations per (branch_id, slot_date) to avoid overselling capacity.
  PERFORM pg_advisory_xact_lock(hashtext('slot_reserve:' || v_branch_id::text || ':' || v_slot_date::text));

  -- Recompute availability inside the lock (authoritative decision).
  SELECT *
    INTO v_slot
    FROM public.compute_delivery_slot_v1(v_input)
   LIMIT 1;

  IF v_slot.is_available IS DISTINCT FROM TRUE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'reserved', FALSE,
      'reason', COALESCE(v_slot.reason, 'unavailable'),
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'slot', to_jsonb(v_slot)
    ));
  END IF;

  -- Extract policy provenance for logging when available.
  BEGIN v_policy_settings_id := NULLIF(v_slot.debug->>'policy_settings_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_settings_id := NULL; END;
  BEGIN v_policy_settings_version_id := NULLIF(v_slot.debug->>'policy_settings_version_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_settings_version_id := NULL; END;
  v_policy_scope_type := NULLIF(v_slot.debug->>'policy_scope_type', '');
  BEGIN v_policy_scope_id := NULLIF(v_slot.debug->>'policy_scope_id', '')::UUID; EXCEPTION WHEN others THEN v_policy_scope_id := NULL; END;
  BEGIN v_policy_version := NULLIF(v_slot.debug->>'policy_version', '')::INT; EXCEPTION WHEN others THEN v_policy_version := NULL; END;
  v_policy_scope_path := v_slot.debug->'policy_scope_path';

  IF v_policy_settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := NULLIF(v_slot.debug->>'organization_id', '')::UUID,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_policy_scope_type, 'global'),
      p_winning_scope_id := v_policy_scope_id,
      p_winning_settings_id := v_policy_settings_id,
      p_winning_settings_version_id := v_policy_settings_version_id,
      p_winning_version := COALESCE(v_policy_version, 1),
      p_scope_path := COALESCE(v_policy_scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_shipment_id,
        'shipment_client_id', v_client_id,
        'slot_date', v_slot.slot_date,
        'slot_start_at', v_slot.slot_start_at,
        'slot_end_at', v_slot.slot_end_at,
        'slot_debug', v_slot.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Persist chosen slot as the shipment promise (force date overwrite).
  SELECT *
    INTO v_apply
    FROM public.apply_shipment_promise_v1(
      p_shipment_id := v_shipment_id,
      p_client_id := v_client_id,
      p_branch_id := NULLIF(v_slot.debug->>'branch_id', '')::UUID,
      p_promised_delivery_date := v_slot.slot_date,
      p_promised_delivery_at := v_slot.slot_end_at,
      p_promised_window_start_at := v_slot.slot_start_at,
      p_promised_window_end_at := v_slot.slot_end_at,
      p_promise_computed_at := public.workflow_now(),
      p_promise_settings_resolution_id := v_settings_resolution_id,
      p_set_promised_delivery_date_mode := 'force',
      p_action_type := 'delivery_slot_reserved',
      p_action_category := 'operational',
      p_action_data := jsonb_strip_nulls(jsonb_build_object(
        'slot_date', v_slot.slot_date,
        'slot_start_at', v_slot.slot_start_at,
        'slot_end_at', v_slot.slot_end_at,
        'capacity_window_id', v_slot.capacity_window_id,
        'settings_resolution_id', v_settings_resolution_id
      )),
      p_performed_by_system := COALESCE(v_performed_by_system, 'workflow_engine')
    )
   LIMIT 1;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'reserved', TRUE,
    'updated', COALESCE(v_apply.updated, FALSE),
    'reason', CASE WHEN COALESCE(v_apply.updated, FALSE) THEN NULL ELSE 'no_change' END,
    'shipment_id', v_shipment_id,
    'client_id', v_client_id,
    'action_id', v_apply.action_id,
    'settings_resolution_id', v_settings_resolution_id,
    'slot', to_jsonb(v_slot)
  ));
END;
$function$;

COMMENT ON FUNCTION public.reserve_delivery_slot_v1(JSONB) IS
  'Reserve a delivery slot for a shipment (capacity-aware, idempotent) by writing the chosen promise window to shipments and emitting shipment_actions.delivery_slot_reserved. Service-only RPC.';

REVOKE ALL ON FUNCTION public.reserve_delivery_slot_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_delivery_slot_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_delivery_slot_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_delivery_slot_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 5) Refactor promise_assign handler to use shared helper (avoid duplicated logic)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_promise_assign_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy_ctx JSONB := '{}'::jsonb;
  v_webhook_id UUID;
  v_webhook_source_id UUID;
  v_policy_row RECORD;
  v_has_policy_row BOOLEAN := FALSE;
  v_policy JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_zone_id UUID;
  v_city_id UUID := NULL;
  v_branch_id UUID;
  v_branch_tz TEXT;
  v_ship_service_level TEXT;
  v_ship_service_type TEXT;
  v_existing_promised_date DATE;
  v_promise RECORD;
  v_settings_resolution_id UUID := NULL;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_apply RECORD;
  v_response public.workflow_handler_response;
  v_reason TEXT := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL OR v_ctx.client_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  -- Best-effort: include webhook_source_id (top of ladder) when available.
  v_webhook_id := NULL;
  BEGIN
    v_webhook_id := NULLIF(v_context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.webhook_source_id
      INTO v_webhook_source_id
      FROM public.webhook_inbox wi
     WHERE wi.id = v_webhook_id;
  END IF;

  -- Load shipment fields needed for zone/branch + promise.
  SELECT s.zone_id, s.service_level, s.service_type, s.promised_delivery_date
    INTO v_zone_id, v_ship_service_level, v_ship_service_type, v_existing_promised_date
    FROM public.shipments s
   WHERE s.id = v_ctx.shipment_id
     AND s.client_id = v_ctx.client_id
   LIMIT 1;

  IF NOT FOUND THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  IF v_zone_id IS NULL THEN
    v_reason := 'zone_missing';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  v_branch_id := public.resolve_branch_id_for_zone(v_zone_id);

  IF v_branch_id IS NULL THEN
    v_reason := 'branch_unmapped';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id
    ));
    RETURN v_response;
  END IF;

  -- Best-effort: derive city_id for richer matching (zone_districts -> canonical_districts).
  BEGIN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = v_zone_id
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_city_id := NULL;
  END;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_shipment_promise_policy(v_policy_ctx)
   LIMIT 1;

  v_has_policy_row := FOUND;
  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_enabled := TRUE; END;
  IF NOT v_enabled THEN
    v_reason := 'policy_disabled';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  -- Determine timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  v_branch_tz := NULL;
  BEGIN
    IF COALESCE((v_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone INTO v_branch_tz FROM public.branches b WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_branch_tz := NULL;
  END;

  v_branch_tz := COALESCE(NULLIF(v_branch_tz, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');

  SELECT *
    INTO v_promise
    FROM public.compute_shipment_promise_v2(
      p_now := v_now,
      p_timezone := v_branch_tz,
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_ctx.organization_id,
        'branch_id', v_branch_id,
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'service_type', v_ship_service_type,
        'service_level', v_ship_service_level
      )),
      p_policy := v_policy,
      p_promised_delivery_date := v_existing_promised_date
    )
   LIMIT 1;

  IF v_promise.promised_delivery_date IS NULL THEN
    v_reason := 'promise_uncomputable';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'settings_policy', v_policy
    ));
    RETURN v_response;
  END IF;

  -- Record settings provenance when available.
  IF v_has_policy_row AND v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_policy_row.scope_type, 'global'),
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'workflow_run_id', p_step.workflow_run_id,
        'workflow_step_id', p_step.id,
        'shipment_id', v_ctx.shipment_id,
        'shipment_client_id', v_ctx.client_id,
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'branch_id', v_branch_id,
        'policy_context', v_policy_ctx,
        'promise_debug', v_promise.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  SELECT *
    INTO v_apply
    FROM public.apply_shipment_promise_v1(
      p_shipment_id := v_ctx.shipment_id,
      p_client_id := v_ctx.client_id,
      p_branch_id := v_branch_id,
      p_promised_delivery_date := v_promise.promised_delivery_date,
      p_promised_delivery_at := v_promise.promised_delivery_at,
      p_promised_window_start_at := v_promise.promised_window_start_at,
      p_promised_window_end_at := v_promise.promised_window_end_at,
      p_promise_computed_at := v_now,
      p_promise_settings_resolution_id := v_settings_resolution_id,
      p_set_promised_delivery_date_mode := 'set_if_null',
      p_action_type := 'promise_assigned',
      p_action_category := 'operational',
      p_action_data := jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'city_id', v_city_id,
        'branch_id', v_branch_id,
        'promised_delivery_date', v_promise.promised_delivery_date,
        'promised_delivery_at', v_promise.promised_delivery_at,
        'promised_window_start_at', v_promise.promised_window_start_at,
        'promised_window_end_at', v_promise.promised_window_end_at,
        'settings_resolution_id', v_settings_resolution_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      p_performed_by_system := 'workflow_engine'
    )
   LIMIT 1;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', COALESCE(v_apply.updated, FALSE),
    'reason', CASE WHEN COALESCE(v_apply.updated, FALSE) THEN NULL ELSE 'no_change' END,
    'zone_id', v_zone_id,
    'city_id', v_city_id,
    'branch_id', v_branch_id,
    'promised_delivery_date', v_promise.promised_delivery_date,
    'promised_delivery_at', v_promise.promised_delivery_at,
    'promised_window_start_at', v_promise.promised_window_start_at,
    'promised_window_end_at', v_promise.promised_window_end_at,
    'settings_resolution_id', v_settings_resolution_id,
    'debug', v_promise.debug
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'shipment', jsonb_build_object(
      'branch_id', v_branch_id,
      'promised_delivery_date', v_promise.promised_delivery_date,
      'promised_delivery_at', v_promise.promised_delivery_at,
      'promised_window_start_at', v_promise.promised_window_start_at,
      'promised_window_end_at', v_promise.promised_window_end_at
    )
  ));

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_promise_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Compute and persist shipment promise fields (branch-aware) using shipment_promise_policy resolved via ladder (compute_shipment_promise_v2 for rule-aware cutoffs + optional blackout/capacity shifting). Uses apply_shipment_promise_v1 for idempotent persistence and shipment_actions emission.';

SELECT pg_advisory_unlock(hashtext('202601292215_delivery_slots_v1'));
COMMIT;
