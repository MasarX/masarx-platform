-- Migration: Make webhook_ack_history compatibility view insertable
-- Purpose:
--   - Some legacy intake paths still execute `INSERT INTO webhook_ack_history`.
--   - webhook_ack_history is a read-only compatibility view backed by decision_log.
--   - Provide an INSTEAD OF INSERT trigger so inserts succeed (persistence is via decision_log).
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION public.webhook_ack_history_insert_noop()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF to_regclass('public.webhook_ack_history') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS webhook_ack_history_insert_noop ON public.webhook_ack_history;
        CREATE TRIGGER webhook_ack_history_insert_noop
        INSTEAD OF INSERT ON public.webhook_ack_history
        FOR EACH ROW
        EXECUTE FUNCTION public.webhook_ack_history_insert_noop();
    END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.webhook_ack_history_insert_noop() FROM PUBLIC;

COMMIT;

