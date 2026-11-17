-- Same-request applicant document return; private attempt authority, no bearer tokens in object keys.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET search_path TO public, extensions, pg_temp;


ALTER TABLE public.marketplace_participant_requests ADD COLUMN document_review_revision BIGINT NOT NULL DEFAULT 0;
CREATE FUNCTION public.driver_application_review_revision_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO public, pg_temp AS $body$
BEGIN
  NEW.document_review_revision := OLD.document_review_revision + 1;
  RETURN NEW;
END; $body$;
CREATE TRIGGER driver_application_review_revision
  BEFORE UPDATE OF reviewed_at, reviewed_by, status, document_review_revision
  ON public.marketplace_participant_requests FOR EACH ROW
  EXECUTE FUNCTION public.driver_application_review_revision_v1();
REVOKE ALL ON FUNCTION public.driver_application_review_revision_v1() FROM PUBLIC,anon,authenticated;

CREATE TABLE public.driver_application_document_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.marketplace_participant_requests(id),
  retry_key UUID NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  review_revision BIGINT NOT NULL,
  requested_types JSONB NOT NULL CHECK (jsonb_typeof(requested_types) = 'array'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  manifest_hash TEXT NOT NULL,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'aborted')),
  cleanup_state TEXT NOT NULL DEFAULT 'not_required' CHECK (cleanup_state IN ('not_required', 'pending', 'complete')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, retry_key)
);
CREATE UNIQUE INDEX driver_application_document_attempts_active
  ON public.driver_application_document_attempts(request_id) WHERE state = 'reserved';
ALTER TABLE public.driver_application_document_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_application_document_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.driver_application_document_attempts TO service_role;
CREATE POLICY driver_application_document_attempts_service ON public.driver_application_document_attempts
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
COMMENT ON TABLE public.driver_application_document_attempts IS
  'Private immutable document manifests and terminal attempt receipts. Application and review truth stays on marketplace_participant_requests.';

CREATE FUNCTION public.driver_application_document_attempt_immutable_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path TO public, extensions, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.request_id, NEW.retry_key, NEW.reviewed_at, NEW.requested_types,
      NEW.manifest, NEW.manifest_hash, NEW.note, NEW.created_at, NEW.review_revision)
    IS DISTINCT FROM
     (OLD.id, OLD.request_id, OLD.retry_key, OLD.reviewed_at, OLD.requested_types,
      OLD.manifest, OLD.manifest_hash, OLD.note, OLD.created_at, OLD.review_revision)
    OR (OLD.state <> 'reserved' AND NEW.state <> OLD.state)
    OR (OLD.state = 'committed' AND NEW.result IS DISTINCT FROM OLD.result) THEN
    RAISE EXCEPTION 'immutable_document_attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER driver_application_document_attempt_immutable
  BEFORE UPDATE ON public.driver_application_document_attempts FOR EACH ROW
  EXECUTE FUNCTION public.driver_application_document_attempt_immutable_v1();

CREATE FUNCTION public.driver_application_requested_types_v1(p_metadata JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path TO public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
  FROM (SELECT DISTINCT btrim(value) AS value
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_metadata->'requested_documents') = 'array'
      THEN p_metadata->'requested_documents' ELSE '[]'::jsonb END)
    WHERE btrim(value) <> '') t;
$$;

