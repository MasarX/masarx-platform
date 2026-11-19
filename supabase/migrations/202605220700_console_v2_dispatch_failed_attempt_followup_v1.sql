-- Migration: Console V2 dispatch failed-attempt follow-up repair
-- Purpose:
-- - Keep active route-stop finalization aligned with dispatch exception taxonomy.
-- - Failed delivery attempts must enqueue the row-driven follow-up task from
--   dispatch_exception_reason.metadata.recommended_followup_task_type_key.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605220700_console_v2_dispatch_failed_attempt_followup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v10(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := '{}'::jsonb;

  v_task_event_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_shipment_action_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_org UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_route_run_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_tracking_number TEXT := NULL;
  v_service_type TEXT := NULL;

  v_exception_reason TEXT := NULL;
  v_followup_task_type_key TEXT := NULL;
  v_default_ndr_action TEXT := NULL;
  v_allowed_ndr_actions JSONB := NULL;
  v_followup_idempotency_key TEXT := NULL;
  v_followup_created RECORD;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_claims JSONB := '{}'::jsonb;
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  v_resp := workflow_handlers.execute_route_stop_finalize_v9(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  v_task_event_payload := COALESCE(
    v_resp.operation_result->'task_event_payload',
    v_payload->'task_event_payload',
    '{}'::jsonb
  );
  IF jsonb_typeof(v_task_event_payload) IS DISTINCT FROM 'object' THEN
    v_task_event_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_task_event_id := COALESCE(
      NULLIF(v_resp.operation_result->>'task_event_id', ''),
      NULLIF(v_task_event_payload->>'task_event_id', ''),
      NULLIF(v_payload->>'task_event_id', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_task_event_id := NULL;
  END;

  BEGIN
    v_route_stop_id := COALESCE(
      NULLIF(v_resp.operation_result->>'route_stop_id', ''),
      NULLIF(v_ctx->>'resource_id', ''),
      NULLIF(v_task_event_payload->>'route_stop_id', ''),
      NULLIF(v_task_event_payload #>> '{route_stop_completion,route_stop_id}', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_route_stop_id := NULL;
  END;

  BEGIN
    v_shipment_action_id := COALESCE(
      NULLIF(v_resp.operation_result->>'shipment_action_id', ''),
      NULLIF(v_resp.operation_result #>> '{dispatch_stop,shipment_action_id}', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_shipment_action_id := NULL;
  END;

  IF v_shipment_action_id IS NULL AND v_route_stop_id IS NOT NULL THEN
    SELECT sa.id
      INTO v_shipment_action_id
      FROM public.shipment_actions sa
     WHERE (sa.action_data->>'route_stop_id') = v_route_stop_id::text
     ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
     LIMIT 1;
  END IF;

  IF v_shipment_action_id IS NOT NULL THEN
    SELECT
      sa.id,
      sa.shipment_id,
      sa.organization_id,
      sa.client_id,
      sa.action_data,
      sa.dispatch_exception_reason,
      s.sender_id,
      s.tracking_number,
      s.service_type,
      rs.route_run_id,
      rr.branch_id
      INTO
        v_shipment_action_id,
        v_shipment_id,
        v_org,
        v_client_id,
        v_task_event_payload,
        v_exception_reason,
        v_sender_id,
        v_tracking_number,
        v_service_type,
        v_route_run_id,
        v_branch_id
      FROM public.shipment_actions sa
      JOIN public.shipments s
        ON s.id = sa.shipment_id
       AND s.client_id = sa.client_id
      LEFT JOIN public.route_stops rs
        ON rs.id = v_route_stop_id
      LEFT JOIN public.route_runs rr
        ON rr.id = rs.route_run_id
     WHERE sa.id = v_shipment_action_id
     LIMIT 1;
  END IF;

  IF v_shipment_id IS NULL THEN
    BEGIN
      v_shipment_id := COALESCE(
        NULLIF(v_resp.operation_result->>'shipment_id', ''),
        NULLIF(v_task_event_payload->>'shipment_id', '')
      )::uuid;
    EXCEPTION WHEN others THEN
      v_shipment_id := NULL;
    END;
  END IF;

  IF v_shipment_id IS NOT NULL AND (v_org IS NULL OR v_client_id IS NULL OR v_sender_id IS NULL OR v_tracking_number IS NULL) THEN
    SELECT
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.tracking_number,
      s.service_type
      INTO v_org, v_client_id, v_sender_id, v_tracking_number, v_service_type
      FROM public.shipments s
     WHERE s.id = v_shipment_id
     LIMIT 1;
  END IF;

  v_exception_reason := lower(NULLIF(btrim(COALESCE(
    v_exception_reason,
    v_task_event_payload->>'dispatch_exception_reason',
    v_task_event_payload->>'outcome_reason',
    v_task_event_payload->>'status_reason',
    v_task_event_payload #>> '{delivery_attempt,dispatch_exception_reason}',
    v_task_event_payload #>> '{route_stop_completion,delivery_attempt,dispatch_exception_reason}',
    v_task_event_payload #>> '{task_event_payload,delivery_attempt,dispatch_exception_reason}',
    ''
  )), ''));

  IF v_exception_reason IS NULL
     OR v_org IS NULL
     OR v_client_id IS NULL
     OR v_shipment_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT
    NULLIF(btrim(COALESCE(lv.metadata->>'recommended_followup_task_type_key', '')), ''),
    NULLIF(btrim(COALESCE(lv.metadata->>'default_ndr_action', '')), '')
    INTO v_followup_task_type_key, v_default_ndr_action
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'dispatch_exception_reason'
     AND lv.value = v_exception_reason
     AND COALESCE(lv.status, 'active') = 'active'
   ORDER BY lv.sort_order NULLS LAST, lv.created_at, lv.id
   LIMIT 1;

  v_followup_task_type_key := lower(NULLIF(btrim(COALESCE(v_followup_task_type_key, '')), ''));
  v_default_ndr_action := lower(NULLIF(btrim(COALESCE(v_default_ndr_action, '')), ''));
  IF v_followup_task_type_key IS NULL THEN
    RETURN v_resp;
  END IF;

  IF v_default_ndr_action IS NOT NULL THEN
    v_allowed_ndr_actions := jsonb_build_array(v_default_ndr_action);
  END IF;

  v_followup_idempotency_key := format(
    'dispatch_stop_followup:%s:%s',
    COALESCE(v_task_event_id::text, v_shipment_action_id::text, v_shipment_id::text),
    v_followup_task_type_key
  );

  BEGIN
    BEGIN
      v_claims := current_setting('request.jwt.claims', true)::jsonb;
    EXCEPTION WHEN others THEN
      v_claims := '{}'::jsonb;
    END;
    IF jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
      v_claims := '{}'::jsonb;
    END IF;
    v_service_claims := (v_claims - 'sub') || jsonb_build_object('role', 'service_role');

    PERFORM set_config('app.actor_system', 'dispatch_engine', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

    SELECT *
      INTO v_followup_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_followup_task_type_key,
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_client_id,
            'sender_id', v_sender_id,
            'branch_id', v_branch_id,
            'shipment_id', v_shipment_id,
            'route_run_id', v_route_run_id,
            'route_stop_id', v_route_stop_id,
            'shipment_action_id', v_shipment_action_id,
            'dispatch_exception_reason', v_exception_reason,
            'service_type', v_service_type,
            'allowed_ndr_actions', v_allowed_ndr_actions
          )),
          'resource_type', 'shipment',
          'resource_id', v_shipment_id,
          'idempotency_key', v_followup_idempotency_key,
          'metadata', jsonb_strip_nulls(jsonb_build_object(
            'parent_workflow_run_id', p_run.id,
            'parent_workflow_step_id', p_step.id,
            'shipment_action_id', v_shipment_action_id,
            'route_stop_id', v_route_stop_id,
            'dispatch_exception_reason', v_exception_reason,
            'tracking_number', v_tracking_number,
            'subject', CASE
              WHEN v_tracking_number IS NOT NULL THEN 'NDR review ' || v_tracking_number
              ELSE NULL
            END,
            'service_type', v_service_type,
            'allowed_ndr_actions', v_allowed_ndr_actions,
            'resolution_action', v_default_ndr_action
          )),
          'actor_system', 'dispatch_engine'
        ))
      )
     LIMIT 1;

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);
    RAISE;
  END;

  IF v_followup_created.task_id IS NOT NULL THEN
    v_resp.operation_result := jsonb_set(
      COALESCE(v_resp.operation_result, '{}'::jsonb),
      '{followup_task_ids}',
      jsonb_build_array(v_followup_created.task_id),
      TRUE
    );
  END IF;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v10',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v10',
  TRUE,
  'Console V2 failed-attempt follow-up repair: wraps v9 and enqueues taxonomy-driven dispatch exception review/RTO follow-up tasks.',
  'docs/ops/evidence/2026-05-22/console-v2-dispatch-failed-attempt-ndr-live-browser-proof.md'
)
ON CONFLICT (handler_key)
DO UPDATE SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = TRUE,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

UPDATE public.workflow_template_steps wts
   SET handler_key = 'route_stop_finalize',
       handler_version = 'v10',
       updated_at = now()
  FROM public.workflow_templates wt
 WHERE wt.id = wts.workflow_template_id
   AND wt.name = 'dispatch_route_stop_finalize_v1'
   AND wts.handler_key = 'route_stop_finalize';

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

COMMENT ON FUNCTION workflow_handlers.execute_route_stop_finalize_v10(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Active route-stop finalizer wrapper. Preserves v9 closeout behavior, then creates row-driven follow-up tasks for failed delivery attempts using dispatch_exception_reason taxonomy metadata.';

DO $backfill$
DECLARE
  v_row RECORD;
  v_followup_task_type_key TEXT;
  v_default_ndr_action TEXT;
  v_allowed_ndr_actions JSONB;
  v_idempotency_key TEXT;
  v_created RECORD;
BEGIN
  FOR v_row IN
    SELECT
      sa.id AS shipment_action_id,
      sa.shipment_id,
      sa.organization_id,
      sa.client_id,
      sa.dispatch_exception_reason,
      sa.action_data,
      s.sender_id,
      s.tracking_number,
      s.service_type,
      NULLIF(sa.action_data->>'route_stop_id', '')::uuid AS route_stop_id,
      NULLIF(sa.action_data->>'route_run_id', '')::uuid AS route_run_id,
      NULLIF(sa.action_data->>'task_event_id', '')::uuid AS task_event_id,
      rr.branch_id
    FROM public.shipment_actions sa
    JOIN public.shipments s
      ON s.id = sa.shipment_id
     AND s.client_id = sa.client_id
    LEFT JOIN public.route_stops rs
      ON rs.id = NULLIF(sa.action_data->>'route_stop_id', '')::uuid
    LEFT JOIN public.route_runs rr
      ON rr.id = COALESCE(rs.route_run_id, NULLIF(sa.action_data->>'route_run_id', '')::uuid)
   WHERE sa.dispatch_exception_reason IS NOT NULL
     AND sa.delivery_attempt_outcome = 'not_delivered'
     AND NOT EXISTS (
       SELECT 1
       FROM public.tasks t
       WHERE t.task_type_key = 'dispatch_exception_review'
         AND t.resource_type = 'shipment'
         AND t.resource_id = sa.shipment_id
         AND (
           t.metadata->>'shipment_action_id' = sa.id::text
           OR t.idempotency_key IN (
             format('dispatch_stop_followup:%s:%s', COALESCE(NULLIF(sa.action_data->>'task_event_id', ''), sa.id::text), 'dispatch_exception_review'),
             format('dispatch_stop_followup:%s:%s', sa.id::text, 'dispatch_exception_review')
           )
         )
     )
  LOOP
    SELECT
      NULLIF(btrim(COALESCE(lv.metadata->>'recommended_followup_task_type_key', '')), ''),
      NULLIF(btrim(COALESCE(lv.metadata->>'default_ndr_action', '')), '')
      INTO v_followup_task_type_key, v_default_ndr_action
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_row.dispatch_exception_reason
       AND COALESCE(lv.status, 'active') = 'active'
     ORDER BY lv.sort_order NULLS LAST, lv.created_at, lv.id
     LIMIT 1;

    v_followup_task_type_key := lower(NULLIF(btrim(COALESCE(v_followup_task_type_key, '')), ''));
    v_default_ndr_action := lower(NULLIF(btrim(COALESCE(v_default_ndr_action, '')), ''));
    IF v_followup_task_type_key IS NULL THEN
      CONTINUE;
    END IF;

    v_allowed_ndr_actions := CASE
      WHEN v_default_ndr_action IS NULL THEN NULL
      ELSE jsonb_build_array(v_default_ndr_action)
    END;
    v_idempotency_key := format(
      'dispatch_stop_followup:%s:%s',
      COALESCE(v_row.task_event_id::text, v_row.shipment_action_id::text),
      v_followup_task_type_key
    );

    SELECT *
      INTO v_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_followup_task_type_key,
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_row.organization_id,
            'client_id', v_row.client_id,
            'sender_id', v_row.sender_id,
            'branch_id', v_row.branch_id,
            'shipment_id', v_row.shipment_id,
            'route_run_id', v_row.route_run_id,
            'route_stop_id', v_row.route_stop_id,
            'shipment_action_id', v_row.shipment_action_id,
            'dispatch_exception_reason', v_row.dispatch_exception_reason,
            'service_type', v_row.service_type,
            'allowed_ndr_actions', v_allowed_ndr_actions
          )),
          'resource_type', 'shipment',
          'resource_id', v_row.shipment_id,
          'idempotency_key', v_idempotency_key,
          'metadata', jsonb_strip_nulls(jsonb_build_object(
            'parent_workflow_run_id', NULLIF(v_row.action_data->>'workflow_run_id', '')::uuid,
            'shipment_action_id', v_row.shipment_action_id,
            'route_stop_id', v_row.route_stop_id,
            'dispatch_exception_reason', v_row.dispatch_exception_reason,
            'tracking_number', v_row.tracking_number,
            'subject', 'NDR review ' || v_row.tracking_number,
            'service_type', v_row.service_type,
            'allowed_ndr_actions', v_allowed_ndr_actions,
            'resolution_action', v_default_ndr_action,
            'backfilled_by', '202605220700_console_v2_dispatch_failed_attempt_followup_v1'
          )),
          'actor_system', 'dispatch_engine'
        ))
      )
     LIMIT 1;
  END LOOP;
END;
$backfill$;

SELECT pg_advisory_unlock(hashtext('202605220700_console_v2_dispatch_failed_attempt_followup_v1'));
COMMIT;
