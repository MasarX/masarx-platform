-- pgTAP: cod.read capability registered in canonical access_control_policy SSOT
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

-- 1) cod.read is in the canonical capabilities[] of access_control_policy global scope
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'capabilities') AS cap
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND cap->>'key' = 'cod.read'
  ),
  'cod.read capability resolves at global access_control_policy ladder scope'
);

-- 2) ops_admin role grants cod.read (super_admin uses '*' wildcard so we only verify ops_admin here)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings sv,
           jsonb_array_elements(sv.cached_value->'roles') AS role,
           jsonb_array_elements(role->'capability_keys') AS cap_key
     WHERE sv.category = 'access_control_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
       AND role->>'key' = 'ops_admin'
       AND cap_key #>> '{}' = 'cod.read'
  ),
  'ops_admin role has cod.read capability granted in access_control_policy'
);

SELECT * FROM finish();
ROLLBACK;
