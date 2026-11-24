BEGIN;

CREATE FUNCTION api.public_tracking_proof_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_body jsonb := public.public_tracking_session_v1(p_input);
  v_session record;
  v_delivery record;
  v_policy jsonb;
  v_until timestamptz;
  v_artifacts jsonb := '[]'::jsonb;
  v_state text := 'unavailable';
  v_now timestamptz := workflow_now();
BEGIN
  IF v_body->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RETURN v_body;
  END IF;

  SELECT ts.*, s.status AS shipment_status
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s ON (s.id, s.client_id, s.organization_id) =
    (ts.shipment_id, ts.client_id, ts.organization_id)
  WHERE ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > v_now)
    AND s.tracking_number = v_body #>> '{tracking,shipment,tracking_number}'
    AND ts.token_hash = crypt(btrim(p_input->>'session_token'), ts.token_hash)
  ORDER BY ts.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));

  SELECT sa.id, sa.timestamp, sa.pod_captured_at, sa.action_data,
    COALESCE(
      sa.action_data #>> '{delivery_completion,signature_artifact_id}',
      sa.action_data #>> '{task_event_payload,pod,signature_artifact_id}',
      sa.action_data #>> '{task_event_payload,signature_artifact_id}',
      sa.action_data #>> '{pod,signature_artifact_id}',
      sa.action_data->>'signature_artifact_id'
    ) AS signature_artifact_id
  INTO v_delivery
  FROM public.shipment_actions sa
  WHERE (sa.shipment_id, sa.client_id, sa.organization_id) =
    (v_session.shipment_id, v_session.client_id, v_session.organization_id)
    AND sa.timestamp <= v_now
    AND (
      (v_session.shipment_status = 'delivered' AND sa.canonical_status = 'delivered')
      OR (sa.delivery_completion_kind = 'partial' AND sa.delivered_box_count > 0)
    )
  ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
  LIMIT 1;

  IF FOUND AND public.public_tracking_bool_v1(v_policy, '{proof,enabled}', true) THEN
    v_until := v_delivery.timestamp + make_interval(hours =>
      public.public_tracking_int_v1(v_policy, '{proof,window_hours}', 24, 1, 168)
    );

    IF v_until <= v_now THEN
      v_state := 'expired';
    ELSE
      WITH eligible AS (
        SELECT a.id, a.storage_bucket, a.storage_key, a.mime_type, a.created_at,
          CASE
            WHEN a.id::text = v_delivery.signature_artifact_id
              OR a.metadata->>'artifact_kind' = 'signature' THEN 'signature'
            WHEN a.metadata->>'artifact_kind' IN ('photo', 'pod_photo')
              OR v_delivery.signature_artifact_id IS DISTINCT FROM a.id::text
                AND a.metadata->>'artifact_kind' IS NULL THEN 'photo'
          END AS kind
        FROM public.artifact_links al
        JOIN public.artifacts a ON a.id = al.artifact_id AND a.organization_id = al.organization_id
        WHERE al.organization_id = v_session.organization_id
          AND al.resource_type = 'shipment_action' AND al.resource_id = v_delivery.id
          AND al.relation_type = 'pod'
          AND a.storage_bucket = 'fieldops-evidence'
          AND starts_with(a.storage_key, v_session.organization_id::text || '/')
          AND a.mime_type IN ('image/png', 'image/jpeg', 'image/jpg')
          AND (a.size_bytes IS NULL OR a.size_bytes BETWEEN 1 AND 5 * 1024 * 1024)
          AND a.metadata->'hide_from_public_tracking' IS DISTINCT FROM 'true'::jsonb
          AND al.metadata->'hide_from_public_tracking' IS DISTINCT FROM 'true'::jsonb
      ),
      selected AS (
        SELECT DISTINCT ON (kind) *
        FROM eligible
        WHERE kind IS NOT NULL
          AND public.public_tracking_bool_v1(v_policy, ARRAY['proof', kind || '_enabled'], true)
        ORDER BY kind, created_at DESC, id DESC
      )
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id, 'kind', kind, 'captured_at', COALESCE(public.parse_external_timestamp_v1(v_delivery.pod_captured_at), v_delivery.timestamp),
        'storage_bucket', storage_bucket, 'storage_key', storage_key, 'mime_type', mime_type
      ) ORDER BY kind), '[]'::jsonb)
      INTO v_artifacts
      FROM selected;

      IF jsonb_array_length(v_artifacts) > 0 THEN
        v_state := 'available';
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'session_id', v_session.id, 'session_expires_at', v_session.expires_at,
    'proof', jsonb_build_object(
      'state', v_state,
      'available_until', CASE WHEN v_state <> 'unavailable' THEN v_until END,
      'recipient_name', CASE WHEN v_state = 'available' THEN
        COALESCE(public.public_tracking_mask_name_v1(COALESCE(
          v_delivery.action_data #>> '{delivery_completion,recipient_name}',
          v_delivery.action_data #>> '{task_event_payload,pod,recipient_name}',
          v_delivery.action_data #>> '{pod,recipient_name}'
        ), 1), v_body #>> '{tracking,recipient,name}')
      END,
      'artifacts', v_artifacts
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.public_tracking_proof_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.public_tracking_proof_v1(jsonb) TO service_role;

COMMIT;
