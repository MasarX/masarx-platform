-- Migration: Webhook system tables RLS hardening
-- Purpose: Enable RLS on webhook system tables and scope access to service_role (and admins if needed).
-- Date: 2025-11-13

BEGIN;

-- webhook_inbox
ALTER TABLE IF EXISTS public.webhook_inbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_inbox FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_inbox FROM anon;
REVOKE ALL ON TABLE public.webhook_inbox FROM authenticated;

DROP POLICY IF EXISTS webhook_inbox_service_policy ON public.webhook_inbox;
CREATE POLICY webhook_inbox_service_policy
    ON public.webhook_inbox
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

-- webhook_ack_history
ALTER TABLE IF EXISTS public.webhook_ack_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_ack_history FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_ack_history FROM anon;
REVOKE ALL ON TABLE public.webhook_ack_history FROM authenticated;

DROP POLICY IF EXISTS webhook_ack_history_service_policy ON public.webhook_ack_history;
CREATE POLICY webhook_ack_history_service_policy
    ON public.webhook_ack_history
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

COMMIT;

