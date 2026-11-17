-- Plan: PLAN-202512-comms-reply-edge-dispatch-v1 / Step: S04
-- Migration: Tighten get_webhook_edge_dispatch_jobs privileges (no anon/auth execute)
-- Purpose:
--   - Enforce least-privilege: only edge_webhook_role + service_role may execute.
--   - Some environments apply broader default EXECUTE grants; revoke explicitly.
-- Date: 2025-12-17

BEGIN;

REVOKE EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) TO service_role;

COMMIT;

