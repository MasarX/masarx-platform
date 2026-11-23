-- F267 rows30/44/70: native worker/inline audit contract, not network proof.
-- Run only through the governed disposable backend pgTAP lifecycle.
-- All fixtures and function replacements roll back. Claim isolation intentionally
-- excludes every other job; real claim concurrency remains separate qualification.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT no_plan();
SELECT public.create_next_partitions();
SELECT set_config('app.force_worker', 'outbound_worker', true);

CREATE TEMP TABLE f267_calls (kind TEXT NOT NULL, request_id BIGINT);
CREATE TEMP TABLE f267_ids AS SELECT gen_random_uuid() AS org, gen_random_uuid() AS provider;
INSERT INTO public.organizations(id,name,slug)
SELECT org, 'F267 owned audit fixture', 'f267-' || org FROM f267_ids;
INSERT INTO public.providers(id,organization_id,name,provider_type)
SELECT provider,org,'F267 owned audit provider','http' FROM f267_ids;

CREATE OR REPLACE FUNCTION public.call_api(
 p_url TEXT,p_method TEXT DEFAULT 'POST',p_headers JSONB DEFAULT '{}',
 p_body JSONB DEFAULT '{}',p_timeout_seconds INT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $$
BEGIN
 INSERT INTO pg_temp.f267_calls(kind) VALUES ('dispatch');
 RETURN current_setting('f267.response')::jsonb;
END;
$$;
CREATE OR REPLACE FUNCTION public.check_async_response(p_request_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $$
BEGIN
 INSERT INTO pg_temp.f267_calls(kind,request_id) VALUES ('poll',p_request_id);
 RETURN current_setting('f267.response')::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_jobs(p_batch_size INT)
RETURNS TABLE(job_id UUID,call_type TEXT,target_type TEXT,target_id UUID,method TEXT,url TEXT,
 headers JSONB,body JSONB,priority INT,retry_count INT,max_retries INT,correlation_id UUID,
 shipment_id UUID,context JSONB)
LANGUAGE sql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $$
 UPDATE public.outbound_calls oc SET lease_expires_at=now()+interval '30 seconds'
 WHERE oc.id=NULLIF(current_setting('f267.job',true),'')::uuid
 AND oc.status='pending' AND oc.scheduled_at<=now()
 AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at<now())
 RETURNING oc.id,oc.call_type,oc.target_type,oc.target_id,oc.method,oc.url,oc.headers,
 oc.body,oc.priority,oc.retry_count,oc.max_retries,oc.correlation_id,oc.shipment_id,oc.context;
$$;

CREATE FUNCTION pg_temp.f267_case(p_lane TEXT,p_status INT,p_completed BOOLEAN,p_poll BOOLEAN)
RETURNS SETOF TEXT LANGUAGE plpgsql
SET search_path TO public,extensions,pgtap,pg_temp AS $$
DECLARE
 v_job UUID:=gen_random_uuid(); v_correlation UUID:=gen_random_uuid();
 v_org UUID; v_provider UUID; v_result JSONB; v_count INT; v_label TEXT;
 v_before INT; v_after INT;
 v_polls INT; v_sends INT; v_claims INT;
 v_claim RECORD; v_spec JSONB; v_response JSONB; v_url TEXT;
BEGIN
 SELECT org,provider INTO v_org,v_provider FROM pg_temp.f267_ids;
 v_label:=p_lane || '/' || CASE WHEN p_poll THEN 'poll' ELSE 'direct' END || '/' || p_status;
 INSERT INTO public.outbound_calls(id,call_type,target_type,target_id,method,url,headers,body,
 status,priority,retry_count,max_retries,scheduled_at,created_at,correlation_id,context)
 VALUES(v_job,'provider_api','provider',v_provider,'POST',
 'https://example.test/f267/'||v_job,
 '{"authorization":"fixture-private","content-type":"application/json"}',
 jsonb_build_object('marker',v_job), 'pending',100,0,1,now()-interval '1 minute',now(),
 v_correlation,CASE WHEN p_poll THEN '{"async_request_id":267}'::jsonb ELSE '{}'::jsonb END);
 PERFORM set_config('f267.job',v_job::text,true);
 PERFORM set_config('f267.response',jsonb_build_object('status',p_status,'completed',p_completed,
 'request_id',267,'headers',jsonb_build_object('authorization','fixture-response-private'),
 'body',jsonb_build_object('ok',p_status BETWEEN 200 AND 299,'password','fixture-body-private'),
 'latency_ms',15)::text,true);
 SELECT count(*) INTO v_before FROM pg_temp.f267_calls WHERE kind='dispatch';
 SELECT count(*) INTO v_polls FROM pg_temp.f267_calls WHERE kind='poll' AND request_id=267;
 SELECT count(*) INTO v_sends FROM pg_temp.f267_calls WHERE kind='edge-send';
 SELECT url INTO STRICT v_url FROM public.outbound_calls WHERE id=v_job;
 v_response:=current_setting('f267.response')::jsonb;
 IF NOT p_poll THEN
  -- Seeded requests keep their historical authorization header. A fresh SQL handoff cannot carry one.
  UPDATE public.outbound_calls SET headers=headers-'authorization' WHERE id=v_job;
  PERFORM set_config('f267.response',jsonb_build_object('status',202,'completed',false,
   'edge_dispatch',(SELECT jsonb_build_object('url',url,'method',method,'headers',headers,'body',body)
    FROM public.outbound_calls WHERE id=v_job))::text,true);
 END IF;
 IF p_lane='worker' THEN
   v_result:=public.run_outbound_worker()::jsonb;
 ELSE
   v_result:=public.dispatch_outbound_call_inline(v_job,
    '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60,"performed_by_system":"f267-native"}');
 END IF;
 -- Product dispatch delegates set a session search_path; restore only the TAP caller context.
 PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
 SELECT count(*) INTO v_after FROM pg_temp.f267_calls WHERE kind='dispatch';
 RETURN NEXT ok(v_result->>'status'=CASE WHEN p_lane='worker' THEN 'completed'
  WHEN NOT p_poll OR NOT p_completed THEN 'pending'
  WHEN p_status BETWEEN 200 AND 299 THEN 'completed' ELSE 'failed' END,v_label||' returns canonical outcome');
 IF NOT p_poll THEN
  RETURN NEXT ok(EXISTS(SELECT FROM public.outbound_calls WHERE id=v_job AND status='pending_edge'
    AND lease_expires_at IS NULL AND context ? 'edge_dispatch' AND NOT (context ? 'async_request_id')),
    v_label||' hands off the exact job');
  RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='edge-send'),v_sends,
    v_label||' enqueue does not send');
  RETURN NEXT is((SELECT count(*)::int FROM public.api_call_log WHERE correlation_id=v_correlation),0,
    v_label||' enqueue does not create a terminal audit');
  -- Keep the transaction's real bounded claimant deterministic across earlier cases and seed data.
  UPDATE public.outbound_calls SET scheduled_at=now()+interval '100 years'
   WHERE id<>v_job AND status IN ('pending_edge','failed') AND scheduled_at<=now();
  SELECT * INTO STRICT v_claim FROM public.claim_pending_edge_job_ids_v1(1);
  RETURN NEXT ok(v_claim.job_id=v_job AND v_claim.lease_token IS NOT NULL,v_label||' claims just the handoff');
  v_spec:=public.get_claimed_edge_job_call_spec_v1(v_job,v_claim.lease_token);
  RETURN NEXT ok(v_spec @> jsonb_build_object('method','POST','body',jsonb_build_object('marker',v_job)),
    v_label||' resolves the attempted request through its lease');
  IF p_completed THEN
   INSERT INTO pg_temp.f267_calls(kind) VALUES ('edge-send');
   IF p_status BETWEEN 200 AND 299 THEN
    PERFORM public.mark_claimed_edge_job_success_v1(v_job,v_claim.lease_token,p_status,
      v_response->'headers',v_response->'body',15);
   ELSE
    PERFORM public.mark_claimed_edge_job_failure_v1(v_job,v_claim.lease_token,p_status,
      v_response->'headers',v_response->'body','controlled failure',15);
   END IF;
   PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
   RETURN NEXT ok(EXISTS(SELECT FROM public.outbound_calls WHERE id=v_job
    AND status IN ('completed','failed','permanently_failed','pending_edge')
    AND lease_expires_at IS NULL AND edge_lease_token IS NULL),v_label||' finalization releases the lease');
  END IF;
  RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='edge-send'),
    v_sends+CASE WHEN p_completed THEN 1 ELSE 0 END,v_label||' counts controlled sends');
 END IF;
 RETURN NEXT is((SELECT count(*)::int FROM net.http_request_queue WHERE url=v_url),0,
   v_label||' produces no new pg_net request');
 SELECT count(*) INTO v_count FROM public.api_call_log WHERE correlation_id=v_correlation;
 RETURN NEXT is(v_count,CASE WHEN p_completed THEN 1 ELSE 0 END,v_label||' terminal-only audit count');
 IF p_poll THEN
  RETURN NEXT ok(v_after=v_before
    AND (SELECT count(*) FROM pg_temp.f267_calls WHERE kind='poll' AND request_id=267)>v_polls
    AND EXISTS(SELECT FROM public.outbound_calls WHERE id=v_job AND status<>'pending_edge'
      AND NOT (context ? 'edge_dispatch')),v_label||' polls the seeded request without a new send or Edge enqueue');
 END IF;
 IF p_completed THEN
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.api_call_log WHERE correlation_id=v_correlation
    AND organization_id=v_org AND provider_id=v_provider AND response_status=p_status
    AND request_body->>'marker'=v_job::text AND method='POST'
    AND url='https://example.test/f267/'||v_job
    AND request_headers->>'content-type'='application/json'),v_label||' persisted attempted request/tenant/provider/correlation');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.api_call_log WHERE correlation_id=v_correlation
    AND (request_headers::text LIKE '%fixture-private%'
      OR response_headers::text LIKE '%fixture-response-private%'
      OR response_body::text LIKE '%fixture-body-private%')),v_label||' secrets absent');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.api_call_log WHERE correlation_id=v_correlation
    AND NOT (request_headers ? 'authorization')),v_label||' authorization omitted');
 END IF;
 IF p_completed AND p_status BETWEEN 200 AND 299 THEN
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.outbound_calls WHERE id=v_job AND status='completed'
   AND retry_count=0 AND lease_expires_at IS NULL),v_label||' delivery/retry state unchanged');
  IF p_lane='worker' THEN PERFORM public.run_outbound_worker();
  ELSE PERFORM public.dispatch_outbound_call_inline(v_job,
    '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60}'); END IF;
  PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
  IF NOT p_poll THEN
   SELECT count(*) INTO v_claims FROM public.claim_pending_edge_job_ids_v1(1);
   RETURN NEXT is(v_claims,0,v_label||' cannot claim a completed job again');
   RETURN NEXT throws_ok(format('SELECT public.mark_claimed_edge_job_success_v1(%L,%L,200,%L,%L,15)',
    v_job,v_claim.lease_token,'{}','{}'),'P0001',
    format('mark_claimed_edge_job_success_v1: active lease for job %s not found',v_job),v_label||' stale finalization is refused');
   RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='edge-send'),v_sends+1,
    v_label||' a second attempt cannot send again');
  END IF;
  RETURN NEXT is((SELECT count(*)::int FROM public.api_call_log WHERE correlation_id=v_correlation),1,
   v_label||' repeated terminal invocation cannot duplicate audit');
  RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='dispatch'),v_after,
   v_label||' repeated terminal invocation cannot resend');
 END IF;
 IF p_lane='inline' AND p_poll AND NOT p_completed THEN
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.outbound_calls WHERE id=v_job
    AND status='pending' AND lease_expires_at IS NULL AND context->>'async_request_id'='267'),
    v_label||' pending retains request identity and releases lease');
  -- Advance only this fixture's due time; transport completion remains supplied by the existing poll seam.
  UPDATE public.outbound_calls SET scheduled_at=now()-interval '1 second' WHERE id=v_job;
  SELECT count(*) INTO v_polls FROM pg_temp.f267_calls WHERE kind='poll' AND request_id=267;
  PERFORM set_config('f267.response','{"status":200,"completed":true,"headers":{},"body":{}}',true);
  v_result:=public.dispatch_outbound_call_inline(v_job,
    '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60}');
  PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
  RETURN NEXT is(v_result->>'status','completed',v_label||' later same request completes');
  RETURN NEXT ok((SELECT count(*) FROM pg_temp.f267_calls WHERE kind='poll' AND request_id=267)>v_polls
    AND NOT EXISTS(SELECT 1 FROM pg_temp.f267_calls WHERE kind='poll' AND request_id IS DISTINCT FROM 267::bigint),
    v_label||' later completion polls the exact seeded request');
  RETURN NEXT ok((SELECT count(*) FROM pg_temp.f267_calls WHERE kind='dispatch')=v_before
    AND NOT EXISTS(SELECT FROM net.http_request_queue WHERE url=v_url)
    AND EXISTS(SELECT FROM public.outbound_calls WHERE id=v_job AND status='completed' AND NOT (context ? 'edge_dispatch')),
    v_label||' later completion creates no transport row or Edge enqueue');
  RETURN NEXT is((SELECT count(*)::int FROM public.api_call_log WHERE correlation_id=v_correlation),1,
    v_label||' only later terminal completion is audited');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.outbound_calls WHERE id=v_job AND status='completed'
    AND retry_count=0 AND lease_expires_at IS NULL),v_label||' later completion preserves delivery state');
 END IF;
