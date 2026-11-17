-- Migration: Disable label bundle synthesize fallback by default
-- Purpose:
--   Align with "no workarounds" objective by defaulting label_print_defaults
--   synthesize_from_existing=false (tenants may override explicitly if needed).
-- Date: 2025-12-15 09:10 UTC

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Retire the currently-approved "global" row so a new current row can be inserted
-- (enforced by unique index on (category, scope_type, scope_hash) for approved, open-ended rows).
UPDATE public.settings_versions
SET effective_until = now()
WHERE category = 'label_print_defaults'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL;

WITH desired AS (
  SELECT jsonb_build_object(
    'synthesize_from_existing', FALSE,
    'prefer_signed_url', TRUE
  ) AS payload
),
next_version AS (
  SELECT COALESCE(MAX(version), 0) + 1 AS version
  FROM public.settings_versions
  WHERE category = 'label_print_defaults'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
),
ins_ver AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'label_print_defaults',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    next_version.version,
    desired.payload,
    1,
    'Default: disable synthesize_from_existing (no workarounds)',
    now(),
    now()
  FROM desired, next_version
  RETURNING id, value
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  gen_random_uuid(),
  'label_print_defaults',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  ins_ver.id,
  ins_ver.value,
  now()
FROM ins_ver
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

COMMIT;
