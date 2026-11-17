-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS item ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'settlements'
  ),
  'ui_read_registry includes settlements resource'
);

SELECT is(
  (
    SELECT item->>'relation'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS item ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'settlements'
    LIMIT 1
  ),
  'public.settlement_batches',
  'settlements resource reads from settlement_batches'
);

SELECT is(
  (
    SELECT item->>'capability_read'
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS item ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'settlements'
    LIMIT 1
  ),
  'tasks.read',
  'settlements resource uses tasks.read operational capability contract'
);

SELECT has_function(
  'public',
  'can_read_settlement_batch_v1',
  ARRAY['uuid', 'uuid', 'text', 'uuid'],
  'can_read_settlement_batch_v1 helper exists'
);

SELECT has_function(
  'public',
  'ui_read_registry_settlements_resource_v1',
  ARRAY[]::text[],
  'ui_read_registry_settlements_resource_v1 helper exists'
);

SELECT finish();
ROLLBACK;
