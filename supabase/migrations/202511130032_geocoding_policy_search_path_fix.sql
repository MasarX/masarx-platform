-- Migration: Geocoding resolve policy search_path fix
-- Purpose: Re-apply geocoding_resolve_policy with explicit public qualification.

BEGIN;

CREATE OR REPLACE FUNCTION public.geocoding_resolve_policy(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID
)
RETURNS TABLE (
    policy JSONB,
    scope_type TEXT,
    scope_id UUID
)
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_policy JSONB;
BEGIN
    IF p_sender_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'sender', p_sender_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'sender';
            scope_id := p_sender_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p_client_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'client', p_client_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'client';
            scope_id := p_client_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p_organization_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'tenant', p_organization_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'tenant';
            scope_id := p_organization_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    v_policy := public.resolve_settings('geocoding_policy', 'global', NULL);
    IF v_policy IS NOT NULL THEN
        policy := v_policy;
        scope_type := 'global';
        scope_id := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
END;
$$;

COMMIT;
