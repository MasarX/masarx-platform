-- Plan: PHASE B / Step: B5 (INSIGHTS reporting RPC contract gap-fill)
-- Migration: compute_kpi_rollup_v1 — projection resolver for kpi_definitions + kpi_rollups_daily
-- Date: 2026-04-28
--
-- Purpose:
--   The INSIGHTS FE re-audit (apps/console-v2/__audit__/REAUDIT/INSIGHTS.md §D5)
--   shows the FE adapter calls `client.rpc('compute_kpi_rollup_v1', ...)` but
--   no backend migration registers the RPC. The FE adapter falls through to a
--   direct table read on `function|not found|does not exist` errors, but the
--   migration-side gap means production swap is implicit/silent.
--
--   This migration registers the canonical
--   `public.compute_kpi_rollup_v1(p_definition_key, p_day, p_window_days, p_scope_organization_id)`
--   resolver. It joins `public.kpi_definitions` with the most-recent
--   `public.kpi_rollups_daily` row for the given key + scope and returns a
--   single typed projection row matching the FE `KpiRollupResolution` shape:
--
--     ( kpi_key, label, group, value_num, numerator, denominator, format,
--       unit, tone, delta, day, scope_organization_id, settings_resolution_id )
--
--   Tone is derived from `definition.tone_thresholds` (good_at_or_above /
--   warn_below for higher-is-better; good_at_or_below / warn_above /
--   danger_above for lower-is-better) with a fallback to
--   `definition.tone`. The settings_resolution_id is a deterministic
--   `srlv_kpi_<key>` token so cache keys stay stable across calls.
--
-- Contract:
--   - Capability: insights.read (the FE module-level guard already enforces
--     this; we additionally assert it inside the body to fail closed for
--     direct RPC callers).
--   - Tenant isolation: `p_scope_organization_id` is enforced against the
--     caller's org via `is_platform_user()` + `current_user_org_id()`.
--   - SECURITY DEFINER + locked search_path; least-privilege grants.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280332_compute_kpi_rollup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_kpi_rollup_v1(
  p_definition_key TEXT,
  p_day            DATE DEFAULT NULL,
  p_window_days    INT  DEFAULT 1,
  p_scope_organization_id UUID DEFAULT NULL
)
RETURNS TABLE (
  kpi_key                 TEXT,
  label                   TEXT,
  "group"                 TEXT,
  value_num               NUMERIC,
  numerator               NUMERIC,
  denominator             NUMERIC,
  format                  TEXT,
  unit                    TEXT,
  tone                    TEXT,
  delta                   TEXT,
  day                     DATE,
  scope_organization_id   UUID,
  settings_resolution_id  TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_caller_org_id UUID := public.current_user_org_id();
  v_scope_org_id  UUID := COALESCE(p_scope_organization_id, v_caller_org_id);
  v_def           public.kpi_definitions%ROWTYPE;
  v_target        public.kpi_rollups_daily%ROWTYPE;
  v_previous      public.kpi_rollups_daily%ROWTYPE;
  v_definition    JSONB;
  v_format        TEXT;
  v_group         TEXT;
  v_tone          TEXT;
  v_delta         TEXT;
  v_block         JSONB;
  v_ga            NUMERIC;
  v_wb            NUMERIC;
  v_gb            NUMERIC;
  v_wa            NUMERIC;
  v_da            NUMERIC;
  v_explicit      TEXT;
  v_label         TEXT;
  v_value         NUMERIC;
  v_prev          NUMERIC;
  v_diff          NUMERIC;
  v_sign          TEXT;
  v_abs           NUMERIC;
  v_formatted     TEXT;
  v_window_days   INT := COALESCE(NULLIF(p_window_days, 0), 1);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'compute_kpi_rollup_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF p_definition_key IS NULL OR btrim(p_definition_key) = '' THEN
    RAISE EXCEPTION 'compute_kpi_rollup_v1 requires definition_key' USING ERRCODE = '22023';
  END IF;

  -- Capability gate (fail-closed for direct RPC callers).
  PERFORM public.assert_capability_v1('insights.read', 'tenant', v_scope_org_id);

  -- Tenant scope: non-platform users may only read their own org rollups.
  IF NOT public.is_platform_user() THEN
    IF v_scope_org_id IS NULL OR v_scope_org_id <> v_caller_org_id THEN
      RAISE EXCEPTION 'compute_kpi_rollup_v1 scope is outside current tenant'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Resolve definition (per org+key).
  SELECT * INTO v_def
    FROM public.kpi_definitions d
   WHERE d.key = p_definition_key
     AND (v_scope_org_id IS NULL OR d.organization_id = v_scope_org_id)
   ORDER BY d.created_at DESC
   LIMIT 1;

  IF v_def.id IS NULL THEN
    RAISE EXCEPTION 'kpi_definition_not_found:%', p_definition_key USING ERRCODE = 'P0002';
  END IF;

  v_definition := COALESCE(v_def.definition, '{}'::jsonb);
  v_format := COALESCE(v_definition->>'format', 'integer');
  v_group  := COALESCE(v_definition->>'group', 'general');
  v_label  := v_def.name;

  -- Latest rollup row for (org, key); honor explicit p_day when supplied.
  IF p_day IS NOT NULL THEN
    SELECT * INTO v_target
      FROM public.kpi_rollups_daily r
     WHERE r.kpi_key = p_definition_key
       AND r.organization_id = v_def.organization_id
       AND r.day = p_day
     ORDER BY r.day DESC
     LIMIT 1;
  END IF;

  IF v_target.id IS NULL THEN
    SELECT * INTO v_target
      FROM public.kpi_rollups_daily r
     WHERE r.kpi_key = p_definition_key
       AND r.organization_id = v_def.organization_id
     ORDER BY r.day DESC
     LIMIT 1;
  END IF;

  -- Previous rollup row (offset by p_window_days from target.day) for delta.
  IF v_target.id IS NOT NULL THEN
    SELECT * INTO v_previous
      FROM public.kpi_rollups_daily r
     WHERE r.kpi_key = p_definition_key
       AND r.organization_id = v_def.organization_id
       AND r.day < v_target.day
     ORDER BY r.day DESC
     LIMIT 1;
  END IF;

  v_value := v_target.value_num;
  v_prev  := v_previous.value_num;

  -- Tone resolution
  v_block := v_definition->'tone_thresholds';
  IF v_value IS NULL THEN
    v_tone := 'neutral';
  ELSIF v_block IS NULL OR jsonb_typeof(v_block) <> 'object' THEN
    v_tone := COALESCE(v_definition->>'tone', 'neutral');
  ELSE
    v_ga := CASE WHEN jsonb_typeof(v_block->'good_at_or_above') = 'number'
                 THEN (v_block->>'good_at_or_above')::NUMERIC ELSE NULL END;
    v_wb := CASE WHEN jsonb_typeof(v_block->'warn_below') = 'number'
                 THEN (v_block->>'warn_below')::NUMERIC ELSE NULL END;
    v_gb := CASE WHEN jsonb_typeof(v_block->'good_at_or_below') = 'number'
                 THEN (v_block->>'good_at_or_below')::NUMERIC ELSE NULL END;
    v_wa := CASE WHEN jsonb_typeof(v_block->'warn_above') = 'number'
                 THEN (v_block->>'warn_above')::NUMERIC ELSE NULL END;
    v_da := CASE WHEN jsonb_typeof(v_block->'danger_above') = 'number'
                 THEN (v_block->>'danger_above')::NUMERIC ELSE NULL END;

    IF v_ga IS NOT NULL THEN
      -- higher-is-better
      IF v_value >= v_ga THEN v_tone := 'good';
      ELSIF v_wb IS NOT NULL AND v_value < v_wb THEN v_tone := 'danger';
      ELSE v_tone := 'warn';
      END IF;
    ELSIF v_gb IS NOT NULL THEN
      -- lower-is-better
      IF v_value <= v_gb THEN v_tone := 'good';
      ELSIF v_da IS NOT NULL AND v_value > v_da THEN v_tone := 'danger';
      ELSIF v_wa IS NOT NULL AND v_value > v_wa THEN v_tone := 'warn';
      ELSE v_tone := COALESCE(v_definition->>'tone', 'neutral');
      END IF;
    ELSE
      v_tone := COALESCE(v_definition->>'tone', 'neutral');
    END IF;
  END IF;

  -- Delta resolution
  v_explicit := v_target.metadata->>'delta_text';
  IF v_explicit IS NOT NULL AND btrim(v_explicit) <> '' THEN
    v_delta := v_explicit;
  ELSIF v_value IS NULL OR v_prev IS NULL THEN
    v_delta := NULLIF(btrim(COALESCE(v_definition->>'delta_label', '')), '');
  ELSE
    v_diff := v_value - v_prev;
    IF abs(v_diff) < 0.0001 THEN
      v_delta := NULLIF(btrim(COALESCE(v_definition->>'delta_label', '')), '');
    ELSE
      v_sign := CASE WHEN v_diff > 0 THEN '+' ELSE U&'\2212' END;
      v_abs  := abs(v_diff);
      IF v_format = 'percent' THEN
        v_formatted := v_sign || to_char(v_abs, 'FM999990.0') || ' pts';
      ELSIF v_format = 'duration_minutes' THEN
        v_formatted := v_sign || to_char(round(v_abs), 'FM999990') || 'm';
      ELSIF v_format = 'duration_seconds' THEN
        v_formatted := v_sign || to_char(v_abs, 'FM999990.0') || 's';
      ELSE
        v_formatted := v_sign || to_char(round(v_abs), 'FM999990');
      END IF;
      IF NULLIF(btrim(COALESCE(v_definition->>'delta_label', '')), '') IS NOT NULL THEN
        v_delta := v_formatted || ' · ' || (v_definition->>'delta_label');
      ELSE
        v_delta := v_formatted;
      END IF;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    v_def.key                                         AS kpi_key,
    v_label                                           AS label,
    v_group                                           AS "group",
    v_target.value_num                                AS value_num,
    v_target.numerator                                AS numerator,
    v_target.denominator                              AS denominator,
    v_format                                          AS format,
    v_def.unit                                        AS unit,
    v_tone                                            AS tone,
    v_delta                                           AS delta,
    v_target.day                                      AS day,
    v_def.organization_id                             AS scope_organization_id,
    ('srlv_kpi_' || v_def.key)::TEXT                  AS settings_resolution_id;
END;
$function$;

COMMENT ON FUNCTION public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) IS
  'Phase B (B5) canonical projection RPC: resolve a single KPI rollup row joined with its definition (tone + delta computed). Capability: insights.read. Args: definition_key (text, required), day (date, optional), window_days (int, default 1), scope_organization_id (uuid, optional — defaults to caller org).';

REVOKE ALL ON FUNCTION public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604280332_compute_kpi_rollup_v1'));
COMMIT;
