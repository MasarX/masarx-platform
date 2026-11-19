-- Console V2 manual shipment duplicate-reference reuse guard.
-- Purpose:
-- - Treat duplicate manual shipment references as idempotent reuse.
-- - Do not create inline recipients, amend addresses, or queue labels when the
--   create request resolves to an existing shipment.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111020_manual_intake_duplicate_reuse_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ui_create_manual_shipment_intake_v1(jsonb) is missing';
  END IF;

  IF v_def LIKE '%v_duplicate_shipment_id uuid%'
     AND v_def LIKE '%resolve_shipment_create_duplicate_v1%'
     AND v_def LIKE '%''duplicate_shipment_id'', v_duplicate_shipment_id%'
     AND v_def LIKE '%manual_shipment_intake_reused%' THEN
    RAISE NOTICE 'ui_create_manual_shipment_intake_v1 already has duplicate-reference reuse guard';
    RETURN;
  END IF;

  IF v_def NOT LIKE '%v_duplicate_shipment_id uuid%' THEN
    v_def := replace(
      v_def,
$needle$  v_idempotency_key text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
$needle$,
$replacement$  v_idempotency_key text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
  v_duplicate_shipment_id uuid;
  v_duplicate_tracking_number text;
  v_duplicate_operation text;
  v_duplicate_matched_on text;
  v_duplicate_org_id uuid;
  v_duplicate_existing_recipient_id uuid;
  v_duplicate_workflow_run_id uuid;
  v_duplicate_decision_log_id uuid;
  v_duplicate_correlation_id uuid := gen_random_uuid();
$replacement$
    );
  END IF;

  IF v_def NOT LIKE '%v_duplicate_shipment_id uuid%' THEN
    RAISE EXCEPTION 'failed to patch manual intake duplicate variable declarations';
  END IF;

  IF v_def NOT LIKE '%resolve_shipment_create_duplicate_v1%' THEN
    v_def := replace(
      v_def,
$needle$  IF v_has_new_recipient AND v_new_recipient_phone_normalized IS NOT NULL THEN
$needle$,
$replacement$  IF v_client_id IS NOT NULL
     AND (v_tracking_number IS NOT NULL OR v_client_reference_number IS NOT NULL) THEN
    SELECT resolved.shipment_id,
           resolved.tracking_number,
           resolved.operation,
           resolved.matched_on
      INTO v_duplicate_shipment_id,
           v_duplicate_tracking_number,
           v_duplicate_operation,
           v_duplicate_matched_on
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client_id,
        v_tracking_number,
        v_client_reference_number
      ) AS resolved
     LIMIT 1;
  END IF;

  IF v_has_new_recipient AND v_new_recipient_phone_normalized IS NOT NULL THEN
