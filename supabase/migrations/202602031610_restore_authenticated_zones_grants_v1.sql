-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Restore authenticated grants for zones + zone_districts v1
-- Purpose:
-- - pgTAP + RBAC tests assert authenticated writes are gated by RLS/RBAC (not blocked at the privilege layer).
-- - Ensure zones + zone_districts remain least-privilege via RLS while allowing PostgREST/RPC test flows.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zone_districts TO authenticated;

COMMIT;
