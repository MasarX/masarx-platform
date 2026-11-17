SET search_path TO public, extensions, pg_temp;
BEGIN;
SELECT plan(3);

SELECT is(
    (SELECT COUNT(*)::INT FROM non_engine_outbound_calls_v),
    0::INT,
    'All outbound_calls rows are linked to workflow_run_steps'
);

SELECT is(
    (SELECT COUNT(*)::INT FROM outbound_calls WHERE workflow_run_step_id IS NULL),
    0::INT,
    'No outbound_calls rows without workflow_run_step_id'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_trigger
        JOIN pg_proc ON pg_proc.oid = pg_trigger.tgfoid
        JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
        WHERE pg_trigger.tgrelid = 'public.outbound_calls'::regclass
          AND pg_trigger.tgisinternal = FALSE
          AND pg_trigger.tgenabled <> 'D'
          AND pg_namespace.nspname = 'public'
          AND pg_proc.proname = 'enforce_workflow_guardrails'
    ),
    'Outbound calls guardrails trigger enforcing workflow linkage exists'
);

SELECT finish();
ROLLBACK;
