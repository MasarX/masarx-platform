BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL row_security = off;

-- The next migration creates both canonical ledgers, indexes, policies, and the directory.
DO $handoff$
BEGIN
  IF to_regclass('public.intake_auth_rejections') IS NULL
     AND to_regclass('public.webhook_source_token_history') IS NULL THEN
    RETURN;
  END IF;

  LOCK TABLE public.intake_auth_rejections, public.webhook_source_token_history
    IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.intake_auth_rejections'::regclass
      AND tgname = 'intake_auth_rejections_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.intake_auth_rejections)
     OR EXISTS (SELECT 1 FROM public.webhook_source_token_history) THEN
    RAISE EXCEPTION 'Intake ledger handoff requires empty ledgers';
  END IF;

  DROP VIEW public.v_intake_auth_rejection_directory RESTRICT;
  DROP TABLE public.intake_auth_rejections, public.webhook_source_token_history RESTRICT;
END;
$handoff$;

COMMIT;
