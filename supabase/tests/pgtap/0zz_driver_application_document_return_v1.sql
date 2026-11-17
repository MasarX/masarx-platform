BEGIN;
SELECT plan(40);
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='api' AND p.proname='marketplace_application_status_by_token_v1'),1,
  'one exposed status overload avoids PostgREST ambiguity');
SELECT ok(to_regprocedure('api.marketplace_application_status_by_token_v1(uuid)') IS NULL,
  'redundant API UUID overload removed without removing public compatibility');
SELECT ok(to_regprocedure('api.marketplace_application_status_by_token_v1(text)') IS NOT NULL,
  'established validating TEXT facade retained');
SELECT ok(has_function_privilege('service_role','api.marketplace_application_status_by_token_v1(text)','EXECUTE'),'Edge service can read status');
SELECT ok(NOT has_function_privilege('anon','api.marketplace_application_status_by_token_v1(text)','EXECUTE'),'anonymous direct status denied');
SELECT ok(NOT has_function_privilege('authenticated','api.marketplace_application_status_by_token_v1(text)','EXECUTE'),'browser direct status denied');
SELECT ok(to_regprocedure('public.marketplace_application_status_by_token_v1(uuid)') IS NOT NULL
  AND to_regprocedure('public.marketplace_application_status_by_token_v1(text)') IS NOT NULL,'both public SQL signatures retained');
SELECT is(api.marketplace_application_status_by_token_v1('not-a-uuid'::text)#>>'{error,code}',
  'request_not_found','TEXT facade retains invalid-token validation');
SELECT ok(NOT has_table_privilege('authenticated','public.driver_application_document_attempts','INSERT'), 'applicant cannot insert attempt authority');
SELECT ok(NOT has_table_privilege('authenticated','public.driver_application_document_attempts','UPDATE'), 'reviewer cannot rewrite attempt manifest');
SELECT ok(NOT has_function_privilege('anon','api.driver_application_document_apply_v1(uuid,uuid,jsonb)','EXECUTE'), 'anonymous direct apply denied');
SELECT ok(NOT has_function_privilege('authenticated','api.driver_application_document_reserve_v1(uuid,uuid,jsonb,text,text)','EXECUTE'), 'authenticated direct reserve denied');

CREATE FUNCTION pg_temp.document_return_test() RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  r UUID; token UUID; retry UUID:=gen_random_uuid(); a JSONB; b JSONB; result JSONB; doc JSONB;
  manifest JSONB; generation BIGINT; bucket TEXT:='fieldops-evidence';