CREATE FUNCTION public.driver_application_document_reserve_v1(
  p_status_token UUID, p_retry_key UUID, p_documents JSONB, p_note TEXT DEFAULT NULL,
  p_storage_bucket TEXT DEFAULT 'fieldops-evidence'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $$
DECLARE
  r public.marketplace_participant_requests%ROWTYPE;
  a public.driver_application_document_attempts%ROWTYPE;
  v_docs JSONB; v_types JSONB; v_requested JSONB; v_hash TEXT; v_id UUID := gen_random_uuid();
  v_bucket storage.buckets%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.marketplace_participant_requests
    WHERE public_status_token = p_status_token FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','request_not_found')); END IF;
  SELECT * INTO v_bucket FROM storage.buckets WHERE id=p_storage_bucket AND public=FALSE;
  IF v_bucket.id IS NULL THEN RAISE EXCEPTION 'document_bucket_unavailable' USING ERRCODE='23514'; END IF;
  IF p_retry_key IS NULL OR jsonb_typeof(p_documents) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_documents) NOT BETWEEN 1 AND 12 OR length(COALESCE(p_note,'')) > 2000 THEN
    RAISE EXCEPTION 'invalid_document_manifest' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_documents) d
    WHERE jsonb_typeof(d) IS DISTINCT FROM 'object' OR btrim(COALESCE(d->>'type','')) = ''
      OR length(d->>'type') > 100 OR COALESCE(d->>'sha256','') !~ '^[a-f0-9]{64}$'
      OR COALESCE(d->>'size_bytes','') !~ '^[0-9]{1,8}$'
      OR (d->>'size_bytes')::BIGINT NOT BETWEEN 1 AND LEAST(COALESCE(v_bucket.file_size_limit,10485760),10485760)
      OR (v_bucket.allowed_mime_types IS NOT NULL AND NOT (d->>'content_type'=ANY(v_bucket.allowed_mime_types)))
      OR COALESCE(d->>'content_type','') NOT IN ('image/jpeg','image/png','application/pdf','application/json')
      OR d ?| ARRAY['status','verified_at','verified_by_user_id','storage_key','storage_bucket','ref']) THEN
    RAISE EXCEPTION 'invalid_document_manifest' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('type',btrim(d->>'type'),'sha256',d->>'sha256',
      'size_bytes',(d->>'size_bytes')::BIGINT,'content_type',d->>'content_type',
      'file_name',left(COALESCE(d->>'file_name','document'),180)) ORDER BY d->>'type',d->>'sha256')
    INTO v_docs FROM jsonb_array_elements(p_documents) d;
  SELECT jsonb_agg(value ORDER BY value) INTO v_types
    FROM (SELECT DISTINCT d->>'type' AS value FROM jsonb_array_elements(v_docs) d) t;
  v_hash := encode(digest(v_docs::TEXT || E'\n' || COALESCE(p_note,'') || E'\n' || v_bucket.id, 'sha256'),'hex');
  SELECT * INTO a FROM public.driver_application_document_attempts
    WHERE request_id=r.id AND retry_key=p_retry_key FOR UPDATE;
  IF a.id IS NOT NULL THEN
    IF a.manifest_hash <> v_hash THEN RAISE EXCEPTION 'document_attempt_payload_changed' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('ok',TRUE,'attempt_id',a.id,'state',a.state,'new_attempt',FALSE,
      'cleanup_state',a.cleanup_state,'result',a.result);
  END IF;
  v_requested := public.driver_application_requested_types_v1(r.decision_metadata);
  IF r.status <> 'pending' OR r.reviewed_at IS NULL
    OR lower(COALESCE(r.decision_metadata->>'request_additional_docs','false')) NOT IN ('true','t','1','yes') THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','additional_documents_not_requested'));
  END IF;
  IF NOT v_types @> v_requested THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','requested_documents_missing'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.driver_application_document_attempts WHERE request_id=r.id AND state='reserved') THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_attempt_in_progress'));
  END IF;
  SELECT jsonb_agg(d || jsonb_build_object('storage_bucket',v_bucket.id,
      'storage_key','driver-applications/'||r.id||'/'||v_id||'/'||n||'-'||(d->>'sha256')) ORDER BY n)
    INTO v_docs FROM jsonb_array_elements(v_docs) WITH ORDINALITY t(d,n);
  INSERT INTO public.driver_application_document_attempts(id,request_id,retry_key,reviewed_at,requested_types,manifest,manifest_hash,note,review_revision)
    VALUES(v_id,r.id,p_retry_key,r.reviewed_at,v_requested,v_docs,v_hash,NULLIF(p_note,''),r.document_review_revision);
  RETURN jsonb_build_object('ok',TRUE,'attempt_id',v_id,'state','reserved','new_attempt',TRUE,'manifest',v_docs);
END; $$;

