-- Migration: Console V2 warehouse checkpoint managed scanner device v1
-- Date: 2026-05-23
--
-- Console warehouse checkpoint scans are browser-originated but still flow
-- through scan_policy, which can require a user device. Align the warehouse
-- checkpoint API wrapper with api.record_scan_event_v1 by creating/reusing the
-- managed Console browser scanner device before delegating to the canonical
-- public workflow RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230545_console_v2_warehouse_checkpoint_scanner_device_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_selection_id TEXT := COALESCE(
    NULLIF(btrim(COALESCE(p_selection_id, '')), ''),
    NULLIF(btrim(COALESCE(v_params->>'warehouse_transfer_id', '')), ''),
    CASE
      WHEN array_length(p_selection_ids, 1) IS NOT NULL
        THEN NULLIF(btrim(COALESCE(p_selection_ids[1], '')), '')
      ELSE NULL
    END
  );
  v_transfer_id UUID := NULL;
  v_org UUID := NULL;
  v_home_org UUID := public.current_user_org_id();
  v_device_id UUID := NULL;
  v_base_ident TEXT := NULL;
  v_ident TEXT := NULL;
  v_generation INTEGER := 1;
  v_replaced_revoked_device_id UUID := NULL;
  v_existing_device RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'api.ui_execute_warehouse_transfer_checkpoint_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'api.ui_execute_warehouse_transfer_checkpoint_v1 expects JSON object params'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_transfer_id := NULLIF(btrim(COALESCE(v_selection_id, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_transfer_id := NULL;
  END;

  IF v_transfer_id IS NOT NULL THEN
    SELECT wt.organization_id
      INTO v_org
      FROM public.warehouse_transfers wt
     WHERE wt.id = v_transfer_id;
  END IF;
  v_org := COALESCE(v_org, v_home_org);

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'api.ui_execute_warehouse_transfer_checkpoint_v1 could not resolve organization_id'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(public.is_platform_user(), FALSE) IS DISTINCT FROM TRUE
    AND v_org IS DISTINCT FROM v_home_org
  THEN
    RAISE EXCEPTION 'api.ui_execute_warehouse_transfer_checkpoint_v1 organization_id is outside caller tenant'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_device_id := NULLIF(btrim(COALESCE(v_params->>'device_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'api.ui_execute_warehouse_transfer_checkpoint_v1 invalid device_id'
        USING ERRCODE = '22P02';
  END;

  IF v_device_id IS NULL THEN
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

    v_params := jsonb_set(v_params, '{device_id}', to_jsonb(v_device_id::text), true);
  END IF;

  RETURN public.ui_execute_warehouse_transfer_checkpoint_v1(
    p_action_key,
    p_resource_key,
    p_selection_ids,
    p_selection_id,
    p_selection_count,
    v_params
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'API-schema browser wrapper for Console V2 warehouse transfer checkpoint scans. Creates/reuses the managed Console browser scanner device before delegating to public.ui_execute_warehouse_transfer_checkpoint_v1.';

SELECT pg_advisory_unlock(hashtext('202605230545_console_v2_warehouse_checkpoint_scanner_device_v1'));
COMMIT;
