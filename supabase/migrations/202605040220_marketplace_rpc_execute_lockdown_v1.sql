-- Migration: Marketplace RPC execute lockdown
-- Date: 2026-05-03
-- Purpose:
--   Revoke PostgreSQL default PUBLIC/anon EXECUTE on marketplace write RPCs
--   and re-grant only the intended runtime roles.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031390_marketplace_rpc_execute_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.marketplace_refresh_reputation_snapshot_v1(
  p_participant_profile_id UUID
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_refresh_reputation_snapshot_v1(p_participant_profile_id);
$function$;

DO $$
DECLARE
  v_signature TEXT;
  v_fn REGPROCEDURE;
  v_authenticated_signatures TEXT[] := ARRAY[
    'public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)',
    'public.marketplace_offer_withdraw_v1(uuid,text)',
    'public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)',
    'public.marketplace_award_respond_v1(uuid,text,jsonb)',
    'public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)',
    'public.marketplace_request_publish_v1(uuid,text)',
    'public.marketplace_request_cancel_v1(uuid,text)',
    'public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)',
    'public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)',
    'public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)'
  ];
  v_service_only_signatures TEXT[] := ARRAY[
    'public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)',
    'public.marketplace_refresh_reputation_snapshot_v1(uuid)'
  ];
  v_api_authenticated_signatures TEXT[] := ARRAY[
    'api.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)',
    'api.marketplace_offer_withdraw_v1(uuid,text)',
    'api.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)',
    'api.marketplace_award_respond_v1(uuid,text,jsonb)',
    'api.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)',
    'api.marketplace_request_publish_v1(uuid,text)',
    'api.marketplace_request_cancel_v1(uuid,text)',
    'api.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)',
    'api.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)',
    'api.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)'
  ];
  v_api_service_only_signatures TEXT[] := ARRAY[
    'api.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)',
    'api.marketplace_refresh_reputation_snapshot_v1(uuid)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_authenticated_signatures LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected marketplace RPC not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
  END LOOP;

  FOREACH v_signature IN ARRAY v_service_only_signatures LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected marketplace service-only RPC not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;

  FOREACH v_signature IN ARRAY v_api_authenticated_signatures LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected api marketplace RPC wrapper not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('GRANT USAGE ON SCHEMA api TO authenticated, service_role');
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
  END LOOP;

  FOREACH v_signature IN ARRAY v_api_service_only_signatures LOOP
    v_fn := to_regprocedure(v_signature);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Expected api marketplace service-only RPC wrapper not found: %', v_signature;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
    EXECUTE format('GRANT USAGE ON SCHEMA api TO service_role');
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031390_marketplace_rpc_execute_lockdown_v1'));
COMMIT;
