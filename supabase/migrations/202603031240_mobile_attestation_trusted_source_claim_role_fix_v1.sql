-- ============================================================================
-- Migration: 202603031240_mobile_attestation_trusted_source_claim_role_fix_v1
-- Purpose  : Preserve trusted background classification for server-side writes
--            under SECURITY DEFINER trigger execution by checking both
--            session role and trusted JWT role claim.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_user_col TEXT := COALESCE(TG_ARGV[0], '');
  v_device_col TEXT := COALESCE(TG_ARGV[1], '');
  v_resource_col TEXT := COALESCE(TG_ARGV[2], '');
  v_rpc_name TEXT := COALESCE(TG_ARGV[3], TG_TABLE_NAME);
  v_trusted_source TEXT := lower(NULLIF(btrim(COALESCE(TG_ARGV[4], '')), ''));
  v_session_role TEXT := lower(NULLIF(btrim(session_user), ''));
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
  v_client_source TEXT := NULL;

  v_org UUID := NULL;
  v_user UUID := NULL;
  v_device UUID := NULL;
  v_resource UUID := NULL;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_org := NULLIF(v_row->>'organization_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_org := NULL;
  END;

  IF v_user_col <> '' THEN
    BEGIN
      v_user := NULLIF(v_row->>v_user_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_user := NULL;
    END;
  END IF;

  IF v_device_col <> '' THEN
    BEGIN
      v_device := NULLIF(v_row->>v_device_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_device := NULL;
    END;
  END IF;

  IF v_resource_col <> '' THEN
    BEGIN
      v_resource := NULLIF(v_row->>v_resource_col, '')::UUID;
    EXCEPTION WHEN others THEN
      v_resource := NULL;
    END;
  END IF;

  IF v_trusted_source NOT IN ('mobile', 'mobile_background') THEN
    v_trusted_source := 'mobile';
  END IF;

  IF jsonb_typeof(v_row->'metadata') = 'object' THEN
    v_metadata := v_row->'metadata';
  END IF;

  v_client_source := lower(NULLIF(btrim(COALESCE(v_metadata->>'source', '')), ''));
  IF v_rpc_name = 'record_location_ping_v1'
     AND (v_session_role = 'service_role' OR v_claim_role = 'service_role')
     AND v_client_source = 'mobile_background'
  THEN
    -- Trusted background classification is allowed only for service_role writes
    -- on record_location_ping_v1. Client metadata alone is never trusted.
    v_trusted_source := 'mobile_background';
  END IF;

  v_metadata :=
    (v_metadata - 'app' - 'source' - '__attestation_source')
    || jsonb_build_object(
      'app', 'fieldops',
      'source', v_trusted_source,
      '__attestation_source', v_trusted_source
    );

  NEW.metadata := v_metadata;

  PERFORM public.assert_mobile_attestation_for_ingest_v1(
    v_rpc_name,
    v_org,
    v_user,
    v_device,
    v_resource,
    v_metadata
  );

  RETURN NEW;
END;
$function$;
