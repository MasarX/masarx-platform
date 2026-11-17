-- Plan: PLAN-202602-fieldops-driver-go-live / Step: S04
-- Migration: Expose FieldOps mobile policy + ingest RPCs in `api` schema (PostgREST boundary).
-- Notes:
--   - Mobile Supabase clients are configured with db.schema = 'api'.
--   - Source-of-truth implementations live in `public`.
--   - This migration creates `api.*` wrappers delegating to `public.*` and copies EXECUTE grants
--     (excluding PUBLIC/anon).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

DO $$
DECLARE
  v_names text[] := ARRAY[
    -- Policy resolvers (FieldOps mobile shell)
    'resolve_mobile_diagnostics_policy',
    'resolve_mobile_visibility_policy',
    'resolve_map_policy',
    'resolve_device_policy',
    'resolve_navigation_policy',
    'resolve_driver_safety_policy',
    'resolve_ux_safety_policy',
    'resolve_communication_policy',
    'resolve_address_policy',
    'resolve_mobile_push_policy',
    'resolve_mobile_attestation_policy',
    'resolve_scan_policy',
    'resolve_location_tracking_policy',

    -- Ingest / telemetry (FieldOps outbox + device attestation)
    'register_user_device_v1',
    'issue_mobile_attestation_challenge_v1',
    'record_scan_event_v1',
    'record_location_ping_v1'
  ];
  v_name text;
  v_found boolean;
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
    v_found := false;
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
      v_found := true;
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

      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC', f.proname, v_identity_args);

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
        IF v_grantee IN ('PUBLIC', 'anon', 'postgres') THEN
          CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_grantee) THEN
          CONTINUE;
        END IF;

        EXECUTE format('GRANT USAGE ON SCHEMA api TO %I', v_grantee);
        EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(%s) TO %I', f.proname, v_identity_args, v_grantee);
      END LOOP;
    END LOOP;

    IF NOT v_found THEN
      RAISE EXCEPTION 'api fieldops mobile wrapper: public.% not found', v_name;
    END IF;
  END LOOP;
END;
$$;

COMMIT;

