-- pgTAP: Console V2 bank deposit slip human completion metadata

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_bank_deposit_task_human_completion_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_step record;
  v_action record;
  v_task_type record;
BEGIN
  SELECT l.*
    INTO v_action
    FROM public.lookup_values l
    JOIN public.lookup_definitions d ON d.id = l.lookup_definition_id
   WHERE d.category = 'task_action_kind'
     AND l.value = 'record_deposit_slip'
   LIMIT 1;

  RETURN NEXT ok(v_action.id IS NOT NULL, 'task_action_kind.record_deposit_slip exists');
  RETURN NEXT is(v_action.label, 'Record deposit slip', 'record_deposit_slip has operator label');
  RETURN NEXT is(v_action.metadata->>'next_status', 'completed', 'record_deposit_slip completes the task');

  SELECT l.*
    INTO v_task_type
    FROM public.lookup_values l
    JOIN public.lookup_definitions d ON d.id = l.lookup_definition_id
   WHERE d.category = 'task_type'
     AND l.value = 'bank_deposit_slip_create'
   LIMIT 1;

  RETURN NEXT ok(v_task_type.id IS NOT NULL, 'task_type.bank_deposit_slip_create exists');
  RETURN NEXT is(v_task_type.label, 'Bank deposit slip', 'bank deposit task type has operator label');
  RETURN NEXT ok(
    NULLIF(v_task_type.metadata->>'reviewer_description', '') IS NOT NULL,
    'bank deposit task type has reviewer description'
  );

  SELECT s.*
    INTO v_step
    FROM public.workflow_template_steps s
    JOIN public.workflow_templates t ON t.id = s.workflow_template_id
   WHERE COALESCE(t.template_key, t.name) = 'bank_deposit_reconciliation_v2'
     AND s.operation_name = 'deposit_slip_task_enqueue'
   LIMIT 1;

  RETURN NEXT ok(v_step.id IS NOT NULL, 'bank deposit v2 slip enqueue step exists');
  RETURN NEXT ok(
    (v_step.metadata->'task_metadata'->'allowed_actions') ? 'record_deposit_slip',
    'slip enqueue step exposes record_deposit_slip action'
  );
  RETURN NEXT is(
    v_step.metadata->'task_metadata'->'completion_payload_schema'->>'action_kind',
    'record_deposit_slip',
    'slip enqueue step carries matching completion payload schema'
  );
  RETURN NEXT is(v_step.metadata->>'queue_key', 'finance', 'slip enqueue step routes to finance queue');
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_bank_deposit_task_human_completion_v1();

SELECT * FROM finish();

ROLLBACK;
