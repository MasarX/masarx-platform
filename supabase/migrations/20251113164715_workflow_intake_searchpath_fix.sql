-- Fixup: pin search_path for workflow_intake_webhook to locate helper functions
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.workflow_intake_webhook(text, jsonb, text, jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) SET search_path = public, extensions, pg_temp';
  ELSE
    RAISE NOTICE 'workflow_intake_webhook not present; skipping';
  END IF;
END $$;
COMMIT;