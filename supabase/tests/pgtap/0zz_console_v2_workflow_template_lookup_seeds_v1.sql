-- Console V2 workflow-template authoring lookup seed contract.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'workflow_branch_kind'
  ),
  'workflow_branch_kind lookup definition exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_branch_kind'
       AND lv.value = 'main'
       AND lv.is_default IS TRUE
       AND lv.metadata->>'lane_index' = '0'
  ),
  'workflow_branch_kind has main default lane'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_branch_kind'
       AND lv.value = 'error'
       AND lv.metadata->>'is_error_branch' = 'true'
  ),
  'workflow_branch_kind marks error branch'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_branch_kind'
       AND lv.value = 'manual'
       AND lv.metadata->>'is_keyboard_secondary' = 'true'
  ),
  'workflow_branch_kind marks manual as secondary keyboard lane'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'workflow_step_action'
  ),
  'workflow_step_action lookup definition exists'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_step_action'
       AND lv.status = 'active'
  ) >= 6,
  'workflow_step_action includes Console V2 step action rows'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_step_action'
       AND lv.value = 'duplicate'
       AND lv.metadata->>'handler_kind' = 'duplicate'
  ),
  'workflow_step_action carries handler kind metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'condition_operator_by_type'
  ),
  'condition_operator_by_type lookup definition exists'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'condition_operator_by_type'
       AND lv.status = 'active'
       AND lv.metadata->>'field_type' = 'string'
  ) >= 7,
  'condition_operator_by_type includes string operator matrix'
);

SELECT ok(
  (
    SELECT count(*)
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'condition_operator_by_type'
       AND lv.status = 'active'
       AND lv.metadata->>'field_type' = 'unknown'
  ) >= 11,
  'condition_operator_by_type includes unknown operator matrix'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'condition_operator_by_type'
       AND lv.value = 'string:equals'
       AND lv.metadata->>'operator' = 'equals'
  ),
  'condition_operator_by_type maps string:equals to equals operator'
);

SELECT * FROM finish();

ROLLBACK;
