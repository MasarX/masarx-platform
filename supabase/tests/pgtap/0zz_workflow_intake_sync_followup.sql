BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(33);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Verify webhook_ingest_policy.workflow.launch_mode='sync_only' runs the follow-up workflow inline
-- (eliminates cron wait for latency-sensitive reply handlers).

INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaa1000-0000-0000-0000-000000000099', 'Sync Followup Org', 'sync-followup-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'cccc1000-0000-0000-0000-000000000099',
  'webhook_inbound',
  'pgtap-sync-followup::default',
  '{}'::jsonb,
  1,
  'pgTAP sync_only follow-up intake mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id
)
VALUES (
  'ffff1000-0000-0000-0000-000000000099',
  'pgtap_sync_followup_v1',
  'Follow-up workflow for sync_only wrapper test',
  1,
  'active',
  'tenant',
  'aaaa1000-0000-0000-0000-000000000099'
)
ON CONFLICT (id) DO NOTHING;

-- Single no-op step: handler exists and completes immediately (no external calls).
INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  enabled
)
VALUES (
  'eeee1000-0000-0000-0000-000000000099',
  'ffff1000-0000-0000-0000-000000000099',
  1,
  'workflow_control',
  'workflow',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object('action', 'complete'),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_sources (
  id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
)
VALUES (
  'bbbb1000-0000-0000-0000-000000000099',
  'aaaa1000-0000-0000-0000-000000000099',
  'pgtap-sync-followup',
  'pgTAP Sync Followup Source',
  'provider',
  'token-pgtap-sync-followup',
  'cccc1000-0000-0000-0000-000000000099',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.settings_versions (
  id,
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  'aaaa2000-0000-0000-0000-000000000099',
  'webhook_ingest_policy',
  'source',
  'bbbb1000-0000-0000-0000-000000000099',
  1,
  jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'synchronous_success',
      'default_headers', jsonb_build_object('cache-control', 'no-store')
    ),
    'workflow', jsonb_build_object(
      'intent', 'pgtap.followup',
      'template_id', 'ffff1000-0000-0000-0000-000000000099',
      'launch_mode', 'sync_only'
    )
  ),
  1,
  'pgTAP webhook_ingest_policy sync_only',
  now(),
  now()
)
ON CONFLICT ON CONSTRAINT settings_versions_new_pkey DO NOTHING;

INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  'aaaa3000-0000-0000-0000-000000000099',
  'webhook_ingest_policy',
  'source',
  'bbbb1000-0000-0000-0000-000000000099',
  'aaaa2000-0000-0000-0000-000000000099',
  (
    SELECT value
    FROM public.settings_versions
    WHERE id = 'aaaa2000-0000-0000-0000-000000000099'
    LIMIT 1
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

CREATE TEMP TABLE pgtap_sync_followup_response AS
SELECT workflow_intake_webhook(
  'token-pgtap-sync-followup',
  jsonb_build_object('content-type', 'application/json'),
  '{"event":{"id":"evt-pgtap-sync-followup","type":"pgtap.followup"},"example":"value"}',
  jsonb_build_object(
    'event',
    jsonb_build_object(
      'id', 'evt-pgtap-sync-followup',
      'type', 'pgtap.followup'
    ),
    'example', 'value'
  )
) AS response;

SELECT ok(
  NULLIF(response->>'followup_workflow_run_id', '') IS NOT NULL,
  'followup_workflow_run_id returned'
)
FROM pgtap_sync_followup_response;

SELECT ok(
  COALESCE((response->>'followup_sync')::BOOLEAN, FALSE),
  'follow-up executed inline when launch_mode=sync_only'
)
FROM pgtap_sync_followup_response;

SELECT is(
  (
    SELECT workflow_status
    FROM public.workflow_runs
    WHERE id = (SELECT (response->>'followup_workflow_run_id')::UUID FROM pgtap_sync_followup_response LIMIT 1)
  ),
  'completed',
  'follow-up workflow_run completed inline'
);

-- Finish the actual entry, not just its sync-only follow-up. This deterministically
-- exposes a delayed duplicate ACK/follow-up instead of racing the background worker.
CREATE TEMP TABLE pgtap_entry_before AS
SELECT (response->>'workflow_run_id')::uuid AS entry_id,
       (response->>'followup_workflow_run_id')::uuid AS child_id,
       (response->>'webhook_id')::uuid AS inbox_id,
       response,
       (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.timestamp,d.id)
          FROM public.decision_log d
         WHERE d.resource_type='webhook_inbox'
           AND d.resource_id=(response->>'webhook_id')::uuid
           AND d.decision_category='http_response_emitted') AS http_before
