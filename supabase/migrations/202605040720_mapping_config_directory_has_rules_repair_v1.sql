-- Spec-Issue: W27 INTEGRATIONS projection repair
-- Step: W27-MAPPING-HAS-RULES-REPAIR-1
-- Migration: Ensure v_mapping_config_directory.has_rules is always boolean.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031690_mapping_config_directory_has_rules_repair_v1'));
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
  mc.mapping_config->>'target' AS target,
  mc.mapping_config->>'target_table' AS target_table,
  mc.mapping_config->>'target_action' AS target_action,
  CASE
    WHEN jsonb_typeof(mc.mapping_config->'rules') = 'array'
      THEN jsonb_array_length(mc.mapping_config->'rules')
    ELSE 0
  END AS rules_count,
  COALESCE(usage_agg.source_count, 0) AS source_count,
  COALESCE(usage_agg.rule_usage_count, 0) AS rule_usage_count,
  ((COALESCE(usage_agg.source_count, 0)
    + COALESCE(usage_agg.rule_usage_count, 0)) > 0) AS is_in_use,
  COALESCE(
    jsonb_typeof(mc.mapping_config->'rules') = 'array'
      AND jsonb_array_length(mc.mapping_config->'rules') > 0,
    FALSE
  ) AS has_rules,
  CASE
    WHEN mc.notes IS NULL THEN NULL
    WHEN length(mc.notes) <= 120 THEN mc.notes
    ELSE LEFT(mc.notes, 120) || '...'
  END AS notes_excerpt,
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
  'FE-friendly projection of mapping_configs with derived target fields, usage counters, rules_count, boolean has_rules, notes excerpt, age_seconds, and status flags. Sources: mapping_configs + webhook_sources + webhook_rules. Read-only; SSOT remains mapping_configs.';

REVOKE ALL ON public.v_mapping_config_directory FROM PUBLIC;
REVOKE ALL ON public.v_mapping_config_directory FROM anon;
GRANT SELECT ON public.v_mapping_config_directory TO authenticated;
GRANT SELECT ON public.v_mapping_config_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605031690_mapping_config_directory_has_rules_repair_v1'));
COMMIT;
