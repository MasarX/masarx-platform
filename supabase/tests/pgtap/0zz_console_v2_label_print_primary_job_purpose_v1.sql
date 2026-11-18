BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  pg_get_functiondef(
    'workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  ) LIKE '%NULLIF(v_context #>> ''{ui_command,params,job_purpose}'', '''')%',
  'label print workflow reads explicit command job_purpose'::text
);

SELECT ok(
  pg_get_functiondef(
    'workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  ) LIKE '%''job_purpose'', v_job_purpose%',
  'label print workflow forwards job_purpose to label-renderer payload'::text
);

SELECT is(
  (
    SELECT command->'execution'->'params'->>'fallback_mode'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'none',
  'shipments.print_labels remains a no-fallback backend command'
);

SELECT is(
  (
    SELECT command->>'workflow_key'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'labels_print_workflow_v2',
  'shipments.print_labels still executes the canonical label print workflow'
);

SELECT * FROM finish();

ROLLBACK;
