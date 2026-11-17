-- pgTAP: ui_command_registry tasks commands (Field Ops v1)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'tasks.complete'
            AND value->>'capability' = 'tasks.complete'
       )
  ),
  'tasks.complete command requires tasks.complete capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'tasks.exception'
            AND value->>'capability' = 'tasks.complete'
       )
  ),
  'tasks.exception command requires tasks.complete capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'tasks.en_route'
            AND value->>'capability' = 'tasks.complete'
       )
  ),
  'tasks.en_route command requires tasks.complete capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'commands'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'commands') AS value
          WHERE value->>'key' = 'tasks.arrived'
            AND value->>'capability' = 'tasks.complete'
       )
  ),
  'tasks.arrived command requires tasks.complete capability'
);

SELECT finish();

ROLLBACK;
