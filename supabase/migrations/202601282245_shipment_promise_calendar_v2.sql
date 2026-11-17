-- Migration: Shipment promise policy schema v2 (rules + calendar) + compute v2 hardening
-- Date: 2026-01-28
--
-- Goals:
--   - Add shipment_promise_policy schema_registry v2 including rule match + calendar blackout controls.
--   - Enhance compute_shipment_promise_v2 to optionally skip blackout dates using calendar_events (row-driven).
--   - Pass organization/branch/zone/city context from canonical handlers (promise_assign + quote_and_promise).
--
-- Notes:
--   - Calendar behavior is disabled by default in the seeded global policy to preserve baseline behavior.
--   - No tenant-specific logic; everything is configuration-driven.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601282245_shipment_promise_calendar_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Filled in follow-up patches (split to avoid Windows patch size/path limits).

-------------------------------------------------------------------------------
-- 1) Schema contract v2 (additive; v1 remains active)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'shipment_promise_policy',
  2,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Shipment Promise Policy (v2)",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "timezone": { "type": ["string", "null"] },
      "use_branch_timezone": { "type": ["boolean", "null"] },
      "cutoff_time": { "type": ["string", "null"] },
      "default_service_level": { "type": ["string", "null"] },
      "default_transit_days": { "type": ["integer", "null"], "minimum": 0 },
      "service_level_transit_days": {
        "type": ["object", "null"],
        "additionalProperties": { "type": "integer", "minimum": 0 }
      },
      "delivery_window_start": { "type": ["string", "null"] },
      "delivery_window_end": { "type": ["string", "null"] },

      "rules": {
        "type": ["array", "null"],
        "items": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "priority": { "type": ["integer", "null"] },
            "is_active": { "type": ["boolean", "null"] },
            "match": {
              "type": ["object", "null"],
              "additionalProperties": true,
              "properties": {
                "zone_id": { "type": ["string", "null"] },
                "city_id": { "type": ["string", "null"] },
                "service_level": { "type": ["string", "null"] },
                "service_type": { "type": ["string", "null"] },
                "day_of_week": { "type": ["integer", "null"], "minimum": 0, "maximum": 6 }
              }
            },
            "cutoff_time": { "type": ["string", "null"] },
            "transit_days": { "type": ["integer", "null"], "minimum": 0 },
            "delivery_window_start": { "type": ["string", "null"] },
            "delivery_window_end": { "type": ["string", "null"] }
          }
        }
      },

      "calendar_enabled": { "type": ["boolean", "null"] },
      "calendar_blackout_event_types": {
        "type": ["array", "null"],
        "items": { "type": "string" }
      },
      "calendar_max_shift_days": { "type": ["integer", "null"], "minimum": 0 }
    }
  }'::jsonb,
  'Policy-driven shipment promise computation (cutoffs, transit days, windows) with optional rule overrides and optional blackout date shifting via calendar_events.',
  '[
    {
      "version": 2,
      "enabled": true,
      "timezone": "UTC",
      "use_branch_timezone": true,
      "cutoff_time": "16:00",
      "default_service_level": "standard",
      "default_transit_days": 2,
      "service_level_transit_days": { "economy": 3, "standard": 2, "premium": 1, "express": 0 },
      "delivery_window_start": "09:00",
      "delivery_window_end": "18:00",
      "rules": [
        {
          "priority": 100,
          "is_active": true,
          "match": { "city_id": "<uuid>", "service_level": "standard", "service_type": "delivery", "day_of_week": 4 },
          "cutoff_time": "12:00",
          "transit_days": 1,
          "delivery_window_start": "10:00",
          "delivery_window_end": "20:00"
        }
      ],
      "calendar_enabled": false,
      "calendar_blackout_event_types": ["holiday", "closure"],
      "calendar_max_shift_days": 14
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version)
DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-------------------------------------------------------------------------------
-- 2) Seed global defaults v2 (calendar disabled by default)
-------------------------------------------------------------------------------

