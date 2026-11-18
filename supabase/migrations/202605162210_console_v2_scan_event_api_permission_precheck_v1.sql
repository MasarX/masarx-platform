-- Keep the browser-safe scan-event API wrapper fail-closed before creating
-- Console-managed scanner devices. The canonical public recorder already
-- requires tasks.complete; this mirrors that guard in the API schema wrapper
-- so denied Console V2 scan attempts leave no scan or device side effects.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605162210_console_v2_scan_event_api_permission_precheck_v1'));
SET search_path TO public, extensions, pg_temp;

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
  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'api.record_scan_event_v1 requires tasks.complete permission' USING ERRCODE = '42501';
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
  IS 'API-schema browser wrapper for canonical scan-event intake. Checks canonical scan permission before creating/reusing a managed Console V2 browser scanner device, then delegates to public.record_scan_event_v1.';

SELECT pg_advisory_unlock(hashtext('202605162210_console_v2_scan_event_api_permission_precheck_v1'));
COMMIT;
