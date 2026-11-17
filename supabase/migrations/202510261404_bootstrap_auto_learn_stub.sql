-- Migration: Bootstrap stub for auto_learn_geography
-- Purpose: Ensure downstream search_path migrations compile cleanly on a fresh reset.

BEGIN;

DO $$
BEGIN
    IF to_regprocedure('public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text)') IS NULL THEN
        EXECUTE '
            CREATE FUNCTION public.auto_learn_geography(
                p_organization_id UUID,
                p_client_id UUID,
                p_sender_id UUID,
                p_address_id UUID,
                p_geocode JSONB,
                p_policy JSONB,
                p_confidence NUMERIC,
                p_action TEXT
            )
            RETURNS JSONB
            LANGUAGE sql
            AS ''SELECT NULL::jsonb'';';
    END IF;
END;
$$;

COMMIT;
