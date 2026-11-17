-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04
-- pgTAP: workflow_template_steps routing fields are editable via ui_read_registry.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.cached_value->'resources') AS value
          WHERE value->>'key' = 'workflow_template_steps'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'columns', '[]'::jsonb)) AS col
               WHERE col->>'key' = 'condition_jsonlogic'
                 AND lower(COALESCE(col->>'edit_mode', 'none')) IN ('inline','modal','form')
                 AND col->>'edit_permission' = 'workflow_runs.write'
            )
       )
  ),
  'ui_read_registry workflow_template_steps allows editing condition_jsonlogic'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.cached_value->'resources') AS value
          WHERE value->>'key' = 'workflow_template_steps'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'columns', '[]'::jsonb)) AS col
               WHERE col->>'key' = 'next_operation_name'
                 AND lower(COALESCE(col->>'edit_mode', 'none')) IN ('inline','modal','form')
                 AND col->>'edit_permission' = 'workflow_runs.write'
            )
       )
  ),
  'ui_read_registry workflow_template_steps allows editing next_operation_name'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.cached_value->'resources') AS value
          WHERE value->>'key' = 'workflow_template_steps'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'columns', '[]'::jsonb)) AS col
               WHERE col->>'key' = 'next_operation_priority'
                 AND lower(COALESCE(col->>'edit_mode', 'none')) IN ('inline','modal','form')
                 AND col->>'edit_permission' = 'workflow_runs.write'
            )
       )
  ),
  'ui_read_registry workflow_template_steps allows editing next_operation_priority'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.cached_value->'resources') AS value
          WHERE value->>'key' = 'workflow_template_steps'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'columns', '[]'::jsonb)) AS col
               WHERE col->>'key' = 'next_operation_delay_seconds'
                 AND lower(COALESCE(col->>'edit_mode', 'none')) IN ('inline','modal','form')
                 AND col->>'edit_permission' = 'workflow_runs.write'
            )
       )
  ),
  'ui_read_registry workflow_template_steps allows editing next_operation_delay_seconds'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.cached_value->'resources') AS value
          WHERE value->>'key' = 'workflow_template_steps'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(value->'columns', '[]'::jsonb)) AS col
               WHERE col->>'key' = 'metadata'
                 AND lower(COALESCE(col->>'edit_mode', 'none')) IN ('inline','modal','form')
                 AND col->>'edit_permission' = 'workflow_runs.write'
            )
       )
  ),
  'ui_read_registry workflow_template_steps allows editing metadata'
);

SELECT * FROM finish();
ROLLBACK;

