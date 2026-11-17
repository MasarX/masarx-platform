-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S95
-- Migration: Fixup security on label_design_drafts partitions (RLS + policies + grants)
-- Purpose:
--   - Ensure partition leaves are locked down (no direct anon/auth grants) and have RLS policies,
--     matching project-wide partition security expectations (pgTAP 0zz_partition_security).
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Canonical partition hardening (RLS enabled + no direct anon/auth grants + service_role policy).
-- This stays dynamic and avoids per-table/per-partition hardcoding.
SELECT public.sync_partition_security();

COMMIT;
