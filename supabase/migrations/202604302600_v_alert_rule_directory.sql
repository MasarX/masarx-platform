-- Spec-Issue: W28 PLATFORM gap closure (paired projection views)
-- Step: W28-VIEW-1
-- Migration: Canonical projection view public.v_alert_rule_directory.
-- Capability: alerts.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-rule derived counters + label rollups used by
--   `apps/console-v2/src/modules/platform/alerts.tsx` (AlertRule + DecoratedRule):
--     - severity_label       : derived projection from alert_severity_lookup_id
--                                via `lookup_values` (canonical lookup-FK
--                                resolution; closes the W10-5 §1 RENAME deferral
--                                where FE rendered the literal severity but
--                                backend stored an FK to a lookup row).
--     - created_by_label     : human-readable user label resolved via
--                                public.users.full_name (FK join). NULL when
--                                created_by is itself NULL.
--     - condition_summary    : derived FE-friendly textual summary of
--                                `trigger_conditions` jsonb (key=value joined
--                                with " AND " for the legacy flat shape;
--                                "complex" for nested structures). Mirrors the
--                                FE `summarizeFlat` helper's output so the
--                                operator pill stays stable when consuming
--                                this view directly.
--     - alert_channels_count : derived COUNT of jsonb array elements in
--                                alert_channels (NULL-safe).
--     - last_triggered_at    : derived MAX(alert_triggers.timestamp) per rule
--                                (closes the W10-5 §1 REMOVE deferral — FE
--                                used to carry a fictional `last_triggered_at`
--                                column on alert_rules; canonical resolution is
--                                aggregation over alert_triggers).
--     - trigger_count_24h    : derived COUNT(alert_triggers WHERE
--                                timestamp >= now() - INTERVAL '24 hours').
--     - ack_count_24h        : derived COUNT(alert_triggers WHERE
--                                acknowledged_at IS NOT NULL AND
--                                acknowledged_at >= now() - INTERVAL '24 hours').
--     - resolved_count_24h   : derived COUNT(alert_triggers WHERE
--                                resolution_notes IS NOT NULL AND
--                                timestamp >= now() - INTERVAL '24 hours').
--     - is_throttled         : derived BOOLEAN — TRUE when rule has at least
--                                one trigger within the last `throttle_window_minutes`
--                                interval (so the operator can see the
--                                throttle state without resolving it manually).
--     - is_paused            : derived alias for `enabled = FALSE` (FE chip
--                                vocabulary — alerts.tsx renders Paused vs
--                                Active using this flag).
--
--   The FE `AlertRule` interface at apps/console-v2/src/modules/platform/alerts.tsx
--   currently joins lookup_values + users via in-memory lookups (or doesn't
--   project them at all) for these derivations. Moving to a canonical view
--   exposes the canonical SSOT columns AND the FE-shaped projection
--   aliases on the same seam, so the production cutover becomes a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('alert_rule_directory')`.
--
-- Notes:
--   * SSOT remains public.alert_rules; this view is read-only.
--   * RLS is enforced by the underlying tables (alert_rules, alert_triggers,
--     lookup_values, users) via security_invoker = true.
--   * Service-role + authenticated SELECT (mirrors W22-W27 paired projection
--     grants).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/PLATFORM.md §1
--   - FE shape: apps/console-v2/src/modules/platform/alerts.tsx:106
--   - Canonical table: 202510110003_mapping_lookup.sql:176
--   - Sibling view: 202604301700_v_alert_trigger_summary.sql (paired by
--     trigger lifecycle; this view is paired by rule lifecycle).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302600_v_alert_rule_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_alert_rule_directory;

CREATE VIEW public.v_alert_rule_directory
  WITH (security_invoker = true)
  AS
WITH trigger_agg AS (
  SELECT
    at.alert_rule_id,
    MAX(at.timestamp)                                                    AS last_triggered_at,
    COUNT(*) FILTER (WHERE at.timestamp >= now() - INTERVAL '24 hours')  AS trigger_count_24h,
    COUNT(*) FILTER (
      WHERE at.acknowledged_at IS NOT NULL
        AND at.acknowledged_at >= now() - INTERVAL '24 hours'
    )                                                                    AS ack_count_24h,
    COUNT(*) FILTER (
      WHERE at.resolution_notes IS NOT NULL
        AND at.timestamp >= now() - INTERVAL '24 hours'
    )                                                                    AS resolved_count_24h
  FROM public.alert_triggers at
  GROUP BY at.alert_rule_id
),
condition_summary_proj AS (
  SELECT
    ar.id AS rule_id,
    CASE
      WHEN ar.trigger_conditions IS NULL
        OR ar.trigger_conditions = '{}'::jsonb
        THEN '— always —'
      WHEN jsonb_typeof(ar.trigger_conditions) = 'object'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(ar.trigger_conditions) AS e(key, val)
          WHERE jsonb_typeof(e.val) IN ('object', 'array')
        )
        THEN (
          SELECT string_agg(e.key || ' = ' || trim(both '"' from e.val::text), ' AND '
                            ORDER BY e.key)
          FROM jsonb_each(ar.trigger_conditions) AS e(key, val)
        )
      ELSE 'complex'
    END AS condition_summary
  FROM public.alert_rules ar
)
SELECT
  ar.id,
  ar.organization_id,
  ar.rule_name,
  ar.enabled,
  ar.priority,
  ar.trigger_source,
  ar.trigger_conditions,
  ar.throttle_window_minutes,
  ar.throttle_key_fields,
  ar.alert_severity_lookup_id,
  ar.alert_channels,
  ar.message_template_id,
  ar.message_variables,
  ar.created_by,
  ar.created_at,
  ar.updated_at,
  -- Derived: severity label resolved from canonical lookup_values (FE used to
  -- render a literal `severity` field; closes the W10-5 §1 RENAME deferral).
  lv.value                                              AS severity_label,
  -- Derived: created_by label from canonical users.full_name (NULL-safe).
  u.full_name                                           AS created_by_label,
  u.email                                               AS created_by_email,
  -- Derived: condition summary (FE-friendly textual summary of the legacy
  -- flat shape; "complex" for nested structures).
  cs.condition_summary                                  AS condition_summary,
  -- Derived: alert_channels jsonb-array length (NULL-safe).
  COALESCE(jsonb_array_length(ar.alert_channels), 0)::INT AS alert_channels_count,
  -- Derived trigger counters (canonical resolution path closes W10-5 §1
  -- REMOVE deferral on the fictional `last_triggered_at` column).
  trigger_agg.last_triggered_at,
  COALESCE(trigger_agg.trigger_count_24h, 0)::INT       AS trigger_count_24h,
  COALESCE(trigger_agg.ack_count_24h, 0)::INT           AS ack_count_24h,
  COALESCE(trigger_agg.resolved_count_24h, 0)::INT      AS resolved_count_24h,
  -- Derived flag — TRUE when the rule has fired within the throttle window
  -- and is therefore currently throttling new triggers.
  (
    trigger_agg.last_triggered_at IS NOT NULL
    AND trigger_agg.last_triggered_at >= now() - make_interval(mins => ar.throttle_window_minutes)
  )                                                     AS is_throttled,
  -- Derived alias: paused = NOT enabled (FE chip vocabulary).
  (NOT ar.enabled)                                      AS is_paused
FROM public.alert_rules ar
LEFT JOIN public.lookup_values lv ON lv.id = ar.alert_severity_lookup_id
LEFT JOIN public.users u ON u.id = ar.created_by
LEFT JOIN trigger_agg ON trigger_agg.alert_rule_id = ar.id
LEFT JOIN condition_summary_proj cs ON cs.rule_id = ar.id;

COMMENT ON VIEW public.v_alert_rule_directory IS
  'FE-friendly projection of alert_rules with severity lookup join (severity_label via lookup_values), created_by user join (created_by_label/email via users.full_name/email), derived condition_summary (textual summary of trigger_conditions), alert_channels_count, and trigger lifecycle aggregates (last_triggered_at, trigger_count_24h, ack_count_24h, resolved_count_24h, is_throttled). Sources: alert_rules + alert_triggers + lookup_values + users. Read-only; SSOT remains alert_rules; mutations go through create_alert_rule_v1 / update_alert_rule_v1 / pause_alert_rule_v1 / resume_alert_rule_v1 / delete_alert_rule_v1 / test_alert_rule_v1.';

REVOKE ALL ON public.v_alert_rule_directory FROM PUBLIC;
REVOKE ALL ON public.v_alert_rule_directory FROM anon;
GRANT SELECT ON public.v_alert_rule_directory TO authenticated;
GRANT SELECT ON public.v_alert_rule_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302600_v_alert_rule_directory'));
COMMIT;