CREATE FUNCTION public.driver_application_document_readback_v1(p_status_token UUID, p_retry_key UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $$
DECLARE r public.marketplace_participant_requests%ROWTYPE; a public.driver_application_document_attempts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.marketplace_participant_requests WHERE public_status_token=p_status_token;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','request_not_found')); END IF;
  SELECT * INTO a FROM public.driver_application_document_attempts WHERE request_id=r.id AND retry_key=p_retry_key;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok',TRUE,'state','not_found'); END IF;
  RETURN jsonb_build_object('ok',TRUE,'attempt_id',a.id,'state',a.state,'cleanup_state',a.cleanup_state,'result',a.result);
END; $$;

CREATE FUNCTION public.driver_application_document_apply_v1(p_status_token UUID, p_attempt_id UUID, p_uploaded_manifest JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $$
DECLARE r public.marketplace_participant_requests%ROWTYPE; a public.driver_application_document_attempts%ROWTYPE;
  v_documents JSONB; v_result JSONB; v_resolution UUID; v_decision UUID;
BEGIN
  SELECT * INTO r FROM public.marketplace_participant_requests WHERE public_status_token=p_status_token FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','request_not_found')); END IF;
  SELECT * INTO a FROM public.driver_application_document_attempts WHERE id=p_attempt_id AND request_id=r.id FOR UPDATE;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_attempt_not_found')); END IF;
  IF a.state='committed' THEN RETURN a.result; END IF;
  IF a.state <> 'reserved' THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_attempt_aborted')); END IF;
  IF p_uploaded_manifest IS DISTINCT FROM a.manifest THEN
    RAISE EXCEPTION 'document_manifest_mismatch' USING ERRCODE='23514';
  END IF;
  IF r.status <> 'pending' OR r.document_review_revision <> a.review_revision OR r.reviewed_at IS DISTINCT FROM a.reviewed_at
    OR public.driver_application_requested_types_v1(r.decision_metadata) IS DISTINCT FROM a.requested_types
    OR lower(COALESCE(r.decision_metadata->>'request_additional_docs','false')) NOT IN ('true','t','1','yes') THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_review_changed'));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(a.manifest) d WHERE NOT EXISTS (
    SELECT 1 FROM storage.objects o WHERE o.bucket_id=d->>'storage_bucket' AND o.name=d->>'storage_key'
      AND (o.metadata->>'size')::BIGINT = (d->>'size_bytes')::BIGINT)) THEN
    RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_upload_not_confirmed'));
  END IF;
  SELECT COALESCE(jsonb_agg(d),'[]'::jsonb) INTO v_documents
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.verification_documents)='array'
      THEN r.verification_documents ELSE '[]'::jsonb END) d
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.manifest) m
      WHERE m->>'type'=COALESCE(d->>'type',d->>'doc_type'));
  SELECT v_documents || jsonb_agg(d || jsonb_build_object('ref',d->>'storage_key','status','submitted',
      'source','driver_application_documents','submitted_at',now(),'attempt_id',a.id))
    INTO v_documents FROM jsonb_array_elements(a.manifest) d;
  SELECT settings_resolution_id INTO v_resolution FROM public.marketplace_resolve_policy_row_v1(
    'marketplace_compliance_policy',jsonb_build_object('organization_id',r.requested_organization_id,
    'participant_type_key',r.requested_participant_type_key)) LIMIT 1;
  UPDATE public.marketplace_participant_requests SET verification_documents=v_documents,
    decision_metadata=COALESCE(decision_metadata,'{}'::jsonb)||jsonb_build_object(
      'request_additional_docs',FALSE,'documents_resubmitted',TRUE,'last_resubmitted_at',now(),
      'last_resubmission_attempt_id',a.id,'last_resubmission_note',a.note),
    updated_at=now() WHERE id=r.id;
  v_decision := public.log_decision(
    p_organization_id:=COALESCE(r.requested_organization_id,public.marketplace_system_org_id_v1()),
    p_decision_category:='marketplace_compliance_policy',p_resource_type:='marketplace_participant_request',
    p_resource_id:=r.id,p_decision_point:='participant_request.documents_resubmitted',
    p_decision_outcome:='documents_resubmitted',p_performed_by_system:='driver_application_document_apply_v1',
    p_decision_inputs:=jsonb_build_object('attempt_id',a.id,'requested_types',a.requested_types,'manifest_hash',a.manifest_hash),
    p_decision_reason:=COALESCE(a.note,'documents_resubmitted'),p_settings_resolution_id:=v_resolution);
  PERFORM public.marketplace_append_event_v1(
    COALESCE(r.requested_organization_id,public.marketplace_system_org_id_v1()),'marketplace_participant_request',r.id,
    'participant_request.documents_resubmitted',jsonb_build_object('attempt_id',a.id,'decision_log_id',v_decision,
      'settings_resolution_id',v_resolution,'requested_types',a.requested_types));
  v_result:=jsonb_build_object('ok',TRUE,'attempt_id',a.id,'status','pending','application_state','documents_resubmitted',
    'submitted_document_count',(SELECT count(DISTINCT d->>'type') FROM jsonb_array_elements(a.manifest) d),
    'missing_document_count',0);
  UPDATE public.driver_application_document_attempts SET state='committed',result=v_result,updated_at=now() WHERE id=a.id;
  RETURN v_result;
