-- Spec-Issue: W30 (INSIGHTS paired projection views — decision_log directory)
-- Migration: paired projection view for the FE-friendly decision_log shape
-- consumed by `apps/console-v2/src/modules/insights/decisions.tsx`.
--
-- Purpose:
--   The Console FE consumer (`decisions.tsx`) reads canonical
--   `public.decision_log` columns, but uses `resolved_from` (projected from
--   `settings_resolution_log.winning_scope_type`) and renders cross-links to
--   the trace surface. This view formalizes the projection so the FE can
--   subscribe via `useResourceList<DecisionLogDirectoryRow>('decision_log_directory')`
--   instead of relying on inline JOINs in the seed-mode adapter.
--
-- Field projection contract — v_decision_log_directory:
--   id                       = decision_log.id                    (canonical SSOT)
--   organization_id          = decision_log.organization_id       (canonical SSOT)
--   timestamp                = decision_log.timestamp             (canonical SSOT)
--   decision_category        = decision_log.decision_category     (canonical SSOT)
--   decision_point           = decision_log.decision_point        (canonical SSOT)
--   decision_outcome         = decision_log.decision_outcome      (canonical SSOT)
--   decision_inputs          = decision_log.decision_inputs       (canonical SSOT)
--   decision_reason          = decision_log.decision_reason       (canonical SSOT)
--   resource_type            = decision_log.resource_type         (canonical SSOT)
--   resource_id              = decision_log.resource_id           (canonical SSOT)
--   correlation_id           = decision_log.correlation_id        (canonical SSOT)
--   settings_resolution_id   = decision_log.settings_resolution_id (canonical SSOT)
--   performed_by_system      = decision_log.performed_by_system   (canonical SSOT)
--   resolved_from            = settings_resolution_log.winning_scope_type (joined)
--   scope_path               = settings_resolution_log.scope_path (joined)
--   scope_category           = settings_resolution_log.category   (joined)
--   winning_settings_id      = settings_resolution_log.winning_settings_id (joined)
--   age_seconds              = derived (now() - timestamp)
--   has_correlation          = derived (correlation_id IS NOT NULL)
--   has_resolution           = derived (settings_resolution_id IS NOT NULL)
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md §6`
--   - `apps/console-v2/src/modules/insights/decisions.tsx`
--   - `supabase/migrations/202510110003_mapping_lookup.sql:129-145` (decision_log SSOT)
--   - `supabase/migrations/202511021310_settings_resolution_log.sql:12-26` (resolution SSOT)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302810_v_decision_log_directory'));
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_decision_log_directory;

CREATE VIEW public.v_decision_log_directory AS
SELECT
  dl.id,
  dl.organization_id,
  dl.timestamp,
  dl.decision_category,
  dl.decision_point,
  dl.decision_outcome,
  dl.decision_inputs,
  dl.decision_reason,
  dl.resource_type,
  dl.resource_id,
  dl.correlation_id,
  dl.settings_resolution_id,
  dl.performed_by_system,
  srl.winning_scope_type                              AS resolved_from,
  COALESCE(srl.scope_path, '[]'::jsonb)               AS scope_path,
  srl.category                                        AS scope_category,
  srl.winning_settings_id                             AS winning_settings_id,
  srl.winning_settings_version_id                     AS winning_settings_version_id,
  srl.winning_version                                 AS winning_version,
  srl.resolved_at                                     AS scope_resolved_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - dl.timestamp))::bigint) AS age_seconds,
  (dl.correlation_id IS NOT NULL)                     AS has_correlation,
  (dl.settings_resolution_id IS NOT NULL)             AS has_resolution
FROM public.decision_log dl
LEFT JOIN public.settings_resolution_log srl
  ON srl.id = dl.settings_resolution_id
  AND srl.organization_id = dl.organization_id;

COMMENT ON VIEW public.v_decision_log_directory IS
  'W30 — FE-friendly directory projection over decision_log joined to
  settings_resolution_log via settings_resolution_id. Surfaces canonical
  decision_log columns plus projected resolved_from
  (= settings_resolution_log.winning_scope_type), scope_path, scope_category,
  winning_settings_id / winning_settings_version_id / winning_version,
  age_seconds, has_correlation, has_resolution. SSOT remains
  public.decision_log; engine writers continue to use canonical column names.';

-- decision_log carries org-scoped tenant data; access mirrors the underlying
-- table's RLS posture (service-role for direct reads; ui_list_resource_v1
-- enforces the surface capability `observability.read`).
REVOKE ALL ON public.v_decision_log_directory FROM PUBLIC;
REVOKE ALL ON public.v_decision_log_directory FROM anon;
GRANT SELECT ON public.v_decision_log_directory TO authenticated;
GRANT SELECT ON public.v_decision_log_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302810_v_decision_log_directory'));
COMMIT;
