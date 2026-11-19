-- Spec-Issue: W13-5 (PLATFORM alert_triggers gap closure — W7 audit + W10-5 deferred)
-- Migration: paired projection view for the FE-friendly alert_triggers shape.
--
-- Purpose:
--   The canonical table `public.alert_triggers` (migration 202510110003) ships
--   with the SSOT columns `(id, alert_rule_id, organization_id, resource_type,
--   resource_id, severity, message, context, notified_at, acknowledged_by,
--   acknowledged_at, resolution_notes, timestamp)`. The Console FE consumer
--   (`apps/console-v2/src/modules/platform/alerts.tsx:114`) expects the FE-
--   friendly shape `(id, rule_id, fired_at, payload, status)` and carries a
--   documented SCHEMA-DRIFT note (`__audit__/SCHEMA-DRIFT/PLATFORM.md §2`)
--   noting that the rename was deferred.
--
--   This view closes the FE/backend gap **additively** without renaming
--   canonical columns — the SSOT remains `public.alert_triggers` and the
--   alert dispatch worker (`202512132030_alert_dispatch_workers.sql`) keeps
--   writing via the canonical column names.
--
-- Field projection contract:
--   id              = alert_triggers.id
--   rule_id         = alert_triggers.alert_rule_id          (RENAME deferred → projection)
--   organization_id = alert_triggers.organization_id
--   fired_at        = alert_triggers.timestamp              (RENAME deferred → projection)
--   payload         = alert_triggers.context                (RENAME deferred → projection)
--   resource_type   = alert_triggers.resource_type
--   resource_id     = alert_triggers.resource_id
--   severity        = alert_triggers.severity
--   message         = alert_triggers.message
--   status          = derived ('fired' | 'acknowledged' | 'resolved' | 'silenced')
--                       'silenced'    when context->>'silenced_at' is set
--                       'resolved'    when resolution_notes IS NOT NULL OR
--                                     context->>'resolved_at' is set
--                       'acknowledged' when acknowledged_at IS NOT NULL
--                       'fired'       otherwise
--   acknowledged_at = alert_triggers.acknowledged_at
--   acknowledged_by = alert_triggers.acknowledged_by
--   notified_at     = alert_triggers.notified_at
--
-- Cross-references:
--   - `apps/console-v2/__audit__/SCHEMA-DRIFT/PLATFORM.md §2` (FE shape)
--   - `apps/console-v2/src/modules/platform/alerts.tsx:114` (FE consumer)
--   - `supabase/migrations/202510110003_mapping_lookup.sql:213` (canonical table)
--   - `supabase/migrations/202512131020_alert_rules_rls_hardening.sql` (RLS posture)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301700_v_alert_trigger_summary'));
SET search_path TO public, extensions, pg_temp;

DROP VIEW IF EXISTS public.v_alert_trigger_summary;

CREATE VIEW public.v_alert_trigger_summary AS
SELECT
  at.id,
  at.alert_rule_id AS rule_id,
  at.organization_id,
  at.timestamp     AS fired_at,
  COALESCE(at.context, '{}'::jsonb) AS payload,
  at.resource_type,
  at.resource_id,
  at.severity,
  at.message,
  CASE
    WHEN at.context ? 'silenced_at'
      AND NULLIF(at.context->>'silenced_at', '') IS NOT NULL
      THEN 'silenced'
    WHEN at.resolution_notes IS NOT NULL
      OR (at.context ? 'resolved_at' AND NULLIF(at.context->>'resolved_at', '') IS NOT NULL)
      THEN 'resolved'
    WHEN at.acknowledged_at IS NOT NULL
      THEN 'acknowledged'
    ELSE 'fired'
  END AS status,
  at.acknowledged_at,
  at.acknowledged_by,
  at.notified_at,
  at.timestamp     AS occurred_at
FROM public.alert_triggers at;

COMMENT ON VIEW public.v_alert_trigger_summary IS
  'W13-5 — FE-friendly projection of alert_triggers. Maps canonical
  alert_rule_id/timestamp/context onto FE-shaped rule_id/fired_at/payload
  + derives status (fired|acknowledged|resolved|silenced) from
  acknowledged_at/resolution_notes/context flags. SSOT remains
  public.alert_triggers; alert_dispatch_workers continue to write via
  canonical column names.';

-- RLS access mirrors the underlying table: views inherit base-table RLS,
-- and the canonical alert_triggers table is service-role only with explicit
-- service_role policy (see 202512131020_alert_rules_rls_hardening.sql).
REVOKE ALL ON public.v_alert_trigger_summary FROM PUBLIC;
REVOKE ALL ON public.v_alert_trigger_summary FROM anon;
REVOKE ALL ON public.v_alert_trigger_summary FROM authenticated;
GRANT SELECT ON public.v_alert_trigger_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301700_v_alert_trigger_summary'));
COMMIT;