FROM pgtap_sync_followup_response;
SELECT is((SELECT (response->>'status')::integer FROM pgtap_entry_before),200,
  'synchronous wire result is 200 before engine ACK progress');
SELECT ok((SELECT r.context->>'followup_workflow_run_id'=b.child_id::text
  FROM pgtap_entry_before b JOIN public.workflow_runs r ON r.id=b.entry_id),
  'entry carries authoritative actual follow-up identity');
SELECT is((SELECT count(*)::integer FROM public.decision_log d,pgtap_entry_before b
  WHERE d.resource_type='webhook_inbox' AND d.resource_id=b.inbox_id
    AND d.decision_outcome='workflow_enqueued'
    AND d.decision_inputs->>'followup_workflow_run_id'=b.child_id::text),1,
  'actual follow-up has one genuine enqueue lineage event');
DO $progress$
DECLARE v_entry uuid; v_index integer;
  v_search_path text := current_setting('search_path');
BEGIN
  SELECT entry_id INTO STRICT v_entry FROM pgtap_entry_before;
  FOR v_index IN 1..16 LOOP
    EXIT WHEN (SELECT workflow_status='completed' FROM public.workflow_runs WHERE id=v_entry);
    PERFORM public.progress_workflow_run(v_entry);
  END LOOP;
  -- Existing handlers may change session search_path; restore the caller's pgTAP lookup.
  PERFORM set_config('search_path',v_search_path,true);
END;
$progress$;
SELECT is((SELECT r.workflow_status FROM public.workflow_runs r,pgtap_entry_before b WHERE r.id=b.entry_id),
  'completed','entry reaches terminal completion through public engine progress');
SELECT ok((SELECT count(*)=2 AND bool_and(s.step_status='completed')
  FROM public.workflow_run_steps s JOIN public.operation_handlers h ON h.handler_key=s.handler_key,
       pgtap_entry_before b
  WHERE s.workflow_run_id=b.entry_id
    AND h.handler_name IN ('persist_http_response_v1','dispatch_followup_workflow_v1')),
  'HTTP persistence and follow-up dispatch both actually execute');
SELECT is((SELECT count(*)::integer FROM public.workflow_runs r,pgtap_entry_before b
  WHERE r.metadata->>'started_by_run_id'=b.entry_id::text),1,
  'entry progress creates no second follow-up');
SELECT is((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.timestamp,d.id)
  FROM public.decision_log d,pgtap_entry_before b
  WHERE d.resource_type='webhook_inbox' AND d.resource_id=b.inbox_id
    AND d.decision_category='http_response_emitted'),
  (SELECT http_before FROM pgtap_entry_before),'engine neither adds nor rewrites emitted HTTP history');
CREATE TEMP TABLE pgtap_entry_replay AS SELECT public.workflow_intake_webhook(
  'token-pgtap-sync-followup',jsonb_build_object('content-type','application/json'),
  '{"event":{"id":"evt-pgtap-sync-followup","type":"pgtap.followup"},"example":"value"}',
  '{"event":{"id":"evt-pgtap-sync-followup","type":"pgtap.followup"},"example":"value"}'::jsonb) AS response;
SELECT ok((SELECT r.response->'body'=b.response->'body'
  AND r.response->>'status'=b.response->>'status'
  AND r.response->>'correlation_id'=b.response->>'correlation_id'
  FROM pgtap_entry_replay r CROSS JOIN pgtap_entry_before b),
  'replay retains original status body and correlation after engine completion');
