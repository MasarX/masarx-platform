-- Spec-Issue: W30 (INSIGHTS paired projection views — settings_resolution directory)
-- Migration: paired projection view for the FE-friendly settings_resolution_log
-- shape consumed by `apps/console-v2/src/modules/insights/resolutions.tsx`.
--
-- Purpose:
--   The Console FE consumer (`resolutions.tsx`) renders the override-ladder
--   resolution log with the LadderViz drawer that walks `scope_path`. This
--   view formalizes the projection so the FE can subscribe via
--   `useResourceList('settings_resolution_directory')` and surface canonical
--   ladder counters (override_count, ladder_levels_visited, age_seconds)
--   without per-row jsonb digging in the FE.
--
-- Field projection contract — v_settings_resolution_directory:
--   id                            = settings_resolution_log.id (canonical SSOT)
--   organization_id               = settings_resolution_log.organization_id (canonical SSOT)
--   resolved_at                   = settings_resolution_log.resolved_at (canonical SSOT)
--   created_at                    = settings_resolution_log.created_at (canonical SSOT)
--   category                      = settings_resolution_log.category (canonical SSOT)
--   scope_path                    = settings_resolution_log.scope_path (canonical SSOT)
--   winning_scope_type            = settings_resolution_log.winning_scope_type (canonical SSOT)
--   winning_scope_id              = settings_resolution_log.winning_scope_id (canonical SSOT)
--   winning_settings_id           = settings_resolution_log.winning_settings_id (canonical SSOT)
--   winning_settings_version_id   = settings_resolution_log.winning_settings_version_id (canonical SSOT)
--   winning_version               = settings_resolution_log.winning_version (canonical SSOT)
--   merge_notes                   = settings_resolution_log.merge_notes (canonical SSOT)
--   inputs                        = settings_resolution_log.inputs (canonical SSOT)
--   ladder_levels_visited         = derived (jsonb_array_length(scope_path))
--   override_count                = derived (count of scope_path elements with has_value=true beyond global)
--   age_seconds                   = derived (now() - resolved_at)
--   is_global_winner              = derived (winning_scope_type = 'global')
--   is_tenant_winner              = derived (winning_scope_type = 'tenant')
--   is_client_winner              = derived (winning_scope_type = 'client')
--   is_sender_winner              = derived (winning_scope_type IN ('sender','source','resource'))
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md §8`
--   - `apps/console-v2/src/modules/insights/resolutions.tsx`
--   - `supabase/migrations/202511021310_settings_resolution_log.sql:12-26`

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302820_v_settings_resolution_directory'));
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_settings_resolution_directory;

CREATE VIEW public.v_settings_resolution_directory AS
SELECT
  srl.id,
  srl.organization_id,
  srl.resolved_at,
  srl.created_at,
  srl.category,
  COALESCE(srl.scope_path, '[]'::jsonb)               AS scope_path,
  srl.winning_scope_type,
  srl.winning_scope_id,
  srl.winning_settings_id,
  srl.winning_settings_version_id,
  srl.winning_version,
  srl.merge_notes,
  srl.inputs,
  CASE
    WHEN jsonb_typeof(srl.scope_path) = 'array' THEN jsonb_array_length(srl.scope_path)
    ELSE 0
  END                                                 AS ladder_levels_visited,
  CASE
    WHEN jsonb_typeof(srl.scope_path) = 'array' THEN (
      SELECT COUNT(*)::int
        FROM jsonb_array_elements(srl.scope_path) AS elem
       WHERE COALESCE((elem->>'has_value')::boolean, FALSE)
         AND COALESCE(elem->>'scope_type', '') <> 'global'
    )
    ELSE 0
  END                                                 AS override_count,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - srl.resolved_at))::bigint) AS age_seconds,
  (srl.winning_scope_type = 'global')                 AS is_global_winner,
  (srl.winning_scope_type = 'tenant')                 AS is_tenant_winner,
  (srl.winning_scope_type = 'client')                 AS is_client_winner,
  (srl.winning_scope_type IN ('sender', 'source', 'resource')) AS is_sender_winner
FROM public.settings_resolution_log srl;

COMMENT ON VIEW public.v_settings_resolution_directory IS
  'W30 — FE-friendly directory projection over settings_resolution_log.
  Surfaces canonical columns plus derived ladder_levels_visited (count of
  scope_path elements), override_count (non-global has_value=true elements),
  age_seconds, and category-bucketed lifecycle booleans
  (is_global_winner / is_tenant_winner / is_client_winner / is_sender_winner).
  SSOT remains public.settings_resolution_log;
  log_settings_resolution_v1 + decision provenance triggers continue to write
  via canonical column names.';

REVOKE ALL ON public.v_settings_resolution_directory FROM PUBLIC;
REVOKE ALL ON public.v_settings_resolution_directory FROM anon;
GRANT SELECT ON public.v_settings_resolution_directory TO authenticated;
GRANT SELECT ON public.v_settings_resolution_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302820_v_settings_resolution_directory'));
COMMIT;
