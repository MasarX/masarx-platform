-- Test Suite: workflow_control fail action + wait_for_shipment handler
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(21);

-- Core entities for shipment wait test.
INSERT INTO organizations (id, name, slug)
VALUES ('aaaaaaaa-0000-0000-0000-000000000111', 'Workflow Test Org', 'wf-test-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'Workflow Test Client',
  'wf-test-client',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  'cccccccc-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'Workflow Test Sender',
  'Workflow Test Sender',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  city,
  province,
  country,
  validation_status,
  created_at,
  updated_at
)
VALUES (
  'dddddddd-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'Test Address',
  'Riyadh',
  'Riyadh',
  'SA',
  'valid',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

-- workflow_control fail action.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000111',
  'pgtap_workflow_control_fail',
  'pgTAP workflow_control fail handler',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  enabled
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000112',
  'eeeeeeee-0000-0000-0000-000000000111',
  1,
  'provider_error',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object('action', 'fail', 'reason', 'provider_error'),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000113', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000113',
  'eeeeeeee-0000-0000-0000-000000000111',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000113', true);

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000114',
  'eeeeeeee-0000-0000-0000-000000000113',
  'eeeeeeee-0000-0000-0000-000000000112',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object('action', 'fail', 'reason', 'provider_error'),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000113'
  ),
  'failed',
  'workflow_control fail returns failed status'
);

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).workflow_status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000113'
  ),
  'failed',
  'workflow_control fail sets workflow_status=failed'
);

-- workflow_control fail action with conditional context.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000201',
  'pgtap_workflow_control_conditional',
  'pgTAP workflow_control conditional fail handler',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  enabled
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000202',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'provider_error',
  'always',
  'workflow_control',
  'v1',
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000203', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000203',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'test',
  'pending',
  jsonb_build_object('flags', jsonb_build_object('force_fail', false))
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000204',
  'eeeeeeee-0000-0000-0000-000000000203',
  'eeeeeeee-0000-0000-0000-000000000202',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000203'
  ),
  'completed',
  'workflow_control conditional fail skips when context flag is false'
);

SELECT set_config('app.workflow_run_id', 'eeeeeeee-0000-0000-0000-000000000205', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000205',
  'eeeeeeee-0000-0000-0000-000000000201',
  1,
  'test',
  'pending',
  jsonb_build_object('flags', jsonb_build_object('force_fail', true))
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeeeeeee-0000-0000-0000-000000000206',
  'eeeeeeee-0000-0000-0000-000000000205',
  'eeeeeeee-0000-0000-0000-000000000202',
  1,
  'pending',
  'provider_error',
  'workflow_control',
  'v1',
  1,
  jsonb_build_object(
    'action',
    'fail',
    'fail_when',
    'context_truthy',
    'context_path',
    'flags.force_fail',
    'reason',
    'provider_failed'
  ),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_workflow_control_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'eeeeeeee-0000-0000-0000-000000000205'
  ),
  'failed',
  'workflow_control conditional fail triggers when context flag is true'
);

-- wait_for_shipment handler.
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'ffffffff-0000-0000-0000-000000000111',
  'pgtap_wait_for_shipment',
  'pgTAP wait_for_shipment handler',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  enabled
)
VALUES (
  'ffffffff-0000-0000-0000-000000000112',
  'ffffffff-0000-0000-0000-000000000111',
  1,
  'wait_for_shipment',
  'always',
  'wait_for_shipment',
  'v1',
  jsonb_build_object('poll_interval_seconds', 5, 'max_wait_seconds', 60),
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffffffff-0000-0000-0000-000000000113', true);
INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'ffffffff-0000-0000-0000-000000000113',
  'ffffffff-0000-0000-0000-000000000111',
  1,
  'test',
  'pending',
  jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000111')
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffffffff-0000-0000-0000-000000000113', true);

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  metadata,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'ffffffff-0000-0000-0000-000000000114',
  'ffffffff-0000-0000-0000-000000000113',
  'ffffffff-0000-0000-0000-000000000112',
  1,
  'pending',
  'wait_for_shipment',
  'wait_for_shipment',
  'v1',
  3,
  jsonb_build_object('poll_interval_seconds', 5, 'max_wait_seconds', 60),
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ),
  'pending',
  'wait_for_shipment returns pending when shipment is missing'
);

