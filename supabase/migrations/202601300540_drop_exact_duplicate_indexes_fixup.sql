-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Drop exact duplicate indexes flagged by pgTAP (fixup)
-- Rationale:
--   - Unique indexes already provide identical access paths; duplicated non-unique indexes add write overhead.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DROP INDEX IF EXISTS public.idx_artifacts_org_storage;
DROP INDEX IF EXISTS public.idx_branch_zones_zone;
DROP INDEX IF EXISTS public.idx_commercial_agreement_terms_agreement;

COMMIT;

