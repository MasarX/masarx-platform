-- Console V2 manual shipment intake lifecycle wrapper.
-- Purpose:
-- - Expose one browser-safe RPC for manual shipment intake.
-- - Keep creation, inline recipient creation, address amendment, and label queueing
--   routed through canonical backend functions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605071930_console_v2_manual_shipment_intake_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_manual_shipment_intake_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_user_id uuid := auth.uid();
  v_dry_run boolean := false;
  v_client_id uuid;
  v_sender_id uuid;
  v_service_type text := COALESCE(NULLIF(btrim(COALESCE(v_args->>'service_type', '')), ''), 'delivery');
  v_tracking_number text := NULLIF(btrim(COALESCE(v_args->>'tracking_number', '')), '');
  v_client_reference_number text := NULLIF(btrim(COALESCE(v_args->>'client_reference_number', '')), '');
  v_carrier_reference_number text := NULLIF(btrim(COALESCE(v_args->>'carrier_reference_number', '')), '');
  v_status text := COALESCE(NULLIF(btrim(COALESCE(v_args->>'status', '')), ''), 'pending');
  v_surface text := COALESCE(NULLIF(lower(btrim(COALESCE(v_args->>'surface', ''))), ''), 'console');
  v_metadata jsonb := '{}'::jsonb;
  v_recipient_text text := NULLIF(btrim(COALESCE(v_args->>'recipient_id', '')), '');
  v_existing_recipient_id uuid;
  v_new_recipient jsonb := NULL;
  v_new_recipient_name text;
  v_new_recipient_phone text;
  v_new_recipient_phone_normalized text;
  v_duplicate_recipient_id uuid;
  v_recipient_id uuid;
  v_recipient_mode text;
  v_recipient_result jsonb := '{}'::jsonb;
  v_destination_address jsonb;
  v_label jsonb := '{}'::jsonb;
  v_label_type text := 'shipping';
  v_job_purpose text := 'primary';
  v_shipment_box_id uuid;
  v_requested_source text := 'console_v2.manual_shipment_intake';
  v_create_preview jsonb := '{}'::jsonb;
  v_create_result jsonb := '{}'::jsonb;
  v_address_result jsonb := '{}'::jsonb;
  v_label_job_id uuid;
  v_shipment_id uuid;
  v_has_existing_recipient boolean := false;
  v_has_new_recipient boolean := false;
  v_existing_recipient_ok boolean := false;
  v_idempotency_key text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
