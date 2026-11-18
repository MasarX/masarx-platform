-- Plan: PLAN-202606-backend-local-readiness / Step: S04
-- Migration: Late reconcile for api.* contract views after readiness table grants
--
-- Purpose:
--   - Keep the Data API contract surface aligned with the dynamic user-facing
--     table inventory after late readiness migrations add or expose tables.
--   - Preserve the existing row-driven contract pattern: api.<table> views are
--     generated from public.security_rls_user_facing and remain security_invoker.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042010_api_contract_views_user_facing_late_reconcile_v1'));
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
  CREATE SCHEMA IF NOT EXISTS api;
  REVOKE ALL ON SCHEMA api FROM PUBLIC;
  REVOKE USAGE ON SCHEMA api FROM anon;
  GRANT USAGE ON SCHEMA api TO authenticated;
  GRANT USAGE ON SCHEMA api TO service_role;

  FOR r IN
    SELECT t.tablename
    FROM public.security_rls_user_facing t
    LEFT JOIN pg_catalog.pg_class c
      ON c.relname = t.tablename
     AND c.relkind = 'v'
    LEFT JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
     AND n.nspname = 'api'
    WHERE n.oid IS NULL
    ORDER BY t.tablename
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

    IF v_auth_select THEN
      EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_insert THEN
      EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_update THEN
      EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename);
    END IF;
    IF v_auth_delete THEN
      EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_missing_count INTEGER;
  v_non_invoker_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
    INTO v_missing_count
  FROM public.security_rls_user_facing t
  LEFT JOIN pg_catalog.pg_class c
    ON c.relname = t.tablename
   AND c.relkind = 'v'
  LEFT JOIN pg_catalog.pg_namespace n
    ON n.oid = c.relnamespace
   AND n.nspname = 'api'
  WHERE n.oid IS NULL;

  IF v_missing_count <> 0 THEN
    RAISE EXCEPTION 'api contract view reconcile left % missing user-facing views', v_missing_count;
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO v_non_invoker_count
  FROM public.security_rls_user_facing t
  JOIN pg_catalog.pg_class c
    ON c.relname = t.tablename
   AND c.relkind = 'v'
  JOIN pg_catalog.pg_namespace n
    ON n.oid = c.relnamespace
   AND n.nspname = 'api'
  WHERE NOT (COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']);

  IF v_non_invoker_count <> 0 THEN
    RAISE EXCEPTION 'api contract view reconcile left % non-security_invoker views', v_non_invoker_count;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202606042010_api_contract_views_user_facing_late_reconcile_v1'));
COMMIT;