WITH body AS (
  SELECT jsonb_build_object(
    'version', 2,
    'enabled', true,
    'timezone', 'UTC',
    'use_branch_timezone', true,
    'cutoff_time', '16:00',
    'default_service_level', 'standard',
    'default_transit_days', 2,
    'service_level_transit_days', jsonb_build_object(
      'economy', 3,
      'standard', 2,
      'premium', 1,
      'express', 0
    ),
    'delivery_window_start', '09:00',
    'delivery_window_end', '18:00',
    'rules', '[]'::jsonb,
    'calendar_enabled', false,
    'calendar_blackout_event_types', jsonb_build_array('holiday', 'closure'),
    'calendar_max_shift_days', 14
  ) AS value
),
close_current AS (
  UPDATE public.settings_versions sv
  SET effective_until = now()
  WHERE sv.category = 'shipment_promise_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
  RETURNING sv.version
),
ins AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at, effective_from)
  SELECT
    'shipment_promise_policy',
    'global',
    NULL,
    COALESCE((SELECT max(version) FROM close_current), 1) + 1,
    (SELECT value FROM body),
    2,
    now(),
    now()
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated)
SELECT
  'shipment_promise_policy',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  (SELECT id FROM ins),
  (SELECT value FROM ins),
  now()
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-------------------------------------------------------------------------------
-- 3) Promise compute helper v2: add city match + optional calendar blackout shift
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_shipment_promise_v2(
  p_now TIMESTAMPTZ,
  p_timezone TEXT,
  p_context JSONB,
  p_policy JSONB,
  p_promised_delivery_date DATE DEFAULT NULL
)
RETURNS TABLE (
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  promised_delivery_at TIMESTAMPTZ,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);

  v_tz TEXT := COALESCE(NULLIF(p_timezone, ''), NULLIF(v_policy->>'timezone', ''), 'UTC');
  v_service_level TEXT := COALESCE(NULLIF(v_ctx->>'service_level', ''), NULLIF(v_policy->>'default_service_level', ''));
  v_service_type TEXT := NULLIF(v_ctx->>'service_type', '');

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_zone_id UUID := NULL;
  v_city_id UUID := NULL;

  v_rules JSONB := COALESCE(v_policy->'rules', '[]'::jsonb);
  v_rule RECORD;
  v_match JSONB;
  v_best_rule JSONB := NULL;
  v_best_idx INT := NULL;
  v_best_priority INT := -1;

  v_local_now TIMESTAMP;
  v_day_of_week INT;
  v_after_cutoff BOOLEAN := FALSE;

  v_cutoff_text TEXT := NULLIF(v_policy->>'cutoff_time', '');
  v_window_start_text TEXT := NULLIF(v_policy->>'delivery_window_start', '');
  v_window_end_text TEXT := NULLIF(v_policy->>'delivery_window_end', '');

  v_default_transit_days INT := NULL;
  v_transit_days INT := NULL;

  v_calendar_enabled BOOLEAN := FALSE;
  v_calendar_max_shift_days INT := 0;
  v_calendar_shift_days INT := 0;
  v_calendar_types TEXT[] := ARRAY[]::TEXT[];
  v_calendar_event_ids JSONB := '[]'::jsonb;
  v_calendar_event_id UUID := NULL;

  v_effective_policy JSONB := v_policy;
  v_effective_promised_date DATE := NULL;
  v_res RECORD;
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;

  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
    v_effective_policy := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  IF COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE) IS NOT TRUE THEN
    promised_delivery_date := p_promised_delivery_date;
    promised_window_start_at := NULL;
    promised_window_end_at := NULL;
    promised_delivery_at := NULL;
    debug := jsonb_build_object('status', 'disabled');
    RETURN NEXT;
    RETURN;
  END IF;

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_ctx->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_zone_id := NULLIF(v_ctx->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;
  BEGIN v_city_id := NULLIF(v_ctx->>'city_id', '')::UUID; EXCEPTION WHEN others THEN v_city_id := NULL; END;

  -- Best-effort: derive city_id from zone when missing (zone_districts -> canonical_districts).
  IF v_city_id IS NULL AND v_zone_id IS NOT NULL THEN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = v_zone_id
     LIMIT 1;
  END IF;

  v_local_now := p_now AT TIME ZONE v_tz;
  v_day_of_week := EXTRACT(DOW FROM v_local_now)::INT;

  -- Base transit days (from policy) when we need to compute the promised date.
  BEGIN
    v_default_transit_days := NULLIF(v_policy->>'default_transit_days', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_default_transit_days := NULL;
  END;

  BEGIN
    v_transit_days := NULLIF((v_policy->'service_level_transit_days'->>v_service_level), '')::INT;
  EXCEPTION
    WHEN others THEN
      v_transit_days := NULL;
  END;

  v_transit_days := COALESCE(v_transit_days, v_default_transit_days);

  -- Apply best matching override rule (optional; forward compatible).
  IF jsonb_typeof(v_rules) <> 'array' THEN
    v_rules := '[]'::jsonb;
  END IF;

  FOR v_rule IN
    SELECT value AS rule, ordinality AS idx
    FROM jsonb_array_elements(v_rules) WITH ORDINALITY
  LOOP
    DECLARE
      v_priority INT := 0;
      v_active BOOLEAN := TRUE;
      v_match_ok BOOLEAN := TRUE;
      v_match_zone TEXT := NULL;
      v_match_city TEXT := NULL;
      v_match_level TEXT := NULL;
      v_match_type TEXT := NULL;
      v_match_dow INT := NULL;
    BEGIN
      BEGIN v_priority := COALESCE(NULLIF((v_rule.rule->>'priority'), '')::INT, 0); EXCEPTION WHEN others THEN v_priority := 0; END;
      BEGIN v_active := COALESCE((v_rule.rule->>'is_active')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_active := TRUE; END;
      IF v_active IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_match := COALESCE(v_rule.rule->'match', '{}'::jsonb);
      IF jsonb_typeof(v_match) <> 'object' THEN
        v_match := '{}'::jsonb;
      END IF;

      v_match_level := NULLIF(v_match->>'service_level', '');
      IF v_match_level IS NOT NULL AND v_match_level IS DISTINCT FROM v_service_level THEN
        v_match_ok := FALSE;
      END IF;

      v_match_type := NULLIF(v_match->>'service_type', '');
      IF v_match_type IS NOT NULL AND v_service_type IS NOT NULL AND v_match_type IS DISTINCT FROM v_service_type THEN
        v_match_ok := FALSE;
      END IF;

      v_match_zone := NULLIF(v_match->>'zone_id', '');
      IF v_match_zone IS NOT NULL THEN
        IF v_zone_id IS NULL OR v_match_zone IS DISTINCT FROM v_zone_id::text THEN
          v_match_ok := FALSE;
        END IF;
      END IF;

      v_match_city := NULLIF(v_match->>'city_id', '');
      IF v_match_city IS NOT NULL THEN
        IF v_city_id IS NULL OR v_match_city IS DISTINCT FROM v_city_id::text THEN
          v_match_ok := FALSE;
        END IF;
      END IF;

      BEGIN v_match_dow := NULLIF(v_match->>'day_of_week', '')::INT; EXCEPTION WHEN others THEN v_match_dow := NULL; END;
      IF v_match_dow IS NOT NULL AND v_match_dow IS DISTINCT FROM v_day_of_week THEN
        v_match_ok := FALSE;
      END IF;

      IF v_match_ok IS NOT TRUE THEN
        CONTINUE;
      END IF;

      IF v_priority > v_best_priority THEN
        v_best_rule := v_rule.rule;
        v_best_idx := v_rule.idx;
        v_best_priority := v_priority;
      END IF;
    END;
  END LOOP;

  IF v_best_rule IS NOT NULL THEN
    -- Rule-level overrides (optional keys).
    IF NULLIF(v_best_rule->>'cutoff_time', '') IS NOT NULL THEN
      v_cutoff_text := NULLIF(v_best_rule->>'cutoff_time', '');
    END IF;
    IF NULLIF(v_best_rule->>'delivery_window_start', '') IS NOT NULL THEN
      v_window_start_text := NULLIF(v_best_rule->>'delivery_window_start', '');
    END IF;
    IF NULLIF(v_best_rule->>'delivery_window_end', '') IS NOT NULL THEN
      v_window_end_text := NULLIF(v_best_rule->>'delivery_window_end', '');
    END IF;

    BEGIN
      v_transit_days := COALESCE(NULLIF(v_best_rule->>'transit_days', '')::INT, v_transit_days);
    EXCEPTION
      WHEN others THEN
        v_transit_days := v_transit_days;
    END;
  END IF;

  -- Build the effective policy (so downstream debug shows effective values).
  v_effective_policy := v_policy;
  IF v_cutoff_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{cutoff_time}', to_jsonb(v_cutoff_text), TRUE);
  END IF;
  IF v_window_start_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{delivery_window_start}', to_jsonb(v_window_start_text), TRUE);
  END IF;
  IF v_window_end_text IS NOT NULL THEN
    v_effective_policy := jsonb_set(v_effective_policy, '{delivery_window_end}', to_jsonb(v_window_end_text), TRUE);
  END IF;

  -- Determine promised date.
  IF p_promised_delivery_date IS NOT NULL THEN
    v_effective_promised_date := p_promised_delivery_date;
  ELSE
    IF v_transit_days IS NULL THEN
      v_effective_promised_date := NULL;
    ELSE
      DECLARE
        v_cutoff TIME := NULL;
        v_base_date DATE := v_local_now::date;
      BEGIN
        BEGIN v_cutoff := CASE WHEN v_cutoff_text IS NULL THEN NULL ELSE v_cutoff_text::time END; EXCEPTION WHEN others THEN v_cutoff := NULL; END;
        IF v_cutoff IS NOT NULL AND (v_local_now::time >= v_cutoff) THEN
          v_base_date := v_base_date + 1;
          v_after_cutoff := TRUE;
        END IF;
        v_effective_promised_date := v_base_date + v_transit_days;
      END;
    END IF;
  END IF;

  -- Optional: calendar blackout shifting (row-driven via calendar_events).
  BEGIN v_calendar_enabled := COALESCE((v_policy->>'calendar_enabled')::BOOLEAN, FALSE); EXCEPTION WHEN others THEN v_calendar_enabled := FALSE; END;
  BEGIN v_calendar_max_shift_days := COALESCE(NULLIF(v_policy->>'calendar_max_shift_days', '')::INT, 14); EXCEPTION WHEN others THEN v_calendar_max_shift_days := 14; END;

  IF v_calendar_enabled AND v_effective_promised_date IS NOT NULL AND v_org_id IS NOT NULL THEN
    IF jsonb_typeof(v_policy->'calendar_blackout_event_types') = 'array' THEN
      SELECT COALESCE(array_agg(lower(t)), ARRAY[]::TEXT[])
        INTO v_calendar_types
        FROM (
          SELECT NULLIF(btrim(value), '') AS t
          FROM jsonb_array_elements_text(v_policy->'calendar_blackout_event_types') AS value
        ) x
       WHERE x.t IS NOT NULL;
    END IF;

    IF COALESCE(array_length(v_calendar_types, 1), 0) > 0 THEN
      v_calendar_shift_days := 0;
      v_calendar_event_ids := '[]'::jsonb;

      WHILE v_calendar_shift_days < v_calendar_max_shift_days LOOP
        v_calendar_event_id := NULL;

        SELECT ce.id
          INTO v_calendar_event_id
          FROM public.calendar_events ce
         WHERE ce.organization_id = v_org_id
           AND ce.is_active IS TRUE
           AND ce.event_type = ANY(v_calendar_types)
           AND (ce.branch_id IS NULL OR (v_branch_id IS NOT NULL AND ce.branch_id = v_branch_id))
           AND (ce.zone_id IS NULL OR (v_zone_id IS NOT NULL AND ce.zone_id = v_zone_id))
           AND (ce.city_id IS NULL OR (v_city_id IS NOT NULL AND ce.city_id = v_city_id))
           AND ce.starts_at < ((v_effective_promised_date + 1)::timestamp AT TIME ZONE v_tz)
           AND ce.ends_at > (v_effective_promised_date::timestamp AT TIME ZONE v_tz)
         ORDER BY
           (ce.branch_id IS NOT NULL) DESC,
           (ce.zone_id IS NOT NULL) DESC,
           (ce.city_id IS NOT NULL) DESC,
           ce.starts_at DESC
         LIMIT 1;

        IF v_calendar_event_id IS NULL THEN
          EXIT;
        END IF;

        v_calendar_event_ids := v_calendar_event_ids || jsonb_build_array(v_calendar_event_id);
        v_effective_promised_date := v_effective_promised_date + 1;
        v_calendar_shift_days := v_calendar_shift_days + 1;
      END LOOP;
    END IF;
  END IF;

  SELECT *
    INTO v_res
    FROM public.compute_shipment_promise_v1(
      p_now := p_now,
      p_timezone := v_tz,
      p_service_level := v_service_level,
      p_policy := v_effective_policy,
      p_promised_delivery_date := v_effective_promised_date
    )
   LIMIT 1;

  promised_delivery_date := v_res.promised_delivery_date;
  promised_window_start_at := v_res.promised_window_start_at;
  promised_window_end_at := v_res.promised_window_end_at;
  promised_delivery_at := v_res.promised_delivery_at;

  debug := jsonb_strip_nulls(COALESCE(v_res.debug, '{}'::jsonb) || jsonb_build_object(
    'status', 'computed',
    'rule_index', v_best_idx,
    'rule_priority', NULLIF(v_best_priority, -1),
    'day_of_week', v_day_of_week,
    'after_cutoff', v_after_cutoff,
    'organization_id', v_org_id,
    'branch_id', v_branch_id,
    'zone_id', v_zone_id,
    'city_id', v_city_id,
    'service_type', v_service_type,
    'calendar_enabled', CASE WHEN v_calendar_enabled THEN TRUE ELSE NULL END,
    'calendar_shift_days', CASE WHEN v_calendar_shift_days > 0 THEN v_calendar_shift_days ELSE NULL END,
    'calendar_event_ids', CASE WHEN v_calendar_shift_days > 0 THEN v_calendar_event_ids ELSE NULL END
  ));

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_shipment_promise_v2(TIMESTAMPTZ, TEXT, JSONB, JSONB, DATE) IS
  'Compute shipment promise using shipment_promise_policy plus optional rule-driven overrides (match on zone/city/service level/type/day_of_week) and optional blackout shifting via calendar_events. Returns date + window and an explainable debug payload.';

-------------------------------------------------------------------------------
-- 4) promise_assign handler: pass org/branch/zone/city into compute context
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
  v_updated INT := 0;
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

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_enabled := TRUE;
  END;

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

  UPDATE public.shipments s
  SET branch_id = v_branch_id,
      promised_delivery_date = COALESCE(s.promised_delivery_date, v_promise.promised_delivery_date),
      promised_delivery_at = v_promise.promised_delivery_at,
      promised_window_start_at = v_promise.promised_window_start_at,
      promised_window_end_at = v_promise.promised_window_end_at,
      promise_computed_at = v_now,
      promise_settings_resolution_id = v_settings_resolution_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = v_ctx.shipment_id
    AND s.client_id = v_ctx.client_id
    AND (s.promised_delivery_date IS NULL OR s.promised_delivery_date IS DISTINCT FROM v_promise.promised_delivery_date)
  RETURNING 1 INTO v_updated;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', TRUE,
    'updated', COALESCE(v_updated, 0) > 0,
    'branch_id', v_branch_id,
    'promised_delivery_date', v_promise.promised_delivery_date,
    'settings_resolution_id', v_settings_resolution_id,
    'debug', v_promise.debug
  ));

  RETURN v_response;
