-- Migration: Demo worker interval tuning + workflow poll reduction
-- Purpose:
--   - Reduce worker intervals for faster workflow + outbound processing during live demos.
--   - Lower workflow_defaults.poll_seconds to reduce wait latency (bounded by engine guardrails).
-- Alignment: SIMPLE, SCALABLE, DYNAMIC, row-driven.
-- Date: 2026-01-11
BEGIN;
SET search_path TO public, extensions, pg_temp;

UPDATE public.cron_config
SET interval_seconds = 10,
    updated_at = now()
WHERE worker_name IN (
  'workflow_engine_worker',
  'outbound_worker',
  'edge_api_caller_worker',
  'label_job_renderer',
  'webhook_processor_worker'
);

WITH base AS (
  SELECT
    sv.id AS settings_version_id,
    sv.value AS policy,
    s.id AS settings_id
  FROM public.settings_versions sv
  JOIN public.settings s ON s.settings_version_id = sv.id
  WHERE sv.category = 'workflow_defaults'
    AND sv.scope_type = 'global'
  ORDER BY sv.version DESC
  LIMIT 1
),
patched AS (
  SELECT
    settings_version_id,
    settings_id,
    jsonb_set(
      COALESCE(policy, '{}'::jsonb),
      '{poll_seconds}',
      to_jsonb(15),
      TRUE
    ) AS patched_policy
  FROM base
),
updated_versions AS (
  UPDATE public.settings_versions sv
  SET value = p.patched_policy,
      change_reason = COALESCE(sv.change_reason, '') || ' + reduce workflow poll_seconds for demo'
  FROM patched p
  WHERE sv.id = p.settings_version_id
    AND sv.value IS DISTINCT FROM p.patched_policy
  RETURNING sv.id
)
UPDATE public.settings s
SET cached_value = sv.value,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.settings_version_id = sv.id
  AND s.category = 'workflow_defaults'
  AND (
    sv.id IN (SELECT id FROM updated_versions)
    OR s.cached_value IS DISTINCT FROM sv.value
  );

COMMIT;
