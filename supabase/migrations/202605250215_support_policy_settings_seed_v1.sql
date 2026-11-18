-- Migration: Console V2 support policy settings seed
-- Purpose: Make the Support profile context limits production-backed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605250215_support_policy_settings_seed_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'support_policy',
  'Support console policy for profile context panels and related readback limits.',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global","tenant","client","sender","source","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'support_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Support Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "recent_shipments_limit": { "type": "integer", "minimum": 0 },
      "recent_decisions_limit": { "type": "integer", "minimum": 0 }
    },
    "required": ["recent_shipments_limit", "recent_decisions_limit"]
  }'::jsonb,
  'Support console context panel policy.',
  '[{ "version": 1, "recent_shipments_limit": 6, "recent_decisions_limit": 5 }]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

WITH payload AS (
  SELECT
    'support_policy'::text AS category,
    jsonb_build_object(
      'version', 1,
      'recent_shipments_limit', 6,
      'recent_decisions_limit', 5
    ) AS body
),
inserted_versions AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    approved_at
  )
  SELECT
    p.category,
    'global',
    NULL::uuid,
    1,
    p.body,
    1,
    now()
  FROM payload p
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = p.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING category, scope_type, scope_id, id, value
),
current_versions AS (
  SELECT category, scope_type, scope_id, id, value
  FROM inserted_versions
  UNION ALL
  SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value
  FROM public.settings_versions sv
  JOIN payload p ON p.category = sv.category
  WHERE sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
  ORDER BY category, id
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT DISTINCT ON (category)
  category,
  scope_type,
  scope_id,
  id,
  value,
  now()
FROM current_versions
ORDER BY category, id
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = now();

SELECT pg_advisory_unlock(hashtext('202605250215_support_policy_settings_seed_v1'));

COMMIT;
