-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S01
-- Migration: Shipment promise capacity shifting (branch_capacity_windows)
-- Date: 2026-01-28
--
-- Goals:
--   - Extend shipment_promise_policy schema_registry to v3 (capacity controls).
--   - Seed global shipment_promise_policy v3 defaults (capacity disabled by default).
--   - Enhance compute_shipment_promise_v2 to optionally shift promised dates when capacity is exceeded.
--   - Keep behavior row-driven; no tenant-specific branches; preserve baseline behavior (capacity off by default).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601282330_promise_capacity_shifting_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Schema contract v3 (additive; v1/v2 remain active)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'shipment_promise_policy',
  3,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Shipment Promise Policy (v3)",
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
      "calendar_max_shift_days": { "type": ["integer", "null"], "minimum": 0 },

      "capacity_enabled": { "type": ["boolean", "null"] },
      "capacity_behavior": { "type": ["string", "null"], "enum": ["shift", "ignore", null] },
      "capacity_usage_mode": { "type": ["string", "null"], "enum": ["shipments_by_promised_date", "ledger", null] },
      "capacity_limit_key": { "type": ["string", "null"] },
      "capacity_demand": { "type": ["number", "null"], "minimum": 0 },
      "capacity_max_shift_days": { "type": ["integer", "null"], "minimum": 0 }
    }
  }'::jsonb,
  'Policy-driven shipment promise computation with optional calendar blackout shifting and optional capacity shifting using branch_capacity_windows.',
  '[
    {
      "version": 3,
      "enabled": true,
      "timezone": "UTC",
      "use_branch_timezone": true,
      "cutoff_time": "16:00",
      "default_service_level": "standard",
      "default_transit_days": 2,
      "service_level_transit_days": { "economy": 3, "standard": 2, "premium": 1, "express": 0 },
      "delivery_window_start": "09:00",
      "delivery_window_end": "18:00",
      "rules": [],
      "calendar_enabled": false,
      "calendar_blackout_event_types": ["holiday", "closure"],
      "calendar_max_shift_days": 14,
      "capacity_enabled": false,
      "capacity_behavior": "shift",
      "capacity_usage_mode": "shipments_by_promised_date",
      "capacity_limit_key": "max_shipments",
      "capacity_demand": 1,
      "capacity_max_shift_days": 14
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
-- 2) Seed global defaults v3 (capacity disabled by default)
-------------------------------------------------------------------------------

