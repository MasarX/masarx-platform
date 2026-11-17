-- Migration: call_api search_path pin
-- Purpose:
--   - Ensure SECURITY DEFINER call_api uses a pinned search_path (secdef guard).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Plan: PLAN-202601-pgtap-outbound-worker-pending-edge / Step: S02
-- Date: 2026-01-12
BEGIN;

ALTER FUNCTION public.call_api(
  TEXT,
  TEXT,
  JSONB,
  JSONB,
  INT
) SET search_path TO public, extensions, pg_temp;

COMMIT;