BEGIN
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 requires a json object'
      USING ERRCODE = '22023';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_dry_run := lower(COALESCE(v_args #>> ARRAY['ui','dry_run'], v_args->>'dry_run', 'false')) IN ('true', '1', 'yes', 'on');

  BEGIN
    v_client_id := NULLIF(v_args->>'client_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 client_id must be a uuid'
      USING ERRCODE = '22023';
  END;

  BEGIN
    v_sender_id := NULLIF(v_args->>'sender_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 sender_id must be a uuid'
      USING ERRCODE = '22023';
  END;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;

  v_has_existing_recipient := v_recipient_text IS NOT NULL;
  IF v_has_existing_recipient THEN
    BEGIN
      v_existing_recipient_id := v_recipient_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 recipient_id must be a uuid'
        USING ERRCODE = '22023';
    END;
  END IF;

  IF v_args ? 'new_recipient' AND jsonb_typeof(v_args->'new_recipient') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(v_args->'new_recipient') <> 'object' THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 new_recipient must be an object'
        USING ERRCODE = '22023';
    END IF;
    v_new_recipient := v_args->'new_recipient';
    v_has_new_recipient := true;
  END IF;

  IF v_has_existing_recipient = v_has_new_recipient THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 accepts exactly one of recipient_id or new_recipient'
      USING ERRCODE = '22023';
  END IF;

  IF v_has_new_recipient THEN
    v_new_recipient_name := NULLIF(btrim(COALESCE(v_new_recipient->>'name', '')), '');
    v_new_recipient_phone := NULLIF(btrim(COALESCE(v_new_recipient->>'phone_number', '')), '');
    IF v_new_recipient_name IS NULL THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 new_recipient requires name'
        USING ERRCODE = '23502';
    END IF;
    IF v_new_recipient_phone IS NULL THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 new_recipient requires phone_number'
        USING ERRCODE = '23502';
    END IF;

    v_new_recipient_phone_normalized := public.normalize_phone_number(v_new_recipient_phone);
  END IF;

  v_destination_address := COALESCE(v_args->'destination_address', v_args->'address');
  IF v_destination_address IS NULL OR jsonb_typeof(v_destination_address) <> 'object' OR v_destination_address = '{}'::jsonb THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 requires destination_address object'
      USING ERRCODE = '23502';
  END IF;

  IF v_args ? 'metadata' THEN
    IF jsonb_typeof(v_args->'metadata') <> 'object' THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 metadata must be an object'
        USING ERRCODE = '22023';
    END IF;
    v_metadata := v_args->'metadata';
  END IF;

  IF v_args ? 'label' AND jsonb_typeof(v_args->'label') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(v_args->'label') <> 'object' THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 label must be an object'
        USING ERRCODE = '22023';
    END IF;
    v_label := v_args->'label';
  END IF;

  v_label_type := COALESCE(NULLIF(btrim(COALESCE(v_label->>'label_type', v_args->>'label_type', '')), ''), 'shipping');
  v_job_purpose := COALESCE(NULLIF(btrim(COALESCE(v_label->>'job_purpose', v_args->>'job_purpose', '')), ''), 'primary');
  v_requested_source := COALESCE(NULLIF(btrim(COALESCE(v_label->>'requested_source', v_args->>'requested_source', '')), ''), v_requested_source);

  BEGIN
    v_shipment_box_id := NULLIF(COALESCE(v_label->>'shipment_box_id', v_args->>'shipment_box_id'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 shipment_box_id must be a uuid'
      USING ERRCODE = '22023';
  END;

  v_recipient_id := v_existing_recipient_id;
  v_recipient_mode := CASE WHEN v_has_new_recipient THEN 'inline' ELSE 'existing' END;

  IF v_has_existing_recipient THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.recipients r
       WHERE r.id = v_existing_recipient_id
         AND r.client_id = v_client_id
    )
      INTO v_existing_recipient_ok;

    IF NOT v_existing_recipient_ok THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 recipient_id is not in the selected client scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_has_new_recipient THEN
    PERFORM public.assert_capability_v1('recipients.write');
  END IF;

  v_create_preview := public.ui_create_shipment_v1(
    v_client_id,
    v_sender_id,
    v_service_type,
    v_tracking_number,
    v_client_reference_number,
    v_carrier_reference_number,
    v_status,
    jsonb_strip_nulls(
      v_metadata
      || jsonb_build_object(
        'dry_run', true,
        'ui', (CASE WHEN jsonb_typeof(v_metadata->'ui') = 'object'
                    THEN v_metadata->'ui' ELSE '{}'::jsonb END) || '{"dry_run":true}'::jsonb,
        'recipient_id', v_recipient_id,
        'source', 'console_v2.manual_shipment_intake'
      )
    )
  );

  IF v_has_new_recipient AND v_new_recipient_phone_normalized IS NOT NULL THEN
    SELECT r.id
      INTO v_duplicate_recipient_id
      FROM public.recipients r
     WHERE r.client_id = v_client_id
       AND r.phone_number_normalized = v_new_recipient_phone_normalized
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT 1;
  END IF;

  IF v_dry_run THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', true,
        'status', 'manual_shipment_intake_preview',
        'dry_run', true,
        'recipient_mode', v_recipient_mode,
        'recipient_id', v_recipient_id,
        'new_recipient_preview', CASE
          WHEN v_has_new_recipient THEN jsonb_build_object(
            'name', v_new_recipient_name,
            'phone_number_normalized', v_new_recipient_phone_normalized,
            'duplicate_recipient_id', v_duplicate_recipient_id,
            'would_reject_duplicate', v_duplicate_recipient_id IS NOT NULL
          )
          ELSE NULL
        END,
        'shipment_preview', v_create_preview,
        'address_amendment_preview', jsonb_build_object(
          'operation', 'address',
          'would_call', 'public.shipment_amend_cancel_v1'
        ),
        'label_preview', jsonb_build_object(
          'would_call', 'public.request_label_generation',
          'label_type', v_label_type,
          'job_purpose', v_job_purpose
        )
      )
    );
  END IF;

  IF v_duplicate_recipient_id IS NOT NULL THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 duplicate new_recipient phone_number for client; use recipient_id %', v_duplicate_recipient_id
      USING ERRCODE = '23505';
  END IF;

  IF v_has_new_recipient THEN
    v_recipient_result := public.recipient_create_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'client_id', v_client_id,
          'external_id', NULLIF(btrim(COALESCE(v_new_recipient->>'external_id', '')), ''),
          'name', v_new_recipient_name,
          'phone_number', v_new_recipient_phone,
          'email', NULLIF(btrim(COALESCE(v_new_recipient->>'email', '')), ''),
          'preferred_language', NULLIF(btrim(COALESCE(v_new_recipient->>'preferred_language', '')), ''),
          'preferred_comm_channel', NULLIF(btrim(COALESCE(v_new_recipient->>'preferred_comm_channel', '')), ''),
          'quiet_hours_start', NULLIF(btrim(COALESCE(v_new_recipient->>'quiet_hours_start', '')), ''),
          'quiet_hours_end', NULLIF(btrim(COALESCE(v_new_recipient->>'quiet_hours_end', '')), ''),
          'communication_preferences', CASE
            WHEN v_new_recipient ? 'communication_preferences' THEN v_new_recipient->'communication_preferences'
            ELSE NULL
          END
        )
      )
    );

    BEGIN
      v_recipient_id := NULLIF(v_recipient_result->>'recipient_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_recipient_id := NULL;
    END;

    IF v_recipient_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 recipient_create_v1 did not return recipient_id';
    END IF;
  END IF;

  v_create_result := public.ui_create_shipment_v1(
    v_client_id,
    v_sender_id,
    v_service_type,
    v_tracking_number,
    v_client_reference_number,
    v_carrier_reference_number,
    v_status,
    jsonb_strip_nulls(
      v_metadata
      || jsonb_build_object(
        'recipient_id', v_recipient_id,
        'source', 'console_v2.manual_shipment_intake',
        'manual_intake', jsonb_build_object(
          'recipient_mode', v_recipient_mode,
          'requested_by', v_user_id
        )
      )
    )
  );

  BEGIN
    v_shipment_id := NULLIF(v_create_result->>'shipment_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 ui_create_shipment_v1 did not return shipment_id';
  END IF;

  v_address_result := public.shipment_amend_cancel_v1(
    jsonb_strip_nulls(
      jsonb_build_object(
        'shipment_id', v_shipment_id,
        'operation', 'address',
        'surface', v_surface,
        'address', v_destination_address,
        'destination_address', v_destination_address,
        'reason', COALESCE(NULLIF(btrim(COALESCE(v_args->>'address_reason', '')), ''), 'manual_shipment_intake_destination_address'),
        'idempotency_key', COALESCE(v_idempotency_key, 'manual-intake-address-' || v_shipment_id::text)
      )
    )
  );

  IF COALESCE((v_address_result->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 address amendment failed: %', COALESCE(v_address_result#>>'{error,code}', 'unknown');
  END IF;
  IF lower(COALESCE(v_address_result->>'workflow_status', '')) <> 'completed' THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 address amendment did not complete before label queueing: %', COALESCE(v_address_result->>'workflow_status', 'unknown');
  END IF;

  v_label_job_id := public.request_label_generation(
    v_shipment_id,
    v_label_type,
    v_user_id,
    v_requested_source,
    v_shipment_box_id,
    v_job_purpose
  );

  IF v_label_job_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_manual_shipment_intake_v1 request_label_generation did not return label_job_id';
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', true,
      'status', 'manual_shipment_intake_created',
      'dry_run', false,
      'recipient_mode', v_recipient_mode,
      'recipient_id', v_recipient_id,
      'recipient_result', CASE WHEN v_has_new_recipient THEN v_recipient_result ELSE NULL END,
      'shipment_id', v_shipment_id,
      'shipment_result', v_create_result,
      'address_result', v_address_result,
      'label_job_id', v_label_job_id,
      'label_type', v_label_type,
      'job_purpose', v_job_purpose
    )
  );
END;
$function$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_manual_shipment_intake_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_create_manual_shipment_intake_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_create_manual_shipment_intake_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_manual_shipment_intake_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_create_manual_shipment_intake_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_create_manual_shipment_intake_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb)
  IS 'Console V2 backend lifecycle RPC for manual shipment intake: validates recipient mode, optionally creates inline recipient through recipient_create_v1, creates shipment through ui_create_shipment_v1, applies destination address through shipment_amend_cancel_v1, and queues label generation through request_label_generation.';
COMMENT ON FUNCTION api.ui_create_manual_shipment_intake_v1(jsonb)
  IS 'api-schema wrapper exposing public.ui_create_manual_shipment_intake_v1 for browser Supabase clients.';

SELECT pg_advisory_unlock(hashtext('202605071930_console_v2_manual_shipment_intake_v1'));
COMMIT;
