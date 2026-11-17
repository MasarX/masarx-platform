-- Plan: PLAN-202603-marketplace-network-v1 / Step: S04
-- Migration: Expose marketplace RPCs in api schema

BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

DO $$
DECLARE
  v_names TEXT[] := ARRAY[
    'marketplace_policy_v1',
    'marketplace_request_policy_v1',
    'marketplace_visibility_policy_v1',
    'marketplace_execution_policy_v1',
    'marketplace_settlement_policy_v1',
    'marketplace_reputation_policy_v1',
    'marketplace_tracking_display_policy_v1',
    'marketplace_compliance_policy_v1',
    'marketplace_request_kind_catalog_v1',
    'marketplace_assert_reviewer_v1',
    'marketplace_provider_opt_in_v1',
    'marketplace_participant_request_create_v1',
    'marketplace_participant_request_review_apply_v1',
    'marketplace_request_create_v1',
    'marketplace_request_publish_v1',
    'marketplace_request_cancel_v1',
    'marketplace_offer_submit_v1',
    'marketplace_offer_withdraw_v1',
    'marketplace_award_offer_v1',
    'marketplace_award_respond_v1',
    'marketplace_work_package_materialize_v1',
    'marketplace_dispute_open_v1',
    'marketplace_dispute_resolve_v1',
    'marketplace_reputation_snapshot_v1',
    'marketplace_matching_suggestions_v1',
    'marketplace_pricing_suggestion_v1'
  ];
  v_name TEXT;
  v_found BOOLEAN;
  f RECORD;
  v_args TEXT;
  v_identity_args TEXT;
  v_result TEXT;
  v_call_args TEXT;
  v_sql TEXT;
  v_volatility TEXT;
  v_is_set BOOLEAN;
  v_grantee TEXT;
  i INTEGER;
BEGIN
  FOREACH v_name IN ARRAY v_names
  LOOP
    v_found := FALSE;

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
      v_found := TRUE;
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
      EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM anon', f.proname, v_identity_args);

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

    IF v_found IS FALSE THEN
      RAISE EXCEPTION 'api marketplace wrapper: public.% not found', v_name;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
