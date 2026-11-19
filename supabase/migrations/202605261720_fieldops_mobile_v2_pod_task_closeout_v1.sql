-- Migration: FieldOps Mobile V2 POD submit completes canonical route-stop closeout.
-- Date: 2026-05-26
--
-- Mobile V2 still writes through submit_fieldops_proof_v1, but delivered,
-- partial, and failed POD now complete the assigned route_stop_execute task and
-- run the existing task.completed.route_stop_execute workflow readback gate.
-- Shipment truth is projected by the workflow handler, not by this mobile RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605261720_fieldops_mobile_v2_pod_task_closeout_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, api, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_outcome TEXT := lower(btrim(COALESCE(p_outcome, '')));
  v_stop public.route_stops%ROWTYPE;
  v_existing UUID;
  v_meta JSONB;
  v_prev_status TEXT;
  v_new_status TEXT;
  v_decision_id UUID;
  v_proof JSONB;
  v_method TEXT;
  v_methods TEXT[];
  v_required_artifact_kind TEXT;
  v_evidence JSONB := '{}'::jsonb;
  v_artifact_ids JSONB := '[]'::jsonb;
  v_artifact_count INT := 0;
  v_valid_artifact_count INT := 0;
  v_scan_codes TEXT[] := ARRAY[]::text[];
  v_expected_scan_codes TEXT[] := ARRAY[]::text[];
  v_otp_code TEXT := NULL;
  v_expected_otp TEXT := NULL;

  v_route_driver_user_id UUID;
  v_branch_id UUID;
  v_route_run_status TEXT;
  v_shipment_id UUID;
  v_sender_id UUID;
  v_tracking_number TEXT;
  v_box_count INT;
  v_shipment_metadata JSONB := '{}'::jsonb;
  v_cod_amount NUMERIC;
  v_cod_currency TEXT;
  v_task_id UUID;
  v_task_assigned_to UUID;
  v_task_event_id UUID;
  v_task_create RECORD;
  v_task_assign RECORD;
  v_status_reason TEXT := NULL;
  v_transition_payload JSONB := '{}'::jsonb;
  v_payment_terms JSONB := NULL;
  v_payment_method TEXT := NULL;
  v_payment_amount NUMERIC := NULL;
  v_payment_currency TEXT := NULL;
  v_payment_receipt_context TEXT := NULL;
  v_payment_expected_amount NUMERIC := NULL;
  v_payment_collection_patch JSONB := '{}'::jsonb;
  v_closeout RECORD;
  v_replay_shipment_action_id UUID;

  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_outcome NOT IN ('delivered', 'failed', 'partial') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: invalid outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  v_evidence := COALESCE(p_evidence, '{}'::jsonb);
  IF jsonb_typeof(v_evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: evidence must be a JSON object' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_proof', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    SELECT te.id, t.id
      INTO v_task_event_id, v_task_id
      FROM public.task_events te
      JOIN public.tasks t
        ON t.id = te.task_id
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.organization_id = v_org
       AND t.resource_type = 'route_stop'
       AND t.resource_id = p_stop_id
       AND tt.organization_id = v_org
       AND tt.key = 'route_stop_execute'
       AND te.idempotency_key = 'fieldops_proof:' || p_idempotency_key::text
     ORDER BY te.created_at DESC
     LIMIT 1;

    SELECT sa.shipment_id, sa.id
      INTO v_shipment_id, v_replay_shipment_action_id
      FROM public.shipment_actions sa
     WHERE sa.organization_id = v_org
       AND sa.action_data->>'task_event_id' = v_task_event_id::text
     ORDER BY sa.timestamp DESC, sa.created_at DESC
     LIMIT 1;

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id,
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'shipment_id', v_shipment_id,
      'shipment_action_id', v_replay_shipment_action_id
    ));
  END IF;

  SELECT * INTO v_stop
    FROM public.route_stops
   WHERE id = p_stop_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % not found', p_stop_id USING ERRCODE = '22023';
  END IF;
  IF v_stop.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
  END IF;

  SELECT
    rr.driver_user_id,
    rr.branch_id,
    rr.status,
    s.id,
    s.sender_id,
    s.tracking_number,
    s.box_count,
    COALESCE(s.metadata, '{}'::jsonb),
    s.cod_amount,
    s.cod_currency
    INTO
      v_route_driver_user_id,
      v_branch_id,
      v_route_run_status,
      v_shipment_id,
      v_sender_id,
      v_tracking_number,
      v_box_count,
      v_shipment_metadata,
      v_cod_amount,
      v_cod_currency
    FROM public.route_runs rr
    JOIN public.shipments s
      ON s.id = v_stop.shipment_id
     AND s.organization_id = v_stop.organization_id
   WHERE rr.id = v_stop.route_run_id
     AND rr.organization_id = v_stop.organization_id
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: shipment readback unavailable for stop %', p_stop_id
      USING ERRCODE = '23503';
  END IF;
  IF v_route_driver_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % is not assigned to current Mobile V2 driver', p_stop_id
      USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_stop.metadata, '{}'::jsonb);
  v_prev_status := lower(COALESCE(NULLIF(btrim(v_meta->>'status'), ''), 'pending'));
  IF v_prev_status NOT IN ('pending', 'en_route', 'arrived') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop is in terminal state %', v_prev_status USING ERRCODE = 'P0001';
  END IF;

  SELECT t.id, t.assigned_to
    INTO v_task_id, v_task_assigned_to
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org
     AND t.resource_type = 'route_stop'
     AND t.resource_id = v_stop.id
     AND tt.organization_id = v_org
     AND tt.key = 'route_stop_execute'
     AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'cancelled', 'canceled')
     AND (t.assigned_to IS NULL OR t.assigned_to = v_user_id)
   ORDER BY
     CASE WHEN t.assigned_to = v_user_id THEN 0 ELSE 1 END,
     t.created_at DESC,
     t.id DESC
   LIMIT 1;

  IF v_task_id IS NULL THEN
    IF lower(COALESCE(v_route_run_status, '')) IN ('completed', 'cancelled', 'canceled', 'closed') THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1: route_stop_execute task required for canonical closeout of stop %', p_stop_id
        USING ERRCODE = '23503';
    END IF;

    v_service_claims := COALESCE(NULLIF(v_prev_claims, '')::jsonb, '{}'::jsonb);
    IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
      v_service_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

    BEGIN
      SELECT *
        INTO v_task_create
        FROM public.create_task_system_v1(
          jsonb_build_object(
            'task_type_key', 'route_stop_execute',
            'resource_type', 'route_stop',
            'resource_id', v_stop.id,
            'context', jsonb_strip_nulls(jsonb_build_object(
              'organization_id', v_org,
              'route_run_id', v_stop.route_run_id,
              'route_stop_id', v_stop.id,
              'shipment_id', v_shipment_id,
              'client_id', v_stop.client_id,
              'sender_id', v_sender_id,
              'branch_id', v_branch_id,
              'driver_user_id', v_user_id
            )),
            'idempotency_key', format('fieldops-mobile-v2:route-stop-task:%s:%s', v_stop.route_run_id, v_stop.id),
            'metadata', jsonb_strip_nulls(jsonb_build_object(
              'route_run_id', v_stop.route_run_id,
              'route_stop_id', v_stop.id,
              'shipment_id', v_shipment_id,
              'mobile_v2_task_sync', TRUE
            )),
            'actor_system', 'fieldops_mobile_v2_task_sync'
          )
        )
       LIMIT 1;

      v_task_id := v_task_create.task_id;
      IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: route_stop_execute task sync failed for stop %', p_stop_id
          USING ERRCODE = '23503';
      END IF;

      SELECT *
        INTO v_task_assign
        FROM public.assign_task_system_v1(
          v_task_id,
          v_user_id,
          format('fieldops-mobile-v2:assign-route-stop-task:%s:%s', v_stop.route_run_id, v_stop.id),
          'Mobile V2 canonical closeout task sync',
          'fieldops_mobile_v2_task_sync'
        )
       LIMIT 1;
      IF v_task_assign.task_id IS NULL THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: route_stop_execute task assignment failed for stop %', p_stop_id
          USING ERRCODE = '23503';
      END IF;
      v_task_assigned_to := v_user_id;

      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    EXCEPTION
      WHEN others THEN
        PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
        PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
        RAISE;
    END;
  ELSIF v_task_assigned_to IS NULL THEN
    v_service_claims := COALESCE(NULLIF(v_prev_claims, '')::jsonb, '{}'::jsonb);
    IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
      v_service_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
    BEGIN
      SELECT *
        INTO v_task_assign
        FROM public.assign_task_system_v1(
          v_task_id,
          v_user_id,
          format('fieldops-mobile-v2:assign-existing-route-stop-task:%s:%s', v_stop.route_run_id, v_stop.id),
          'Mobile V2 canonical closeout task assignment sync',
          'fieldops_mobile_v2_task_sync'
        )
       LIMIT 1;
      IF v_task_assign.task_id IS NULL THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: route_stop_execute task assignment failed for stop %', p_stop_id
          USING ERRCODE = '23503';
      END IF;
      v_task_assigned_to := v_user_id;

      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    EXCEPTION
      WHEN others THEN
        PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
        PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
        RAISE;
    END;
  END IF;

  v_new_status := CASE v_outcome
    WHEN 'delivered' THEN 'done'
    WHEN 'failed' THEN 'failed'
    WHEN 'partial' THEN 'partial'
  END;

  v_proof := CASE
    WHEN jsonb_typeof(v_meta->'proof') = 'object' THEN v_meta->'proof'
    ELSE '{}'::jsonb
  END;

  SELECT COALESCE(array_agg(method), ARRAY[]::text[])
    INTO v_methods
    FROM regexp_split_to_table(lower(COALESCE(v_evidence->>'pod_methods', '')), '[^a-z0-9_]+') AS method
   WHERE method <> '';

  IF jsonb_typeof(v_evidence->'artifact_ids') = 'array' THEN
    v_artifact_ids := v_evidence->'artifact_ids';
  ELSIF jsonb_typeof(v_evidence #> '{pod,artifact_ids}') = 'array' THEN
    v_artifact_ids := v_evidence #> '{pod,artifact_ids}';
  ELSE
    v_artifact_ids := '[]'::jsonb;
  END IF;

  SELECT COUNT(DISTINCT artifact_id.value)::int
    INTO v_artifact_count
    FROM jsonb_array_elements_text(v_artifact_ids) AS artifact_id(value)
   WHERE btrim(artifact_id.value) <> '';

  IF v_artifact_count > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(v_artifact_ids) AS artifact_id(value)
       WHERE btrim(artifact_id.value) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1: artifact_ids must be UUID values'
        USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(DISTINCT a.id)::int
      INTO v_valid_artifact_count
      FROM jsonb_array_elements_text(v_artifact_ids) AS artifact_id(value)
      JOIN public.artifacts a
        ON a.id = artifact_id.value::uuid
       AND a.organization_id = v_org;

    IF v_valid_artifact_count <> v_artifact_count THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1: artifact_ids must reference current-tenant registered artifacts'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_outcome IN ('delivered', 'partial') THEN
    IF COALESCE(array_length(v_methods, 1), 0) = 0 THEN
      v_methods := ARRAY['scan', 'photo', 'sig'];
    END IF;
    IF v_artifact_count = 0 AND v_methods && ARRAY['photo', 'sig', 'id']::text[] THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1: registered POD artifact_ids are required for photo/signature/id proof'
        USING ERRCODE = '23514';
    END IF;

    FOREACH v_method IN ARRAY v_methods LOOP
      v_required_artifact_kind := CASE v_method
        WHEN 'photo' THEN 'photo'
        WHEN 'sig' THEN 'signature'
        WHEN 'id' THEN 'identity'
        ELSE NULL
      END;
      IF v_required_artifact_kind IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(v_artifact_ids) AS artifact_id(value)
          JOIN public.artifacts a
            ON a.id = artifact_id.value::uuid
           AND a.organization_id = v_org
         WHERE lower(COALESCE(a.metadata->>'artifact_kind', '')) = v_required_artifact_kind
           AND COALESCE(a.metadata->>'route_stop_id', '') = v_stop.id::text
         LIMIT 1
      ) THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: % POD proof requires a matching current-stop artifact', v_method
          USING ERRCODE = '23514';
      END IF;
    END LOOP;

    IF 'scan' = ANY(v_methods) THEN
      SELECT COALESCE(array_agg(DISTINCT btrim(scan_code.value)), ARRAY[]::text[])
        INTO v_scan_codes
        FROM (
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(v_evidence #> '{scan,codes}') = 'array'
              THEN v_evidence #> '{scan,codes}'
              ELSE '[]'::jsonb
            END
          ) AS value
          UNION ALL
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(v_evidence->'scan_codes') = 'array'
              THEN v_evidence->'scan_codes'
              ELSE '[]'::jsonb
            END
          ) AS value
          UNION ALL
          SELECT v_evidence->>'scan_code' AS value
        ) AS scan_code
       WHERE btrim(COALESCE(scan_code.value, '')) <> '';

      IF COALESCE(array_length(v_scan_codes, 1), 0) = 0 THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: scan POD proof requires backend barcode readback codes'
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(array_agg(sb.barcode ORDER BY sb.box_number), ARRAY[]::text[])
        INTO v_expected_scan_codes
        FROM public.shipment_boxes sb
       WHERE sb.shipment_id = v_shipment_id
         AND sb.organization_id = v_org;

      IF COALESCE(array_length(v_expected_scan_codes, 1), 0) = 0 THEN
        SELECT COALESCE(array_agg(v_tracking_number || ':' || box_no.value::text ORDER BY box_no.value), ARRAY[]::text[])
          INTO v_expected_scan_codes
          FROM generate_series(1, GREATEST(COALESCE(v_box_count, 1), 1)) AS box_no(value);
      END IF;

      IF v_outcome = 'delivered' AND EXISTS (
        SELECT 1
          FROM unnest(v_expected_scan_codes) AS expected(code)
         WHERE NOT expected.code = ANY(v_scan_codes)
      ) THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: delivered scan proof must include every expected parcel barcode'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF 'otp' = ANY(v_methods) THEN
      v_otp_code := regexp_replace(COALESCE(v_evidence->>'otp_code', ''), '\D', '', 'g');
      v_expected_otp := regexp_replace(COALESCE(
        NULLIF(v_meta->>'otp_code', ''),
        NULLIF(v_meta #>> '{otp,code}', ''),
        NULLIF(v_meta->>'recipient_otp', ''),
        NULLIF(v_shipment_metadata->>'otp_code', ''),
        NULLIF(v_shipment_metadata #>> '{otp,code}', ''),
        NULLIF(v_shipment_metadata->>'recipient_otp', ''),
        ''
      ), '\D', '', 'g');
      IF v_expected_otp = '' THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: otp POD proof requires a configured backend OTP'
          USING ERRCODE = '23514';
      END IF;
      IF v_otp_code = '' OR v_otp_code IS DISTINCT FROM v_expected_otp THEN
        RAISE EXCEPTION 'submit_fieldops_proof_v1: otp POD proof did not match backend OTP'
          USING ERRCODE = '23514';
      END IF;
      v_evidence := v_evidence - 'otp_code';
      v_evidence := jsonb_set(
        v_evidence,
        '{otp}',
        (
          CASE
            WHEN jsonb_typeof(v_evidence->'otp') = 'object'
              THEN (v_evidence->'otp') - 'code' - 'value' - 'otp_code'
            ELSE '{}'::jsonb
          END
        ) || jsonb_build_object(
          'entered', TRUE,
          'verified', TRUE,
          'code_length', length(v_otp_code)
        ),
        TRUE
      );
    END IF;

    FOREACH v_method IN ARRAY v_methods LOOP
      IF v_method IN ('scan', 'photo', 'sig', 'otp', 'id', 'cod') THEN
        v_proof := jsonb_set(v_proof, ARRAY[v_method], 'true'::jsonb, TRUE);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.route_stops
     SET metadata = jsonb_set(
                      jsonb_set(
                        jsonb_set(v_meta, '{status}', to_jsonb(v_new_status), TRUE),
                        '{last_proof}',
                        jsonb_build_object(
                          'outcome', v_outcome,
                          'evidence', v_evidence,
                          'submitted_at', now(),
                          'submitted_by', v_user_id
                        ),
                        TRUE
                      ),
                      '{proof}',
                      v_proof,
                      TRUE
                    ),
         updated_at = now()
   WHERE id = v_stop.id;

  v_decision_id := public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'fieldops_proof',
    p_resource_type := 'route_stop',
    p_resource_id := v_stop.id,
    p_decision_point := 'submit_proof',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id := p_idempotency_key,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_prev_status,
      'new_status', v_new_status,
      'proof', v_proof,
      'evidence', v_evidence,
      'actor_user_id', v_user_id,
      'canonical_task_id', v_task_id,
      'shipment_id', v_shipment_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  IF v_outcome = 'partial' THEN
    v_status_reason := 'partial_delivery';
  ELSIF v_outcome = 'failed' THEN
    v_status_reason := lower(NULLIF(btrim(COALESCE(
      v_evidence->>'status_reason',
      v_evidence->>'reason_code',
      ''
    )), ''));

    IF v_status_reason IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.lookup_values lv
        JOIN public.lookup_definitions ld
          ON ld.id = lv.lookup_definition_id
       WHERE ld.category = 'dispatch_exception_reason'
         AND lv.value = v_status_reason
         AND lv.status = 'active'
       LIMIT 1
    ) THEN
      v_status_reason := 'no_answer';
    END IF;
  END IF;

  v_transition_payload := jsonb_strip_nulls(jsonb_build_object(
    'source', 'fieldops_mobile_v2',
    'route_stop_id', v_stop.id,
    'route_run_id', v_stop.route_run_id,
    'shipment_id', v_shipment_id,
    'outcome', v_outcome,
    'fieldops_proof_decision_id', v_decision_id,
    'captured_at', NULLIF(btrim(COALESCE(v_evidence->>'captured_at', '')), ''),
    'pod_methods', NULLIF(btrim(COALESCE(v_evidence->>'pod_methods', '')), ''),
    'artifact_ids', CASE WHEN v_artifact_count > 0 THEN v_artifact_ids ELSE NULL END,
    'pod', jsonb_strip_nulls(jsonb_build_object(
      'methods', to_jsonb(v_methods),
      'proof', v_proof,
      'artifact_ids', CASE WHEN v_artifact_count > 0 THEN v_artifact_ids ELSE NULL END,
      'evidence', v_evidence
    ))
  ));

  v_payment_terms := public.resolve_route_stop_payment_terms_v1(
    v_org,
    v_stop.client_id,
    v_sender_id,
    v_branch_id,
    v_cod_amount,
    v_cod_currency
  );

  IF v_payment_terms IS NOT NULL THEN
    v_payment_currency := COALESCE(
      NULLIF(btrim(COALESCE(v_payment_terms->>'currency', '')), ''),
      NULLIF(btrim(COALESCE(v_cod_currency, '')), ''),
      'SAR'
    );

    BEGIN
      v_payment_expected_amount := NULLIF(btrim(COALESCE(v_payment_terms->>'expected_amount', '')), '')::numeric;
    EXCEPTION WHEN others THEN
      v_payment_expected_amount := NULL;
    END;
    v_payment_expected_amount := COALESCE(v_payment_expected_amount, v_cod_amount);

    IF v_outcome = 'failed' THEN
      v_transition_payload := v_transition_payload || jsonb_build_object(
        'payment_outcome', 'refused',
        'payment_collection', jsonb_build_object(
          'outcome', 'refused',
          'collected_amount', 0,
          'currency', v_payment_currency,
          'receipt_context', COALESCE(NULLIF(btrim(COALESCE(v_evidence->>'payment_receipt_context', '')), ''), 'fieldops_mobile_v2_pod')
        )
      );
    ELSE
      v_payment_method := lower(NULLIF(btrim(COALESCE(
        v_evidence #>> '{payment_collection,method}',
        v_evidence->>'payment_method',
        ''
      )), ''));

      IF v_payment_method IS NULL THEN
        SELECT lower(methods.value)
          INTO v_payment_method
          FROM jsonb_array_elements_text(COALESCE(v_payment_terms->'allowed_methods', '["cash"]'::jsonb)) WITH ORDINALITY AS methods(value, ordinality)
         ORDER BY methods.ordinality
         LIMIT 1;
      END IF;
      v_payment_method := COALESCE(v_payment_method, 'cash');

      BEGIN
        v_payment_amount := NULLIF(btrim(COALESCE(
          v_evidence #>> '{payment_collection,collected_amount}',
          v_evidence->>'payment_amount',
          ''
        )), '')::numeric;
      EXCEPTION WHEN others THEN
        v_payment_amount := NULL;
      END;
      v_payment_amount := COALESCE(v_payment_amount, v_payment_expected_amount, v_cod_amount);

      v_payment_receipt_context := COALESCE(
        NULLIF(btrim(COALESCE(v_evidence #>> '{payment_collection,receipt_context}', '')), ''),
        NULLIF(btrim(COALESCE(v_evidence->>'payment_receipt_context', '')), ''),
        'fieldops_mobile_v2_pod'
      );

      v_transition_payload := v_transition_payload || jsonb_build_object(
        'payment_outcome', 'collected',
        'payment_method', v_payment_method,
        'payment_amount', v_payment_amount,
        'payment_receipt_context', v_payment_receipt_context,
        'payment_collection', jsonb_strip_nulls(jsonb_build_object(
          'outcome', 'collected',
          'method', v_payment_method,
          'expected_amount', v_payment_expected_amount,
          'collected_amount', v_payment_amount,
          'tendered_amount', COALESCE(v_evidence #> '{payment_collection,tendered_amount}', v_evidence #> '{payment_collection,collected_amount}'),
          'change_due_amount', v_evidence #> '{payment_collection,change_due_amount}',
          'currency', v_payment_currency,
          'receipt_context', v_payment_receipt_context
        ))
      );
      v_payment_collection_patch := jsonb_strip_nulls(jsonb_build_object(
        'tendered_amount', v_evidence #> '{payment_collection,tendered_amount}',
        'change_due_amount', v_evidence #> '{payment_collection,change_due_amount}'
      ));
    END IF;
  END IF;

  SELECT transitioned.task_event_id
    INTO v_task_event_id
    FROM public.transition_task_v1(
      v_task_id,
      'completed',
      v_status_reason,
      v_transition_payload,
      'fieldops_proof:' || p_idempotency_key::text
    ) AS transitioned
   LIMIT 1;

  IF v_task_event_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: task transition readback unavailable for stop %', p_stop_id
      USING ERRCODE = '23503';
  END IF;

  BEGIN
    BEGIN
      v_service_claims := NULLIF(v_prev_claims, '')::jsonb;
    EXCEPTION WHEN others THEN
      v_service_claims := '{}'::jsonb;
    END;
    IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
      v_service_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

    SELECT *
      INTO v_closeout
      FROM api.ui_finalize_route_stop_closeout_event_v1(v_task_event_id, 50)
     LIMIT 1;

    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      RAISE;
  END;

  IF v_closeout.task_event_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: closeout readback unavailable for task_event %', v_task_event_id
      USING ERRCODE = '23503';
  END IF;

  IF v_payment_collection_patch <> '{}'::jsonb THEN
    IF v_closeout.shipment_action_id IS NOT NULL THEN
      UPDATE public.shipment_actions sa
         SET action_data = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   COALESCE(sa.action_data, '{}'::jsonb),
                   '{delivery_completion,payment_collection}',
                   COALESCE(sa.action_data #> '{delivery_completion,payment_collection}', '{}'::jsonb) || v_payment_collection_patch,
                   TRUE
                 ),
                 '{task_event_payload,payment_collection}',
                 COALESCE(sa.action_data #> '{task_event_payload,payment_collection}', '{}'::jsonb) || v_payment_collection_patch,
                 TRUE
               ),
               '{task_event_payload,delivery_completion,payment_collection}',
               COALESCE(sa.action_data #> '{task_event_payload,delivery_completion,payment_collection}', '{}'::jsonb) || v_payment_collection_patch,
               TRUE
             )
       WHERE sa.id = v_closeout.shipment_action_id;
    END IF;

    IF v_closeout.shipment_id IS NOT NULL THEN
      UPDATE public.shipments s
         SET metadata = jsonb_set(
               COALESCE(s.metadata, '{}'::jsonb),
               '{delivery_completion,payment_collection}',
               COALESCE(s.metadata #> '{delivery_completion,payment_collection}', '{}'::jsonb) || v_payment_collection_patch,
               TRUE
             ),
             updated_at = now()
       WHERE s.id = v_closeout.shipment_id
         AND s.client_id = v_stop.client_id;
    END IF;

    UPDATE public.route_stops rs
       SET metadata = jsonb_set(
             COALESCE(rs.metadata, '{}'::jsonb),
             '{delivery_completion,payment_collection}',
             COALESCE(rs.metadata #> '{delivery_completion,payment_collection}', '{}'::jsonb) || v_payment_collection_patch,
             TRUE
           ),
           updated_at = now()
     WHERE rs.id = v_stop.id;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_new_status,
    'stop_id', v_stop.id,
    'task_id', v_task_id,
    'task_event_id', v_closeout.task_event_id,
    'workflow_run_id', v_closeout.workflow_run_id,
    'workflow_status', v_closeout.workflow_status,
    'shipment_id', v_closeout.shipment_id,
    'shipment_action_id', v_closeout.shipment_action_id
  ));
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID)
  IS 'FieldOps Mobile V2 proof submit: records same-context route-stop proof, completes the canonical route_stop_execute task, and returns workflow/shipment_action readback without direct shipment mutation.';

REVOKE ALL ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_proof_v1(p_stop_id, p_outcome, p_evidence, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605261720_fieldops_mobile_v2_pod_task_closeout_v1'));
COMMIT;
