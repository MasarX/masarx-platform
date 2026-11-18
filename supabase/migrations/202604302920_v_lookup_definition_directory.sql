-- Spec-Issue: W31 CATALOG gap closure (paired projection views)
-- Step: W31-VIEW-3
-- Migration: Canonical projection view public.v_lookup_definition_directory.
-- Capability: lookups.read (read-only; underlying RLS enforced via security_invoker)
--
-- Purpose:
--   Project per-definition derived counters used by
--   `apps/console-v2/src/modules/catalog/lookups.tsx` (lookup editor list +
--   definition drawer):
--     - value_count            : derived COUNT(lookup_values WHERE
--                                 lookup_definition_id = ld.id)
--     - active_value_count     : derived COUNT(lookup_values WHERE
--                                 status = 'active')
--     - draft_value_count      : derived COUNT(lookup_values WHERE
--                                 status = 'draft')
--     - archived_value_count   : derived COUNT(lookup_values WHERE
--                                 status = 'archived')
--     - retired_value_count    : derived COUNT(lookup_values WHERE
--                                 retired_at IS NOT NULL)
--     - default_value          : derived value of the is_default=TRUE row
--                                 (when present; first by sort_order asc)
--     - default_value_label    : derived label of that row
--     - has_default            : derived flag
--     - last_value_updated_at  : derived MAX(lookup_values.updated_at)
--     - age_seconds / age_hours: derived from created_at vs now()
--     - last_updated_at        : alias of updated_at
--
--   The FE `LookupDefinitionRow` is a clean meta + synthetic values[] array.
--   This view supplies the per-definition counters + default-value resolution
--   so the FE can render summary chips (count badges, has-default indicator)
--   without hand-rolling aggregations on the client side.
--
-- Notes:
--   * SSOT remains public.lookup_definitions; this view is read-only.
--   * RLS enforced via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302920_v_lookup_definition_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_lookup_definition_directory;

CREATE VIEW public.v_lookup_definition_directory
  WITH (security_invoker = true)
  AS
SELECT
  ld.id,
  ld.category,
  ld.description,
  ld.owner_role,
  ld.approval_policy,
  ld.is_mutable,
  ld.created_by,
  ld.created_at,
  ld.updated_at,
  -- Derived: per-definition counters
  COALESCE(val_agg.value_count, 0)            AS value_count,
  COALESCE(val_agg.active_value_count, 0)     AS active_value_count,
  COALESCE(val_agg.draft_value_count, 0)      AS draft_value_count,
  COALESCE(val_agg.archived_value_count, 0)   AS archived_value_count,
  COALESCE(val_agg.retired_value_count, 0)    AS retired_value_count,
  -- Derived: default value resolution
  default_row.value                           AS default_value,
  default_row.label                           AS default_value_label,
  (default_row.value IS NOT NULL)             AS has_default,
  -- Derived: last_value_updated_at (most recent value mutation across the
  -- definition; useful for the "Updated" column in the editor list)
  val_agg.last_value_updated_at,
  -- Derived: temporal projections
  GREATEST(0, EXTRACT(EPOCH FROM (now() - ld.created_at))::bigint) AS age_seconds,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - ld.created_at))::bigint / 3600) AS age_hours,
  ld.updated_at                               AS last_updated_at
FROM public.lookup_definitions ld
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)                                                         AS value_count,
    COUNT(*) FILTER (WHERE lv.status = 'active')                     AS active_value_count,
    COUNT(*) FILTER (WHERE lv.status = 'draft')                      AS draft_value_count,
    COUNT(*) FILTER (WHERE lv.status = 'archived')                   AS archived_value_count,
    COUNT(*) FILTER (WHERE lv.retired_at IS NOT NULL)                AS retired_value_count,
    MAX(lv.updated_at)                                               AS last_value_updated_at
    FROM public.lookup_values lv
   WHERE lv.lookup_definition_id = ld.id
) val_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT lv.value, lv.label
    FROM public.lookup_values lv
   WHERE lv.lookup_definition_id = ld.id
     AND lv.is_default = TRUE
   ORDER BY lv.sort_order NULLS LAST, lv.created_at
   LIMIT 1
) default_row ON TRUE;

COMMENT ON VIEW public.v_lookup_definition_directory IS
  'FE-friendly projection of lookup_definitions with derived per-definition counters (value_count + active/draft/archived/retired splits via lookup_values), default-value resolution (default_value/default_value_label/has_default for the is_default=TRUE row, ordered by sort_order), last_value_updated_at (MAX(lookup_values.updated_at) for editor list "Updated" column), and temporal projections (age_seconds/age_hours/last_updated_at). SSOT remains lookup_definitions; mutations go through lookup_definition_create_v1 / lookup_value_create_v1 / lookup_value_update_v1 / lookup_value_archive_v1 / lookup_value_promote_v1 (Phase B6 RPCs).';

REVOKE ALL ON public.v_lookup_definition_directory FROM PUBLIC;
REVOKE ALL ON public.v_lookup_definition_directory FROM anon;
GRANT SELECT ON public.v_lookup_definition_directory TO authenticated;
GRANT SELECT ON public.v_lookup_definition_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302920_v_lookup_definition_directory'));
COMMIT;
