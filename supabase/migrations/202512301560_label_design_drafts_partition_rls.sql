-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S95
-- Migration: Ensure RLS enabled on label_design_drafts partitions
-- Purpose:
--   - Postgres does not automatically enable RLS on existing partition leaves.
--   - pgTAP enforces that all partition leaves have RLS enabled.
BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE IF EXISTS public.label_design_drafts_p0 ENABLE ROW LEVEL SECURITY;

COMMIT;
