-- Plan: PLAN-202602-landing-page-live / Step: S04
-- Migration: Ensure marketing demo intake RPC is callable via PostgREST `api` schema.
-- Purpose:
--   - PostgREST is configured to expose `api` schema only (see supabase/config.toml).
--   - Edge functions call `/rest/v1/rpc/<fn>` without schema/profile headers.
--   - Therefore, an `api.<fn>` wrapper MUST exist for intake RPCs.
--   - Keep SSOT logic in `public`; `api` remains a thin contract layer.

BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'marketing_demo_request_create_v1'
  ];
  v_name text;
  f record;
  v_args text;
  v_identity_args text;
  v_result text;
  v_call_args text;
  v_sql text;
  v_volatility text;
  v_is_set boolean;
  v_grantee text;
  i integer;
BEGIN
  FOREACH v_name IN ARRAY v_names
  LOOP
    FOR f IN
      SELECT
        p.oid,
        p.proname,
        p.pronargs,
        p.proowner,
        p.proacl,
        p.provolatile
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
    LOOP
      v_args := pg_get_function_arguments(f.oid);
      v_identity_args := pg_get_function_identity_arguments(f.oid);
      v_result := pg_get_function_result(f.oid);
      v_volatility := CASE f.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE '' END;

      v_call_args := '';
      IF f.pronargs > 0 THEN
        FOR i IN 1..f.pronargs LOOP
          v_call_args := v_call_args || CASE WHEN i > 1 THEN ', ' ELSE '' END || '$' || i;
        END LOOP;
      END IF;

      v_is_set := (v_result ILIKE 'SETOF %') OR (v_result ILIKE 'TABLE%');
      IF v_is_set THEN
        v_sql := format('SELECT * FROM public.%I(%s);', f.proname, v_call_args);
      ELSE
        v_sql := format('SELECT public.%I(%s);', f.proname, v_call_args);
      END IF;

      EXECUTE format(
        'CREATE OR REPLACE FUNCTION api.%I(%s) RETURNS %s LANGUAGE sql%s SET search_path TO public, extensions, pg_temp AS $fn$ %s $fn$',
        f.proname,
        v_args,
        v_result,
        CASE WHEN v_volatility <> '' THEN ' ' || v_volatility ELSE '' END,
        v_sql
      );

      -- Default EXECUTE is granted to PUBLIC for new functions; enforce deny-by-default.
      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC', f.proname, v_identity_args);
      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM anon', f.proname, v_identity_args);
      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM authenticated', f.proname, v_identity_args);

      -- Copy grants from the underlying public function, but never expose PUBLIC/anon.
      FOR v_grantee IN
        SELECT DISTINCT
          CASE
            WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE (SELECT rolname FROM pg_roles WHERE oid = acl.grantee)
          END AS grantee
        FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) acl
        WHERE acl.privilege_type = 'EXECUTE'
      LOOP
        IF v_grantee IS NULL THEN
          CONTINUE;
        END IF;
        IF v_grantee IN ('PUBLIC', 'anon', 'authenticated', 'postgres') THEN
          CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_grantee) THEN
          CONTINUE;
        END IF;

        EXECUTE format('GRANT USAGE ON SCHEMA api TO %I', v_grantee);
        EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(%s) TO %I', f.proname, v_identity_args, v_grantee);
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;

