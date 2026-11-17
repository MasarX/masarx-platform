BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH source_template AS (
  SELECT id
  FROM public.workflow_templates
  WHERE name = 'labels_print_workflow_v2'
  LIMIT 1
),
archive_template AS (
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid(),
    'labels_print_workflow_v2_history',
    'Historical archive for labels_print_workflow_v2 template steps preserved to keep workflow run references valid during shared-environment migration repair.',
    1,
    'archived',
    'global',
    NULL,
    'Created by the shared-environment migration repair guard before 202603062500 redefines the active labels_print_workflow_v2 template steps.',
    now(),
    now()
  WHERE EXISTS (SELECT 1 FROM source_template)
  ON CONFLICT (name) DO UPDATE
  SET description = EXCLUDED.description,
      status = 'archived',
      notes = EXCLUDED.notes,
      updated_at = now()
  RETURNING id
),
effective_archive AS (
  SELECT id
  FROM archive_template

  UNION ALL

  SELECT wt.id
  FROM public.workflow_templates wt
  WHERE wt.name = 'labels_print_workflow_v2_history'
    AND NOT EXISTS (SELECT 1 FROM archive_template)
),
referenced_steps AS (
  SELECT DISTINCT wts.id
  FROM public.workflow_template_steps wts
  JOIN source_template st
    ON st.id = wts.workflow_template_id
  WHERE EXISTS (
          SELECT 1
          FROM public.workflow_runs wr
          WHERE wr.current_step_id = wts.id
        )
     OR EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_template_step_id = wts.id
        )
)
UPDATE public.workflow_template_steps wts
SET workflow_template_id = (
      SELECT id
      FROM effective_archive
      LIMIT 1
    ),
    updated_at = now()
WHERE wts.id IN (SELECT id FROM referenced_steps)
  AND EXISTS (SELECT 1 FROM effective_archive)
  AND EXISTS (SELECT 1 FROM source_template WHERE id = wts.workflow_template_id);

COMMIT;
