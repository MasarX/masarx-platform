-- Plan: PLAN-202512-ops-whatsapp-alerting-cron-health / Step: S03
-- Migration: Worker trace context propagation
-- Purpose: Ensure worker/cron executions always set request.correlation_id so audit_table_changes never misses correlation.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_request_context(
    p_worker_name TEXT,
    p_entry_point TEXT DEFAULT 'worker'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
    v_batch_size INT;
BEGIN
    -- Make correlation id available to audit triggers for all downstream writes in this transaction.
    PERFORM set_config('request.correlation_id', v_id::text, true);

    SELECT batch_size
    INTO v_batch_size
    FROM public.cron_config
    WHERE worker_name = p_worker_name;

    INSERT INTO public.request_contexts (
        id,
        entry_point,
        primary_entity_type,
        primary_entity_id,
        batch_size,
        started_at,
        created_at,
        error_occurred
    ) VALUES (
        v_id,
        p_entry_point,
        'worker',
        NULL,
        v_batch_size,
        now(),
        now(),
        FALSE
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_request_context(TEXT, TEXT)
  IS 'Create a request_context row for worker execution; seeds batch_size from cron_config when available and sets request.correlation_id for audit traceability.';

ALTER FUNCTION public.create_request_context(TEXT, TEXT)
  SET search_path TO public, extensions, pg_temp;

COMMIT;

