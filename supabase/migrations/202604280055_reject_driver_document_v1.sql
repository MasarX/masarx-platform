-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: reject_driver_document_v1 — reject a driver document with a reason
-- Date: 2026-04-28

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280055_reject_driver_document_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.reject_driver_document_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_document_id UUID;
  v_reason TEXT;
  v_metadata JSONB;

  v_doc public.driver_documents%ROWTYPE;
  v_compliance_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'reject_driver_document_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'reject_driver_document_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_document_id := NULLIF(p_args->>'driver_document_id', '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_document_id IS NULL THEN
    RAISE EXCEPTION 'reject_driver_document_v1: driver_document_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reject_driver_document_v1: reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_doc
    FROM public.driver_documents
   WHERE id = v_document_id
   FOR UPDATE;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'reject_driver_document_v1: document % not found', v_document_id USING ERRCODE = 'P0002';
  END IF;
  IF v_doc.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'reject_driver_document_v1: document % belongs to another organization', v_document_id USING ERRCODE = '42501';
  END IF;
  IF v_doc.status NOT IN ('submitted','verified') THEN
    RAISE EXCEPTION 'reject_driver_document_v1: document % is not in a rejectable state (status=%)', v_document_id, v_doc.status
      USING ERRCODE = '22023';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('driver_compliance_policy', 'tenant', v_org_id);

  UPDATE public.driver_documents
     SET status = 'rejected',
         verified_at = NULL,
         verified_by_user_id = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'rejected_reason', v_reason,
                         'rejected_correlation_id', v_correlation_id,
                         'rejected_by', auth.uid(),
                         'rejected_at', now()
                       )
                    || COALESCE(v_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_document_id;

  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload
  )
  VALUES (
    v_compliance_event_id,
    v_org_id,
    v_doc.user_id,
    'document_rejected',
    auth.uid(),
    'reject_driver_document_v1',
    jsonb_build_object(
      'driver_document_id', v_document_id,
      'doc_type', v_doc.doc_type,
      'previous_status', v_doc.status,
      'reason', v_reason,
      'correlation_id', v_correlation_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'compliance.driver_document_rejected',
    'driver_document',
    v_document_id,
    jsonb_build_object(
      'driver_user_id', v_doc.user_id,
      'doc_type', v_doc.doc_type,
      'reason', v_reason,
      'driver_compliance_event_id', v_compliance_event_id,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'compliance.driver_document_rejected',
    'driver_document',
    v_document_id,
    'rpc_dispatch',
    'rejected',
    'reject_driver_document_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_doc.user_id,
      'doc_type', v_doc.doc_type,
      'previous_status', v_doc.status,
      'driver_compliance_event_id', v_compliance_event_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_document_id', v_document_id,
    'driver_user_id', v_doc.user_id,
    'doc_type', v_doc.doc_type,
    'status', 'rejected',
    'driver_compliance_event_id', v_compliance_event_id,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_compliance_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_driver_document_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_driver_document_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.reject_driver_document_v1(JSONB)
  IS 'Canonical RPC: reject a driver_documents row (status=rejected) with a required reason and append a driver_compliance_events row (event_type=document_rejected). Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280055_reject_driver_document_v1'));
COMMIT;
