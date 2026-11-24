BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL client_min_messages TO notice;
SELECT plan(1);

DO $catalog$
DECLARE
  v_signature text;
  v_function record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.create_task_v1(text,jsonb,text,uuid,text,integer,integer,text,jsonb)',
    'public.run_workflow_run_triggers_worker()',
    'public.create_task_system_v1(jsonb)',
    'public.ui_start_tabular_import_run_v1(uuid,jsonb)',
    'workflow_handlers.execute_task_enqueue_v2(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'workflow_handlers.execute_settings_apply_v1(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'workflow_handlers.execute_manual_review_wait_v1(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'workflow_handlers.execute_zone_override_apply_v1(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'public.resolve_manual_review_task_v1(uuid,text,text)'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid) AS definition, p.proacl AS acl, pg_get_userbyid(p.proowner) AS owner
      INTO STRICT v_function
      FROM pg_proc p WHERE p.oid = v_signature::regprocedure;
    RAISE NOTICE 'B08_CATALOG %', json_build_object(
      'signature', v_signature, 'definition', v_function.definition,
      'acl', v_function.acl, 'owner', v_function.owner
    );
  END LOOP;
END;
$catalog$;

SELECT pass('workflow approval catalog collected');
SELECT * FROM finish();
ROLLBACK;
