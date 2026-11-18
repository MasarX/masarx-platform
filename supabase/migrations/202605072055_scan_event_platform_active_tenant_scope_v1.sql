-- Plan: Console V2 universal scanner / Step: platform active-tenant scan writes.
-- Purpose:
-- - Keep record_scan_event_v1 as the canonical scan-event SSOT.
-- - Let platform Console operators pass an explicit active tenant organization_id
--   when scanning tenant-owned route loads.
-- - Keep tenant callers fail-closed if they try to scan for another tenant.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605072055_scan_event_platform_active_tenant_scope_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $mig$
DECLARE
  v_function_def TEXT;
  v_old_decl TEXT := $old$
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_scan, '{}'::jsonb);
$old$;
  v_new_decl TEXT := $new$
  v_user UUID := auth.uid();
  v_in JSONB := COALESCE(p_scan, '{}'::jsonb);
  v_home_org UUID := public.current_user_org_id();
  v_requested_org UUID := NULL;
  v_org UUID := NULL;
$new$;
  v_old_guard TEXT := $old$
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
$old$;
  v_new_guard TEXT := $new$
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires an authenticated user';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'record_scan_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_requested_org := NULLIF(btrim(COALESCE(v_in->>'organization_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'record_scan_event_v1 invalid organization_id' USING ERRCODE = '22P02';
  END;

  v_org := CASE
    WHEN COALESCE(public.is_platform_user(), FALSE) IS TRUE
      AND v_requested_org IS NOT NULL
      THEN v_requested_org
    ELSE v_home_org
  END;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF v_requested_org IS NOT NULL THEN
    PERFORM 1 FROM public.organizations o WHERE o.id = v_requested_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1 organization_id not found' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(public.is_platform_user(), FALSE) IS DISTINCT FROM TRUE
    AND v_requested_org IS NOT NULL
    AND v_requested_org IS DISTINCT FROM v_home_org
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 organization_id is outside caller tenant' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
$new$;
BEGIN
  SELECT pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    INTO v_function_def;

  IF position('v_requested_org UUID := NULL;' IN v_function_def) > 0
     AND position('record_scan_event_v1 organization_id is outside caller tenant' IN v_function_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old_decl IN v_function_def) = 0 THEN
    RAISE EXCEPTION 'Unexpected record_scan_event_v1 declaration shape while adding active tenant scan scope';
  END IF;
  IF position(v_old_guard IN v_function_def) = 0 THEN
    RAISE EXCEPTION 'Unexpected record_scan_event_v1 guard shape while adding active tenant scan scope';
  END IF;

  v_function_def := replace(v_function_def, v_old_decl, v_new_decl);
  v_function_def := replace(v_function_def, v_old_guard, v_new_guard);
  EXECUTE v_function_def;
END;
$mig$;

COMMENT ON FUNCTION public.record_scan_event_v1(JSONB)
  IS 'Insert a scan event (SSOT ledger) with idempotency via scan_event_dedupe; policy-resolved; tenant-only, with explicit active-tenant organization_id support for platform Console operators; can link scans to handling units, warehouse transfers, and ops sessions. Supports warehouse checkpoint sequencing, append-only corrections, and bulk manifest/container batches.';

DO $mig$
DECLARE
  v_function_def TEXT;
  v_anchor TEXT := $anchor$
  IF v_ops_session_id IS NOT NULL THEN
$anchor$;
  v_guard TEXT := $guard$
  IF v_stop_id IS NULL AND v_run_id IS NOT NULL THEN
    DECLARE
      v_run_org UUID;
      v_run_branch UUID;
    BEGIN
      SELECT rr.organization_id, rr.branch_id
        INTO v_run_org, v_run_branch
        FROM public.route_runs rr
       WHERE rr.id = v_run_id;

      IF v_run_org IS NULL THEN
        RAISE EXCEPTION 'record_scan_event_v1 route_run_id % not found', v_run_id USING ERRCODE = '23503';
      END IF;
      IF v_run_org IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'record_scan_event_v1: organization mismatch (event org %, route_run org %)', v_org, v_run_org
          USING ERRCODE = '23514';
      END IF;

      IF v_branch_id IS NULL THEN
        v_branch_id := v_run_branch;
      ELSIF v_run_branch IS NOT NULL AND v_branch_id IS DISTINCT FROM v_run_branch THEN
        RAISE EXCEPTION 'record_scan_event_v1: branch_id mismatch vs route_run' USING ERRCODE = '23514';
      END IF;
    END;
  END IF;

  IF v_ops_session_id IS NOT NULL THEN
$guard$;
BEGIN
  SELECT pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    INTO v_function_def;

  IF position('branch_id mismatch vs route_run' IN v_function_def) > 0 THEN
    RETURN;
  END IF;
  IF position(v_anchor IN v_function_def) = 0 THEN
    RAISE EXCEPTION 'Unexpected record_scan_event_v1 shape while adding route_run scan guard';
  END IF;

  v_function_def := replace(v_function_def, v_anchor, v_guard);
  EXECUTE v_function_def;
END;
$mig$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.record_scan_event_v1(p_scan JSONB)
RETURNS TABLE (
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_scan JSONB := COALESCE(p_scan, '{}'::jsonb);
  v_home_org UUID := public.current_user_org_id();
  v_requested_org UUID := NULL;
  v_org UUID := NULL;
  v_device_id UUID := NULL;
  v_source TEXT := NULL;
  v_ident TEXT := NULL;
  v_existing_device RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'api.record_scan_event_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_scan) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'api.record_scan_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_requested_org := NULLIF(btrim(COALESCE(v_scan->>'organization_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'api.record_scan_event_v1 invalid organization_id' USING ERRCODE = '22P02';
  END;

  v_org := CASE
    WHEN COALESCE(public.is_platform_user(), FALSE) IS TRUE
      AND v_requested_org IS NOT NULL
      THEN v_requested_org
    ELSE v_home_org
  END;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'api.record_scan_event_v1 could not resolve organization_id' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(public.is_platform_user(), FALSE) IS DISTINCT FROM TRUE
    AND v_requested_org IS NOT NULL
    AND v_requested_org IS DISTINCT FROM v_home_org
  THEN
    RAISE EXCEPTION 'api.record_scan_event_v1 organization_id is outside caller tenant' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_device_id := NULLIF(btrim(COALESCE(v_scan->>'device_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'api.record_scan_event_v1 invalid device_id' USING ERRCODE = '22P02';
  END;

  v_source := lower(NULLIF(btrim(COALESCE(v_scan->'metadata'->>'source', '')), ''));
  IF v_device_id IS NULL AND v_source LIKE 'console_v2%' THEN
    v_ident := encode(digest(format('console-v2-browser-scanner:%s:%s', v_org, v_user), 'sha256'), 'hex');

    SELECT d.id, d.revoked_at
      INTO v_existing_device
      FROM public.user_devices d
     WHERE d.organization_id = v_org
       AND d.user_id = v_user
       AND d.device_identifier_sha256 = v_ident
     LIMIT 1;

    IF v_existing_device.id IS NOT NULL AND v_existing_device.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'api.record_scan_event_v1 console scanner device is revoked' USING ERRCODE = '42501';
    END IF;

    IF v_existing_device.id IS NULL THEN
      INSERT INTO public.user_devices (
        id,
        organization_id,
        user_id,
        device_platform,
        device_identifier_sha256,
        device_label,
        last_seen_at,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        v_org,
        v_user,
        'browser',
        v_ident,
        'Console V2 browser scanner',
        now(),
        jsonb_build_object('source', 'console_v2_scanner', 'managed', true),
        now(),
        now()
      )
      RETURNING id INTO v_device_id;
    ELSE
      v_device_id := v_existing_device.id;
      UPDATE public.user_devices d
         SET last_seen_at = now(),
             metadata = COALESCE(d.metadata, '{}'::jsonb)
               || jsonb_build_object('source', 'console_v2_scanner', 'managed', true),
             updated_at = now()
       WHERE d.id = v_device_id;
    END IF;

    v_scan := jsonb_set(v_scan, '{device_id}', to_jsonb(v_device_id::text), true);
  END IF;

  RETURN QUERY
  SELECT *
    FROM public.record_scan_event_v1(v_scan);
END;
$function$;

REVOKE ALL ON FUNCTION api.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.record_scan_event_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION api.record_scan_event_v1(JSONB)
  IS 'API-schema browser wrapper for canonical scan-event intake. Creates/reuses a managed Console V2 browser scanner device for Console-origin scans before delegating to public.record_scan_event_v1.';

SELECT pg_advisory_unlock(hashtext('202605072055_scan_event_platform_active_tenant_scope_v1'));

COMMIT;
