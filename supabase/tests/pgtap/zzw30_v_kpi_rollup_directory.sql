-- pgTAP: public.v_kpi_rollup_directory projection contract
-- Spec-Issue: W30 (paired projection views — INSIGHTS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_kpi_rollup_directory',
  'public.v_kpi_rollup_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_kpi_rollup_directory',
  ARRAY[
    'id', 'organization_id', 'definition_id', 'kpi_key', 'kpi_label',
    'kpi_description', 'kpi_unit',
    'group_label', 'format', 'tone', 'tone_thresholds',
    'day', 'value_num', 'numerator', 'denominator',
    'dimensions', 'scope_label',
    'rollup_created_at', 'rollup_updated_at', 'age_seconds',
    'is_active', 'is_fresh', 'is_stale', 'has_rollup'
  ],
  'v_kpi_rollup_directory exposes canonical + derived FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_kpi_rollup_directory', 'SELECT'),
  'service_role has SELECT on v_kpi_rollup_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_kpi_rollup_directory', 'SELECT'),
  'anon has no SELECT on v_kpi_rollup_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_kpi_rollup_directory', 'SELECT'),
  'authenticated has SELECT on v_kpi_rollup_directory'
);

-- 6) Underlying base tables remain SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('kpi_definitions', 'kpi_rollups_daily')
       AND c.relkind = 'r'
  ),
  'public.kpi_definitions + kpi_rollups_daily remain base tables (SSOT preserved)'
);

-- 7) Projection: insert a definition + a rollup row (within 24h) and a definition
--    without any rollup, then verify projection booleans (is_fresh, is_stale,
--    has_rollup) and joined fields (kpi_label, scope_label).
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000030a001';
  v_def_a  UUID := '00000000-0000-0000-0000-00000030a002';
  v_def_b  UUID := '00000000-0000-0000-0000-00000030a003';
  v_roll_a UUID := '00000000-0000-0000-0000-00000030a004';
  v_label_a       TEXT;
  v_group_label_a TEXT;
  v_format_a      TEXT;
  v_scope_label_a TEXT;
  v_age_a         BIGINT;
  v_is_fresh_a    BOOLEAN;
  v_is_stale_a    BOOLEAN;
  v_has_rollup_a  BOOLEAN;
  v_value_a       NUMERIC;
  v_has_rollup_b  BOOLEAN;
  v_is_stale_b    BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W30 KPI Org', 'w30-kpi-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- Definition A: full definition jsonb (group + format + tone) + has rollup.
  INSERT INTO public.kpi_definitions (id, organization_id, key, name, description, unit, definition, is_active)
  VALUES (
    v_def_a, v_org, 'w30_otd_rate', 'On-time delivery rate', 'OTD percent', 'percent',
    jsonb_build_object('group', 'operations', 'format', 'percent', 'tone', 'good'),
    TRUE
  )
  ON CONFLICT (organization_id, key) DO NOTHING;

  -- Definition B: definition without any rollup (has_rollup must be FALSE).
  INSERT INTO public.kpi_definitions (id, organization_id, key, name, definition, is_active)
  VALUES (
    v_def_b, v_org, 'w30_norollup_rate', 'No rollup KPI',
    jsonb_build_object('group', 'workflows', 'format', 'integer'),
    TRUE
  )
  ON CONFLICT (organization_id, key) DO NOTHING;

  -- Rollup A: branch-scoped, fresh (now()).
  INSERT INTO public.kpi_rollups_daily (
    id, organization_id, kpi_key, day, dimensions, value_num, numerator, denominator
  )
  VALUES (
    v_roll_a, v_org, 'w30_otd_rate', current_date,
    jsonb_build_object('branch_id', 'br_w30'),
    93.5, 935, 1000
  )
  ON CONFLICT (organization_id, kpi_key, day, dimensions) DO NOTHING;

  -- Verify projection for definition A.
  SELECT
    kpi_label, group_label, format, scope_label, age_seconds,
    is_fresh, is_stale, has_rollup, value_num
    INTO
    v_label_a, v_group_label_a, v_format_a, v_scope_label_a, v_age_a,
    v_is_fresh_a, v_is_stale_a, v_has_rollup_a, v_value_a
    FROM public.v_kpi_rollup_directory
   WHERE organization_id = v_org
     AND kpi_key = 'w30_otd_rate';

  -- Verify projection for definition B (no rollup).
  SELECT has_rollup, is_stale
    INTO v_has_rollup_b, v_is_stale_b
    FROM public.v_kpi_rollup_directory
   WHERE organization_id = v_org
     AND kpi_key = 'w30_norollup_rate';

  PERFORM ok(
    v_label_a = 'On-time delivery rate'
      AND v_group_label_a = 'operations'
      AND v_format_a = 'percent'
      AND v_scope_label_a = 'branch:br_w30'
      AND v_age_a IS NOT NULL
      AND v_age_a >= 0
      AND v_age_a < 60 * 60 * 24
      AND v_is_fresh_a = TRUE
      AND v_is_stale_a = FALSE
      AND v_has_rollup_a = TRUE
      AND v_value_a = 93.5
      AND v_has_rollup_b = FALSE
      AND v_is_stale_b = TRUE,
    'v_kpi_rollup_directory derives kpi_label/group_label/format/scope_label/age_seconds + lifecycle booleans (is_fresh/is_stale/has_rollup); definitions without rollups project as is_stale=TRUE has_rollup=FALSE'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
