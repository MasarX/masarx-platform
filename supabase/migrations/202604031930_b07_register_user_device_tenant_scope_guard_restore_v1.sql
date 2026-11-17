-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- Fix: restore tenant-scope enforcement on register_user_device_v1 after the
-- B07 device-governance contract override dropped the earlier ingest guard.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604031930_b07_register_user_device_tenant_scope_guard_restore_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.register_user_device_v1(
  p_device JSONB
)
RETURNS TABLE (
  device_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
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

  v_created := FALSE;
  UPDATE public.user_devices d
     SET push_token = COALESCE(v_push, d.push_token),
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

COMMENT ON FUNCTION public.register_user_device_v1(JSONB)
  IS 'Register or update a user device (push token + versions). Idempotent by (org,user,device_identifier_sha256). Tenant-only.';

REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_user_device_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604031930_b07_register_user_device_tenant_scope_guard_restore_v1'));
COMMIT;
