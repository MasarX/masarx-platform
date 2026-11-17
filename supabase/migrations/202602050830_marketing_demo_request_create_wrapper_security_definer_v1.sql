-- Plan: PLAN-202602-landing-page-live / Step: S00
-- Migration: Marketing demo intake RPC wrapper security definer fix v1
-- Date: 2026-02-05
--
-- Goal:
--   - Guarantee marketing_demo_request_create_v1 is SECURITY DEFINER (pgTAP expectation).
--   - Self-heal preview-db drift where ALTER FUNCTION did not toggle prosecdef.
--   - Keep logic SSOT by renaming existing implementation and installing a thin wrapper.
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602050830_marketing_demo_request_create_wrapper_security_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_sig TEXT := 'public.marketing_demo_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)';
  v_impl_sig TEXT := 'public.marketing_demo_request_create_v1_impl(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)';
  v_fn_oid OID;
  v_impl_oid OID;
  v_is_definer BOOLEAN;
  v_sql TEXT;
BEGIN
  v_fn_oid := to_regprocedure(v_sig);
  IF v_fn_oid IS NULL THEN
    RAISE NOTICE '[marketing_demo_request_create_wrapper] % not found; skipping.', v_sig;
    RETURN;
  END IF;

  SELECT p.prosecdef
    INTO v_is_definer
    FROM pg_proc p
   WHERE p.oid = v_fn_oid;

  IF COALESCE(v_is_definer, FALSE) THEN
    RETURN;
  END IF;

  v_impl_oid := to_regprocedure(v_impl_sig);
  IF v_impl_oid IS NULL THEN
    EXECUTE format('ALTER FUNCTION %s RENAME TO marketing_demo_request_create_v1_impl', v_fn_oid::regprocedure);
    v_impl_oid := to_regprocedure(v_impl_sig);
  END IF;

  IF v_impl_oid IS NULL THEN
    RAISE EXCEPTION '[marketing_demo_request_create_wrapper] Expected impl % but it is missing.', v_impl_sig;
  END IF;

  -- Re-create the public RPC as a SECURITY DEFINER wrapper (SSOT logic lives in *_impl).
  EXECUTE format('DROP FUNCTION IF EXISTS %s', v_sig);

  v_sql := $create$
    CREATE FUNCTION public.marketing_demo_request_create_v1(
      p_email TEXT,
      p_company TEXT,
      p_volume TEXT DEFAULT NULL,
      p_role TEXT DEFAULT NULL,
      p_notes TEXT DEFAULT NULL,
      p_locale TEXT DEFAULT NULL,
      p_page_url TEXT DEFAULT NULL,
      p_referrer TEXT DEFAULT NULL,
      p_origin TEXT DEFAULT NULL,
      p_marketing JSONB DEFAULT '{}'::jsonb,
      p_ip_hash TEXT DEFAULT NULL,
      p_turnstile_verified BOOLEAN DEFAULT FALSE
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO public, extensions, pg_temp
    AS $fn$
    BEGIN
      RETURN public.marketing_demo_request_create_v1_impl(
        p_email,
        p_company,
        p_volume,
        p_role,
        p_notes,
        p_locale,
        p_page_url,
        p_referrer,
        p_origin,
        p_marketing,
        p_ip_hash,
        p_turnstile_verified
      );
    END;
    $fn$;
  $create$;

  EXECUTE v_sql;

  v_fn_oid := to_regprocedure(v_sig);
  SELECT p.prosecdef
    INTO v_is_definer
    FROM pg_proc p
   WHERE p.oid = v_fn_oid;

  IF NOT COALESCE(v_is_definer, FALSE) THEN
    RAISE EXCEPTION '[marketing_demo_request_create_wrapper] % still not SECURITY DEFINER after wrapper install.', v_sig;
  END IF;
END
$$;

-- Ensure least-privilege execution on the public wrapper RPC.
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
      TO edge_api_gateway_role;
  END IF;
END;
$$;

-- Lock down the internal implementation function (owner-only; wrapper calls it as definer).
DO $$
DECLARE
  v_impl regprocedure := to_regprocedure('public.marketing_demo_request_create_v1_impl(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)');
BEGIN
  IF v_impl IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER FUNCTION %s SET search_path TO public, extensions, pg_temp', v_impl);

  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_impl);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_impl);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', v_impl);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM edge_api_gateway_role', v_impl);
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602050830_marketing_demo_request_create_wrapper_security_definer_v1'));
COMMIT;

