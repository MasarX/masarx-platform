-- Migration: RLS hardening for outbound communications tables
-- Purpose: enforce service_role-only access on outbound_calls and comms_attempts
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · ZERO HARD CODING

BEGIN;

-- outbound_calls
ALTER TABLE public.outbound_calls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.outbound_calls FROM PUBLIC;
REVOKE ALL ON TABLE public.outbound_calls FROM anon;
REVOKE ALL ON TABLE public.outbound_calls FROM authenticated;

DROP POLICY IF EXISTS outbound_calls_service_policy ON public.outbound_calls;
CREATE POLICY outbound_calls_service_policy
    ON public.outbound_calls
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

-- comms_attempts
ALTER TABLE public.comms_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.comms_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.comms_attempts FROM anon;
REVOKE ALL ON TABLE public.comms_attempts FROM authenticated;

DROP POLICY IF EXISTS comms_attempts_service_policy ON public.comms_attempts;
CREATE POLICY comms_attempts_service_policy
    ON public.comms_attempts
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

COMMIT;
