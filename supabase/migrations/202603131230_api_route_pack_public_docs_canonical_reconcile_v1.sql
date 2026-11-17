-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Reconcile canonical API route-pack public docs visibility
-- Purpose:
--   - Keep public OpenAPI generation deterministic across fresh and reused preview workspaces.
--   - Normalize canonical compatibility packs to the intended public-doc visibility instead of
--     inheriting stale values from older preview data.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603131230_api_route_pack_public_docs_canonical_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.api_route_packs
SET public_docs_enabled = FALSE,
    updated_at = now()
WHERE name = 'logestechs_v2_mirror'
  AND scope_type = 'global'
  AND scope_id IS NULL
  AND COALESCE(public_docs_enabled, FALSE) IS DISTINCT FROM FALSE;

SELECT pg_advisory_unlock(hashtext('202603131230_api_route_pack_public_docs_canonical_reconcile_v1'));
COMMIT;