END;
$function$;

-------------------------------------------------------------------------------
-- 5) quote_and_promise_v1: pass org/branch/zone/city into promise compute context
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.quote_and_promise_v1(
  p_policy_context JSONB,
  p_zone_id UUID,
  p_service_type TEXT,
  p_service_level TEXT,
  p_distance_km NUMERIC DEFAULT NULL,
  p_box_count INT DEFAULT NULL,
  p_cod_amount NUMERIC DEFAULT NULL,
  p_now TIMESTAMPTZ DEFAULT NULL,
  p_promised_delivery_date DATE DEFAULT NULL,
  p_resource_type TEXT DEFAULT 'quote_request',
  p_resource_id UUID DEFAULT NULL,
  p_decision_point TEXT DEFAULT 'quote_and_promise_v1',
  p_decision_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_policy_ctx JSONB := COALESCE(p_policy_context, '{}'::jsonb);
  v_org_id UUID := NULL;

  v_branch_id UUID := NULL;
  v_city_id UUID := NULL;
  v_timezone TEXT := NULL;

  v_promise_row RECORD;
  v_pricing_row RECORD;
  v_cod_row RECORD;
  v_settlement_row RECORD;
  v_has_promise_row BOOLEAN := FALSE;
  v_has_pricing_row BOOLEAN := FALSE;
  v_has_cod_row BOOLEAN := FALSE;
  v_has_settlement_row BOOLEAN := FALSE;

  v_promise_policy JSONB := '{}'::jsonb;
  v_pricing_policy JSONB := '{}'::jsonb;
  v_cod_policy JSONB := '{}'::jsonb;
  v_settlement_policy JSONB := '{}'::jsonb;

  v_promise RECORD;
  v_quote RECORD;

  v_promise_settings_resolution_id UUID := NULL;
  v_pricing_settings_resolution_id UUID := NULL;
  v_cod_settings_resolution_id UUID := NULL;
  v_settlement_settings_resolution_id UUID := NULL;

  v_actor_system TEXT := NULLIF(btrim(COALESCE(current_setting('app.actor_system', true), '')), '');
  v_resource_id UUID := COALESCE(p_resource_id, gen_random_uuid());
  v_outcome TEXT := 'computed';
  v_decision_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_policy_ctx) <> 'object' THEN
    RAISE EXCEPTION 'quote_and_promise_v1 expects policy_context as a JSON object'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_policy_ctx->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'quote_and_promise_v1 missing policy_context.organization_id'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve branch_id (resource scope) for ladder, based on zone coverage.
  v_branch_id := public.resolve_branch_id_for_zone(p_zone_id);

  -- Best-effort: derive city_id for richer matching (zone_districts -> canonical_districts).
  BEGIN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = p_zone_id
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_city_id := NULL;
  END;

  -- Enrich policy context with resource scope when available.
  v_policy_ctx := jsonb_strip_nulls(v_policy_ctx || jsonb_build_object('resource_id', v_branch_id));

  SELECT * INTO v_promise_row FROM public.resolve_shipment_promise_policy(v_policy_ctx) LIMIT 1;
  v_has_promise_row := FOUND;
  IF v_has_promise_row AND v_promise_row.value IS NOT NULL THEN
    v_promise_policy := v_promise_row.value;
  END IF;

  SELECT * INTO v_pricing_row FROM public.resolve_pricing_policy(v_policy_ctx) LIMIT 1;
  v_has_pricing_row := FOUND;
  IF v_has_pricing_row AND v_pricing_row.value IS NOT NULL THEN
    v_pricing_policy := v_pricing_row.value;
  END IF;

  SELECT * INTO v_cod_row FROM public.resolve_cod_policy(v_policy_ctx) LIMIT 1;
  v_has_cod_row := FOUND;
  IF v_has_cod_row AND v_cod_row.value IS NOT NULL THEN
    v_cod_policy := v_cod_row.value;
  END IF;

  SELECT * INTO v_settlement_row FROM public.resolve_settlement_policy(v_policy_ctx) LIMIT 1;
  v_has_settlement_row := FOUND;
  IF v_has_settlement_row AND v_settlement_row.value IS NOT NULL THEN
    v_settlement_policy := v_settlement_row.value;
  END IF;

  -- Determine effective timezone: branch timezone when enabled + present; otherwise policy timezone (or UTC).
  BEGIN
    IF v_branch_id IS NOT NULL AND COALESCE((v_promise_policy->>'use_branch_timezone')::BOOLEAN, TRUE) THEN
      SELECT b.timezone
        INTO v_timezone
        FROM public.branches b
       WHERE b.id = v_branch_id;
    END IF;
  EXCEPTION
    WHEN others THEN
      v_timezone := NULL;
  END;
  v_timezone := COALESCE(NULLIF(v_timezone, ''), NULLIF(v_promise_policy->>'timezone', ''), 'UTC');

  -- Compute (pure) promise + quote.
  SELECT *
    INTO v_promise
    FROM public.compute_shipment_promise_v2(
      p_now := v_now,
      p_timezone := v_timezone,
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'city_id', v_city_id,
        'service_type', NULLIF(p_service_type, ''),
        'service_level', NULLIF(p_service_level, '')
      )),
      p_policy := v_promise_policy,
      p_promised_delivery_date := p_promised_delivery_date
    )
   LIMIT 1;

  SELECT *
    INTO v_quote
    FROM public.compute_pricing_quote_v1(
      p_context := jsonb_strip_nulls(jsonb_build_object(
        'service_type', NULLIF(p_service_type, ''),
        'service_level', NULLIF(p_service_level, ''),
        'zone_id', p_zone_id,
        'distance_km', p_distance_km,
        'box_count', p_box_count,
        'cod_amount', p_cod_amount
      )),
      p_policy := v_pricing_policy
    )
   LIMIT 1;

  IF v_promise.promised_delivery_date IS NULL AND v_quote.total_amount IS NULL THEN
    v_outcome := 'uncomputable';
  ELSIF v_promise.promised_delivery_date IS NULL OR v_quote.total_amount IS NULL THEN
    v_outcome := 'partial';
  END IF;

  -- Record settings provenance (one row per category when available).
  IF v_has_promise_row AND v_promise_row.settings_id IS NOT NULL THEN
    v_promise_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'shipment_promise_policy',
      p_winning_scope_type := COALESCE(v_promise_row.scope_type, 'global'),
      p_winning_scope_id := v_promise_row.scope_id,
      p_winning_settings_id := v_promise_row.settings_id,
      p_winning_settings_version_id := v_promise_row.settings_version_id,
      p_winning_version := COALESCE(v_promise_row.version, 1),
      p_scope_path := COALESCE(v_promise_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'city_id', v_city_id,
        'policy_context', v_policy_ctx,
        'compute_context', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'branch_id', v_branch_id,
          'zone_id', p_zone_id,
          'city_id', v_city_id,
          'service_type', NULLIF(p_service_type, ''),
          'service_level', NULLIF(p_service_level, ''),
          'now', v_now
        )),
        'promise_debug', v_promise.debug
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_pricing_row AND v_pricing_row.settings_id IS NOT NULL THEN
    v_pricing_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'pricing_policy',
      p_winning_scope_type := COALESCE(v_pricing_row.scope_type, 'global'),
      p_winning_scope_id := v_pricing_row.scope_id,
      p_winning_settings_id := v_pricing_row.settings_id,
      p_winning_settings_version_id := v_pricing_row.settings_version_id,
      p_winning_version := COALESCE(v_pricing_row.version, 1),
      p_scope_path := COALESCE(v_pricing_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx,
        'quote_debug', COALESCE(v_quote.debug, '{}'::jsonb)
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_cod_row AND v_cod_row.settings_id IS NOT NULL THEN
    v_cod_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'cod_policy',
      p_winning_scope_type := COALESCE(v_cod_row.scope_type, 'global'),
      p_winning_scope_id := v_cod_row.scope_id,
      p_winning_settings_id := v_cod_row.settings_id,
      p_winning_settings_version_id := v_cod_row.settings_version_id,
      p_winning_version := COALESCE(v_cod_row.version, 1),
      p_scope_path := COALESCE(v_cod_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_settlement_row AND v_settlement_row.settings_id IS NOT NULL THEN
    v_settlement_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := COALESCE(v_settlement_row.scope_type, 'global'),
      p_winning_scope_id := v_settlement_row.scope_id,
      p_winning_settings_id := v_settlement_row.settings_id,
      p_winning_settings_version_id := v_settlement_row.settings_version_id,
      p_winning_version := COALESCE(v_settlement_row.version, 1),
      p_scope_path := COALESCE(v_settlement_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'decision_point', p_decision_point,
        'resource_type', p_resource_type,
        'resource_id', v_resource_id,
        'branch_id', v_branch_id,
        'zone_id', p_zone_id,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Persist decision log (SSOT).
  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_event_source := COALESCE(v_actor_system, 'system'),
    p_event_type := 'quote_and_promise',
    p_resource_type := p_resource_type,
    p_resource_id := v_resource_id,
    p_decision_point := p_decision_point,
    p_decision_reason := p_decision_reason,
    p_outcome := v_outcome,
    p_metadata := jsonb_strip_nulls(jsonb_build_object(
      'zone_id', p_zone_id,
      'branch_id', v_branch_id,
      'city_id', v_city_id,
      'service_type', NULLIF(p_service_type, ''),
      'service_level', NULLIF(p_service_level, ''),
      'distance_km', p_distance_km,
      'box_count', p_box_count,
      'cod_amount', p_cod_amount,
      'promise', jsonb_strip_nulls(jsonb_build_object(
        'promised_delivery_date', v_promise.promised_delivery_date,
        'promised_delivery_at', v_promise.promised_delivery_at,
        'promised_window_start_at', v_promise.promised_window_start_at,
        'promised_window_end_at', v_promise.promised_window_end_at
      )),
      'quote', jsonb_strip_nulls(jsonb_build_object(
        'currency', v_quote.currency,
        'total_amount', v_quote.total_amount,
        'components', v_quote.components
      )),
      'settings_resolution_ids', jsonb_strip_nulls(jsonb_build_object(
        'shipment_promise_policy', v_promise_settings_resolution_id,
        'pricing_policy', v_pricing_settings_resolution_id,
        'cod_policy', v_cod_settings_resolution_id,
        'settlement_policy', v_settlement_settings_resolution_id
      ))
    ))
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', v_outcome,
    'decision_id', v_decision_id,
    'resource_id', v_resource_id,
    'branch_id', v_branch_id,
    'promise', jsonb_strip_nulls(jsonb_build_object(
      'promised_delivery_date', v_promise.promised_delivery_date,
      'promised_delivery_at', v_promise.promised_delivery_at,
      'promised_window_start_at', v_promise.promised_window_start_at,
      'promised_window_end_at', v_promise.promised_window_end_at,
      'debug', v_promise.debug
    )),
    'quote', jsonb_strip_nulls(jsonb_build_object(
      'currency', v_quote.currency,
      'total_amount', v_quote.total_amount,
      'components', v_quote.components,
      'debug', v_quote.debug
    )),
    'settings_resolution_ids', jsonb_strip_nulls(jsonb_build_object(
      'shipment_promise_policy', v_promise_settings_resolution_id,
      'pricing_policy', v_pricing_settings_resolution_id,
      'cod_policy', v_cod_settings_resolution_id,
      'settlement_policy', v_settlement_settings_resolution_id
    ))
  ));
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202601282245_shipment_promise_calendar_v2'));
COMMIT;
