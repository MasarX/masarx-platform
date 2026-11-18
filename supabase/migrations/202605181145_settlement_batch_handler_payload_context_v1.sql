-- Repair settlement_batch workflow handler input normalization.
-- Browser-safe workflow starts store operator input under context.payload while
-- service starts may pass the same keys at the context root. The handler must
-- merge both shapes before calling the canonical settlement RPCs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605181145_settlement_batch_handler_payload_context_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_signature REGPROCEDURE :=
    'workflow_handlers.execute_settlement_batch_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure;
  v_sql TEXT;
  v_needle TEXT :=
    '  IF jsonb_typeof(v_input) <> ''object'' THEN';
  v_patch TEXT :=
    '  IF jsonb_typeof(v_input->''payload'') = ''object'' THEN
    v_input := v_input || (v_input->''payload'');
  END IF;

  IF jsonb_typeof(v_input) <> ''object'' THEN';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_sql;

  IF POSITION('v_input := v_input || (v_input->''payload'')' IN v_sql) = 0 THEN
    IF POSITION(v_needle IN v_sql) = 0 THEN
      RAISE EXCEPTION 'execute_settlement_batch_v1 patch anchor not found'
        USING ERRCODE = '42704';
    END IF;
    v_sql := REPLACE(v_sql, v_needle, v_patch);
    EXECUTE v_sql;
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605181145_settlement_batch_handler_payload_context_v1'));
COMMIT;
