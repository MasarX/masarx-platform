-- Spec-Issue: W30 (INSIGHTS paired projection views — ui_event_log directory)
-- Migration: paired projection view for the FE-friendly ui_event_log shape
-- consumed by `apps/console-v2/src/modules/insights/ui-events.tsx`.
--
-- Purpose:
--   The Console FE consumer (`ui-events.tsx`) reads canonical
--   `public.ui_event_log` columns and resolves `path` / `command` via
--   `event_context` / `event_name` (or `meta` jsonb projection per W17-4
--   closure). This view formalizes the canonical projection so the FE has a
--   directory-style read seam with derived fields (path_label, command_label,
--   age_seconds, is_action) without per-row jsonb digging.
--
-- Field projection contract — v_ui_event_log_directory:
--   id                       = ui_event_log.id                    (canonical SSOT)
--   organization_id          = ui_event_log.organization_id       (canonical SSOT)
--   user_id                  = ui_event_log.user_id               (canonical SSOT)
--   app                      = ui_event_log.app                   (canonical SSOT)
--   event_type               = ui_event_log.event_type            (canonical SSOT)
--   event_context            = ui_event_log.event_context         (canonical SSOT)
--   event_name               = ui_event_log.event_name            (canonical SSOT)
--   event_message            = ui_event_log.event_message         (canonical SSOT)
--   settings_resolution_id   = ui_event_log.settings_resolution_id (canonical SSOT)
--   scope_type               = ui_event_log.scope_type            (canonical SSOT)
--   scope_id                 = ui_event_log.scope_id              (canonical SSOT)
--   meta                     = ui_event_log.meta                  (canonical SSOT)
--   digest                   = ui_event_log.digest                (canonical SSOT)
--   created_at               = ui_event_log.created_at            (canonical SSOT)
--   path_label               = COALESCE(event_context, meta->>'path')
--   command_label            = COALESCE(event_name, meta->>'command')
--   age_seconds              = derived (now() - created_at)
--   is_action                = derived (event_type LIKE '%.action%' OR event_type LIKE '%.click%')
--   has_resolution           = derived (settings_resolution_id IS NOT NULL)
--   has_scope                = derived (scope_type IS NOT NULL)
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/INSIGHTS.md §9`
--   - `apps/console-v2/src/modules/insights/ui-events.tsx`
--   - `supabase/migrations/202601162000_ui_event_log.sql`

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302830_v_ui_event_log_directory'));
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_ui_event_log_directory;

CREATE VIEW public.v_ui_event_log_directory AS
SELECT
  uel.id,
  uel.organization_id,
  uel.user_id,
  uel.app,
  uel.event_type,
  uel.event_context,
  uel.event_name,
  uel.event_message,
  uel.settings_resolution_id,
  uel.scope_type,
  uel.scope_id,
  uel.meta,
  uel.digest,
  uel.created_at,
  -- path_label resolves event_context first (canonical), then meta->>'path'
  -- (jsonb projection per W17-4 closure).
  COALESCE(
    NULLIF(trim(uel.event_context), ''),
    NULLIF(trim(uel.meta->>'path'), '')
  )                                                   AS path_label,
  -- command_label resolves event_name first (canonical), then meta->>'command'.
  COALESCE(
    NULLIF(trim(uel.event_name), ''),
    NULLIF(trim(uel.meta->>'command'), '')
  )                                                   AS command_label,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - uel.created_at))::bigint) AS age_seconds,
  CASE
    WHEN uel.event_type ILIKE '%.action%' THEN TRUE
    WHEN uel.event_type ILIKE '%.click%'  THEN TRUE
    WHEN uel.event_type ILIKE '%.submit%' THEN TRUE
    ELSE FALSE
  END                                                 AS is_action,
  (uel.settings_resolution_id IS NOT NULL)            AS has_resolution,
  (uel.scope_type IS NOT NULL)                        AS has_scope
FROM public.ui_event_log uel;

COMMENT ON VIEW public.v_ui_event_log_directory IS
  'W30 — FE-friendly directory projection over ui_event_log. Surfaces
  canonical columns plus derived path_label (= event_context OR meta->>path),
  command_label (= event_name OR meta->>command), age_seconds, and
  lifecycle booleans (is_action / has_resolution / has_scope). SSOT remains
  public.ui_event_log; ui_log_event_v1 / ui_log_events_v1 RPCs continue to
  write via canonical column names.';

REVOKE ALL ON public.v_ui_event_log_directory FROM PUBLIC;
REVOKE ALL ON public.v_ui_event_log_directory FROM anon;
GRANT SELECT ON public.v_ui_event_log_directory TO authenticated;
GRANT SELECT ON public.v_ui_event_log_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302830_v_ui_event_log_directory'));
COMMIT;
