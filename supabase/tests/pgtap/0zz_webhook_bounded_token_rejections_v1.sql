-- Disposable backend only; fixtures/settings/fault injection are rolled back.
-- Two-session nonwaiting contention and cross-transaction window expiry remain
-- admitted integration checks; this file does not pretend a reentrant lock proves them.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT no_plan();
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
SELECT public.upsert_settings_value_v1('webhook_auth_rejection_logging_policy',
  public.get_root_scope_type_key_v1(), NULL,
  '{"enabled":true,"max_records":1000,"window_seconds":3600,"max_token_bytes":4096}', 1, 'Disposable R08 fixture');
SELECT ok((SELECT COUNT(*) FROM public.intake_auth_rejections
  WHERE service='webhook_receiver' AND occurred_at >= clock_timestamp()-INTERVAL '1 hour') < 997,
  'disposable logging budget has room for three owned source cases');

CREATE TEMP TABLE rejection_sources AS
SELECT key, gen_random_uuid() AS org_id, gen_random_uuid() AS source_id,
  gen_random_uuid() AS mapping_id, gen_random_uuid()::TEXT AS token
FROM (VALUES ('disabled'), ('rotated')) AS names(key);
INSERT INTO public.organizations(id,name,slug)
SELECT org_id,'R08 rejection fixture','r08-rejection-'||org_id FROM rejection_sources;
INSERT INTO public.mapping_configs(id,mapping_type,mapping_key,mapping_config,mapping_version,organization_id)
SELECT mapping_id,'webhook_inbound','r08-rejection-'||mapping_id,'{}',1,org_id FROM rejection_sources;
INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,enabled)
SELECT source_id,org_id,'r08-rejection-'||source_id,'R08 rejection fixture','provider',token,mapping_id,key<>'disabled'
FROM rejection_sources;
UPDATE public.webhook_sources SET auth_token=gen_random_uuid()::TEXT
WHERE id=(SELECT source_id FROM rejection_sources WHERE key='rotated');

CREATE TEMP TABLE rejection_tokens AS SELECT gen_random_uuid()::TEXT AS unknown_token, gen_random_uuid()::TEXT AS sink_token;
CREATE TEMP TABLE rejection_results(label TEXT PRIMARY KEY,response JSONB NOT NULL);
GRANT SELECT ON rejection_sources,rejection_tokens TO edge_webhook_role;
GRANT INSERT ON rejection_results TO edge_webhook_role;
SELECT ok(NOT has_function_privilege(role_name,
  'public.record_webhook_token_rejection_bounded_v1(text,uuid,uuid)','EXECUTE'),
  role_name||' cannot invoke the private budget helper')
FROM unnest(ARRAY['anon','authenticated','service_role','edge_webhook_role','edge_api_gateway_role']) AS roles(role_name);

SET LOCAL ROLE edge_webhook_role;
SELECT set_config('request.jwt.claims','{"role":"edge_webhook_role"}',TRUE);
INSERT INTO rejection_results
SELECT key,api.workflow_intake_webhook(token,'{"organization_id":"caller-claim","authorization":"Bearer caller-secret","x-api-key":"caller-secret"}','{}','{}')
FROM rejection_sources;
INSERT INTO rejection_results SELECT 'unknown',api.workflow_intake_webhook(unknown_token,
  '{"organization_id":"caller-claim","authorization":"Bearer caller-secret"}','{}','{}') FROM rejection_tokens;
