-- Test Suite: Mobile V2 incident policy
-- Validates 202605170000_mobile_incident_policy_v1 has registered the
-- `mobile_incident_policy` settings category, its JSON Schema, and a
-- global default seed so the FieldOps V2 incident report sheet resolves
-- its type registry through the standard settings ladder (closes
-- engineering audit B1 / I2).
--
-- Assertions:
--   1)  category registered in settings_category_registry
--   2)  category requires a schema + a global default
--   3)  category resource_scope_rel = public.branches (hub overrides)
--   4)  active JSON Schema registered for version 1
--   5)  schema requires version + types
--   6)  schema types[].severity enum is {high, med, low}
--   7)  schema types[].needs enum is {photo, geo, statement, call_112, call_999}
--   8)  global default settings_versions row exists + approved
--   9)  global default settings cache row exists
--   10) cached_value matches the versioned value
--   11) default payload carries version + non-empty types array
--   12) default registry has exactly 6 incident types
--   13) collision type is high severity with photo+geo+statement needs
--   14) every default type carries id/label/icon/severity
--   15) every default type's severity is a valid enum value
--
-- Single transaction; ROLLBACK at end keeps the DB clean.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

-- ===========================================================================
-- 1) Category registered
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
     WHERE category = 'mobile_incident_policy'
  ),
  'mobile_incident_policy registered in settings_category_registry'
);

-- ===========================================================================
-- 2) Requires schema + global default
-- ===========================================================================

SELECT ok(
  (SELECT requires_schema AND requires_global_default
     FROM public.settings_category_registry
    WHERE category = 'mobile_incident_policy'),
  'mobile_incident_policy requires a schema and a global default'
);

-- ===========================================================================
-- 3) resource_scope_rel = public.branches (hub override surface)
-- ===========================================================================

SELECT is(
  (SELECT resource_scope_rel::text
     FROM public.settings_category_registry
    WHERE category = 'mobile_incident_policy'),
  'branches',
  'mobile_incident_policy resource scope is public.branches'
);

-- ===========================================================================
-- 4) Active JSON Schema registered
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
     WHERE category = 'mobile_incident_policy'
       AND version = 1
       AND is_active = TRUE
  ),
  'mobile_incident_policy v1 JSON Schema is registered and active'
);

-- ===========================================================================
-- 5) Schema requires version + types
-- ===========================================================================

SELECT ok(
  (
    SELECT (schema -> 'required') ? 'version'
       AND (schema -> 'required') ? 'types'
      FROM public.schema_registry
     WHERE category = 'mobile_incident_policy' AND version = 1
  ),
  'mobile_incident_policy schema requires version + types'
);

-- ===========================================================================
-- 6) severity enum
-- ===========================================================================

SELECT ok(
  (
    SELECT (
      schema -> 'properties' -> 'types' -> 'items' -> 'properties'
             -> 'severity' -> 'enum'
    ) = jsonb_build_array('high', 'med', 'low')
      FROM public.schema_registry
     WHERE category = 'mobile_incident_policy' AND version = 1
  ),
  'mobile_incident_policy schema types[].severity enum = {high, med, low}'
);

-- ===========================================================================
-- 7) needs enum
-- ===========================================================================

SELECT ok(
  (
    SELECT (
      schema -> 'properties' -> 'types' -> 'items' -> 'properties'
             -> 'needs' -> 'items' -> 'enum'
    ) = jsonb_build_array('photo', 'geo', 'statement', 'call_112', 'call_999')
      FROM public.schema_registry
     WHERE category = 'mobile_incident_policy' AND version = 1
  ),
  'mobile_incident_policy schema types[].needs enum = {photo,geo,statement,call_112,call_999}'
);

-- ===========================================================================
-- 8) Global default settings_versions row, approved
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
     WHERE category = 'mobile_incident_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND effective_until IS NULL
       AND approved_at IS NOT NULL
  ),
  'mobile_incident_policy has an approved global settings_versions row'
);

-- ===========================================================================
-- 9) Global default settings cache row
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
     WHERE category = 'mobile_incident_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  'mobile_incident_policy has a global settings cache row'
);

-- ===========================================================================
-- 10) cached_value matches versioned value
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND s.cached_value = sv.value
  ),
  'mobile_incident_policy settings.cached_value matches settings_versions.value'
);

-- ===========================================================================
-- 11) Default payload shape
-- ===========================================================================

SELECT ok(
  (
    SELECT (sv.value ? 'version')
       AND (sv.value ? 'types')
       AND jsonb_typeof(sv.value -> 'types') = 'array'
       AND jsonb_array_length(sv.value -> 'types') > 0
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ),
  'mobile_incident_policy default payload carries version + non-empty types'
);

-- ===========================================================================
-- 12) Exactly 6 default incident types
-- ===========================================================================

SELECT is(
  (
    SELECT jsonb_array_length(sv.value -> 'types')
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ),
  6,
  'mobile_incident_policy default registry has exactly 6 incident types'
);

-- ===========================================================================
-- 13) collision type — high severity with photo+geo+statement needs
-- ===========================================================================

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'types') AS t
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND t->>'id' = 'collision'
       AND t->>'severity' = 'high'
       AND (t -> 'needs') ? 'photo'
       AND (t -> 'needs') ? 'geo'
       AND (t -> 'needs') ? 'statement'
  ),
  'mobile_incident_policy collision type is high-severity + photo/geo/statement'
);

-- ===========================================================================
-- 14) Every default type carries id/label/icon/severity
-- ===========================================================================

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'types') AS t
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND (
         COALESCE(length(t->>'id'), 0) = 0
         OR COALESCE(length(t->>'label'), 0) = 0
         OR COALESCE(length(t->>'icon'), 0) = 0
         OR COALESCE(length(t->>'severity'), 0) = 0
       )
  ),
  'every mobile_incident_policy default type carries id/label/icon/severity'
);

-- ===========================================================================
-- 15) Every default type severity is a valid enum value
-- ===========================================================================

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
           jsonb_array_elements(sv.value -> 'types') AS t
     WHERE s.category = 'mobile_incident_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND t->>'severity' NOT IN ('high', 'med', 'low')
  ),
  'every mobile_incident_policy default type severity is a valid enum value'
);

SELECT * FROM finish();
ROLLBACK;
