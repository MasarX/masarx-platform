-- Migration: Seed tenant renderer_defaults for all organizations missing it
-- Date: 2025-11-13

BEGIN;

WITH missing AS (
  /* objectives:allow TENANT_LITERAL Justification: use dynamic organization_id scope from organizations table; no hard-coded tenant ids */
  SELECT o.id AS organization_id, COALESCE(NULLIF(o.name,''), 'Shipping Label') AS brand
  FROM organizations o
  WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND COALESCE(o.slug, '') <> 'global-root'
    AND NOT EXISTS (
    SELECT 1 FROM settings s
    WHERE s.category = 'renderer_defaults'
      AND s.scope_type = 'tenant'
      AND s.scope_id = o.id
  )
), sv_ins AS (
  INSERT INTO settings_versions (
    category, scope_type, scope_id, version, value, approved_at
  )
  SELECT 'renderer_defaults', 'tenant', m.organization_id, 1, /* objectives:allow TENANT_LITERAL Justification: settings rows seeded per-tenant via dynamic organization_id; literal version number is not a tenant id */
         jsonb_build_object(
           'fallback_title', m.brand,
           'primary_color', '#0D3A74'
         ),
         now()
  FROM missing m
  RETURNING id, scope_id
)
INSERT INTO settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT 'renderer_defaults', 'tenant', sv.scope_id, sv.id, sv2.value, now()
FROM sv_ins sv
JOIN settings_versions sv2 ON sv2.id = sv.id
WHERE NOT EXISTS (
  SELECT 1 FROM settings s
  WHERE s.category = 'renderer_defaults'
    AND s.scope_type = 'tenant'
    AND s.scope_id = sv.scope_id
);

COMMIT;