END;
$$;

SELECT * FROM pg_temp.f267_case('worker',200,true,false);
SELECT * FROM pg_temp.f267_case('worker',200,true,true);
SELECT * FROM pg_temp.f267_case('worker',500,true,false);
SELECT * FROM pg_temp.f267_case('worker',500,true,true);
SELECT * FROM pg_temp.f267_case('worker',202,false,false);
SELECT * FROM pg_temp.f267_case('worker',202,false,true);
SELECT * FROM pg_temp.f267_case('inline',200,true,false);
SELECT * FROM pg_temp.f267_case('inline',200,true,true);
SELECT * FROM pg_temp.f267_case('inline',500,true,false);
SELECT * FROM pg_temp.f267_case('inline',202,false,false);
SELECT * FROM pg_temp.f267_case('inline',202,false,true);

-- Ordering proof only: emulate the existing failure helper's provider/request
-- retargeting. Earlier cases retain the actual failure policy implementation.
ALTER TABLE pg_temp.f267_ids ADD COLUMN successor UUID DEFAULT gen_random_uuid();
INSERT INTO public.providers(id,organization_id,name,provider_type)
SELECT successor,org,'F267 owned successor provider','http' FROM pg_temp.f267_ids;
CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure_v2(
 p_job_id UUID,p_status_code INT,p_headers JSONB,p_body JSONB,p_error TEXT,
 p_performed_by_system TEXT,p_correlation_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $$
BEGIN
 UPDATE public.outbound_calls SET target_id=(SELECT successor FROM pg_temp.f267_ids),
 method='PUT',url='https://example.test/f267-successor',
 headers='{"content-type":"text/plain"}',body='{"marker":"successor"}',
 status='permanently_failed',retry_count=retry_count+1,lease_expires_at=NULL
 WHERE id=p_job_id AND id=current_setting('f267.job')::uuid;
END;
$$;
CREATE FUNCTION pg_temp.f267_retarget_case(p_lane TEXT,p_poll BOOLEAN)
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
BEGIN
 RETURN QUERY SELECT * FROM pg_temp.f267_case(p_lane,500,true,p_poll);
 PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
 RETURN NEXT ok(EXISTS(SELECT 1 FROM public.outbound_calls oc,pg_temp.f267_ids ids
 WHERE oc.id=current_setting('f267.job')::uuid AND oc.target_id=ids.successor
 AND oc.method='PUT' AND oc.url='https://example.test/f267-successor'
 AND oc.body->>'marker'='successor' AND oc.headers->>'content-type'='text/plain'
 AND (SELECT count(*) FROM public.api_call_log l WHERE l.correlation_id=oc.correlation_id
   AND l.provider_id=ids.provider AND l.method='POST' AND l.request_body->>'marker'=oc.id::text)=1
 AND NOT EXISTS(SELECT FROM public.api_call_log l WHERE l.correlation_id=oc.correlation_id AND l.provider_id=ids.successor)),
 p_lane||CASE WHEN p_poll THEN '/poll' ELSE '/direct' END||' failure actually retargeted provider and request after attempted audit');
END;
$$;
SELECT * FROM pg_temp.f267_retarget_case('worker',false);
SELECT * FROM pg_temp.f267_retarget_case('worker',true);
SELECT * FROM pg_temp.f267_retarget_case('inline',false);

-- Isolated audit-sink failure: genuine worker/inline must retain delivery state.
SAVEPOINT f267_sink;
CREATE OR REPLACE FUNCTION public.log_api_call_event(p_job_id UUID,p_request JSONB,p_response JSONB,
 p_status INT,p_latency_ms INT,p_error TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fixture-sink-private'; END;
$$;
CREATE FUNCTION pg_temp.f267_sink_case(p_lane TEXT) RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE v_job UUID:=gen_random_uuid();v_result JSONB;v_dispatch INT;
 v_claim RECORD;v_sends INT;v_correlation UUID:=gen_random_uuid();v_url TEXT;
BEGIN
 INSERT INTO public.outbound_calls(id,call_type,target_type,target_id,method,url,headers,body,
 status,priority,retry_count,max_retries,scheduled_at,created_at)
 SELECT v_job,'provider_api','provider',provider,'POST','https://example.test/f267-sink',
 '{}','{}','pending',100,0,1,now()-interval '1 minute',now() FROM pg_temp.f267_ids;
 PERFORM set_config('f267.job',v_job::text,true);
 UPDATE public.outbound_calls SET correlation_id=v_correlation WHERE id=v_job RETURNING url INTO v_url;
 PERFORM set_config('f267.response',jsonb_build_object('status',202,'completed',false,
  'edge_dispatch',(SELECT jsonb_build_object('url',url,'method',method,'headers',headers,'body',body)
    FROM public.outbound_calls WHERE id=v_job))::text,true);
 SELECT count(*) INTO v_sends FROM pg_temp.f267_calls WHERE kind='edge-send';
 IF p_lane='worker' THEN v_result:=public.run_outbound_worker()::jsonb;
 ELSE v_result:=public.dispatch_outbound_call_inline(v_job,
 '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60}'); END IF;
 PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
 RETURN NEXT ok(v_result->>'status'=CASE WHEN p_lane='worker' THEN 'completed' ELSE 'pending' END
  AND EXISTS(SELECT FROM public.outbound_calls WHERE id=v_job AND status='pending_edge'),
  p_lane||' audit failure fixture reaches Edge');
 RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='edge-send'),v_sends,
  p_lane||' enqueue created no sends');
 RETURN NEXT is((SELECT count(*)::int FROM public.api_call_log WHERE correlation_id=v_correlation),0,
  p_lane||' enqueue created no audit');
 UPDATE public.outbound_calls SET scheduled_at=now()+interval '100 years'
 WHERE id<>v_job AND status IN ('pending_edge','failed') AND scheduled_at<=now();
 SELECT * INTO STRICT v_claim FROM public.claim_pending_edge_job_ids_v1(1);
 RETURN NEXT ok(v_claim.job_id=v_job AND v_claim.lease_token IS NOT NULL
  AND public.get_claimed_edge_job_call_spec_v1(v_job,v_claim.lease_token)->>'method'='POST',
  p_lane||' obtains the failing-audit job spec under its lease');
 INSERT INTO pg_temp.f267_calls(kind) VALUES ('edge-send');
 PERFORM public.mark_claimed_edge_job_success_v1(v_job,v_claim.lease_token,200,'{}','{}',1);
 PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
 RETURN NEXT ok(EXISTS(SELECT 1 FROM public.outbound_calls WHERE id=v_job AND status='completed'
 AND retry_count=0 AND lease_expires_at IS NULL),p_lane||' audit failure cannot requeue');
 SELECT count(*) INTO v_dispatch FROM pg_temp.f267_calls WHERE kind='dispatch';
 IF p_lane='worker' THEN PERFORM public.run_outbound_worker();
 ELSE PERFORM public.dispatch_outbound_call_inline(v_job,
 '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60}'); END IF;
 PERFORM set_config('search_path','public,extensions,pgtap,pg_temp',true);
 RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='dispatch'),v_dispatch,
 p_lane||' failed audit does not authorize resend');
 RETURN NEXT is((SELECT count(*)::int FROM public.claim_pending_edge_job_ids_v1(1)),0,
  p_lane||' audit failure cannot authorize a new claim');
 RETURN NEXT is((SELECT count(*)::int FROM pg_temp.f267_calls WHERE kind='edge-send'),v_sends+1,
  p_lane||' audit failure leaves exactly one send');
 RETURN NEXT is((SELECT count(*)::int FROM public.api_call_log WHERE correlation_id=v_correlation),0,
  p_lane||' the failed audit sink leaves no row');
 RETURN NEXT ok(NOT EXISTS(SELECT FROM net.http_request_queue WHERE url=v_url),
  p_lane||' the failed audit sink creates no transport row');
END;
$$;
SELECT * FROM pg_temp.f267_sink_case('worker');
SELECT * FROM pg_temp.f267_sink_case('inline');
-- Do not roll back TAP state before finish; the enclosing transaction restores all functions.
SELECT * FROM finish();
ROLLBACK;
