-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S99
-- Migration: Reconcile api contract views after integration plugin control-plane tables
-- Purpose:
--   - Ensure every user-facing integration plugin table has api.<table> contract views.
--   - Keep api views security_invoker and privilege-aligned with public table grants.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220120_integration_plugin_api_contract_views_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
BEGIN
  IF to_regprocedure('public.refresh_api_contract_views_v1()') IS NOT NULL THEN
    PERFORM public.refresh_api_contract_views_v1();
    RETURN;
  END IF;

  CREATE SCHEMA IF NOT EXISTS api;
  REVOKE ALL ON SCHEMA api FROM PUBLIC;
  REVOKE USAGE ON SCHEMA api FROM anon;
  GRANT USAGE ON SCHEMA api TO authenticated;
  GRANT USAGE ON SCHEMA api TO service_role;

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

SELECT pg_advisory_unlock(hashtext('202602220120_integration_plugin_api_contract_views_reconcile_v1'));
COMMIT;
