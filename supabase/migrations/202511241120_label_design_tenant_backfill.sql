-- Migration: Tenant label_design backfill from global template
-- Purpose: Ensure organizations without label_design settings inherit the dynamic template locally.

BEGIN;

WITH global_template AS (
  SELECT
    sv.schema_version,
    s.cached_value
  FROM settings s
  JOIN settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'label_design'
    AND s.scope_type = 'global'
  ORDER BY s.last_updated DESC
  LIMIT 1
),
tenant_targets AS (
  SELECT o.id AS organization_id, o.slug
  FROM organizations o
  WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND o.slug <> 'global-root'
    AND NOT EXISTS (
    SELECT 1
    FROM settings s
    WHERE s.category = 'label_design'
      AND s.scope_type = 'tenant'
      AND s.scope_id = o.id
  )
),
insert_versions AS (
  INSERT INTO settings_versions (
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
    'label_design',
    'tenant',
    t.organization_id,
    t.organization_id,
    1,
    gt.cached_value,
    gt.schema_version,
    format('Tenant label_design backfill (%s)', t.slug),
    now(),
    now()
  FROM tenant_targets t
  CROSS JOIN global_template gt
  RETURNING id, scope_id, value
)
INSERT INTO settings (
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
  'label_design',
  'tenant',
  v.scope_id,
  v.scope_id,
  v.id,
  v.value,
  now()
FROM insert_versions v;

COMMIT;
