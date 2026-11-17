-- Plan: PLAN-202601-schema-reaudit-v2 / Step: S04
-- Migration: Harden Data API surface by enforcing PostgREST exposed schemas (api-only)
--            and disabling Supabase GraphQL (pg_graphql).
--
-- Rationale (enterprise-grade, deny-by-default)
-- - The schema name `public` is not a security boundary. The Data API boundary is enforced by
--   (a) PostgREST exposed schemas (`pgrst.db_schemas`), (b) explicit grants, and (c) RLS.
-- - Supabase GraphQL can surface internal schemas/tables (e.g., extension-owned relations)
--   and is not required for our contract-first API. We disable it.
-- - Preview projects created by CI must match production hardening rules; this migration
--   makes that configuration part of the DB SSOT (no dashboard-only drift).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Disable Supabase GraphQL (pg_graphql)
-- ---------------------------------------------------------------------------
-- Supabase hardening guidance: disable `pg_graphql` when not explicitly required.
-- This reduces attack surface and prevents automatic surfacing of internal schemas.
DROP EXTENSION IF EXISTS pg_graphql CASCADE;

-- ---------------------------------------------------------------------------
-- 2) Enforce PostgREST exposed schemas (api-only) + safe extra search path
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    -- Expose only the contract schema.
    ALTER ROLE authenticator SET pgrst.db_schemas = 'api';

    -- Extra search path is NOT a security boundary, but keeping `public` out avoids
    -- accidental function resolution against internal schemas.
    ALTER ROLE authenticator SET pgrst.db_extra_search_path = 'extensions';
  END IF;
END;
$$;

-- Ask PostgREST to reload config (Supabase listens on channel `pgrst`).
NOTIFY pgrst;

COMMIT;