SELECT is((SELECT count(*)::integer FROM public.workflow_runs r,pgtap_entry_before b
  WHERE r.metadata->>'started_by_run_id'=b.entry_id::text),1,'replay does not enqueue another follow-up');

-- Forged composite arguments cannot borrow another inbox's persisted response.
CREATE FUNCTION pg_temp.reject_forged_response_context(p_key text) RETURNS boolean LANGUAGE plpgsql AS $negative$
DECLARE v_run public.workflow_runs; v_step public.workflow_run_steps;
  v_search_path text := current_setting('search_path');
BEGIN
  SELECT r.* INTO STRICT v_run FROM public.workflow_runs r,pgtap_entry_before b WHERE r.id=b.entry_id;
  SELECT s.* INTO STRICT v_step FROM public.workflow_run_steps s
    JOIN public.operation_handlers h ON h.handler_key=s.handler_key
   WHERE s.workflow_run_id=v_run.id AND h.handler_name='persist_http_response_v1';
  IF p_key='run_id' THEN v_run.id:=gen_random_uuid();
  ELSIF p_key='step_id' THEN v_step.id:=gen_random_uuid();
  ELSIF p_key='wrong_handler' THEN
    SELECT s.* INTO STRICT v_step FROM public.workflow_run_steps s
      JOIN public.operation_handlers h ON h.handler_key=s.handler_key
     WHERE s.workflow_run_id=v_run.id AND h.handler_name='dispatch_followup_workflow_v1';
  ELSE v_run.context := jsonb_set(v_run.context,ARRAY[p_key],to_jsonb(gen_random_uuid()::text));
  END IF;
  BEGIN
    PERFORM workflow_handlers.persist_http_response_v1(v_step,v_run,'{}'::jsonb);
    PERFORM set_config('search_path',v_search_path,true);
    RETURN false;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    PERFORM set_config('search_path',v_search_path,true);
    RETURN true;
  END;
END;
$negative$;
SELECT ok(pg_temp.reject_forged_response_context('organization_id'),'foreign organization context cannot reuse emitted response');
SELECT ok(pg_temp.reject_forged_response_context('correlation_id'),'foreign correlation context cannot reuse emitted response');
SELECT ok(pg_temp.reject_forged_response_context('webhook_id'),'foreign inbox cannot fall through to legacy writer');
SELECT ok(pg_temp.reject_forged_response_context('run_id'),'unpersisted run identity cannot reuse response');
SELECT ok(pg_temp.reject_forged_response_context('step_id'),'unpersisted step identity cannot reuse response');
SELECT ok(pg_temp.reject_forged_response_context('wrong_handler'),'other genuine step cannot impersonate HTTP persistence');

-- A genuine engine-only entry with no prior core emission must still persist one ACK.
CREATE TEMP TABLE pgtap_legacy_entry (entry_id uuid,inbox_id uuid);
DO $legacy$
DECLARE v_run public.workflow_runs; v_inbox uuid:=gen_random_uuid(); v_correlation uuid:=gen_random_uuid();
  v_legacy_key text := 'evt-legacy-' || gen_random_uuid()::text;
  v_entry uuid; v_context jsonb; v_index integer;
  v_search_path text := current_setting('search_path');
BEGIN
  SELECT r.* INTO STRICT v_run FROM public.workflow_runs r,pgtap_entry_before b WHERE r.id=b.entry_id;
  v_context := (v_run.context - ARRAY['followup_workflow_run_id','followup_template_id','http_response','ack','ack_metadata'])
    || jsonb_build_object('webhook_id',v_inbox,'correlation_id',v_correlation,'idempotency_key',v_legacy_key,'workflow','{}'::jsonb);
  v_context:=jsonb_set(v_context,'{payload,event,id}',to_jsonb(v_legacy_key));
  PERFORM public.insert_webhook_inbox_record(v_inbox,'bbbb1000-0000-0000-0000-000000000099'::uuid,
    'provider',v_context->'payload','{}'::jsonb,'in_progress',v_correlation,v_legacy_key);
  v_entry := public.start_workflow_run(v_run.workflow_template_id,v_context);
  INSERT INTO pgtap_legacy_entry VALUES(v_entry,v_inbox);
  FOR v_index IN 1..16 LOOP
    EXIT WHEN (SELECT workflow_status='completed' FROM public.workflow_runs WHERE id=v_entry);
    PERFORM public.progress_workflow_run(v_entry);
  END LOOP;
  PERFORM set_config('search_path',v_search_path,true);
