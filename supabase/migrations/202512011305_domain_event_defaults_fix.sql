-- Migration: domain_event_policy defaults backfill
-- Purpose: Ensure global domain_event_policy includes prod-ready defaults (action=skip, rate_limit_per_minute=0)

BEGIN;

-- Backfill settings_versions value for global scope
WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'defaults', jsonb_build_object('action', 'skip', 'rate_limit_per_minute', 0),
    'events', COALESCE(
      (SELECT value->'events' FROM public.settings_versions sv
       WHERE sv.category = 'domain_event_policy' AND sv.scope_type = 'global' AND sv.scope_id IS NULL
       ORDER BY approved_at DESC LIMIT 1),
      '{}'::jsonb
    )
  ) AS v
), upsert_sv AS (
  UPDATE public.settings_versions sv
  SET value = p.v,
      approved_at = now()
  FROM payload p
  WHERE sv.category = 'domain_event_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
  RETURNING sv.id, sv.value
), ensure_sv AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, approved_at)
  SELECT 'domain_event_policy', 'global', NULL::uuid, 1, p.v, now()
  FROM payload p
  WHERE NOT EXISTS (SELECT 1 FROM upsert_sv)
  RETURNING id, value
), chosen AS (
  SELECT id, value FROM upsert_sv
  UNION ALL
  SELECT id, value FROM ensure_sv
)
UPDATE public.settings s
SET settings_version_id = c.id,
    cached_value = c.value,
    last_updated = now()
FROM chosen c
WHERE s.category = 'domain_event_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL;

COMMIT;