$replacement$
    );
  END IF;

  IF v_def NOT LIKE '%resolve_shipment_create_duplicate_v1%' THEN
    RAISE EXCEPTION 'failed to patch manual intake duplicate preflight';
  END IF;

  IF v_def NOT LIKE '%''duplicate_shipment_id'', v_duplicate_shipment_id%' THEN
    v_def := replace(
      v_def,
$needle$        'shipment_preview', v_create_preview,
        'address_amendment_preview', jsonb_build_object(
$needle$,
$replacement$        'shipment_preview', v_create_preview,
        'duplicate_shipment_id', v_duplicate_shipment_id,
        'duplicate_tracking_number', v_duplicate_tracking_number,
        'duplicate_operation', v_duplicate_operation,
        'duplicate_matched_on', v_duplicate_matched_on,
        'address_amendment_preview', jsonb_build_object(
$replacement$
    );
  END IF;

  IF v_def NOT LIKE '%''duplicate_operation'', v_duplicate_operation%' THEN
    RAISE EXCEPTION 'failed to patch manual intake dry-run duplicate evidence';
  END IF;

  IF v_def NOT LIKE '%manual_shipment_intake_reused%' THEN
    v_def := replace(
      v_def,
$needle$  IF v_duplicate_recipient_id IS NOT NULL THEN
$needle$,
$replacement$  IF v_duplicate_shipment_id IS NOT NULL THEN
    SELECT s.organization_id,
           s.recipient_id,
           CASE
             WHEN NULLIF(s.metadata->>'workflow_run_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN NULLIF(s.metadata->>'workflow_run_id', '')::uuid
             ELSE NULL
           END
      INTO v_duplicate_org_id,
           v_duplicate_existing_recipient_id,
           v_duplicate_workflow_run_id
      FROM public.shipments s
     WHERE s.id = v_duplicate_shipment_id
     LIMIT 1;

    v_duplicate_decision_log_id := public.log_decision(
      v_duplicate_org_id,
      'workflow',
      'shipment',
      v_duplicate_shipment_id,
      'manual_shipment_duplicate_reference',
      COALESCE(v_duplicate_operation, 'reused'),
      'ui_create_manual_shipment_intake_v1',
      v_duplicate_correlation_id,
      jsonb_strip_nulls(
        jsonb_build_object(
          'client_id', v_client_id,
          'sender_id', v_sender_id,
          'recipient_mode', v_recipient_mode,
          'requested_recipient_id', v_recipient_id,
          'existing_recipient_id', v_duplicate_existing_recipient_id,
          'tracking_number', v_tracking_number,
          'client_reference_number', v_client_reference_number,
          'carrier_reference_number', v_carrier_reference_number,
          'matched_on', v_duplicate_matched_on,
          'operation', v_duplicate_operation,
          'side_effects_skipped', jsonb_build_array('recipient_create', 'address_amend', 'label_queue')
        )
      ),
      'Duplicate manual shipment intake reused an existing shipment; address and label side effects were skipped.'
    );

    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', true,
        'status', 'manual_shipment_intake_reused',
        'dry_run', false,
        'recipient_mode', v_recipient_mode,
        'recipient_id', COALESCE(v_duplicate_existing_recipient_id, v_recipient_id),
        'shipment_id', v_duplicate_shipment_id,
        'tracking_number', v_duplicate_tracking_number,
        'operation', COALESCE(v_duplicate_operation, 'reused'),
        'matched_on', v_duplicate_matched_on,
        'duplicate_reused', true,
        'workflow_run_id', v_duplicate_workflow_run_id,
        'correlation_id', v_duplicate_correlation_id,
        'decision_log_id', v_duplicate_decision_log_id,
        'shipment_result', jsonb_strip_nulls(
          jsonb_build_object(
            'shipment_id', v_duplicate_shipment_id,
            'tracking_number', v_duplicate_tracking_number,
            'operation', COALESCE(v_duplicate_operation, 'reused'),
            'matched_on', v_duplicate_matched_on,
            'workflow_run_id', v_duplicate_workflow_run_id,
            'correlation_id', v_duplicate_correlation_id,
            'decision_log_id', v_duplicate_decision_log_id
          )
        ),
        'address_result', jsonb_build_object(
          'skipped', true,
          'reason', 'duplicate_reference_reuse'
        ),
        'label_result', jsonb_build_object(
          'skipped', true,
          'reason', 'duplicate_reference_reuse'
        )
      )
    );
  END IF;

  IF v_duplicate_recipient_id IS NOT NULL THEN
$replacement$
    );
  END IF;

  IF v_def NOT LIKE '%manual_shipment_intake_reused%' THEN
    RAISE EXCEPTION 'failed to patch manual intake duplicate reuse branch';
  END IF;

  EXECUTE v_def;
END
$migration$;

COMMENT ON FUNCTION public.ui_create_manual_shipment_intake_v1(jsonb)
  IS 'Console V2 backend lifecycle RPC for manual shipment intake: validates recipient mode, optionally creates inline recipient through recipient_create_v1, creates shipment through ui_create_shipment_v1, applies destination address through shipment_amend_cancel_v1, queues label generation through request_label_generation, and returns existing shipment context without side effects when tracking/client reference resolves to a duplicate.';

SELECT pg_advisory_unlock(hashtext('202605111020_manual_intake_duplicate_reuse_guard_v1'));
COMMIT;
