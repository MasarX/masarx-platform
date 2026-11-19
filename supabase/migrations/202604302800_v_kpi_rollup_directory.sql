-- Spec-Issue: W30 (INSIGHTS paired projection views — KPI rollup directory)
-- Migration: paired projection view for the FE-friendly kpi catalog + rollup
-- shape consumed by `apps/console-v2/src/modules/insights/reporting.tsx`.
--
-- Purpose:
--   The Console FE consumer (`reporting.tsx`) displays grouped KPI cards
--   resolved by `useKpiRollup(definition_key, { scope })` per definition. The
--   live data path goes through `compute_kpi_rollup_v1` (per-card RPC) which
--   joins `kpi_definitions + kpi_rollups_daily`. This view exposes the same
--   joined projection as a directory-style read seam so list/filter UIs and
--   header chips can resolve via canonical SQL without per-card RPC fanout.
--
-- Field projection contract — v_kpi_rollup_directory:
--   id                       = kpi_rollups_daily.id (per row; NULL if no rollup)
--   organization_id          = kpi_definitions.organization_id (joined SSOT)
--   kpi_key                  = kpi_definitions.key                 (canonical SSOT)
--   kpi_label                = kpi_definitions.name                (joined)
--   kpi_description          = kpi_definitions.description         (joined)
--   kpi_unit                 = kpi_definitions.unit                (joined)
--   group_label              = definition->>'group'                (jsonb path)
--   format                   = definition->>'format'               (jsonb path)
--   tone                     = definition->>'tone'                 (jsonb path)
--   tone_thresholds          = definition->'tone_thresholds'       (jsonb)
--   day                      = kpi_rollups_daily.day               (canonical SSOT)
--   value_num                = kpi_rollups_daily.value_num         (canonical SSOT)
--   numerator                = kpi_rollups_daily.numerator         (canonical SSOT)
--   denominator              = kpi_rollups_daily.denominator       (canonical SSOT)
--   dimensions               = kpi_rollups_daily.dimensions        (canonical SSOT)
--   scope_label              = derived from dimensions (organization-scope label)
--   age_seconds              = derived (now() - rollup_updated_at)
--   is_active                = kpi_definitions.is_active           (canonical SSOT)
--   is_fresh                 = derived (age_seconds < 86400)
--   is_stale                 = derived (age_seconds >= 86400)
--   has_rollup               = derived (kpi_rollups_daily.id IS NOT NULL)
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md`
--   - `apps/console-v2/src/modules/insights/reporting.tsx`
--   - `supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql`
--   - `supabase/migrations/202604280332_compute_kpi_rollup_v1.sql`

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302800_v_kpi_rollup_directory'));
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_kpi_rollup_directory;

CREATE VIEW public.v_kpi_rollup_directory AS
SELECT
  COALESCE(rd.id::text, kd.id::text || '::no_rollup') AS id,
  kd.organization_id,
  kd.id                                               AS definition_id,
  kd.key                                              AS kpi_key,
  kd.name                                             AS kpi_label,
  kd.description                                      AS kpi_description,
  kd.unit                                             AS kpi_unit,
  NULLIF(trim(kd.definition->>'group'), '')           AS group_label,
  NULLIF(trim(kd.definition->>'format'), '')          AS format,
  NULLIF(trim(kd.definition->>'tone'), '')            AS tone,
  COALESCE(kd.definition->'tone_thresholds', '{}'::jsonb) AS tone_thresholds,
  rd.day                                              AS day,
  rd.value_num                                        AS value_num,
  rd.numerator                                        AS numerator,
  rd.denominator                                      AS denominator,
  COALESCE(rd.dimensions, '{}'::jsonb)                AS dimensions,
  -- scope_label projects a single readable label for the dimensions JSONB.
  -- Order of preference: branch_id > zone_id > service_level > 'tenant'.
  CASE
    WHEN rd.dimensions ? 'branch_id'     THEN 'branch:' || (rd.dimensions->>'branch_id')
    WHEN rd.dimensions ? 'zone_id'       THEN 'zone:' || (rd.dimensions->>'zone_id')
    WHEN rd.dimensions ? 'service_level' THEN 'service:' || (rd.dimensions->>'service_level')
    ELSE 'tenant'
  END                                                 AS scope_label,
  rd.created_at                                       AS rollup_created_at,
  rd.updated_at                                       AS rollup_updated_at,
  CASE
    WHEN rd.updated_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - rd.updated_at))::bigint)
  END                                                 AS age_seconds,
  kd.is_active,
  CASE
    WHEN rd.updated_at IS NULL THEN FALSE
    WHEN now() - rd.updated_at < INTERVAL '24 hours' THEN TRUE
    ELSE FALSE
  END                                                 AS is_fresh,
  CASE
    WHEN rd.updated_at IS NULL THEN TRUE
    WHEN now() - rd.updated_at >= INTERVAL '24 hours' THEN TRUE
    ELSE FALSE
  END                                                 AS is_stale,
  (rd.id IS NOT NULL)                                 AS has_rollup
FROM public.kpi_definitions kd
LEFT JOIN LATERAL (
  SELECT id, day, value_num, numerator, denominator, dimensions, created_at, updated_at
  FROM public.kpi_rollups_daily r
  WHERE r.organization_id = kd.organization_id
    AND r.kpi_key = kd.key
  ORDER BY r.day DESC, r.updated_at DESC
  LIMIT 1
) rd ON TRUE;

COMMENT ON VIEW public.v_kpi_rollup_directory IS
  'W30 — FE-friendly directory projection over kpi_definitions joined to the
  most recent kpi_rollups_daily row. Surfaces resolved label / format / tone /
  group_label, latest value_num / numerator / denominator / day, scope_label
  derived from dimensions, age_seconds, and lifecycle booleans
  (is_active, is_fresh, is_stale, has_rollup). SSOT remains
  public.kpi_definitions + public.kpi_rollups_daily; rollup workers continue
  to write via canonical column names.';

REVOKE ALL ON public.v_kpi_rollup_directory FROM PUBLIC;
REVOKE ALL ON public.v_kpi_rollup_directory FROM anon;
GRANT SELECT ON public.v_kpi_rollup_directory TO authenticated;
GRANT SELECT ON public.v_kpi_rollup_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302800_v_kpi_rollup_directory'));
COMMIT;
