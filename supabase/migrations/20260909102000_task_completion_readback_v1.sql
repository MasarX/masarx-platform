-- F546: scoped persisted completion proof, no raw task payload or auth secrets.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE OR REPLACE FUNCTION public.ui_get_task_completion_readback_v1(p_task_id UUID, p_task_event_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $function$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_event public.task_events%ROWTYPE;
  v_stop public.route_stops%ROWTYPE;
  v_action public.shipment_actions%ROWTYPE;
  v_completion JSONB;
  v_pod JSONB;
  v_payment JSONB;
  v_artifacts JSONB;
  v_geostamp JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- Reuse canonical registry capability + tenant/client/sender scope admission.
  IF public.ui_get_resource_v1('tasks', p_task_id) IS NULL THEN
    RAISE EXCEPTION 'Task not visible' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_task FROM public.tasks WHERE id=p_task_id;
  SELECT * INTO v_event FROM public.task_events
    WHERE id=p_task_event_id AND task_id=v_task.id
      AND organization_id=v_task.organization_id AND actor_user_id=auth.uid();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_task.resource_type <> 'route_stop' THEN RETURN NULL; END IF;
  SELECT * INTO v_stop FROM public.route_stops
    WHERE id=v_task.resource_id AND organization_id=v_task.organization_id
      AND (v_task.client_id IS NULL OR client_id=v_task.client_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_action FROM public.shipment_actions
    WHERE organization_id=v_stop.organization_id AND client_id=v_stop.client_id
      AND shipment_id=v_stop.shipment_id
      AND action_data->>'route_stop_id'=v_stop.id::text
      AND action_data->>'task_event_id'=v_event.id::text
    ORDER BY timestamp DESC,created_at DESC,id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_completion := COALESCE(v_action.action_data->'delivery_completion','{}'::jsonb);
  v_pod := COALESCE(v_action.action_data#>'{task_event_payload,pod}','{}'::jsonb);
  v_payment := COALESCE(v_completion->'payment_collection','{}'::jsonb);
  v_artifacts:=COALESCE(v_action.action_data->'artifact_ids',v_action.action_data#>'{task_event_payload,artifact_ids}','[]'::jsonb);
  IF jsonb_typeof(v_artifacts) IS DISTINCT FROM 'array' THEN v_artifacts:='[]'::jsonb; END IF;
  v_geostamp:=CASE
    WHEN jsonb_typeof(v_action.action_data#>'{task_event_payload,exception_evidence,geostamp}')='object'
      THEN v_action.action_data#>'{task_event_payload,exception_evidence,geostamp}'
    WHEN jsonb_typeof(v_completion->'geostamp')='object' THEN v_completion->'geostamp'
    WHEN jsonb_typeof(v_action.action_data#>'{delivery_attempt,geostamp}')='object' THEN v_action.action_data#>'{delivery_attempt,geostamp}'
    WHEN jsonb_typeof(v_action.action_data#>'{task_event_payload,geostamp}')='object' THEN v_action.action_data#>'{task_event_payload,geostamp}'
    WHEN jsonb_typeof(v_pod->'geostamp')='object' THEN v_pod->'geostamp' ELSE NULL END;
  RETURN jsonb_build_object(
    'task',jsonb_build_object('id',v_task.id,'status',v_task.status),
    'task_event_id',v_event.id,'shipment_action_id',v_action.id,
    'proof',jsonb_build_object(
      'artifact_ids',v_artifacts,
      'signature_artifact_id',COALESCE(v_completion->>'signature_artifact_id',
        v_pod->>'signature_artifact_id',v_action.action_data#>>'{task_event_payload,signature_artifact_id}',
        v_action.action_data#>>'{pod,signature_artifact_id}',v_action.action_data->>'signature_artifact_id'),
      'geostamp_present',jsonb_typeof(v_geostamp->'latitude')='number' AND jsonb_typeof(v_geostamp->'longitude')='number',
      'otp_confirmed',v_completion->'otp_confirmed',
      'identity_present',NULLIF(v_completion->>'recipient_identity_kind','') IS NOT NULL
        AND NULLIF(v_completion->>'recipient_identity_last4','') IS NOT NULL),
    'pickup',CASE WHEN v_stop.stop_kind='pickup' THEN jsonb_build_object(
      'confirmed_quantity',v_event.payload->'confirmed_quantity',
      'handover_contact_present',NULLIF(btrim(v_event.payload->>'handover_contact_name'),'') IS NOT NULL,
      'handover_notes_present',NULLIF(btrim(v_event.payload->>'handover_notes'),'') IS NOT NULL,
      'receipt_context_present',NULLIF(btrim(v_event.payload->>'receipt_context'),'') IS NOT NULL
    ) ELSE NULL END,
    'completion',jsonb_build_object(
      'completion_kind',v_completion->'completion_kind',
      'delivered_box_numbers',v_completion->'delivered_box_numbers',
      'payment_collection',jsonb_build_object(
        'collected_amount',v_payment->'collected_amount','outcome',v_payment->'outcome',
        'method',v_payment->'method','has_discrepancy',v_payment->'has_discrepancy',
        'discrepancy_kind',v_payment->'discrepancy_kind','variance_amount',v_payment->'variance_amount')),
    'stop',jsonb_build_object('id',v_stop.id,'kind',v_stop.stop_kind,
      'canonical_status',v_action.canonical_status,'dispatch_exception_reason',CASE WHEN v_stop.stop_kind='pickup' THEN NULLIF(btrim(v_action.action_data->>'outcome_reason'),'') ELSE v_action.dispatch_exception_reason END,
      'route_stop_outcome',v_action.route_stop_outcome,
      'delivery_attempt_outcome',v_action.delivery_attempt_outcome,
      'delivery_attempt_reason',v_action.delivery_attempt_reason));
END;
$function$;
REVOKE ALL ON FUNCTION public.ui_get_task_completion_readback_v1(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_get_task_completion_readback_v1(UUID,UUID) TO authenticated;
CREATE OR REPLACE FUNCTION api.ui_get_task_completion_readback_v1(p_task_id UUID,p_task_event_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp AS $function$
 SELECT public.ui_get_task_completion_readback_v1(p_task_id,p_task_event_id);
$function$;
REVOKE ALL ON FUNCTION api.ui_get_task_completion_readback_v1(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.ui_get_task_completion_readback_v1(UUID,UUID) TO authenticated;
COMMIT;
