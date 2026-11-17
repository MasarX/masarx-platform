-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Ensure `anon` has no access to the Data API contract surface (`api` schema).
--
-- Why
-- - pgTAP asserts: `anon` must have no schema USAGE on `api`, no relation privileges on any
--   `api` objects, and no EXECUTE on any `api` functions.
-- - `public.refresh_api_contract_views_v1()` previously mirrored `anon` table privileges from
--   `public.*` into `api.*` contract views and granted `USAGE` on schema `api`.
-- - Even with `USAGE` revoked on schema `public`, `has_table_privilege('anon', ...)` can still
--   be TRUE for extension-owned objects, which widened the `api` surface unintentionally.
--
-- What
-- - Patch `public.refresh_api_contract_views_v1()` to NEVER grant privileges to `anon`.
-- - Re-assert deny-by-default revokes for `anon` on `api` schema, relations, and functions.
-- - Keep the implementation row-driven and idempotent (no per-table hardcoding).
--
-- Notes
-- - The `api` schema is an internal PostgREST contract surface. All access is explicit and
--   governed by RLS + role grants; `anon` is denied by default.
-- - This migration is intentionally additive (append-only) and safe to re-run.
BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.refresh_api_contract_views_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_has_exclusions BOOLEAN := FALSE;
BEGIN
  v_has_exclusions := (to_regclass('public.api_contract_view_exclusions') IS NOT NULL);

  EXECUTE 'CREATE SCHEMA IF NOT EXISTS api';

  -- Deny-by-default: no PUBLIC, no anon schema access.
  EXECUTE 'REVOKE ALL ON SCHEMA api FROM PUBLIC';
  EXECUTE 'REVOKE USAGE ON SCHEMA api FROM anon';

  -- Explicit grants for supported roles only.
  EXECUTE 'GRANT USAGE ON SCHEMA api TO authenticated';
  EXECUTE 'GRANT USAGE ON SCHEMA api TO service_role';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_label_renderer_role';
  END IF;

  FOR r IN
    SELECT tablename
    FROM public.security_rls_user_facing
    ORDER BY tablename
  LOOP
    IF v_has_exclusions AND EXISTS (
      SELECT 1
      FROM public.api_contract_view_exclusions x
      WHERE x.schema_name = 'api'
        AND x.view_name = r.tablename
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE OR REPLACE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);

    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    IF v_auth_select THEN EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename); END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_api_contract_views_v1() TO service_role;

COMMENT ON FUNCTION public.refresh_api_contract_views_v1()
  IS 'Service-only: Rebuild api.<table> contract views for the current user-facing public surface, skipping api_contract_view_exclusions. Does not grant to anon.';

-- Re-assert runtime state: anon must have no schema/object access to `api`.
CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;

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

COMMIT;