END;
$legacy$;
SELECT is((SELECT r.workflow_status FROM public.workflow_runs r,pgtap_legacy_entry l WHERE r.id=l.entry_id),
  'completed','legacy engine-only entry still completes');
SELECT is((SELECT count(*)::integer FROM public.decision_log d,pgtap_legacy_entry l
  WHERE d.resource_type='webhook_inbox' AND d.resource_id=l.inbox_id
    AND d.decision_category='http_response_emitted' AND d.performed_by_system='workflow_engine'),1,
  'legacy path still produces its genuine engine HTTP response');
SELECT is((SELECT count(*)::integer FROM public.decision_log d,pgtap_entry_before b
  WHERE d.resource_type='webhook_inbox' AND d.resource_id=b.inbox_id
    AND d.decision_category='http_response_emitted' AND d.decision_outcome='response_sent'),1,
  'negative and legacy cases leave original single emitted response intact');
-- Each negative runs in a subtransaction and restores even an unexpectedly accepted write.
CREATE FUNCTION pg_temp.reject_legacy_authority(p_case text) RETURNS boolean LANGUAGE plpgsql AS $negative$
DECLARE v_run public.workflow_runs; v_step public.workflow_run_steps;
  v_other_org uuid := gen_random_uuid(); v_missing uuid := gen_random_uuid();
  v_search_path text := current_setting('search_path');
BEGIN
  IF p_case='core_null_org' THEN
    SELECT r.* INTO STRICT v_run FROM public.workflow_runs r,pgtap_entry_before b WHERE r.id=b.entry_id;
  ELSE
    SELECT r.* INTO STRICT v_run FROM public.workflow_runs r,pgtap_legacy_entry b WHERE r.id=b.entry_id;
  END IF;
  SELECT s.* INTO STRICT v_step FROM public.workflow_run_steps s
    JOIN public.operation_handlers h ON h.handler_key=s.handler_key
   WHERE s.workflow_run_id=v_run.id AND h.handler_name='persist_http_response_v1';
  BEGIN
    IF p_case='missing_source' THEN
      v_run.context:=jsonb_set(v_run.context,'{webhook_id}',to_jsonb(v_missing::text));
      v_run.context:=v_run.context-ARRAY['webhook_source_id','source_identifier'];
      UPDATE public.workflow_runs SET context=v_run.context WHERE id=v_run.id;
    ELSIF p_case='core_null_org' THEN
      UPDATE public.webhook_inbox SET organization_id=NULL WHERE id=(v_run.context->>'webhook_id')::uuid;
    ELSE
      INSERT INTO public.organizations(id,name,slug)
        VALUES(v_other_org,'Negative source authority','negative-authority-'||v_other_org::text);
      IF p_case='foreign_source_org' THEN
        UPDATE public.webhook_sources SET organization_id=v_other_org
         WHERE id=(SELECT webhook_source_id FROM public.webhook_inbox WHERE id=(v_run.context->>'webhook_id')::uuid);
      ELSIF p_case='explicit_inbox_mismatch' THEN
        UPDATE public.webhook_inbox SET organization_id=v_other_org WHERE id=(v_run.context->>'webhook_id')::uuid;
      ELSE RAISE EXCEPTION 'Unknown negative case';
      END IF;
    END IF;
    PERFORM workflow_handlers.persist_http_response_v1(v_step,v_run,'{}'::jsonb);
    RAISE EXCEPTION 'Accepted negative case' USING ERRCODE='Z0001';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      PERFORM set_config('search_path',v_search_path,true);
      RETURN true;
    WHEN SQLSTATE 'Z0001' THEN
      PERFORM set_config('search_path',v_search_path,true);
      RETURN false;
  END;