END; $$;

CREATE FUNCTION public.driver_application_document_abort_v1(
  p_status_token UUID,p_attempt_id UUID,p_cleanup_complete BOOLEAN DEFAULT FALSE
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $$
DECLARE r public.marketplace_participant_requests%ROWTYPE; a public.driver_application_document_attempts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.marketplace_participant_requests WHERE public_status_token=p_status_token FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','request_not_found')); END IF;
  SELECT * INTO a FROM public.driver_application_document_attempts WHERE request_id=r.id AND id=p_attempt_id FOR UPDATE;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'error',jsonb_build_object('code','document_attempt_not_found')); END IF;
  IF a.state='committed' THEN RETURN jsonb_build_object('ok',TRUE,'state','committed','result',a.result); END IF;
  IF p_cleanup_complete AND (a.state <> 'aborted' OR EXISTS(
    SELECT 1 FROM storage.objects o JOIN jsonb_array_elements(a.manifest) d
      ON o.bucket_id=d->>'storage_bucket' AND o.name=d->>'storage_key')) THEN
    RAISE EXCEPTION 'document_cleanup_not_confirmed' USING ERRCODE='23514';
  END IF;
  UPDATE public.driver_application_document_attempts SET state='aborted',
    cleanup_state=CASE WHEN p_cleanup_complete OR cleanup_state='complete' THEN 'complete' ELSE 'pending' END,
    updated_at=now() WHERE id=a.id RETURNING * INTO a;
  RETURN jsonb_build_object('ok',TRUE,'state','aborted','cleanup_state',a.cleanup_state,
    'cleanup_manifest',CASE WHEN a.cleanup_state='pending' THEN a.manifest ELSE '[]'::jsonb END);
END; $$;

-- Preserve existing compliance/reverification projection, adding only submission-state/count evidence.
ALTER FUNCTION public.marketplace_application_status_by_token_v1(UUID)
  RENAME TO marketplace_application_status_before_document_return_v1;
