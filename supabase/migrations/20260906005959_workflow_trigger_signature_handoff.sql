BEGIN;
SET LOCAL lock_timeout = '30s';

-- The next migration replaces the defaulted scope argument with explicit overloads.
DO $handoff$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('api.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)')
      AND pronargdefaults > 0
  ) THEN
    DROP FUNCTION api.ui_create_workflow_run_trigger_v1(uuid, uuid, text[], jsonb, boolean, text, uuid) RESTRICT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)')
      AND pronargdefaults > 0
  ) THEN
    DROP FUNCTION public.ui_create_workflow_run_trigger_v1(uuid, uuid, text[], jsonb, boolean, text, uuid) RESTRICT;
  END IF;
END;
$handoff$;

COMMIT;
