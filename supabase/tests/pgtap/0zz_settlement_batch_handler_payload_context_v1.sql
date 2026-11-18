-- pgTAP: settlement_batch handler supports browser-safe context.payload starts.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

SELECT ok(
  POSITION(
    'v_input := v_input || (v_input->''payload'')'
    IN pg_get_functiondef(
      'workflow_handlers.execute_settlement_batch_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
    )
  ) > 0,
  'settlement_batch handler merges context.payload into canonical RPC input'
);

SELECT * FROM finish();
ROLLBACK;
