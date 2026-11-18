-- Console V2 managed browser scanner device reissue.
--
-- A revoked user-owned device must remain terminal, but the Console browser
-- scanner is a backend-managed helper identity. If an old managed scanner row
-- is revoked, create a new generation instead of permanently blocking
-- operator Dispatch scan-out.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605220455_console_v2_scanner_device_reissue_v1'));
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
  v_base_ident TEXT := NULL;
  v_ident TEXT := NULL;
  v_generation INTEGER := 1;
  v_replaced_revoked_device_id UUID := NULL;
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
    v_base_ident := encode(digest(format('console-v2-browser-scanner:%s:%s', v_org, v_user), 'sha256'), 'hex');

    SELECT d.id, d.revoked_at
      INTO v_existing_device
      FROM public.user_devices d
     WHERE d.organization_id = v_org
       AND d.user_id = v_user
       AND (
         d.device_identifier_sha256 = v_base_ident
         OR (
           lower(COALESCE(d.metadata->>'managed', 'false')) IN ('true', 't', '1', 'yes')
           AND d.metadata->>'console_scanner_base_identifier_sha256' = v_base_ident
         )
       )
       AND d.revoked_at IS NULL
     ORDER BY d.last_seen_at DESC NULLS LAST, d.created_at DESC
     LIMIT 1;

    IF v_existing_device.id IS NULL THEN
      SELECT latest.id,
             COALESCE(generations.max_generation, 0) + 1
        INTO v_replaced_revoked_device_id, v_generation
        FROM (
          SELECT COALESCE(
                   MAX(COALESCE(NULLIF(d.metadata->>'console_scanner_generation', '')::integer, 1)),
                   0
                 ) AS max_generation
            FROM public.user_devices d
           WHERE d.organization_id = v_org
             AND d.user_id = v_user
             AND (
               d.device_identifier_sha256 = v_base_ident
               OR (
                 lower(COALESCE(d.metadata->>'managed', 'false')) IN ('true', 't', '1', 'yes')
                 AND d.metadata->>'console_scanner_base_identifier_sha256' = v_base_ident
               )
             )
             AND d.revoked_at IS NOT NULL
        ) generations
        LEFT JOIN LATERAL (
          SELECT d.id
            FROM public.user_devices d
           WHERE d.organization_id = v_org
             AND d.user_id = v_user
             AND (
               d.device_identifier_sha256 = v_base_ident
               OR (
                 lower(COALESCE(d.metadata->>'managed', 'false')) IN ('true', 't', '1', 'yes')
                 AND d.metadata->>'console_scanner_base_identifier_sha256' = v_base_ident
               )
             )
             AND d.revoked_at IS NOT NULL
           ORDER BY d.revoked_at DESC NULLS LAST, d.created_at DESC
           LIMIT 1
        ) latest ON TRUE;

      v_generation := GREATEST(COALESCE(v_generation, 1), 1);
      v_ident := CASE
        WHEN v_generation <= 1 THEN v_base_ident
        ELSE encode(digest(format('console-v2-browser-scanner:%s:%s:g:%s', v_org, v_user, v_generation), 'sha256'), 'hex')
      END;

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
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'console_v2_scanner',
          'managed', true,
          'console_scanner_base_identifier_sha256', v_base_ident,
          'console_scanner_generation', v_generation,
          'replaced_revoked_device_id', v_replaced_revoked_device_id
        )),
        now(),
        now()
      )
      RETURNING id INTO v_device_id;
    ELSE
      v_device_id := v_existing_device.id;
      UPDATE public.user_devices d
         SET last_seen_at = now(),
             metadata = COALESCE(d.metadata, '{}'::jsonb)
               || jsonb_build_object(
                 'source', 'console_v2_scanner',
                 'managed', true,
                 'console_scanner_base_identifier_sha256', v_base_ident,
                 'console_scanner_generation', COALESCE(NULLIF(d.metadata->>'console_scanner_generation', '')::integer, 1)
               ),
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
  IS 'API-schema browser wrapper for canonical scan-event intake. Checks canonical scan permission before creating/reusing a managed Console V2 browser scanner device, reissues managed browser scanner generations after revocation, then delegates to public.record_scan_event_v1.';

SELECT pg_advisory_unlock(hashtext('202605220455_console_v2_scanner_device_reissue_v1'));
COMMIT;