INSERT INTO shipments (
  id,
  organization_id,
  client_id,
  sender_id,
  service_type,
  tracking_number,
  box_count,
  destination_address_id,
  status,
  status_updated_at,
  metadata,
  created_at,
  updated_at
)
VALUES (
  '99999999-0000-0000-0000-000000000111',
  'aaaaaaaa-0000-0000-0000-000000000111',
  'bbbbbbbb-0000-0000-0000-000000000111',
  'cccccccc-0000-0000-0000-000000000111',
  'delivery',
  'PITCH-WAIT-001',
  1,
  'dddddddd-0000-0000-0000-000000000111',
  'pending',
  now(),
  jsonb_build_object('source', jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000111')),
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

SELECT is(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).status
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ),
  'completed',
  'wait_for_shipment completes once shipment exists'
);

SELECT ok(
  (
    SELECT (workflow_handlers.execute_wait_for_shipment_v1(wrs, wr, '{}'::jsonb)).context_patch->>'shipment_id'
    FROM workflow_runs wr
    JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
    WHERE wr.id = 'ffffffff-0000-0000-0000-000000000113'
  ) = '99999999-0000-0000-0000-000000000111',
  'wait_for_shipment patches shipment_id in context'
);

-- F823: read-only seeded source/provider prerequisites; mutate only new request/call rows.
CREATE TEMP TABLE f823_wait_results(label text PRIMARY KEY, result jsonb, expected_request uuid, expected_call uuid) ON COMMIT DROP;
DO $f823$
DECLARE
  v_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_source uuid := gen_random_uuid();
  v_mapping uuid := gen_random_uuid();
  v_pack uuid;
  v_foreign_run public.workflow_runs;
  v_count integer;
  v_dispatch_template uuid := gen_random_uuid();
  v_dispatch uuid := gen_random_uuid();
  v_provider uuid;
  v_route uuid;
  v_request uuid := gen_random_uuid();
  v_call uuid := gen_random_uuid();
  v_response public.workflow_handler_response;
  v_original_context jsonb;
  v_status text;