END;
$negative$;
SELECT ok(pg_temp.reject_legacy_authority('missing_source'),'legacy inbox creation rejects missing source authority');
SELECT ok(pg_temp.reject_legacy_authority('foreign_source_org'),'legacy unbound inbox rejects foreign canonical source organization');
SELECT ok(pg_temp.reject_legacy_authority('explicit_inbox_mismatch'),'legacy writer rejects explicit inbox organization mismatch');
SELECT ok(pg_temp.reject_legacy_authority('core_null_org'),'core response reuse still requires explicit inbox organization binding');
CREATE FUNCTION pg_temp.accept_legacy_creation(p_duplicate boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $positive$
DECLARE v_run public.workflow_runs; v_step public.workflow_run_steps;
  v_inbox uuid:=gen_random_uuid(); v_ok boolean;
  v_source uuid; v_other_org uuid:=gen_random_uuid();
BEGIN
  SELECT r.* INTO STRICT v_run FROM public.workflow_runs r,pgtap_legacy_entry b WHERE r.id=b.entry_id;
  SELECT s.* INTO STRICT v_step FROM public.workflow_run_steps s
    JOIN public.operation_handlers h ON h.handler_key=s.handler_key
   WHERE s.workflow_run_id=v_run.id AND h.handler_name='persist_http_response_v1';
  BEGIN
    SELECT webhook_source_id INTO STRICT v_source FROM public.webhook_inbox WHERE id=(v_run.context->>'webhook_id')::uuid;
    IF p_duplicate THEN
      INSERT INTO public.organizations(id,name,slug)
        VALUES(v_other_org,'Duplicate identifier organization','duplicate-identifier-'||v_other_org::text);
      INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,enabled,created_at)
        SELECT gen_random_uuid(),v_other_org,source_identifier,'Foreign duplicate identifier',provider_type,
          'duplicate-test-'||gen_random_uuid()::text,mapping_config_id,true,clock_timestamp()+interval '1 second'
        FROM public.webhook_sources WHERE id=v_source;
      v_run.context:=v_run.context-'webhook_source_id';
    END IF;
    v_run.context:=v_run.context||jsonb_build_object('webhook_id',v_inbox,'idempotency_key','legacy-created-'||v_inbox::text);
    v_run.context:=jsonb_set(v_run.context,'{payload,event,id}',v_run.context->'idempotency_key');
    UPDATE public.workflow_runs SET context=v_run.context WHERE id=v_run.id;
    PERFORM workflow_handlers.persist_http_response_v1(v_step,v_run,'{}'::jsonb);
    SELECT EXISTS(SELECT 1 FROM public.webhook_inbox i
      JOIN public.webhook_sources s ON s.id=i.webhook_source_id
      WHERE i.id=v_inbox AND i.workflow_run_id=v_run.id AND i.webhook_source_id=v_source
        AND i.provider_type=s.provider_type
        AND s.organization_id=(v_run.context->>'organization_id')::uuid) INTO v_ok;
    RAISE EXCEPTION 'Rollback positive fixture' USING ERRCODE='Z0002';
  EXCEPTION WHEN SQLSTATE 'Z0002' THEN RETURN v_ok;
  END;
