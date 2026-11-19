-- Console V2 amend operation mapping + workflow trigger SSOT sync contracts.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

SELECT is(
  (
    SELECT lv.metadata->>'backend_operation'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_amend_op'
      AND lv.value = 'amend_address'
  ),
  'address',
  'amend_address maps to backend address operation'
);

SELECT is(
  (
    SELECT lv.metadata->>'backend_operation'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_amend_op'
      AND lv.value = 'amend_cod'
  ),
  'modify',
  'amend_cod maps to backend modify operation'
);

SELECT is(
  (
    SELECT lv.metadata->>'backend_operation'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_amend_op'
      AND lv.value = 'cancel'
  ),
  'cancel',
  'cancel maps to backend cancel operation'
);

SELECT is(
  (
    SELECT lv.metadata->>'backend_operation'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_amend_op'
      AND lv.value = 'reschedule'
  ),
  'reschedule',
  'reschedule maps to backend reschedule operation'
);

SELECT ok(
  to_regprocedure('public.workflow_template_step_trigger_metadata_sync_v1()') IS NOT NULL,
  'workflow trigger metadata sync function exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'workflow_template_step_trigger_metadata_sync_tg'
      AND tgrelid = 'public.workflow_template_steps'::regclass
      AND NOT tgisinternal
  ),
  'workflow trigger metadata sync trigger exists on workflow_template_steps'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.workflow_template_step_trigger_metadata_sync_v1()')) LIKE '%UPDATE public.workflow_templates%',
  'workflow trigger metadata sync writes workflow_templates metadata'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.workflow_template_step_trigger_metadata_sync_v1()')) LIKE '%trigger_event%',
  'workflow trigger metadata sync propagates trigger_event'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.workflow_template_step_trigger_metadata_sync_v1()')) LIKE '%trigger_conditions%',
  'workflow trigger metadata sync propagates trigger_conditions'
);

SELECT ok(
  pg_get_viewdef('public.workflow_templates_console_v1'::regclass, true) LIKE '%wt.metadata ->> ''trigger_event''%',
  'Console workflow template projection reads trigger_event from workflow_templates metadata'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_v1(jsonb)')) LIKE '%modify%'
  AND pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_v1(jsonb)')) LIKE '%address%',
  'shipment_amend_cancel_v1 backend operation contract includes modify and address'
);

SELECT ok(
  to_regprocedure('public.shipment_amend_cancel_execute_base_v1(jsonb)') IS NOT NULL,
  'shipment amend/cancel base executor exists behind the response facade'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_execute_v1(jsonb)')) LIKE '%workflow_template_name%'
  AND pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_execute_v1(jsonb)')) LIKE '%workflow_template_id%',
  'shipment amend/cancel execute response exposes workflow template evidence'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_execute_v1(jsonb)')) LIKE '%public.workflow_runs%'
  AND pg_get_functiondef(to_regprocedure('public.shipment_amend_cancel_execute_v1(jsonb)')) LIKE '%public.workflow_templates%',
  'shipment amend/cancel execute response resolves workflow evidence server-side'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.transition_task_v1(uuid,text,text,jsonb,text)')) LIKE '%tasks.complete%',
  'task transition backend contract requires tasks.complete'
);

SELECT * FROM finish();

ROLLBACK;
