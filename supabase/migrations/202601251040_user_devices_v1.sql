-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: User devices registry v1 (driver/warehouse apps)
-- Date: 2026-01-25
--
-- Goals:
--   - Canonical device registry (SSOT) for mobile/scanner apps.
--   - No direct DML from clients: writes via RPC, reads via RLS.
--   - Keep extensibility via JSONB metadata (no hardcoding).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251040_user_devices_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('device_platform', 'Device platform identifiers for mobile/scanner apps', 'ops', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('ios', 'iOS', 'Apple iOS device', 10, FALSE, '{}' ),
  ('android', 'Android', 'Android device', 20, TRUE, '{}' ),
  ('web', 'Web', 'Web client', 30, FALSE, '{}' ),
  ('scanner', 'Scanner', 'Dedicated barcode scanner device', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'device_platform'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Table: user_devices (SSOT)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_platform TEXT NOT NULL, -- lookup category: device_platform
  device_identifier_sha256 TEXT NOT NULL,
  device_label TEXT,
  push_token TEXT,
  app_version TEXT,
  os_version TEXT,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_platform_ck CHECK (btrim(device_platform) <> '' AND device_platform = lower(device_platform)),
  CONSTRAINT user_devices_identifier_ck CHECK (btrim(device_identifier_sha256) <> ''),
  CONSTRAINT user_devices_unique_device UNIQUE (organization_id, user_id, device_identifier_sha256)
);

COMMENT ON TABLE public.user_devices
  IS 'User device registry (SSOT) for driver/warehouse apps (push tokens, versions, last seen). Writes via RPC; RLS protects visibility.';

CREATE INDEX IF NOT EXISTS idx_user_devices_org_user_seen
  ON public.user_devices (organization_id, user_id, last_seen_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_user_devices_set_updated_at ON public.user_devices;
CREATE TRIGGER trg_user_devices_set_updated_at
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants
-------------------------------------------------------------------------------

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_devices FROM PUBLIC;
REVOKE ALL ON TABLE public.user_devices FROM anon;
REVOKE ALL ON TABLE public.user_devices FROM authenticated;

DROP POLICY IF EXISTS user_devices_select ON public.user_devices;
CREATE POLICY user_devices_select ON public.user_devices
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_devices_service_policy ON public.user_devices;
CREATE POLICY user_devices_service_policy ON public.user_devices
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.user_devices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_devices TO service_role;

-------------------------------------------------------------------------------
-- 4) RPC: register_user_device_v1 (idempotent; no direct DML)
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
   RETURNING d.id INTO v_id;

  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.register_user_device_v1(JSONB)
  IS 'Register or update a user device (push token + versions). Idempotent by (org,user,device_identifier_sha256).';
REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_user_device_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Table contracts (audit/timestamps)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'user_devices', TRUE, TRUE, TRUE, 'Device registry (driver/warehouse apps).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601251040_user_devices_v1'));
COMMIT;

