-- Spec-Issue: W27 INTEGRATIONS gap closure (paired projection views)
-- Step: W27-VIEW-3
-- Migration: Canonical projection view public.v_mapping_config_directory.
-- Capability: mappings.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-mapping derived joins + counters used by
--   `apps/console-v2/src/modules/integrations/mapping.tsx` (MappingConfig):
--     - target               : derived projection (mapping_config->>'target')
--                                — closes the W18-4 §6 deferral by exposing
--                                the canonical jsonb-extracted column shadow
--                                under a stable view key.
--     - target_table         : derived projection (mapping_config->>'target_table')
--                                — secondary alias when target follows the
--                                {table}.{action} convention.
--     - target_action        : derived projection (mapping_config->>'target_action')
--     - rules_count          : derived COUNT of rules array length when
--                                mapping_config carries a `rules[]` jsonb field
--     - source_count         : derived COUNT(webhook_sources WHERE
--                                mapping_config_id = mc.id)
--     - rule_usage_count     : derived COUNT(webhook_rules WHERE
--                                mapping_config_id = mc.id)
--     - is_in_use            : derived flag (source_count + rule_usage_count > 0)
--     - has_rules            : derived flag (mapping_config carries `rules[]`)
--     - notes_excerpt        : derived projection (LEFT(notes, 120)) for table
--                                hover tooltip — keeps full `notes` available
--                                via canonical column.
--     - age_seconds          : derived (now() - updated_at)::seconds
--
--   The FE `MappingConfig` interface at
--   apps/console-v2/src/modules/integrations/mapping.tsx carries:
--     - target as derived projection (W18-4 §6 deferral). This view exposes
--       the projection over the canonical SSOT plus usage counters and rule
--       presence flags.
--
-- Notes:
--   * SSOT remains public.mapping_configs; this view is read-only.
--   * RLS enforced via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302520_v_mapping_config_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_mapping_config_directory;

CREATE VIEW public.v_mapping_config_directory
  WITH (security_invoker = true)
  AS
SELECT
  mc.id,
  mc.mapping_type,
  mc.mapping_key,
  mc.mapping_config,
  mc.mapping_version,
  mc.notes,
  mc.created_at,
  mc.updated_at,
  -- Derived: target jsonb-path projection (W18-4 §6 closure)
  mc.mapping_config->>'target' AS target,
  mc.mapping_config->>'target_table' AS target_table,
  mc.mapping_config->>'target_action' AS target_action,
  -- Derived: rule array counter
  CASE
    WHEN jsonb_typeof(mc.mapping_config->'rules') = 'array'
      THEN jsonb_array_length(mc.mapping_config->'rules')
    ELSE 0
  END AS rules_count,
  -- Derived: usage counters
  COALESCE(usage_agg.source_count, 0) AS source_count,
  COALESCE(usage_agg.rule_usage_count, 0) AS rule_usage_count,
  -- Derived: status flags
  ((COALESCE(usage_agg.source_count, 0)
    + COALESCE(usage_agg.rule_usage_count, 0)) > 0) AS is_in_use,
  (jsonb_typeof(mc.mapping_config->'rules') = 'array'
    AND jsonb_array_length(mc.mapping_config->'rules') > 0) AS has_rules,
  -- Derived: notes excerpt for tooltip rendering
  CASE
    WHEN mc.notes IS NULL THEN NULL
    WHEN length(mc.notes) <= 120 THEN mc.notes
    ELSE LEFT(mc.notes, 120) || '…'
  END AS notes_excerpt,
  -- Derived: age (now-aware, deterministic at query time)
  GREATEST(0, EXTRACT(EPOCH FROM (now() - mc.updated_at)))::BIGINT AS age_seconds
FROM public.mapping_configs mc
LEFT JOIN LATERAL (
  SELECT
    (SELECT COUNT(*) FROM public.webhook_sources ws
      WHERE ws.mapping_config_id = mc.id) AS source_count,
    (SELECT COUNT(*) FROM public.webhook_rules wr
      WHERE wr.mapping_config_id = mc.id) AS rule_usage_count
) usage_agg ON TRUE;

COMMENT ON VIEW public.v_mapping_config_directory IS
  'FE-friendly projection of mapping_configs with derived jsonb-path projections (target, target_table, target_action via mapping_config jsonb), usage counters (source_count via webhook_sources, rule_usage_count via webhook_rules), rule-array counter (rules_count from mapping_config->rules), notes excerpt (first 120 chars), age derivation (age_seconds), and status flags (is_in_use, has_rules). Sources: mapping_configs + webhook_sources + webhook_rules. Read-only; SSOT remains mapping_configs; mutations go through ui_upsert_mapping_artifact_v1 / mapping_config_promote_v1.';

REVOKE ALL ON public.v_mapping_config_directory FROM PUBLIC;
REVOKE ALL ON public.v_mapping_config_directory FROM anon;
GRANT SELECT ON public.v_mapping_config_directory TO authenticated;
GRANT SELECT ON public.v_mapping_config_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302520_v_mapping_config_directory'));
COMMIT;
