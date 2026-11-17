-- Migration: log_decision compatibility wrapper (clock_timestamp)
-- Purpose:
--   - Ensure legacy 10-arg log_decision() uses the canonical helper that writes
--     accurate timestamps (clock_timestamp) and supports settings provenance.
-- Alignment: SIMPLE - SCALABLE - SSOT.
-- Date: 2025-12-15

BEGIN;

-- Legacy signature preserved for backward compatibility.
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
    p_decision_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    RETURN public.log_decision(
        p_organization_id := p_organization_id,
        p_decision_category := p_decision_category,
        p_resource_type := p_resource_type,
        p_resource_id := p_resource_id,
        p_decision_point := p_decision_point,
        p_decision_outcome := p_decision_outcome,
        p_performed_by_system := p_performed_by_system,
        p_correlation_id := p_correlation_id,
        p_decision_inputs := p_decision_inputs,
        p_decision_reason := p_decision_reason,
        p_settings_resolution_id := NULL
    );
END;
$$;

COMMENT ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT)
  IS 'Compatibility wrapper for legacy callers; delegates to the canonical log_decision (with clock_timestamp) and sets settings_resolution_id=NULL.';

COMMIT;