BEGIN
  INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    VALUES(bucket,bucket,FALSE,10485760,ARRAY['image/png']) ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.marketplace_participant_requests(requested_participant_type_key,email,full_name,organization_name,
    status,reviewed_at,decision_metadata,verification_documents)
    VALUES('freelancer_driver','r14-'||gen_random_uuid()||'@example.test','R14 owned','R14 owned','pending',now(),
      '{"request_additional_docs":true,"requested_documents":["license","license"]}',
      '[{"type":"license","status":"verified","ref":"old"},{"type":"unrelated","status":"submitted","ref":"keep"}]')
    RETURNING id,public_status_token INTO r,token;
  doc:=jsonb_build_array(jsonb_build_object('type','license','sha256',repeat('a',64),'size_bytes',1,'content_type','image/png','file_name','one.png'));
  result:=public.marketplace_application_status_by_token_v1(token);
  RETURN NEXT is((result->>'missing_document_count')::INT,1,'old same-type evidence does not satisfy new replacement request');
  result:=api.driver_application_document_reserve_v1(gen_random_uuid(),retry,doc);
  RETURN NEXT is(result#>>'{error,code}','request_not_found','unknown token cannot reserve');
  result:=api.driver_application_document_reserve_v1(token,gen_random_uuid(),jsonb_set(doc,'{0,type}','"other"'));
  RETURN NEXT is(result#>>'{error,code}','requested_documents_missing','wrong type cannot cover requested set');
  result:=api.driver_application_document_reserve_v1(token,retry,doc);
  a:=result; manifest:=a->'manifest';
  RETURN NEXT is(a->>'new_attempt','true','first request owns upload dispatch');
  RETURN NEXT is((SELECT state FROM public.driver_application_document_attempts WHERE id=(a->>'attempt_id')::UUID),
    'reserved','reservation retains its state default');
  RETURN NEXT is((SELECT cleanup_state FROM public.driver_application_document_attempts WHERE id=(a->>'attempt_id')::UUID),
    'not_required','reservation retains its cleanup default');
  BEGIN
    UPDATE public.driver_application_document_attempts SET state='invalid' WHERE id=(a->>'attempt_id')::UUID;
    RETURN NEXT fail('lookup contract rejects unknown attempt state');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT ok(SQLERRM LIKE 'Invalid lookup value for public.driver_application_document_attempts.state:%',
      'lookup contract rejects unknown attempt state');
  END;
  BEGIN
    UPDATE public.driver_application_document_attempts SET cleanup_state='invalid' WHERE id=(a->>'attempt_id')::UUID;
    RETURN NEXT fail('lookup contract rejects unknown cleanup state');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT ok(SQLERRM LIKE 'Invalid lookup value for public.driver_application_document_attempts.cleanup_state:%',
      'lookup contract rejects unknown cleanup state');
  END;
  RETURN NEXT ok((manifest::TEXT NOT LIKE '%'||token||'%'),'storage keys do not contain bearer token');
  result:=api.driver_application_document_reserve_v1(token,retry,doc);
  RETURN NEXT is(result->>'new_attempt','false','same retry gets no second upload authority');
  RETURN NEXT ok(NOT result ? 'manifest','replay does not expose upload manifest');
  result:=api.driver_application_document_reserve_v1(token,gen_random_uuid(),doc);
  RETURN NEXT is(result#>>'{error,code}','document_attempt_in_progress','competing attempt rejected');
  generation:=(SELECT document_review_revision FROM public.marketplace_participant_requests WHERE id=r);
  result:=public.marketplace_participant_request_review_apply_v1(r,'request_additional_docs',p_decision_metadata:='{"requested_documents":["license"]}');
  RETURN NEXT ok((SELECT document_review_revision>generation FROM public.marketplace_participant_requests WHERE id=r),'same-transaction same-type re-review increments authority');
  result:=api.driver_application_document_apply_v1(token,(a->>'attempt_id')::UUID,manifest);
  RETURN NEXT is(result#>>'{error,code}','document_review_changed','old reservation rejected after re-review');
  result:=api.driver_application_document_abort_v1(token,(a->>'attempt_id')::UUID);
  RETURN NEXT is(result->>'cleanup_state','pending','abort fence is not cleanup completion');
  result:=api.driver_application_document_apply_v1(token,(a->>'attempt_id')::UUID,manifest);
  RETURN NEXT is(result#>>'{error,code}','document_attempt_aborted','abort permanently fences apply');
  result:=api.driver_application_document_abort_v1(token,(a->>'attempt_id')::UUID,TRUE);
  RETURN NEXT is(result->>'cleanup_state','complete','empty manifest object scope can acknowledge cleanup');
  retry:=gen_random_uuid();
  a:=api.driver_application_document_reserve_v1(token,retry,doc); manifest:=a->'manifest';
  INSERT INTO storage.objects(bucket_id,name,metadata) SELECT bucket,d->>'storage_key','{"size":1,"mimetype":"image/png"}'
    FROM jsonb_array_elements(manifest) d;
  result:=api.driver_application_document_apply_v1(token,(a->>'attempt_id')::UUID,manifest);
  RETURN NEXT is(result->>'application_state','documents_resubmitted','same request returns to review');
  RETURN NEXT is((SELECT status FROM public.marketplace_participant_requests WHERE id=r),'pending','resubmission does not approve applicant');
  RETURN NEXT is((SELECT d->>'status' FROM public.marketplace_participant_requests q,
    LATERAL jsonb_array_elements(q.verification_documents)d WHERE q.id=r AND d->>'type'='license'),'submitted','applicant cannot inherit verified status');
  RETURN NEXT ok((SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(q.verification_documents)d WHERE d->>'ref'='keep')
    FROM public.marketplace_participant_requests q WHERE q.id=r),'unrelated documents preserved');
  b:=api.driver_application_document_apply_v1(token,(a->>'attempt_id')::UUID,manifest);
  RETURN NEXT is(b,result,'apply replay returns identical persisted receipt');
  b:=api.driver_application_document_abort_v1(token,(a->>'attempt_id')::UUID);
  RETURN NEXT ok(b->>'state'='committed' AND NOT b ? 'cleanup_manifest','committed attempt never authorizes cleanup');
  b:=api.driver_application_document_reserve_v1(token,retry,doc);
  RETURN NEXT is(b->>'state','committed','committed reserve replay wins over no-longer-outstanding guard');
  b:=api.driver_application_document_readback_v1(token,retry);
  RETURN NEXT is(b->'result',result,'readback reconciles lost apply response');

  BEGIN
    PERFORM api.driver_application_document_reserve_v1(token,retry,jsonb_set(doc,'{0,sha256}',to_jsonb(repeat('b',64))));
    RETURN NEXT fail('committed retry rejects changed payload');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT is(SQLERRM,'document_attempt_payload_changed','committed retry rejects changed payload');
  END;
  BEGIN
    UPDATE public.driver_application_document_attempts SET manifest='[]' WHERE id=(a->>'attempt_id')::UUID;
    RETURN NEXT fail('private manifest is immutable even to ordinary service mutation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('private manifest is immutable even to ordinary service mutation');
  END;
  BEGIN
    PERFORM api.driver_application_document_reserve_v1(token,gen_random_uuid(),jsonb_set(doc,'{0,status}','"verified"'));
    RETURN NEXT fail('SQL rejects caller verified-status spoof');
  EXCEPTION WHEN invalid_parameter_value THEN
    RETURN NEXT pass('SQL rejects caller verified-status spoof');
  END;
END; $$;
SELECT * FROM pg_temp.document_return_test();
SELECT * FROM finish();
ROLLBACK;
