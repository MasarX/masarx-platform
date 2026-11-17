-- Plan: PLAN-202512-api-gateway-pack-taxonomy / Step: S04
-- Migration: Seed API gateway pack taxonomy (canonical + custom)
-- Purpose:
--   - Seed canonical pack identifiers for future MasarX REST (`masarx_v1`) and custom (`custom_v1`) APIs.
--   - Keep the system single-ingress and row-driven: packs are toggles/containers; routes remain in api_routes.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.api_route_packs (name, description, enabled, created_at, updated_at)
VALUES
  ('masarx_v1', 'MasarX canonical REST API (v1).', FALSE, now(), now()),
  ('custom_v1', 'Client-specific custom API endpoints (v1).', FALSE, now(), now())
ON CONFLICT (name) DO UPDATE
  SET description = EXCLUDED.description,
      updated_at = now();

COMMIT;