BEGIN
  SELECT * INTO STRICT v_run FROM public.workflow_runs
    WHERE id = 'ffffffff-0000-0000-0000-000000000113';
  SELECT * INTO STRICT v_step FROM public.workflow_run_steps
    WHERE id = 'ffffffff-0000-0000-0000-000000000114';
  SELECT * INTO STRICT v_foreign_run FROM public.workflow_runs
    WHERE id='eeeeeeee-0000-0000-0000-000000000113';
  SELECT r.provider_id,r.id INTO v_provider,v_route
    FROM public.api_routes r JOIN public.api_route_packs p ON p.id=r.pack_id
    WHERE p.name='logestechs_v2_mirror' AND upper(r.method)='PUT'
      AND r.path_template='/api/guests/{companyId}/packages/{shipmentId}/cancel'
      AND r.scope_type='global' AND r.enabled ORDER BY r.updated_at DESC LIMIT 1;
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'F823 requires the unchanged seeded Logestechs provider';
  END IF;
  INSERT INTO public.mapping_configs(id,organization_id,mapping_type,mapping_key,mapping_config,mapping_version)
    VALUES(v_mapping,'aaaaaaaa-0000-0000-0000-000000000111','webhook_inbound','f823-'||v_mapping,'{}',1);
  INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,rate_limit_per_hour,enabled,sender_id)
    VALUES(v_source,'aaaaaaaa-0000-0000-0000-000000000111','f823-'||v_source,'F823 owned source','api_gateway','synthetic-f823-'||v_source,v_mapping,1000,true,'cccccccc-0000-0000-0000-000000000111');
  INSERT INTO public.api_route_packs(name,description) VALUES('f823-'||v_request,'F823 owned route pack') RETURNING id INTO v_pack;
  INSERT INTO public.api_routes(pack_id,route_name,enabled,method,path_template,policy)
    VALUES(v_pack,'f823-'||v_request,true,'POST','/pgtap/f823/'||v_request,'{"workflow":{"intent":"shipment.create"}}') RETURNING id INTO v_route;
  PERFORM set_config('app.workflow_run_id',v_run.id::text,true);
  INSERT INTO public.workflow_template_steps(id,workflow_template_id,sequence_order,operation_name,transition_condition,handler_key,handler_version,metadata,enabled)
    VALUES(v_dispatch_template,v_run.workflow_template_id,2,'dispatch_create','always','api_gateway_dispatch_outbound','v1','{}',true);
  INSERT INTO public.workflow_run_steps(id,workflow_run_id,workflow_template_step_id,sequence_order,step_status,operation_name,handler_key,handler_version,max_retries,metadata,enqueued_at,created_at,updated_at)
    VALUES(v_dispatch,v_run.id,v_dispatch_template,2,'completed','dispatch_create','api_gateway_dispatch_outbound','v1',3,'{}',now(),now(),now());
  -- This matrix supplies immutable input composites; only the separate engine case proves persistence.
  PERFORM set_config('app.workflow_run_step_id',v_dispatch::text,true);
  INSERT INTO public.outbound_calls
    (id,call_type,target_type,target_id,method,url,status,workflow_run_step_id,
     response_status_code,response_body,error_message)
    VALUES(v_call,'provider_api','provider',v_provider,'POST','https://example.test/f823',
      'permanently_failed',v_dispatch,503,'{"secret":"synthetic-private-marker"}','synthetic-private-marker');
  INSERT INTO public.api_gateway_requests
    (id,organization_id,client_id,sender_id,source_id,route_id,method,path,outbound_call_id,workflow_run_id)
    VALUES(v_request,'aaaaaaaa-0000-0000-0000-000000000111','bbbbbbbb-0000-0000-0000-000000000111','cccccccc-0000-0000-0000-000000000111',v_source,v_route,'POST','/pgtap/f823',v_call,v_run.id);
  v_original_context := v_run.context;
  v_run.context := jsonb_build_object('api_gateway_request_id',v_request);
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
  INSERT INTO f823_wait_results VALUES('permanent',to_jsonb(v_response),v_request,v_call);
  FOREACH v_status IN ARRAY ARRAY['failed','pending','completed'] LOOP
    UPDATE public.outbound_calls SET status=v_status WHERE id=v_call;
    v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
    INSERT INTO f823_wait_results(label,result) VALUES(v_status,to_jsonb(v_response));
  END LOOP;
  UPDATE public.outbound_calls SET status='permanently_failed' WHERE id=v_call;
  UPDATE public.api_gateway_requests SET workflow_run_id=v_foreign_run.id WHERE id=v_request;
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
  INSERT INTO f823_wait_results(label,result) VALUES('foreign_link',to_jsonb(v_response));
  v_run.context := jsonb_build_object('api_gateway_request_id',gen_random_uuid(),
    'api_gateway',jsonb_build_object('outbound_call_id',v_call));
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,
    jsonb_build_object('outbound_call_id',v_call));
  INSERT INTO f823_wait_results(label,result) VALUES('forged',to_jsonb(v_response));
  UPDATE public.api_gateway_requests SET workflow_run_id=v_run.id WHERE id=v_request;
  v_run.context := jsonb_build_object('api_gateway_request_id',v_request);
  v_step.workflow_run_id := v_foreign_run.id;
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
  INSERT INTO f823_wait_results(label,result) VALUES('mismatched_step',to_jsonb(v_response));
  v_step.workflow_run_id := v_run.id;
  UPDATE public.outbound_calls SET status='pending' WHERE id=v_call;
  v_step.operation_started_at := now()-interval '2 minutes';
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
  INSERT INTO f823_wait_results(label,result) VALUES('timeout',to_jsonb(v_response));
  v_step.operation_started_at := NULL;
  UPDATE public.outbound_calls SET status='permanently_failed' WHERE id=v_call;
  -- Associate the existing owned shipment with this owned request, within outer rollback.
  UPDATE public.shipments SET metadata=jsonb_set(metadata,'{source,api_gateway_request_id}',to_jsonb(v_request::text))
    WHERE id='99999999-0000-0000-0000-000000000111'
      AND client_id='bbbbbbbb-0000-0000-0000-000000000111';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'F823 owned shipment update did not affect exactly one row'; END IF;
  v_run.context := jsonb_build_object('api_gateway_request_id',v_request);
  v_response := workflow_handlers.execute_wait_for_shipment_v1(v_step,v_run,'{}');
  INSERT INTO f823_wait_results(label,result) VALUES('success_precedence',to_jsonb(v_response));
END;
$f823$;
SELECT is((SELECT result->>'status' FROM f823_wait_results WHERE label='permanent'),'failed','terminal provider failure fails wait');
SELECT is((SELECT result->>'workflow_status' FROM f823_wait_results WHERE label='permanent'),'failed','terminal provider failure fails workflow');
SELECT ok((SELECT result#>>'{operation_result,provider_failure,status}'='permanently_failed'
  AND result#>>'{operation_result,provider_failure,response_status_code}'='503'
  AND result#>>'{operation_result,outbound_call_id}'=expected_call::text
  AND result#>>'{operation_result,api_gateway_request_id}'=expected_request::text
  AND result::text NOT LIKE '%synthetic-private-marker%' FROM f823_wait_results WHERE label='permanent'),
  'provider failure metadata is linked and sanitized');
