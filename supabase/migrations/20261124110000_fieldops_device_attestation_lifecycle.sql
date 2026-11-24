-- Keep re-attestation on the bound device and allow only revocation-only updates.
BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.register_user_device_v1(p_device jsonb)
 RETURNS TABLE(device_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_device, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_platform TEXT := NULL;
  v_ident TEXT := NULL;
  v_label TEXT := NULL;
  v_push TEXT := NULL;
  v_app TEXT := NULL;
  v_os TEXT := NULL;
  v_meta JSONB := '{}'::jsonb;
  v_existing RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'register_user_device_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'register_user_device_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_platform := lower(NULLIF(btrim(COALESCE(v_in->>'device_platform', '')), ''));
  v_ident := NULLIF(btrim(COALESCE(v_in->>'device_identifier_sha256', '')), '');
  v_label := NULLIF(btrim(COALESCE(v_in->>'device_label', '')), '');
  v_push := NULLIF(btrim(COALESCE(v_in->>'push_token', '')), '');
  v_app := NULLIF(btrim(COALESCE(v_in->>'app_version', '')), '');
  v_os := NULLIF(btrim(COALESCE(v_in->>'os_version', '')), '');
  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 missing device_platform' USING ERRCODE = '23514';
  END IF;
  IF v_ident IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 missing device_identifier_sha256' USING ERRCODE = '23514';
  END IF;

  SELECT d.id, d.revoked_at
    INTO v_existing
    FROM public.user_devices d
   WHERE d.organization_id = v_org
     AND d.user_id = v_user
     AND d.device_identifier_sha256 = v_ident
   LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 device % is revoked', v_existing.id USING ERRCODE = '42501';
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.user_devices (
      id, organization_id, user_id,
      device_platform, device_identifier_sha256, device_label,
      push_token, app_version, os_version,
      last_seen_at, metadata, created_at, updated_at
    ) VALUES (
      v_id, v_org, v_user,
      v_platform, v_ident, v_label,
      v_push, v_app, v_os,
      now(), v_meta, now(), now()
    )
    ON CONFLICT (organization_id, user_id, device_identifier_sha256) DO NOTHING;

    IF FOUND THEN
      RETURN QUERY SELECT v_id, TRUE;
      RETURN;
    END IF;
  END IF;

  v_created := FALSE;
  UPDATE public.user_devices d
     SET push_token = [REDACTED](v_push, d.push_token),
         device_label = COALESCE(v_label, d.device_label),
         app_version = COALESCE(v_app, d.app_version),
         os_version = COALESCE(v_os, d.os_version),
         last_seen_at = now(),
         metadata = COALESCE(d.metadata, '{}'::jsonb) || v_meta,
         updated_at = now()
   WHERE d.organization_id = v_org
     AND d.user_id = v_user
     AND d.device_identifier_sha256 = v_ident
     AND d.revoked_at IS NULL
   RETURNING d.id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 device % is revoked', v_existing.id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_enforce_mobile_attestation_ingest_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_revocation_columns CONSTANT TEXT[] := ARRAY[
    'revoked_at', 'revoked_by_user_id', 'revoked_reason', 'push_token', 'updated_at'
  ];
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
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'user_devices' AND TG_OP = 'UPDATE'
     AND to_jsonb(OLD)->>'revoked_at' IS NULL
     AND v_row->>'revoked_at' IS NOT NULL
     AND v_row->>'push_token' IS NULL
     AND (v_row - v_revocation_columns) = (to_jsonb(OLD) - v_revocation_columns) THEN
    RETURN NEW;
  END IF;

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
     AND (v_session_role = [REDACTED] OR v_claim_role = 'service_role')
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

COMMIT;
