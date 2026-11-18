-- Console V2 workflow-template status actions must be seeded canonically.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'workflow_status'
  ),
  'workflow_status lookup definition exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.value = 'active'
       AND lv.metadata->>'toggle_to' = 'inactive'
       AND lv.metadata->>'toggle_label' = 'Deactivate'
       AND lv.metadata->>'toggle_kind' = 'danger'
       AND lv.metadata->>'toggle_icon' = 'lock'
  ),
  'active workflow status carries deactivate toggle metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.value = 'inactive'
       AND lv.metadata->>'toggle_to' = 'active'
       AND lv.metadata->>'toggle_label' = 'Activate'
       AND lv.metadata->>'toggle_kind' = 'primary'
       AND lv.metadata->>'toggle_icon' = 'check'
  ),
  'inactive workflow status carries activate toggle metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.value = 'draft'
       AND lv.metadata->>'toggle_to' = 'active'
  ),
  'draft workflow status can activate through row metadata'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.status = 'active'
       AND lv.metadata ? 'toggle_kind'
  ) >= 4,
  'workflow status rows carry row-driven button presentation metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.status = 'active'
       AND lv.metadata ? 'toggle_to'
       AND COALESCE(lv.metadata->>'toggle_kind', '') NOT IN ('primary', 'ghost', 'danger')
  ),
  'workflow status toggle_kind values map to Console V2 button presentation'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_status'
       AND lv.status = 'active'
       AND lv.metadata ? 'toggle_to'
       AND COALESCE(lv.metadata->>'toggle_icon', '') = ''
  ),
  'workflow status toggle presentation includes an icon for each active row'
);

SELECT * FROM finish();

ROLLBACK;