SELECT is((SELECT count(*)::integer FROM f823_wait_results WHERE label IN ('failed','pending','completed') AND result->>'status'='pending'),3,'nonterminal provider states continue polling');
SELECT is((SELECT result->>'status' FROM f823_wait_results WHERE label='foreign_link'),'pending','unlinked request cannot fail another workflow');
SELECT is((SELECT result->>'status' FROM f823_wait_results WHERE label='forged'),'pending','forged outbound IDs cannot fail workflow');
SELECT is((SELECT result->>'status' FROM f823_wait_results WHERE label='mismatched_step'),'pending','mismatched step cannot consume terminal failure');
SELECT is((SELECT result->>'last_error' FROM f823_wait_results WHERE label='timeout'),'shipment_wait_timeout','nonterminal provider retains timeout');
SELECT is((SELECT result->>'status' FROM f823_wait_results WHERE label='success_precedence'),'completed','canonical shipment success precedes stale provider failure');
SELECT is((SELECT result#>>'{operation_result,shipment_id}' FROM f823_wait_results WHERE label='success_precedence'),'99999999-0000-0000-0000-000000000111','success returns exact owned shipment');

-- Persisted engine proof uses a separate dispatch step: outbound triggers cannot finalize wait.
CREATE TEMP TABLE f823_engine_result(before_wait text, after_wait text, after_run text, reason text, request_id uuid, outbound_id uuid, observed_request text, observed_outbound text) ON COMMIT DROP;
CREATE TEMP TABLE f823_engine_diagnostic(proof jsonb) ON COMMIT DROP;
DO $engine$
DECLARE
  v_template uuid := gen_random_uuid();
  v_dispatch_template uuid := gen_random_uuid();
  v_wait_template uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_dispatch uuid := gen_random_uuid();
  v_wait uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_call uuid := gen_random_uuid();
  v_seed public.api_gateway_requests;
  v_seed_call public.outbound_calls;
  v_before text;
  v_before_run text;
  v_before_dispatch text;
  v_progress jsonb;
BEGIN
  SELECT r.* INTO STRICT v_seed FROM public.api_gateway_requests r JOIN f823_wait_results x ON x.expected_request=r.id WHERE x.label='permanent';
  SELECT * INTO STRICT v_seed_call FROM public.outbound_calls WHERE id=v_seed.outbound_call_id;
  INSERT INTO public.workflow_templates(id,name,description,version,status,scope_type)
    VALUES(v_template,'f823-engine-'||v_template,'Owned F823 engine proof',1,'active','global');
  INSERT INTO public.workflow_template_steps(id,workflow_template_id,sequence_order,operation_name,transition_condition,handler_key,handler_version,metadata,enabled)
    VALUES(v_dispatch_template,v_template,1,'dispatch_create','always','api_gateway_dispatch_outbound','v1','{}',true),
          (v_wait_template,v_template,2,'wait_for_shipment','always','wait_for_shipment','v1','{"poll_interval_seconds":5,"max_wait_seconds":60}',true);
  PERFORM set_config('app.workflow_run_id',v_run::text,true);
  INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status,context)
    VALUES(v_run,v_template,1,'test','pending',jsonb_build_object('api_gateway_request_id',v_request,
      'organization_id',v_seed.organization_id));
  INSERT INTO public.workflow_run_steps(id,workflow_run_id,workflow_template_step_id,sequence_order,step_status,operation_name,handler_key,handler_version,max_retries,metadata,enqueued_at,created_at,updated_at)
    VALUES(v_dispatch,v_run,v_dispatch_template,1,'completed','dispatch_create','api_gateway_dispatch_outbound','v1',3,'{}',now(),now(),now()),
          (v_wait,v_run,v_wait_template,2,'pending','wait_for_shipment','wait_for_shipment','v1',3,'{"poll_interval_seconds":5,"max_wait_seconds":60}',now(),now(),now());
  PERFORM set_config('app.workflow_run_step_id',v_dispatch::text,true);
  INSERT INTO public.outbound_calls(id,call_type,target_type,target_id,method,url,status,workflow_run_step_id,response_status_code)
    VALUES(v_call,'provider_api','provider',v_seed_call.target_id,'POST','https://example.test/f823-engine','permanently_failed',v_dispatch,503);
  INSERT INTO public.api_gateway_requests(id,organization_id,client_id,sender_id,source_id,route_id,method,path,outbound_call_id,workflow_run_id)
    VALUES(v_request,v_seed.organization_id,v_seed.client_id,v_seed.sender_id,v_seed.source_id,v_seed.route_id,'POST','/pgtap/f823-engine',v_call,v_run);
  SELECT step_status INTO STRICT v_before FROM public.workflow_run_steps WHERE id=v_wait;
  SELECT workflow_status INTO STRICT v_before_run FROM public.workflow_runs WHERE id=v_run;
  SELECT step_status INTO STRICT v_before_dispatch FROM public.workflow_run_steps WHERE id=v_dispatch;
  IF v_before_run <> 'pending' OR v_before_dispatch <> 'completed' THEN RAISE EXCEPTION 'F823 run/dispatch changed before canonical progression'; END IF;
  IF v_before <> 'pending' THEN RAISE EXCEPTION 'F823 wait changed before canonical progression'; END IF;
  v_progress := public.progress_workflow_run(v_run,'{}');
  -- Engine catches retain SQLERRM, not SQLSTATE. Classify in memory only;
  -- never print error text, payloads, request data or guessed SQLSTATE values.
  INSERT INTO f823_engine_diagnostic
  SELECT jsonb_build_object(
    'caught_exception',v_progress ? 'error',
    'returned_owned_run',v_progress->>'workflow_run_id'=v_run::text,
    'returned_owned_step',v_progress->>'step_id'=v_wait::text,
    'step_result_present',s.operation_result IS NOT NULL,
    'errors',(
      SELECT jsonb_object_agg(source,CASE
        WHEN message IS NULL OR message='' THEN 'absent'
        WHEN starts_with(message,'record_workflow_decision: unable to resolve organization_id for workflow_run_id=') THEN 'decision_org_unresolved'
        WHEN starts_with(message,'record_workflow_decision: workflow_run ') AND message LIKE '% not found' THEN 'decision_run_missing'
        WHEN starts_with(message,'log_decision requires organization_id') THEN 'decision_org_required'
        WHEN starts_with(message,'workflow guardrails: missing context ') THEN 'workflow_context_missing'
        WHEN starts_with(message,'workflow guardrails: context ') AND position(' mismatch for ' IN message)>0 THEN 'workflow_context_mismatch'
        WHEN starts_with(message,'progress_workflow_run: handler_key unresolved for step ') THEN 'handler_key_unresolved'
        WHEN starts_with(message,'progress_workflow_run: workflow ') AND message LIKE '% not found' THEN 'engine_run_missing'
        WHEN message ~* 'violates foreign key constraint' THEN 'foreign_key'
        WHEN message ~* 'violates not-null constraint|null value in column' THEN 'not_null'
        WHEN message ~* 'violates check constraint' THEN 'check_constraint'
        WHEN message ~* 'violates unique constraint|duplicate key' THEN 'unique_constraint'
        WHEN message ~* 'permission denied|not authorized|access denied' THEN 'authorization'
        WHEN message ~* 'handler .*not registered|handler function .*missing' THEN 'handler_registration'
        WHEN message ~* 'returned NULL status|returned invalid status' THEN 'handler_status'
        WHEN message ~* 'column .*does not exist|relation .*does not exist|function .*does not exist' THEN 'missing_schema_object'
        WHEN message ~* 'invalid input syntax|cannot cast|out of range' THEN 'type_conversion'
        WHEN message ~* 'statement timeout|canceling statement' THEN 'statement_timeout'
        ELSE 'unclassified' END)
      FROM (VALUES ('progress',v_progress->>'error'),('step',s.last_error),
        ('run',r.failure_reason)) errors(source,message)))
  FROM public.workflow_run_steps s JOIN public.workflow_runs r ON r.id=s.workflow_run_id
  WHERE s.id=v_wait;
  INSERT INTO f823_engine_result
    SELECT v_before,s.step_status,r.workflow_status,s.operation_result->>'reason',v_request,v_call,
      s.operation_result->>'api_gateway_request_id',s.operation_result->>'outbound_call_id'
    FROM public.workflow_run_steps s JOIN public.workflow_runs r ON r.id=s.workflow_run_id WHERE s.id=v_wait;
END;
$engine$;
SELECT diag(proof::text) FROM f823_engine_diagnostic
WHERE proof->>'caught_exception'='true' OR proof->>'step_result_present'='false';
SELECT is((SELECT before_wait FROM f823_engine_result),'pending','outbound insertion does not independently finalize wait');
SELECT is((SELECT after_wait FROM f823_engine_result),'failed','canonical progression persists wait failure');
SELECT is((SELECT after_run FROM f823_engine_result),'failed','canonical progression persists workflow failure');
SELECT ok((SELECT reason='provider_outbound_permanently_failed' AND observed_request=request_id::text AND observed_outbound=outbound_id::text FROM f823_engine_result),'persisted wait failure retains exact provider lineage');

SELECT * FROM finish();

ROLLBACK;
