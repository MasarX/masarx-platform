-- Migration: Direct query contract (authenticated read access)
-- Purpose:
--   - Allow authenticated users to query core user-facing tables directly (read-first)
--   - Keep write access mediated via RPC/Edge unless explicitly granted elsewhere
BEGIN;

GRANT SELECT ON TABLE public.organizations TO authenticated;
GRANT SELECT ON TABLE public.senders TO authenticated;
GRANT SELECT ON TABLE public.shipments TO authenticated;
GRANT SELECT ON TABLE public.recipients TO authenticated;
GRANT SELECT ON TABLE public.addresses TO authenticated;

-- Already granted in prior migrations, but included here as documentation for the contract.
GRANT SELECT ON TABLE public.clients TO authenticated;
GRANT SELECT ON TABLE public.shipment_actions TO authenticated;

COMMIT;