CREATE FUNCTION public.marketplace_application_status_by_token_v1(p_status_token UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $$
DECLARE r public.marketplace_participant_requests%ROWTYPE; v_result JSONB; v_submitted JSONB;
BEGIN
  v_result:=public.marketplace_application_status_before_document_return_v1(p_status_token);
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RETURN v_result; END IF;
  SELECT * INTO r FROM public.marketplace_participant_requests WHERE public_status_token=p_status_token;
  SELECT COALESCE(jsonb_agg(DISTINCT COALESCE(d->>'type',d->>'doc_type')),'[]'::jsonb) INTO v_submitted
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.verification_documents)='array' THEN r.verification_documents ELSE '[]'::jsonb END) d
    WHERE COALESCE(d->>'status','') IN ('submitted','verified','approved');
  IF r.status='pending' AND v_result->>'application_state'='pending_review'
    AND EXISTS(SELECT 1 FROM public.driver_application_document_attempts a
      WHERE a.request_id=r.id AND a.state='committed' AND a.reviewed_at=r.reviewed_at AND a.review_revision=r.document_review_revision) THEN
    v_result:=v_result||jsonb_build_object('application_state','documents_resubmitted');
  END IF;
  RETURN v_result||jsonb_build_object('document_review_revision',r.document_review_revision,
    'document_return_attempt',(SELECT jsonb_build_object('retry_key',a.retry_key,'state',a.state)
      FROM public.driver_application_document_attempts a WHERE a.request_id=r.id AND a.state='reserved'),
    'submitted_document_count',jsonb_array_length(v_submitted),
    'missing_document_count',CASE WHEN v_result->>'application_state'='additional_documents_requested'
      THEN jsonb_array_length(public.driver_application_requested_types_v1(r.decision_metadata))
      ELSE (SELECT count(*) FROM jsonb_array_elements_text(
      public.driver_application_requested_types_v1(r.decision_metadata)) t(value) WHERE NOT v_submitted ? value) END);
END; $$;

REVOKE ALL ON FUNCTION public.driver_application_document_attempt_immutable_v1() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.driver_application_requested_types_v1(JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.marketplace_application_status_before_document_return_v1(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.marketplace_application_status_by_token_v1(UUID) TO authenticated,service_role;

CREATE FUNCTION api.driver_application_document_reserve_v1(p_status_token UUID, p_retry_key UUID, p_documents JSONB, p_note TEXT DEFAULT NULL, p_storage_bucket TEXT DEFAULT 'fieldops-evidence') RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, pg_temp AS $$ SELECT public.driver_application_document_reserve_v1(p_status_token,p_retry_key,p_documents,p_note,p_storage_bucket); $$;
REVOKE ALL ON FUNCTION public.driver_application_document_reserve_v1(UUID,UUID,JSONB,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.driver_application_document_reserve_v1(UUID,UUID,JSONB,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_application_document_reserve_v1(UUID,UUID,JSONB,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.driver_application_document_reserve_v1(UUID,UUID,JSONB,TEXT,TEXT) TO service_role;

CREATE FUNCTION api.driver_application_document_apply_v1(p_status_token UUID, p_attempt_id UUID, p_uploaded_manifest JSONB) RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, pg_temp AS $$ SELECT public.driver_application_document_apply_v1(p_status_token,p_attempt_id,p_uploaded_manifest); $$;
REVOKE ALL ON FUNCTION public.driver_application_document_apply_v1(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.driver_application_document_apply_v1(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_application_document_apply_v1(UUID,UUID,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.driver_application_document_apply_v1(UUID,UUID,JSONB) TO service_role;

CREATE FUNCTION api.driver_application_document_abort_v1(p_status_token UUID, p_attempt_id UUID, p_cleanup_complete BOOLEAN DEFAULT FALSE) RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, pg_temp AS $$ SELECT public.driver_application_document_abort_v1(p_status_token,p_attempt_id,p_cleanup_complete); $$;
REVOKE ALL ON FUNCTION public.driver_application_document_abort_v1(UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.driver_application_document_abort_v1(UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_application_document_abort_v1(UUID,UUID,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION api.driver_application_document_abort_v1(UUID,UUID,BOOLEAN) TO service_role;

CREATE FUNCTION api.driver_application_document_readback_v1(p_status_token UUID, p_retry_key UUID) RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, api, pg_temp AS $$ SELECT public.driver_application_document_readback_v1(p_status_token,p_retry_key); $$;
REVOKE ALL ON FUNCTION public.driver_application_document_readback_v1(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.driver_application_document_readback_v1(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_application_document_readback_v1(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.driver_application_document_readback_v1(UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION api.marketplace_application_status_by_token_v1(p_status_token UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path TO public,api,pg_temp
AS $$ SELECT public.marketplace_application_status_by_token_v1(p_status_token); $$;
REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.marketplace_application_status_by_token_v1(UUID) TO authenticated,service_role;
COMMIT;