INSERT INTO rejection_results VALUES ('missing',api.workflow_intake_webhook(NULL,'{}','{}','{}'));
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
SELECT is(response->>'status','401',label||' preserves authentication rejection') FROM rejection_results;
SELECT is(response#>>'{auth_rejection_logging,status}','recorded',label||' records admitted rejection')
FROM rejection_results WHERE label<>'missing';
SELECT ok(NOT response ? 'auth_rejection_logging','missing token has no DB logging attempt')
FROM rejection_results WHERE label='missing';
SELECT is((SELECT COUNT(*) FROM public.intake_auth_rejections r JOIN rejection_results t
  ON r.correlation_id=(t.response->>'correlation_id')::UUID),3::BIGINT,'one canonical rejection per admitted call');
SELECT ok(r.organization_id IS NULL AND r.source_id IS NULL AND r.client_id IS NULL AND r.sender_id IS NULL,
  'unknown stays unscoped despite caller organization claims')
FROM public.intake_auth_rejections r JOIN rejection_results t ON r.correlation_id=(t.response->>'correlation_id')::UUID
WHERE t.label='unknown';
SELECT ok(r.organization_id=s.org_id AND r.source_id=s.source_id,'disabled source derives organization from DB')
FROM public.intake_auth_rejections r JOIN rejection_results t ON r.correlation_id=(t.response->>'correlation_id')::UUID
JOIN rejection_sources s ON s.key=t.label WHERE t.label='disabled';
SELECT ok(r.organization_id=s.org_id AND r.source_id=s.source_id,'rotated token derives original source from retained token history')
FROM public.intake_auth_rejections r JOIN rejection_results t ON r.correlation_id=(t.response->>'correlation_id')::UUID
JOIN rejection_sources s ON s.key=t.label WHERE t.label='rotated';
SELECT ok(r.request_headers='{}'::JSONB AND r.path IS NULL AND r.query_string IS NULL
  AND r.token_fingerprint IS NOT NULL AND r.request_id=r.correlation_id::TEXT
  AND to_jsonb(r)::TEXT NOT LIKE '%caller-secret%' AND to_jsonb(r)::TEXT NOT LIKE '%caller-claim%',
  t.label||' stores redacted fixed context and canonical identity')
FROM public.intake_auth_rejections r JOIN rejection_results t ON r.correlation_id=(t.response->>'correlation_id')::UUID;
SELECT is((SELECT r.token_fingerprint FROM public.intake_auth_rejections r JOIN rejection_results t
  ON r.correlation_id=(t.response->>'correlation_id')::UUID WHERE t.label='unknown'),
  (SELECT encode(digest(unknown_token,'sha256'),'hex') FROM rejection_tokens),'raw unknown token persists only as a fingerprint');
SELECT ok(NOT response ? 'webhook_id' AND NOT response ? 'workflow_run_id'
  AND NOT (response->'auth_rejection_logging') ?| ARRAY['source_id','organization_id','id'],
  label||' exposes no private logging lineage or operational IDs') FROM rejection_results WHERE label<>'missing';
SELECT is((SELECT COUNT(*) FROM public.webhook_inbox WHERE webhook_source_id IN (SELECT source_id FROM rejection_sources)),
  0::BIGINT,'source denials never fabricate operational inbox records');

-- Existing rotated-token API rejection assertion above remains unchanged.
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source_id FROM rejection_sources WHERE key='rotated')),
  1::BIGINT,'plaintext rotation captures exactly one history row');
UPDATE public.webhook_sources SET auth_token_hash=auth_token_hash,enabled=enabled,managed_metadata=managed_metadata
WHERE id=(SELECT source_id FROM rejection_sources WHERE key='rotated');
SELECT is((SELECT count(*) FROM public.webhook_source_token_history
  WHERE source_id=(SELECT source_id FROM rejection_sources WHERE key='rotated')),
  1::BIGINT,'unchanged watched columns do not duplicate history');
CREATE TEMP TABLE r08_previous_hash AS SELECT id,auth_token_hash FROM public.webhook_sources
WHERE id=(SELECT source_id FROM rejection_sources WHERE key='rotated');
UPDATE public.webhook_sources SET auth_token_hash=extensions.crypt(gen_random_uuid()::TEXT,extensions.gen_salt('bf'))
WHERE id=(SELECT id FROM r08_previous_hash);
SELECT is((SELECT count(*) FROM public.webhook_source_token_history h JOIN r08_previous_hash p
  ON h.source_id=p.id AND h.retired_auth_token_hash=p.auth_token_hash AND h.retired_reason='rotated'),
  1::BIGINT,'direct hash rotation retains its predecessor');
UPDATE public.webhook_sources SET enabled=FALSE WHERE id=(SELECT id FROM r08_previous_hash);
SELECT is((SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=(SELECT id FROM r08_previous_hash)
  AND retired_reason='revoked'),1::BIGINT,'enabled retirement retains revoked reason');
UPDATE public.webhook_sources SET enabled=TRUE WHERE id=(SELECT id FROM r08_previous_hash);
UPDATE public.webhook_sources SET enabled=FALSE,managed_metadata=COALESCE(managed_metadata,'{}'::jsonb)||'{"lifecycle":"archived"}'::jsonb
WHERE id=(SELECT id FROM r08_previous_hash);
SELECT is((SELECT count(*) FROM public.webhook_source_token_history WHERE source_id=(SELECT id FROM r08_previous_hash)
  AND retired_reason='archived'),1::BIGINT,'metadata archive and disable retains archived reason');

SELECT public.upsert_settings_value_v1('webhook_auth_rejection_logging_policy',public.get_root_scope_type_key_v1(),NULL,
  '{"enabled":true,"max_records":1,"window_seconds":3600,"max_token_bytes":4096}',1,'Disposable exhausted budget');
