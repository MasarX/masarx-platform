BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.mark_fieldops_return_received_v1(
  p_stop_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_stop     public.route_stops%ROWTYPE;
  v_meta     JSONB;
  v_prev_status TEXT;
  v_existing UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1('returns.write', 'tenant', v_org);

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_return_received', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop % not found', p_stop_id USING ERRCODE = '22023';
  END IF;
  IF v_stop.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_stop.metadata, '{}'::jsonb);
  v_prev_status := lower(COALESCE(NULLIF(btrim(v_meta->>'status'), ''), 'pending'));
  IF v_prev_status = 'rto' THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop already marked rto' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.route_stops
     SET metadata = jsonb_set(v_meta, '{status}', to_jsonb('rto'::text), TRUE),
         updated_at = now()
   WHERE id = v_stop.id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_return_received',
    p_resource_type       := 'route_stop',
    p_resource_id         := v_stop.id,
    p_decision_point      := 'mark_return_received',
    p_decision_outcome    := 'rto',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'previous_status', v_prev_status,
                               'new_status',      'rto',
                               'actor_user_id',   v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'rto',
    'stop_id', v_stop.id
  );
END;
$$;

COMMIT;
