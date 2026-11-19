-- Migration: Console V2 warehouse scan correction UI v1
-- Date: 2026-05-23
--
-- Expose an operator-safe request path for append-only scan corrections and
-- project correction scan rows back into the Warehouse drawer read model.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230735_console_v2_warehouse_scan_correction_ui_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.warehouse_checkpoint_scans;

CREATE VIEW public.warehouse_checkpoint_scans
  WITH (security_invoker = true)
AS
SELECT
  se.id,
  se.organization_id,
  se.scan_type,
  se.warehouse_transfer_id AS transfer_id,
  se.warehouse_transfer_id,
  se.shipment_id,
  COALESCE(
    NULLIF(btrim(se.checkpoint_key), ''),
    NULLIF(btrim(se.metadata->>'checkpoint'), ''),
    NULLIF(btrim(se.metadata->>'checkpoint_key'), ''),
    CASE WHEN se.scan_type = 'correction' THEN 'correction' ELSE NULL END
  ) AS checkpoint,
  COALESCE(
    se.checkpoint_sequence,
    CASE
      WHEN COALESCE(se.metadata->>'sequence', '') ~ '^[0-9]+$'
        THEN (se.metadata->>'sequence')::INT
      ELSE NULL
    END
  ) AS sequence,
  se.captured_at AS occurred_at,
  se.captured_at,
  se.actor_user_id AS user_id,
  se.actor_user_id,
  se.branch_id,
  se.client_id,
  se.barcode,
  se.correction_of_scan_event_id,
  se.correction_reason,
  se.correction_approval_task_id,
  se.metadata,
  se.received_at,
  se.created_at
FROM public.scan_events se
WHERE se.scan_type IN ('warehouse_checkpoint', 'correction')
  AND (
    se.scan_type = 'warehouse_checkpoint'
    OR se.correction_of_scan_event_id IS NOT NULL
  );

COMMENT ON VIEW public.warehouse_checkpoint_scans IS
  'Console V2 warehouse scan projection derived from canonical scan_events for warehouse_checkpoint and approved append-only correction scans. Read-only; writes stay on record_scan_event_v1 and dedicated UI wrappers.';

REVOKE ALL ON public.warehouse_checkpoint_scans FROM PUBLIC;
REVOKE ALL ON public.warehouse_checkpoint_scans FROM anon;
GRANT SELECT ON public.warehouse_checkpoint_scans TO authenticated;
GRANT SELECT ON public.warehouse_checkpoint_scans TO service_role;

