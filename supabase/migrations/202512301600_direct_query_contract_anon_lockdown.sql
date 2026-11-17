-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Direct query contract - lock down anon (least privilege)
-- Purpose:
--   - Authenticated users may query core user-facing tables directly (read-first).
--   - anon must not have direct table access to tenant data (RLS is not a substitute
--     for least-privilege grants).
-- Notes:
--   - This is intentionally explicit (contract) and idempotent.
BEGIN;
SET search_path TO public, pg_temp;

-- Remove any accidental grants to anon/PUBLIC.
REVOKE ALL ON TABLE public.organizations FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.clients FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.senders FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.shipments FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.recipients FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.addresses FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.shipment_actions FROM PUBLIC, anon;

-- Re-assert the direct-query read contract for authenticated users.
GRANT SELECT ON TABLE public.organizations TO authenticated;
GRANT SELECT ON TABLE public.clients TO authenticated;
GRANT SELECT ON TABLE public.senders TO authenticated;
GRANT SELECT ON TABLE public.shipments TO authenticated;
GRANT SELECT ON TABLE public.recipients TO authenticated;
GRANT SELECT ON TABLE public.addresses TO authenticated;
GRANT SELECT ON TABLE public.shipment_actions TO authenticated;

COMMIT;

