-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04
-- Migration: Guard operation_handlers signature validation to handler identity changes only
-- Purpose: Allow UI metadata updates on operation_handlers without re-validating unchanged handler procedures.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601210920_operation_handlers_validate_signature_guard'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.validate_operation_handler_signature()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_proc REGPROCEDURE;
BEGIN
    -- Only validate on INSERT, or when the handler identity changes.
    IF TG_OP = 'UPDATE'
      AND NEW.handler_schema IS NOT DISTINCT FROM OLD.handler_schema
      AND NEW.handler_name IS NOT DISTINCT FROM OLD.handler_name
      AND NEW.handler_signature IS NOT DISTINCT FROM OLD.handler_signature THEN
        RETURN NEW;
    END IF;

    -- Ensure composite types resolve even when caller search_path omits public/extensions.
    PERFORM set_config('search_path', 'public, extensions, pg_temp', true);

    v_proc := to_regprocedure(format('%I.%I%s', NEW.handler_schema, NEW.handler_name, NEW.handler_signature));
    IF v_proc IS NULL THEN
        RAISE EXCEPTION 'operation handler % not found or signature mismatch',
            format('%I.%I%s', NEW.handler_schema, NEW.handler_name, NEW.handler_signature);
    END IF;

    RETURN NEW;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202601210920_operation_handlers_validate_signature_guard'));
COMMIT;

