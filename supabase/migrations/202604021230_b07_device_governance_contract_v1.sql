-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: B07 device governance contract foundation v1
-- Date: 2026-04-02
--
-- Goals:
--   - Add sticky device revocation metadata to user_devices.
--   - Expose a browser-safe api.user_devices visibility surface.
--   - Provide a canonical revoke_user_device_v1 RPC for Console/Portal and service flows.
--   - Fail closed for revoked devices across mobile ingest/session tables.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604021230_b07_device_governance_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) user_devices revocation metadata
-------------------------------------------------------------------------------

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

ALTER TABLE public.user_devices
  DROP CONSTRAINT IF EXISTS user_devices_revoked_reason_ck;
ALTER TABLE public.user_devices
  ADD CONSTRAINT user_devices_revoked_reason_ck
  CHECK (revoked_at IS NULL OR btrim(COALESCE(revoked_reason, '')) <> '');

CREATE INDEX IF NOT EXISTS idx_user_devices_org_user_revoked
  ON public.user_devices (organization_id, user_id, revoked_at DESC NULLS LAST);

COMMENT ON TABLE public.user_devices
  IS 'User device registry (SSOT) for driver/warehouse apps with sticky revocation metadata. Writes via RPC; RLS protects visibility.';

-------------------------------------------------------------------------------
-- 2) Guardrail helper for revoked devices on ingest/session tables
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_block_revoked_user_device_ingest_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_device_col TEXT := COALESCE(TG_ARGV[0], '');
  v_rpc_name TEXT := COALESCE(TG_ARGV[1], TG_TABLE_NAME);
  v_device_id UUID := NULL;
  v_org_id UUID := NULL;
  v_revoked_at TIMESTAMPTZ := NULL;
  v_revoked_reason TEXT := NULL;
BEGIN
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'user_devices'
     AND NULLIF(btrim(COALESCE(v_row->>'revoked_at', '')), '') IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  IF v_device_col <> '' THEN
    BEGIN
      v_device_id := NULLIF(btrim(COALESCE(v_row->>v_device_col, '')), '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_device_id := NULL;
    END;
  END IF;

  IF v_device_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_org_id := NULLIF(btrim(COALESCE(v_row->>'organization_id', '')), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  SELECT ud.revoked_at, ud.revoked_reason
    INTO v_revoked_at, v_revoked_reason
    FROM public.user_devices ud
   WHERE ud.id = v_device_id
     AND (v_org_id IS NULL OR ud.organization_id = v_org_id)
   LIMIT 1;

  IF FOUND AND v_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION '% blocked by revoked device % (revoked_at %, reason %)', v_rpc_name, v_device_id, v_revoked_at, v_revoked_reason
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_block_revoked_user_device_ingest_v1()
  IS 'Fails closed when a mobile/session ingest row references a revoked device.';

DROP TRIGGER IF EXISTS trg_block_revoked_user_devices_v1 ON public.location_pings;
CREATE TRIGGER trg_block_revoked_user_devices_v1
  BEFORE INSERT OR UPDATE ON public.location_pings
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_block_revoked_user_device_ingest_v1('device_id', 'record_location_ping_v1');

DROP TRIGGER IF EXISTS trg_block_revoked_user_scan_events_v1 ON public.scan_events;
CREATE TRIGGER trg_block_revoked_user_scan_events_v1
  BEFORE INSERT OR UPDATE ON public.scan_events
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_block_revoked_user_device_ingest_v1('device_id', 'record_scan_event_v1');

DROP TRIGGER IF EXISTS trg_block_revoked_user_ops_sessions_v1 ON public.ops_sessions;
CREATE TRIGGER trg_block_revoked_user_ops_sessions_v1
  BEFORE INSERT OR UPDATE ON public.ops_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_block_revoked_user_device_ingest_v1('device_id', 'open_ops_session_v1');

-------------------------------------------------------------------------------
-- 3) Canonical revoke RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_user_device_v1(
  p_device JSONB
)
RETURNS TABLE (
  device_id UUID,
  revoked BOOLEAN,
  revoked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_claims JSONB;
  v_role TEXT := NULL;
  v_in JSONB := COALESCE(p_device, '{}'::jsonb);
  v_device_id UUID := NULL;
  v_reason TEXT := NULL;
  v_device RECORD;
  v_revoke_at TIMESTAMPTZ := NULL;
  v_revoke_changed BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'revoke_user_device_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(v_in->>'revoked_reason', '')), '');

  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 missing device_id' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 missing revoked_reason' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := lower(NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''));

  SELECT ud.id, ud.organization_id, ud.user_id, ud.revoked_at
    INTO v_device
    FROM public.user_devices ud
   WHERE ud.id = v_device_id
   LIMIT 1;

  IF v_device.id IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 device % not found', v_device_id USING ERRCODE = '23503';
  END IF;

  IF v_role IS DISTINCT FROM 'service_role' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'revoke_user_device_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;
    IF v_device.user_id IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'revoke_user_device_v1 device % is not owned by current user', v_device_id USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_device.revoked_at IS NULL THEN
    UPDATE public.user_devices d
       SET revoked_at = now(),
           revoked_by_user_id = COALESCE(v_user, d.revoked_by_user_id),
           revoked_reason = v_reason,
           push_token = NULL,
           updated_at = now()
     WHERE d.id = v_device_id
     RETURNING d.revoked_at INTO v_revoke_at;
    v_revoke_changed := TRUE;
  ELSE
    v_revoke_at := v_device.revoked_at;
  END IF;

  RETURN QUERY
  SELECT v_device_id, v_revoke_changed, v_revoke_at;
END;
$function$;

COMMENT ON FUNCTION public.revoke_user_device_v1(JSONB)
  IS 'Sticky revoke for a registered user device. Blocks future ingest/session use and clears push delivery.';
REVOKE ALL ON FUNCTION public.revoke_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_user_device_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) api schema visibility + RPC wrapper
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE VIEW api.user_devices
WITH (security_invoker = true) AS
SELECT *
FROM public.user_devices;

REVOKE ALL ON api.user_devices FROM PUBLIC;
REVOKE ALL ON api.user_devices FROM anon;
REVOKE ALL ON api.user_devices FROM authenticated;
GRANT SELECT ON api.user_devices TO authenticated;
GRANT SELECT ON api.user_devices TO service_role;

CREATE OR REPLACE FUNCTION api.revoke_user_device_v1(
  p_device JSONB
)
RETURNS TABLE (
  device_id UUID,
  revoked BOOLEAN,
  revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.revoke_user_device_v1(p_device);
$fn$;

REVOKE ALL ON FUNCTION api.revoke_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.revoke_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.revoke_user_device_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Harden register RPC against revoked devices
-------------------------------------------------------------------------------

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

SELECT pg_advisory_unlock(hashtext('202604021230_b07_device_governance_contract_v1'));
COMMIT;