DROP POLICY IF EXISTS scan_events_warehouse_checkpoint_select ON public.scan_events;
CREATE POLICY scan_events_warehouse_checkpoint_select
  ON public.scan_events
  FOR SELECT
  TO authenticated
  USING (
    scan_type IN ('warehouse_checkpoint', 'correction')
    AND (
      public.is_platform_user()
      OR (
        organization_id = public.current_user_org_id()
        AND public.user_has_capability_v1('warehouse.read', 'tenant', organization_id)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.ui_request_warehouse_scan_correction_v1(
  p_scan_event_id UUID,
  p_correction_reason TEXT,
  p_corrected_barcode TEXT,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_reason TEXT := NULLIF(btrim(COALESCE(p_correction_reason, '')), '');
  v_corrected_barcode TEXT := NULLIF(btrim(COALESCE(p_corrected_barcode, '')), '');
  v_visible_scan JSONB := NULL;
  v_scan public.scan_events%ROWTYPE;
  v_task RECORD;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_idempotency_key TEXT := NULL;
  v_subject TEXT := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 expects JSON object params'
      USING ERRCODE = '23514';
  END IF;
  IF p_scan_event_id IS NULL THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 requires scan_event_id'
      USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 requires correction_reason'
      USING ERRCODE = '23514';
  END IF;
  IF v_corrected_barcode IS NULL THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 requires corrected_barcode'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_capability_v1('warehouse.write', v_scope_type, v_scope_id);

  v_visible_scan := public.ui_get_resource_v1('warehouse_checkpoint_scans', p_scan_event_id);
  IF v_visible_scan IS NULL THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 scan % is not visible', p_scan_event_id
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_scan
    FROM public.scan_events se
   WHERE se.id = p_scan_event_id
     AND se.scan_type = 'warehouse_checkpoint';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_request_warehouse_scan_correction_v1 scan_event % not found', p_scan_event_id
      USING ERRCODE = '23503';
  END IF;

  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), ''),
    'warehouse_scan_correction_request_v1:' || p_scan_event_id::text || ':' || md5(v_corrected_barcode || ':' || v_reason)
  );
  v_subject := 'Scan correction · ' || COALESCE(NULLIF(v_scan.barcode, ''), p_scan_event_id::text);

  BEGIN
    v_service_claims := COALESCE(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb);
  EXCEPTION
    WHEN others THEN
      v_service_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := v_service_claims || jsonb_build_object(
    'role', 'service_role',
    'sub', v_user_id::text,
    'organization_id', v_scan.organization_id::text,
    'origin', 'ui_request_warehouse_scan_correction_v1'
  );

  BEGIN
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);

    SELECT *
      INTO v_task
      FROM public.create_task_system_v1(
        jsonb_build_object(
          'task_type_key', 'warehouse_scan_supervisor_approval',
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_scan.organization_id,
            'requested_by', v_user_id,
            'source', 'console_v2.warehouse.scan_correction_request'
          )),
          'resource_type', 'scan_event',
          'resource_id', p_scan_event_id,
          'idempotency_key', v_idempotency_key,
          'metadata', jsonb_strip_nulls(jsonb_build_object(
            'subject', v_subject,
            'source', 'console_v2.warehouse.scan_correction_request',
            'task_type_key', 'warehouse_scan_supervisor_approval',
            'scan_correction', jsonb_strip_nulls(jsonb_build_object(
              'original_scan_event_id', p_scan_event_id,
              'warehouse_transfer_id', v_scan.warehouse_transfer_id,
              'shipment_id', v_scan.shipment_id,
              'original_barcode', v_scan.barcode,
              'corrected_barcode', v_corrected_barcode,
              'correction_reason', v_reason,
              'requested_by', v_user_id
            ))
          ))
        )
      )
      LIMIT 1;

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      RAISE;
  END;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 'requested',
    'task_id', v_task.task_id,
    'scan_event_id', p_scan_event_id,
    'warehouse_transfer_id', v_scan.warehouse_transfer_id,
    'corrected_barcode', v_corrected_barcode,
    'correction_reason', v_reason,
    'count', 1
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_request_warehouse_scan_correction_v1(
  p_scan_event_id UUID,
  p_correction_reason TEXT,
  p_corrected_barcode TEXT,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN public.ui_request_warehouse_scan_correction_v1(
    p_scan_event_id,
    p_correction_reason,
    p_corrected_barcode,
    COALESCE(p_params, '{}'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB)
  IS 'Console V2 browser-safe wrapper to request an append-only warehouse scan correction by creating a warehouse_scan_supervisor_approval task for the original scan_event.';
COMMENT ON FUNCTION api.ui_request_warehouse_scan_correction_v1(UUID, TEXT, TEXT, JSONB)
  IS 'API-schema wrapper for Console V2 warehouse scan correction request.';

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
BEGIN
  SELECT s.settings_version_id, COALESCE(s.cached_value, sv.value, '{}'::jsonb)
    INTO v_settings_version_id, v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RETURN;
  END IF;

  v_resource := jsonb_build_object(
    'key', 'warehouse_checkpoint_scans',
    'relation', 'public.warehouse_checkpoint_scans',
    'id_column', 'id',
    'capability_read', 'warehouse.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'select', jsonb_build_array(
      'id','organization_id','scan_type','transfer_id','warehouse_transfer_id','shipment_id',
      'checkpoint','sequence','occurred_at','captured_at','user_id','actor_user_id',
      'branch_id','client_id','barcode','correction_of_scan_event_id','correction_reason',
      'correction_approval_task_id','metadata','received_at','created_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','transfer_id','column','transfer_id','op','eq'),
      jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
      jsonb_build_object('key','checkpoint','column','checkpoint','op','eq'),
      jsonb_build_object('key','scan_type','column','scan_type','op','eq')
    ),
    'default_sort', jsonb_build_object('column','occurred_at','direction','desc')
  );

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);
  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
    INTO v_filtered
    FROM jsonb_array_elements(v_resources) AS value
   WHERE value->>'key' <> 'warehouse_checkpoint_scans';

  v_current := jsonb_set(
    v_current,
    '{resources}',
    v_filtered || jsonb_build_array(v_resource),
    true
  );

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605230735_console_v2_warehouse_scan_correction_ui_v1'));
COMMIT;
