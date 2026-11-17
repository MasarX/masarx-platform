-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Clear short-code registry (demo reset)
-- Purpose:
--   - Reset short-code registry for a clean demo start.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-12
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

DELETE FROM public.address_code_registry
WHERE code_type = 'sa_short_code';

COMMIT;
