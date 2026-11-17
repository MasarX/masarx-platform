-- Plan: PLAN-202601-schema-reaudit-v2 / Step: S04
-- Migration: Harden API boundary by removing `anon` access.
--
-- Rationale
-- - Enterprise-grade default: unauthenticated clients (role `anon`) must not have access to
--   application data or contract views by default.
-- - Supabase may install extension-owned relations under `supabase_admin` with ACLs we cannot
--   rewrite as `postgres`; therefore, the primary control plane is the API boundary (`api` only)
--   and least-privilege grants for our own objects.
--
-- Notes
-- - Keep this migration dynamic and idempotent (no per-table hardcoding).
-- - We revoke only `anon` (not `authenticated`) here; authenticated access is governed by
--   explicit RLS + intended contract grants.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure contract schema exists (should already exist; this makes the migration idempotent).
CREATE SCHEMA IF NOT EXISTS api;

-- ---------------------------------------------------------------------------
-- Schema-level hardening (deny-by-default; explicit grants only)
-- ---------------------------------------------------------------------------

-- Contract surface: `api` must not be usable by `anon` (and PUBLIC must not have implicit access).
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;

GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT USAGE ON SCHEMA api TO authenticator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_caller_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_webhook_role;
  END IF;
END;
$$;

-- Internal schema `public`: remove implicit PUBLIC usage, then grant explicit usage only to
-- required app/service roles. This prevents `anon` from accessing extension tables even if
-- object-level ACLs exist (e.g., supabase_admin-owned PostGIS relations).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE USAGE ON SCHEMA public FROM anon;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT USAGE ON SCHEMA public TO authenticator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    GRANT USAGE ON SCHEMA public TO label_renderer_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA public TO edge_api_gateway_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    GRANT USAGE ON SCHEMA public TO edge_api_caller_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA public TO edge_label_renderer_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
    GRANT USAGE ON SCHEMA public TO edge_webhook_role;
  END IF;
END;
$$;

-- Revoke anon privileges on all relations in the exposed `api` schema.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    ORDER BY c.relkind, c.relname
  LOOP
    IF rec.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM anon', rec.schema_name, rec.rel_name);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', rec.schema_name, rec.rel_name);
    END IF;
  END LOOP;
END;
$$;

-- Revoke anon EXECUTE on any RPC wrappers in the `api` schema (deny-by-default).
DO $$
DECLARE
  rec RECORD;
  v_identity_args TEXT;
BEGIN
  FOR rec IN
    SELECT p.oid, p.proname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
    ORDER BY p.proname, p.oid
  LOOP
    v_identity_args := pg_catalog.pg_get_function_identity_arguments(rec.oid);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM anon', rec.proname, v_identity_args);
  END LOOP;
END;
$$;

-- Revoke anon privileges on postgres-owned internal relations in `public` and `qa`.
-- (Skip supabase_admin-owned extension objects; we cannot modify their ACLs here.)
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'qa')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
    ORDER BY n.nspname, c.relkind, c.relname
  LOOP
    IF rec.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM anon', rec.schema_name, rec.rel_name);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', rec.schema_name, rec.rel_name);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