WITH body AS (
  SELECT jsonb_build_object(
    'version', 3,
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
    'calendar_max_shift_days', 14,
    'capacity_enabled', false,
    'capacity_behavior', 'shift',
    'capacity_usage_mode', 'shipments_by_promised_date',
    'capacity_limit_key', 'max_shipments',
    'capacity_demand', 1,
    'capacity_max_shift_days', 14
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
    3,
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
-- 3) Index for capacity lookups (shipments by branch + promised date)
-------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_shipments_branch_promised_delivery_date
  ON public.shipments (branch_id, promised_delivery_date)
  WHERE branch_id IS NOT NULL AND promised_delivery_date IS NOT NULL;

-------------------------------------------------------------------------------
-- 4) Promise compute helper v2: add optional capacity shifting
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
  v_shipment_id UUID := NULL;
  v_service_level_id UUID := NULL;

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
  v_calendar_limit_reached BOOLEAN := FALSE;

  v_capacity_enabled BOOLEAN := FALSE;
  v_capacity_behavior TEXT := 'shift';
  v_capacity_usage_mode TEXT := 'shipments_by_promised_date';
  v_capacity_limit_key TEXT := NULL;
  v_capacity_demand NUMERIC := 1;
  v_capacity_max_shift_days INT := 0;
  v_capacity_shift_days INT := 0;
  v_capacity_window_ids JSONB := '[]'::jsonb;
  v_capacity_last_window_id UUID := NULL;
  v_capacity_last_limit NUMERIC := NULL;
  v_capacity_last_used NUMERIC := NULL;
  v_capacity_limit_reached BOOLEAN := FALSE;
  v_capacity_exceeded BOOLEAN := FALSE;

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
  BEGIN v_shipment_id := NULLIF(v_ctx->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;

  -- Best-effort: derive city_id from zone when missing (zone_districts -> canonical_districts).
  IF v_city_id IS NULL AND v_zone_id IS NOT NULL THEN
    SELECT cd.city_id
      INTO v_city_id
      FROM public.zone_districts zd
      JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
     WHERE zd.zone_id = v_zone_id
     LIMIT 1;
  END IF;

  -- Best-effort: resolve service_level_id (for capacity window matching).
  IF v_org_id IS NOT NULL AND v_service_level IS NOT NULL AND btrim(v_service_level) <> '' THEN
    SELECT sl.id
      INTO v_service_level_id
      FROM public.service_levels sl
     WHERE sl.organization_id = v_org_id
       AND sl.is_active IS TRUE
       AND sl.key = lower(btrim(v_service_level))
     ORDER BY sl.id
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

      v_match_level := NULLIF(v_match->>'service_level', '');
      IF v_match_level IS NOT NULL AND v_match_level IS DISTINCT FROM v_service_level THEN
        v_match_ok := FALSE;
      END IF;

      v_match_type := NULLIF(v_match->>'service_type', '');
      IF v_match_type IS NOT NULL AND v_match_type IS DISTINCT FROM v_service_type THEN
        v_match_ok := FALSE;
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

  IF v_calendar_enabled AND v_org_id IS NOT NULL AND jsonb_typeof(v_policy->'calendar_blackout_event_types') = 'array' THEN
    SELECT COALESCE(array_agg(lower(t)), ARRAY[]::TEXT[])
      INTO v_calendar_types
      FROM (
        SELECT NULLIF(btrim(value), '') AS t
        FROM jsonb_array_elements_text(v_policy->'calendar_blackout_event_types') AS value
      ) x
     WHERE x.t IS NOT NULL;
  END IF;

  -- Optional: capacity shifting (row-driven via branch_capacity_windows).
  BEGIN v_capacity_enabled := COALESCE((v_policy->>'capacity_enabled')::BOOLEAN, FALSE); EXCEPTION WHEN others THEN v_capacity_enabled := FALSE; END;
  v_capacity_behavior := lower(NULLIF(v_policy->>'capacity_behavior', ''));
  IF v_capacity_behavior IS NULL OR v_capacity_behavior NOT IN ('shift','ignore') THEN
    v_capacity_behavior := 'shift';
  END IF;
  v_capacity_usage_mode := lower(NULLIF(v_policy->>'capacity_usage_mode', ''));
  IF v_capacity_usage_mode IS NULL OR v_capacity_usage_mode NOT IN ('shipments_by_promised_date','ledger') THEN
    v_capacity_usage_mode := 'shipments_by_promised_date';
  END IF;
  v_capacity_limit_key := NULLIF(v_policy->>'capacity_limit_key', '');
  BEGIN v_capacity_demand := COALESCE(NULLIF(v_policy->>'capacity_demand', '')::NUMERIC, 1); EXCEPTION WHEN others THEN v_capacity_demand := 1; END;
  BEGIN v_capacity_max_shift_days := COALESCE(NULLIF(v_policy->>'capacity_max_shift_days', '')::INT, 14); EXCEPTION WHEN others THEN v_capacity_max_shift_days := 14; END;

  v_calendar_shift_days := 0;
  v_calendar_event_ids := '[]'::jsonb;
  v_capacity_shift_days := 0;
  v_capacity_window_ids := '[]'::jsonb;

  LOOP
    -- Calendar check first (so capacity shifts cannot land on blackout dates without re-check).
    IF v_calendar_enabled
      AND v_effective_promised_date IS NOT NULL
      AND v_org_id IS NOT NULL
      AND COALESCE(array_length(v_calendar_types, 1), 0) > 0
    THEN
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

      IF v_calendar_event_id IS NOT NULL THEN
        IF v_calendar_shift_days < v_calendar_max_shift_days THEN
          v_calendar_event_ids := v_calendar_event_ids || jsonb_build_array(v_calendar_event_id);
          v_effective_promised_date := v_effective_promised_date + 1;
          v_calendar_shift_days := v_calendar_shift_days + 1;
          CONTINUE;
        ELSE
          v_calendar_limit_reached := TRUE;
        END IF;
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

    -- If we can't compute a date, stop early (capacity/calendar can't help).
    IF v_res.promised_delivery_date IS NULL THEN
      EXIT;
    END IF;

    -- Capacity check (default: disabled).
    IF v_capacity_enabled
      AND v_capacity_behavior = 'shift'
      AND v_capacity_usage_mode = 'shipments_by_promised_date'
      AND v_capacity_limit_key IS NOT NULL
      AND v_org_id IS NOT NULL
      AND v_branch_id IS NOT NULL
      AND v_res.promised_window_start_at IS NOT NULL
    THEN
      DECLARE
        v_cap JSONB := NULL;
        v_win_id UUID := NULL;
        v_limit NUMERIC := NULL;
        v_used NUMERIC := NULL;
        v_local_dow INT := NULL;
        v_local_t TIME := NULL;
      BEGIN
        v_local_dow := EXTRACT(DOW FROM (v_res.promised_window_start_at AT TIME ZONE v_tz))::INT;
        v_local_t := (v_res.promised_window_start_at AT TIME ZONE v_tz)::time;

        SELECT bcw.id, bcw.capacity
          INTO v_win_id, v_cap
          FROM public.branch_capacity_windows bcw
         WHERE bcw.branch_id = v_branch_id
           AND bcw.is_active IS TRUE
           AND bcw.effective_from <= v_res.promised_window_start_at
           AND (bcw.effective_to IS NULL OR bcw.effective_to > v_res.promised_window_start_at)
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

        v_capacity_last_window_id := v_win_id;

        IF v_win_id IS NOT NULL AND jsonb_typeof(v_cap) = 'object' THEN
          BEGIN v_limit := NULLIF(v_cap->>v_capacity_limit_key, '')::NUMERIC; EXCEPTION WHEN others THEN v_limit := NULL; END;
        END IF;

        v_capacity_last_limit := v_limit;

        IF v_win_id IS NOT NULL AND v_limit IS NOT NULL AND v_limit > 0 THEN
          SELECT COUNT(*)::NUMERIC
            INTO v_used
            FROM public.shipments s
           WHERE s.branch_id = v_branch_id
             AND s.promised_delivery_date = v_res.promised_delivery_date
             AND s.organization_id = v_org_id
             AND (v_shipment_id IS NULL OR s.id IS DISTINCT FROM v_shipment_id);

          v_capacity_last_used := v_used;

          IF COALESCE(v_used, 0) + COALESCE(v_capacity_demand, 0) > v_limit THEN
            v_capacity_exceeded := TRUE;

            IF v_capacity_shift_days < v_capacity_max_shift_days THEN
              v_capacity_window_ids := v_capacity_window_ids || jsonb_build_array(v_win_id);
              v_capacity_shift_days := v_capacity_shift_days + 1;
              v_effective_promised_date := v_res.promised_delivery_date + 1;
              CONTINUE;
            ELSE
              v_capacity_limit_reached := TRUE;
            END IF;
          END IF;
        END IF;
      END;
    END IF;

    EXIT;
  END LOOP;

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
    'calendar_event_ids', CASE WHEN v_calendar_shift_days > 0 THEN v_calendar_event_ids ELSE NULL END,
    'calendar_limit_reached', CASE WHEN v_calendar_limit_reached THEN TRUE ELSE NULL END,

    'capacity_enabled', CASE WHEN v_capacity_enabled THEN TRUE ELSE NULL END,
    'capacity_behavior', CASE WHEN v_capacity_enabled THEN v_capacity_behavior ELSE NULL END,
    'capacity_usage_mode', CASE WHEN v_capacity_enabled THEN v_capacity_usage_mode ELSE NULL END,
    'capacity_limit_key', CASE WHEN v_capacity_enabled THEN v_capacity_limit_key ELSE NULL END,
    'capacity_demand', CASE WHEN v_capacity_enabled THEN v_capacity_demand ELSE NULL END,
    'capacity_shift_days', CASE WHEN v_capacity_shift_days > 0 THEN v_capacity_shift_days ELSE NULL END,
    'capacity_window_ids', CASE WHEN v_capacity_shift_days > 0 THEN v_capacity_window_ids ELSE NULL END,
    'capacity_window_id', CASE WHEN v_capacity_enabled AND v_capacity_last_window_id IS NOT NULL THEN v_capacity_last_window_id ELSE NULL END,
    'capacity_limit', CASE WHEN v_capacity_enabled AND v_capacity_last_limit IS NOT NULL THEN v_capacity_last_limit ELSE NULL END,
    'capacity_used', CASE WHEN v_capacity_enabled AND v_capacity_last_used IS NOT NULL THEN v_capacity_last_used ELSE NULL END,
    'capacity_exceeded', CASE WHEN v_capacity_enabled AND v_capacity_exceeded THEN TRUE ELSE NULL END,
    'capacity_limit_reached', CASE WHEN v_capacity_enabled AND v_capacity_limit_reached THEN TRUE ELSE NULL END
  ));

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_shipment_promise_v2(TIMESTAMPTZ, TEXT, JSONB, JSONB, DATE) IS
  'Compute shipment promise using shipment_promise_policy plus optional rule-driven overrides (match on zone/city/service level/type/day_of_week), optional blackout shifting via calendar_events, and optional capacity shifting via branch_capacity_windows.';

SELECT pg_advisory_unlock(hashtext('202601282330_promise_capacity_shifting_v1'));
COMMIT;

