-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: verify_driver_document_v1 — approve a driver document and emit a compliance event
-- Date: 2026-04-28
--
-- Notes:
--   - Capability key: fleet.write (canonical SSOT; "compliance.write" is not a registered key
--     in the rbac_permission lookup. Driver-document RLS already gates writes on fleet.write.)
--   - Sets driver_documents.status='verified', verified_at=now(), verified_by_user_id=auth.uid().
--   - Appends a driver_compliance_events row (event_type='document_verified').

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280050_verify_driver_document_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.verify_driver_document_v1(p_args JSONB)
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
  v_notes TEXT;
  v_metadata JSONB;

  v_doc public.driver_documents%ROWTYPE;
  v_compliance_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'verify_driver_document_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'verify_driver_document_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_document_id := NULLIF(p_args->>'driver_document_id', '')::UUID;
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_document_id IS NULL THEN
    RAISE EXCEPTION 'verify_driver_document_v1: driver_document_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_doc
    FROM public.driver_documents
   WHERE id = v_document_id
   FOR UPDATE;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'verify_driver_document_v1: document % not found', v_document_id USING ERRCODE = 'P0002';
  END IF;
  IF v_doc.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'verify_driver_document_v1: document % belongs to another organization', v_document_id USING ERRCODE = '42501';
  END IF;
  IF v_doc.status NOT IN ('submitted','rejected') THEN
    RAISE EXCEPTION 'verify_driver_document_v1: document % is not in a verifiable state (status=%)', v_document_id, v_doc.status
      USING ERRCODE = '22023';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('driver_compliance_policy', 'tenant', v_org_id);

  -- Approve the document
  UPDATE public.driver_documents
     SET status = 'verified',
         verified_at = now(),
         verified_by_user_id = auth.uid(),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'verified_correlation_id', v_correlation_id,
                         'verified_notes', v_notes
                       )
                    || COALESCE(v_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_document_id;

  -- Emit compliance event in the SSOT ledger
  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload,
    settings_resolution_id
  )
  VALUES (
    v_compliance_event_id,
    v_org_id,
    v_doc.user_id,
    'document_verified',
    auth.uid(),
    'verify_driver_document_v1',
    jsonb_build_object(
      'driver_document_id', v_document_id,
      'doc_type', v_doc.doc_type,
      'previous_status', v_doc.status,
      'notes', v_notes,
      'correlation_id', v_correlation_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    NULL
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'compliance.driver_document_verified',
    'driver_document',
    v_document_id,
    jsonb_build_object(
      'driver_user_id', v_doc.user_id,
      'doc_type', v_doc.doc_type,
      'driver_compliance_event_id', v_compliance_event_id,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'compliance.driver_document_verified',
    'driver_document',
    v_document_id,
    'rpc_dispatch',
    'verified',
    'verify_driver_document_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_doc.user_id,
      'doc_type', v_doc.doc_type,
      'previous_status', v_doc.status,
      'driver_compliance_event_id', v_compliance_event_id,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_document_id', v_document_id,
    'driver_user_id', v_doc.user_id,
    'doc_type', v_doc.doc_type,
    'status', 'verified',
    'driver_compliance_event_id', v_compliance_event_id,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_compliance_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_driver_document_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_driver_document_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.verify_driver_document_v1(JSONB)
  IS 'Canonical RPC: approve a driver_documents row (status=verified) and append a driver_compliance_events row (event_type=document_verified). Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280050_verify_driver_document_v1'));
COMMIT;
