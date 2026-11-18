-- Console V2 webhook source creation must resolve its default rate limit from
-- canonical settings rows in live DB-backed runtimes, not frontend seed data.

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
  'webhook_source_default_policy',
  'Webhook source defaults used by Console V2 source creation, including rate-limit defaults.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'webhook_source_default_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Webhook Source Default Policy",
    "type": "object",
    "additionalProperties": true,
    "required": ["default_rate_limit_per_hour"],
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "default_rate_limit_per_hour": { "type": "integer", "minimum": 1 }
    }
  }'::jsonb,
  'Default settings for Console V2 webhook source creation.',
  '[{"version":1,"default_rate_limit_per_hour":1000}]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

WITH policy_payload AS (
  SELECT
    'webhook_source_default_policy'::text AS category,
    'global'::text AS scope_type,
    NULL::uuid AS scope_id,
    '00000000-0000-0000-0000-000000000000'::uuid AS scope_hash,
    jsonb_build_object(
      'version', 1,
      'default_rate_limit_per_hour', 1000
    ) AS value
),
updated_current AS (
  UPDATE public.settings_versions sv
     SET value = pp.value,
         schema_version = 1,
         change_reason = 'Console V2 webhook source default policy seed'
    FROM policy_payload pp
   WHERE sv.category = pp.category
     AND sv.scope_type = pp.scope_type
     AND sv.scope_hash = pp.scope_hash
     AND sv.effective_until IS NULL
     AND sv.approved_at IS NOT NULL
  RETURNING sv.id, sv.category, sv.scope_type, sv.scope_id, sv.scope_hash, sv.value
),
inserted_current AS (
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
    'd62300a3-a3ae-4d44-bc40-972db6dfc550'::uuid,
    pp.category,
    pp.scope_type,
    pp.scope_id,
    pp.scope_hash,
    1,
    pp.value,
    1,
    'Console V2 webhook source default policy seed',
    now(),
    now()
  FROM policy_payload pp
  WHERE NOT EXISTS (SELECT 1 FROM updated_current)
  RETURNING id, category, scope_type, scope_id, scope_hash, value
),
current_version AS (
  SELECT * FROM updated_current
  UNION ALL
  SELECT * FROM inserted_current
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
  'ca0974ad-3932-432f-9260-32ef3a54045a'::uuid,
  cv.category,
  cv.scope_type,
  cv.scope_id,
  cv.scope_hash,
  cv.id,
  cv.value,
  now()
FROM current_version cv
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();
