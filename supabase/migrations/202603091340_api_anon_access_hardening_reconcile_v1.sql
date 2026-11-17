-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Reconcile API anon access hardening v1
--
-- Purpose:
--   - Re-assert the fail-closed API boundary in shared/cloud environments after
--     drift or legacy grants reintroduce anon access.
--   - Keep the hardening fully dynamic and idempotent across all current api
--     relations/functions without hardcoded object names.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091340_api_anon_access_hardening_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

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

SELECT pg_advisory_unlock(hashtext('202603091340_api_anon_access_hardening_reconcile_v1'));
COMMIT;