INSERT INTO rejection_results SELECT 'budget',api.workflow_intake_webhook(unknown_token,'{}','{}','{}') FROM rejection_tokens;
SELECT is((SELECT response#>>'{auth_rejection_logging,reason}' FROM rejection_results WHERE label='budget'),
  'budget_exhausted','all webhook service records conservatively consume the bounded window');
SELECT public.upsert_settings_value_v1('webhook_auth_rejection_logging_policy',public.get_root_scope_type_key_v1(),NULL,
  '{"enabled":false,"max_records":1000,"window_seconds":3600,"max_token_bytes":4096}',1,'Disposable disabled logging');
INSERT INTO rejection_results SELECT 'disabled-policy',api.workflow_intake_webhook(unknown_token,'{}','{}','{}') FROM rejection_tokens;
SELECT is((SELECT response#>>'{auth_rejection_logging,reason}' FROM rejection_results WHERE label='disabled-policy'),
  'policy_disabled','disabled logging leaves authentication unchanged');
SELECT public.upsert_settings_value_v1('webhook_auth_rejection_logging_policy',public.get_root_scope_type_key_v1(),NULL,
  '{"enabled":true,"max_records":1000,"window_seconds":3600,"max_token_bytes":4096}',1,'Disposable reset budget');
SELECT is(public.record_webhook_token_rejection_bounded_v1(repeat('x',4097),NULL,gen_random_uuid())->>'reason',
  'token_size','oversize logging token is suppressed before additional lineage work');
SELECT is(public.record_webhook_token_rejection_bounded_v1(NULL,NULL,gen_random_uuid())->>'reason',
  'missing_identity','private helper also rejects missing identity');

-- Malformed schema limits cannot null out or bypass a finite bound.
CREATE TEMP TABLE rejection_policy_schema AS SELECT schema FROM public.schema_registry
WHERE category='webhook_auth_rejection_logging_policy' AND version=1;
UPDATE public.schema_registry SET schema=schema #- '{properties,max_records,maximum}'
WHERE category='webhook_auth_rejection_logging_policy' AND version=1;
SELECT is(public.record_webhook_token_rejection_bounded_v1('owned-missing-max',NULL,gen_random_uuid())->>'reason',
  'policy_invalid','missing maximum fails closed');
UPDATE public.schema_registry SET schema=jsonb_set((SELECT schema FROM rejection_policy_schema),
  '{properties,window_seconds,maximum}','"invalid"'::JSONB)
WHERE category='webhook_auth_rejection_logging_policy' AND version=1;
SELECT is(public.record_webhook_token_rejection_bounded_v1('owned-invalid-max',NULL,gen_random_uuid())->>'reason',
  'policy_invalid','non-number maximum fails closed');
UPDATE public.schema_registry SET schema=(SELECT schema FROM rejection_policy_schema)
WHERE category='webhook_auth_rejection_logging_policy' AND version=1;

-- Fault is connection- and fingerprint-scoped; no other caller can match it.
SELECT set_config('masarx.r08_sink_fingerprint',(SELECT encode(digest(sink_token,'sha256'),'hex') FROM rejection_tokens),TRUE);
CREATE FUNCTION pg_temp.r08_rejection_sink_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_fingerprint=current_setting('masarx.r08_sink_fingerprint',TRUE) THEN
    RAISE EXCEPTION 'owned disposable sink failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER r08_owned_rejection_sink_failure BEFORE INSERT ON public.intake_auth_rejections
FOR EACH ROW EXECUTE FUNCTION pg_temp.r08_rejection_sink_failure();
INSERT INTO rejection_results SELECT 'sink-failure',api.workflow_intake_webhook(sink_token,'{}','{}','{}') FROM rejection_tokens;
SELECT is((SELECT response#>>'{auth_rejection_logging,reason}' FROM rejection_results WHERE label='sink-failure'),
  'recorder_unavailable','sink failure remains safe best-effort suppression');
SELECT is(response->>'status','401',label||' never turns logging suppression into authentication success or 500')
FROM rejection_results WHERE label IN ('budget','disabled-policy','sink-failure');
SELECT is((SELECT COUNT(*) FROM public.intake_auth_rejections r JOIN rejection_results t
  ON r.correlation_id=(t.response->>'correlation_id')::UUID),3::BIGINT,'suppression and failed sink add no rejection rows');
-- Real authenticated rotation API, using the existing rollback-owned source fixtures.
CREATE TEMP TABLE r08_rotation_actor AS SELECT gen_random_uuid() id,org_id,source_id
FROM rejection_sources WHERE key='disabled';
INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
SELECT id,org_id,id::text||'@example.invalid','R08 rotation actor','tenant' FROM r08_rotation_actor;
DO $policy$
DECLARE p JSONB; v INTEGER; a RECORD;
BEGIN
 SELECT * INTO STRICT a FROM r08_rotation_actor;
 SELECT public.resolve_settings_merged('access_control_policy','tenant',a.org_id) INTO p;
 SELECT version INTO STRICT v FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'roles') r WHERE r->>'key'='r08_rotation_operator') THEN RAISE EXCEPTION 'fixture role collision'; END IF;
 p:=jsonb_set(p,'{roles}',COALESCE(p->'roles','[]')||'[{"key":"r08_rotation_operator","label":"R08 rotation","capability_keys":["webhooks.write"]}]',true);
 p:=jsonb_set(p,'{assignments}',COALESCE(p->'assignments','{}')||jsonb_build_object('user_id',
   COALESCE(p#>'{assignments,user_id}','{}')||jsonb_build_object(a.id::text,jsonb_build_array('r08_rotation_operator'))),true);
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',a.org_id,p,v,'Rollback-only R08 API rotation');
END;
$policy$;
CREATE TEMP TABLE r08_rotation_before AS SELECT w.id,w.auth_token_hash,
 (SELECT count(*) FROM public.webhook_source_token_history h WHERE h.source_id=w.id) history_count
FROM public.webhook_sources w WHERE id IN(SELECT source_id FROM rejection_sources);
CREATE TEMP TABLE r08_rotation_result(value JSONB);
GRANT SELECT ON r08_rotation_actor,rejection_sources TO authenticated;
GRANT INSERT ON r08_rotation_result TO authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true),
 set_config('request.jwt.claim.sub',id::text,true) FROM r08_rotation_actor;
SET LOCAL ROLE authenticated;
SELECT ok(auth.uid()=(SELECT id FROM r08_rotation_actor)
 AND public.current_user_org_id()=(SELECT org_id FROM r08_rotation_actor)
 AND NOT public.request_role_is_service_v1() AND NOT public.is_platform_user()
 AND (public.user_capability_eval_v1('webhooks.write')->>'allowed')::boolean,
 'rotation actor has exact tenant identity and real policy capability without service bypass');
INSERT INTO r08_rotation_result SELECT api.ui_rotate_webhook_source_token_v1(jsonb_build_object('source_id',source_id)) FROM r08_rotation_actor;
SELECT throws_ok(format('SELECT api.ui_rotate_webhook_source_token_v1(%L::jsonb)',
 jsonb_build_object('source_id',(SELECT source_id FROM rejection_sources WHERE key='rotated'))::text),
 '42501',NULL,'rotation actor cannot mutate a foreign tenant source');
RESET ROLE;
SELECT ok((value->>'ok')::boolean AND value->>'webhook_source_id'=(SELECT source_id::text FROM r08_rotation_actor)
 AND length(value->>'auth_token')=64,'rotation API returns exact owned source and one-time token') FROM r08_rotation_result;
SELECT is((SELECT count(*) FROM public.webhook_source_token_history h JOIN r08_rotation_before b ON b.id=h.source_id
 WHERE h.source_id=(SELECT source_id FROM r08_rotation_actor) AND h.retired_auth_token_hash=b.auth_token_hash AND h.retired_reason='rotated'),
 1::BIGINT,'rotation API captures prior hash exactly once');
SELECT ok(w.auth_token_hash<>b.auth_token_hash AND extensions.crypt(r.value->>'auth_token',w.auth_token_hash)=w.auth_token_hash
 AND w.auth_token IS NULL,'rotation API replaces hash without retaining plaintext')
FROM public.webhook_sources w JOIN r08_rotation_before b ON b.id=w.id CROSS JOIN r08_rotation_result r
WHERE w.id=(SELECT source_id FROM r08_rotation_actor);
SELECT is((SELECT id FROM public.resolve_retired_webhook_source_by_token_v1((SELECT token FROM rejection_sources WHERE key='disabled'))),
 (SELECT source_id FROM r08_rotation_actor),'rotation API old token resolves original source');
SELECT ok(w.auth_token_hash=b.auth_token_hash AND (SELECT count(*) FROM public.webhook_source_token_history h WHERE h.source_id=w.id)=b.history_count,
 'foreign rotation denial preserves hash and history') FROM public.webhook_sources w JOIN r08_rotation_before b ON b.id=w.id
WHERE w.id=(SELECT source_id FROM rejection_sources WHERE key='rotated');
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.ui_rotate_webhook_source_token_v1(%L::jsonb)',
 jsonb_build_object('source_id',(SELECT source_id FROM r08_rotation_actor))::text),
 '42501','ui_rotate_webhook_source_token_v1 requires authenticated user','rotation API denies absent actor');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