END;
$positive$;
SELECT ok(pg_temp.accept_legacy_creation(),'legacy writer creates missing inbox from persisted canonical source authority');
SELECT ok(pg_temp.accept_legacy_creation(true),'identifier-only legacy creation binds owned source despite newer foreign duplicate');
-- Independent source/event: retain all existing sync/replay assertions unchanged.
CREATE FUNCTION pg_temp.f267_transformed_child_context() RETURNS SETOF TEXT LANGUAGE plpgsql AS $proof$
DECLARE
 source_id UUID:=gen_random_uuid(); token TEXT:='qa-f267-'||gen_random_uuid();
 source_key TEXT:='qa-f267-'||gen_random_uuid(); event_id TEXT:='qa-f267-'||gen_random_uuid();
 template_id UUID:='ffff1000-0000-0000-0000-000000000099';
 org UUID:='aaaa1000-0000-0000-0000-000000000099';
 payload JSONB; expected JSONB; policy JSONB; schema_version INT; response JSONB;
 child public.workflow_runs; parent_id UUID; resolution JSONB;
 prior_path TEXT:=current_setting('search_path');
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 payload:=jsonb_build_object('event',jsonb_build_object('id',event_id,'type','shipment.updated'),
   'status','in_transit','example','retained-original');
 expected:=jsonb_set(payload,'{event,type}','"update.status"'::jsonb);
 resolution:=public.resolve_webhook_shipment_intent_v1(payload,'shipment.updated','shipment.updated');
 RETURN NEXT ok(resolution->>'canonical_intent'='update.status'
   AND resolution->'transformed_payload'=expected AND expected<>payload
   AND NOT public.should_reserve_identifiers_for_shipment_intent_v1('update.status','{}'),
   'F267 real resolver derives a distinct typed payload without shipment identifier reservation');
 INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,enabled)
 SELECT source_id,organization_id,source_key,'F267 transformed followup','provider',token,mapping_config_id,true
 FROM public.webhook_sources WHERE id='bbbb1000-0000-0000-0000-000000000099';
 SELECT p.value,p.schema_version INTO STRICT policy,schema_version
 FROM public.settings s JOIN public.settings_versions p ON p.id=s.settings_version_id AND p.scope_hash=s.scope_hash
 WHERE s.category='webhook_ingest_policy' AND s.scope_type='source'
   AND s.scope_id='bbbb1000-0000-0000-0000-000000000099';
 policy:=jsonb_set(policy,'{workflow,intent}','"shipment.updated"'::jsonb);
 PERFORM public.upsert_settings_value_v1('webhook_ingest_policy','source',source_id,policy,schema_version,'F267 owned transformed followup');
 SET CONSTRAINTS ALL IMMEDIATE;
 response:=public.workflow_intake_webhook(token,'{"content-type":"application/json"}',payload::text,payload);
 PERFORM set_config('search_path',prior_path,true);
 parent_id:=(response->>'workflow_run_id')::uuid;
 SELECT * INTO STRICT child FROM public.workflow_runs WHERE id=(response->>'followup_workflow_run_id')::uuid;
 RETURN NEXT ok((response->>'status')::int=200 AND child.workflow_status='completed'
   AND child.workflow_template_id=template_id
   AND child.context->>'followup_template_id'=template_id::text,
   'F267 returned child completes the policy-selected existing no-op template');
 RETURN NEXT is(child.context->'payload',payload,'F267 returned child preserves exact original payload');
 RETURN NEXT is(child.context->'transformed_payload',expected,'F267 returned child preserves distinct canonical transformed payload');
 RETURN NEXT ok(child.context->>'source_identifier'=source_key AND child.entry_point='webhook'
   AND child.context->>'organization_id'=org::text,
   'F267 returned child carries canonical source identity and persisted webhook entry point');
 RETURN NEXT ok(parent_id IS NOT NULL AND child.context->>'started_by_run_id'=parent_id::text
   AND child.metadata->>'started_by_run_id'=parent_id::text
   AND EXISTS(SELECT 1 FROM public.workflow_runs WHERE id=parent_id)
   AND EXISTS(SELECT 1 FROM public.webhook_inbox WHERE id=(response->>'webhook_id')::uuid
     AND webhook_source_id=source_id AND workflow_run_id=parent_id),
   'F267 returned child context and metadata bind the exact persisted intake parent');
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$proof$;
SELECT * FROM pg_temp.f267_transformed_child_context();
SELECT finish();

ROLLBACK;
