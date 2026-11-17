-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Reapply `api.<table>` contract views for user-facing `public` tables (drift fix)
-- Rationale:
--   - `public.security_rls_user_facing` is a dynamic inventory derived from effective grants.
--   - When new tables become user-facing (or grants change), the `api` contract layer must be
--     regenerated to keep PostgREST exposure consistent and avoid base-table coupling.
-- Notes:
--   - Views are `security_invoker` so underlying RLS policies apply to caller roles.
--   - This migration mirrors *authenticated* privileges only; `anon` remains deny-by-default
--     via `api_anon_access_hardening` (do not re-grant).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

DO $$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
BEGIN
  FOR r IN
    SELECT tablename
    FROM public.security_rls_user_facing
    ORDER BY tablename
  LOOP
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
$$;

COMMIT;

