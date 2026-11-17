-- Migration: UC080 routes RBAC permissions seed v1
BEGIN;
SELECT pg_advisory_lock(hashtext('202604062250_rbac_routes_permissions_seed_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('routes.read', 'Routes Read', 'Read route run projections, assignments, and route-level execution ownership.', 150, '{"resource":"routes","action":"read"}'),
  ('routes.write', 'Routes Write', 'Assign route runs and manage route assignment responses.', 160, '{"resource":"routes","action":"write"}')
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'rbac_permission'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH permission_registry AS (
  SELECT lv.id, lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value IN ('routes.read', 'routes.write')
), template_perm_map AS (
  SELECT *
  FROM (VALUES
    ('ops_admin', 'routes.read'),
    ('ops_admin', 'routes.write'),
    ('driver', 'routes.read')
  ) AS v(template_key, permission_value)
)
INSERT INTO public.rbac_role_template_permissions (
  role_template_id,
  permission_id,
  metadata
)
SELECT
  t.id,
  p.id,
  jsonb_build_object('seed', TRUE, 'source', 'uc080_routes_rbac_permissions_seed_v1')
FROM template_perm_map m
JOIN public.rbac_role_templates t ON t.key = m.template_key
JOIN permission_registry p ON p.value = m.permission_value
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202604062250_rbac_routes_permissions_seed_v1'));
COMMIT;
