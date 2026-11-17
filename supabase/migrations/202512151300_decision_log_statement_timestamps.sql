-- Migration: decision_log timestamps should reflect statement time
-- Purpose:
--   - Ensure decision_log.timestamp records the actual decision emission time,
--     not the surrounding transaction start time (critical for accurate latency
--     and 2am debugging).
--
-- Notes:
--   - Postgres `now()` is the transaction timestamp; use `statement_timestamp()`
--     to represent the current statement's start time for stable, correct logs.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_decision(
    p_organization_id UUID,
    p_decision_category TEXT,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_decision_point TEXT,
    p_decision_outcome TEXT,
    p_performed_by_system TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_decision_inputs JSONB DEFAULT '{}'::jsonb,
    p_decision_reason TEXT DEFAULT NULL,
    p_settings_resolution_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'log_decision requires organization_id (received NULL for resource_type=% resource_id=%)', p_resource_type, p_resource_id;
    END IF;

    INSERT INTO public.decision_log (
        id,
        organization_id,
        decision_category,
        resource_type,
        resource_id,
        decision_point,
        decision_outcome,
        decision_inputs,
        decision_reason,
        performed_by_system,
        correlation_id,
        settings_resolution_id,
        timestamp
    ) VALUES (
        v_id,
        p_organization_id,
        p_decision_category,
        p_resource_type,
        p_resource_id,
        p_decision_point,
        p_decision_outcome,
        COALESCE(p_decision_inputs, '{}'::jsonb),
        p_decision_reason,
        p_performed_by_system,
        p_correlation_id,
        p_settings_resolution_id,
        statement_timestamp()
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID)
    IS 'Canonical helper to insert decision_log rows. Requires organization_id (no global fallbacks). Returns decision_log.id. Uses statement_timestamp() for accurate decision emission time.';

COMMIT;
