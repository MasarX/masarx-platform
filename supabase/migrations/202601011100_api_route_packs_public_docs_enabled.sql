-- Plan: PLAN-202601-api-ingress-docs-prod-ready / Step: S04
-- Migration: API route pack public docs visibility
-- Purpose:
--   - Keep public OpenAPI generation row-driven (SSOT): DB controls which route packs are allowed to appear in public docs.
--   - Avoid hardcoded allowlists in docs/CI code.
-- Date: 2026-01-01

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.api_route_packs
  ADD COLUMN IF NOT EXISTS public_docs_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.api_route_packs.public_docs_enabled IS
  'When TRUE, routes from this pack may be included in public OpenAPI documentation generation.';

-- Backfill: enable public docs for the existing Logestechs compatibility pack (if present).
UPDATE public.api_route_packs
SET public_docs_enabled = TRUE,
    updated_at = now()
WHERE name = 'logestechs_v2_mirror';

COMMIT;

