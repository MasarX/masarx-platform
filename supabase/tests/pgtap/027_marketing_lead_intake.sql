BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(41);

-- pgTAP runs via direct SQL (not PostgREST), so request.jwt.claims is unset by default.
-- Task creation paths require either auth.uid() or role=service_role claims.
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);

-- 1) RPC exists (public)
SELECT has_function(
  'public',
  'marketing_lead_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'marketing_lead_request_create_v1 exists'
);

-- 2) RPC is SECURITY DEFINER
SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'
    )
      AND p.prokind = 'f'
  ),
  'marketing_lead_request_create_v1 is SECURITY DEFINER'
);

-- 3) api wrapper exists
SELECT has_function(
  'api',
  'marketing_lead_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'api.marketing_lead_request_create_v1 exists'
);

-- 4) service_role can execute api wrapper
SELECT ok(
  has_function_privilege(
    'service_role',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'service_role can EXECUTE api.marketing_lead_request_create_v1'
);

-- 5) anon cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE api.marketing_lead_request_create_v1'
);

-- 6) authenticated cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE api.marketing_lead_request_create_v1'
);

-- 7) edge_api_gateway_role cannot execute the service-only api wrapper
SELECT ok(
  NOT has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role cannot EXECUTE service-only api.marketing_lead_request_create_v1'
);

-- 8) edge_api_gateway_role can execute public implementation through the api wrapper
SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can EXECUTE public.marketing_lead_request_create_v1'
);

-- 9) task_type_catalog includes marketing_lead_followup (global default)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS t(value)
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = 'marketing_lead_followup'
  ),
  'task_type_catalog includes marketing_lead_followup'
);

-- 10-11) calling lead intake RPC returns ok=true and a task_id (not deduped)
WITH res AS (
  SELECT api.marketing_lead_request_create_v1(
    'lead@example.com',
    'Acme',
    NULL,
    'Ops',
    'Test lead intake.',
    'en',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    NULL,
    TRUE
  ) AS body
)
SELECT ok((body->>'ok') = 'true', 'marketing_lead_request_create_v1 returns ok=true') FROM res;

WITH res AS (
  SELECT api.marketing_lead_request_create_v1(
    'lead2@example.com',
    'Acme',
    NULL,
    'Ops',
    'Test lead intake.',
    'en',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    NULL,
    TRUE
  ) AS body
)
SELECT ok((body->>'task_id') IS NOT NULL, 'marketing_lead_request_create_v1 returns task_id') FROM res;



-- Duplicate identity and recovery are transaction-owned; no fixture is committed.
CREATE FUNCTION pg_temp.marketing_duplicate_recovery_tests() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $marketing_tests$
DECLARE
  v_email TEXT := 'f641-' || gen_random_uuid() || '@example.test';
  v_demo_email TEXT := 'f641-demo-' || gen_random_uuid() || '@example.test';
  v_expired_email TEXT := 'f641-expired-' || gen_random_uuid() || '@example.test';
  v_first JSONB;
  v_second JSONB;
  v_recovered JSONB;
  v_again JSONB;
  v_demo JSONB;
  v_latest_id UUID;
  v_lead_id UUID;
  v_task_id UUID;
  v_policy JSONB;
  v_dedupe_seconds INT;
  v_dispatch_count BIGINT;
BEGIN
  v_policy := public.resolve_settings_merged('marketing_demo_intake_policy', public.get_root_scope_type_key_v1(), NULL::UUID);
  v_dedupe_seconds := COALESCE(NULLIF(v_policy#>>'{dedupe,window_seconds}', '')::INT, 3600);
  IF v_dedupe_seconds <= 0 THEN
    RAISE EXCEPTION 'Marketing duplicate fixture requires seeded dedupe-enabled policy';
  END IF;
  v_first := api.marketing_lead_request_create_v1(v_email, 'F641 owned lead', p_turnstile_verified => TRUE);
  v_lead_id := (v_first->>'id')::UUID;
  v_task_id := (v_first->>'task_id')::UUID;
  RETURN NEXT ok(v_first->>'ok' = 'true' AND v_lead_id IS NOT NULL AND v_task_id IS NOT NULL,
    'new marketing lead returns canonical lead and task identities');
  SELECT count(*) INTO v_dispatch_count FROM public.workflow_binding_dispatches
   WHERE resource_type='marketing_lead_request' AND resource_id=v_lead_id;
  v_second := api.marketing_lead_request_create_v1('  ' || v_email || '  ', 'F641 duplicate', p_turnstile_verified => TRUE);
  RETURN NEXT is(v_second->>'deduped', 'true', 'trimmed duplicate is marked deduped');
  RETURN NEXT is(v_second->>'id', v_first->>'id', 'duplicate returns the exact existing lead id');
  RETURN NEXT is(v_second->>'task_id', v_first->>'task_id', 'duplicate returns the exact existing task id');
  RETURN NEXT is(v_second->>'workflow_run_id', v_first->>'workflow_run_id', 'duplicate preserves existing task workflow reference');
  RETURN NEXT ok(EXISTS(
    SELECT 1 FROM public.tasks t JOIN public.task_types tt ON tt.id=t.task_type_id
     WHERE t.id=(v_second->>'task_id')::UUID AND t.resource_type='marketing_lead_request'
       AND t.resource_id=v_lead_id AND t.organization_id=tt.organization_id
       AND tt.key=COALESCE(NULLIF(lower(btrim(v_policy#>>'{task,task_type_key}')), ''), 'marketing_lead_followup')
       AND t.idempotency_key=format('marketing_lead_followup:%s', v_lead_id)
  ), 'duplicate task is the persisted canonical scoped follow-up');
  RETURN NEXT is((SELECT count(*) FROM public.workflow_binding_dispatches
    WHERE resource_type='marketing_lead_request' AND resource_id=v_lead_id),
    v_dispatch_count, 'existing duplicate task causes no new binding dispatch');

  DELETE FROM public.tasks WHERE id=v_task_id AND resource_type='marketing_lead_request' AND resource_id=v_lead_id;
  RETURN NEXT is((SELECT count(*) FROM public.tasks WHERE id=v_task_id), 0::BIGINT,
    'only the transaction-owned follow-up is removed for recovery');
  v_recovered := api.marketing_lead_request_create_v1(v_email, 'F641 repair', p_turnstile_verified => TRUE);
  RETURN NEXT ok(v_recovered->>'ok'='true' AND v_recovered->>'deduped'='true'
      AND v_recovered->>'id'=v_first->>'id'
      AND (v_recovered->>'task_id')::UUID IS DISTINCT FROM v_task_id,
    'missing-task duplicate recovers a new task without creating a lead');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.tasks t
    WHERE t.id=(v_recovered->>'task_id')::UUID AND t.resource_id=v_lead_id
      AND t.resource_type='marketing_lead_request'
      AND t.idempotency_key=format('marketing_lead_followup:%s', v_lead_id)),
    'repair preserves stable canonical task idempotency');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.workflow_binding_dispatches d
    WHERE d.id=(v_recovered->>'dispatch_id')::UUID
      AND d.workflow_run_id=(v_recovered->>'binding_workflow_run_id')::UUID
      AND d.resource_id=v_lead_id AND d.resource_type='marketing_lead_request'
      AND d.binding_key='marketing_lead' AND d.stage_key='review_requested'
      AND d.outcome='completed'
      AND d.idempotency_key LIKE format('marketing_lead_followup:%s:repair:%%', v_lead_id)),
    'repair uses one fresh completed canonical binding dispatch');
  RETURN NEXT is((SELECT count(*) FROM public.marketing_demo_requests WHERE email=v_email), 1::BIGINT,
    'duplicate recovery retains exactly one lead');
  v_again := api.marketing_lead_request_create_v1(v_email, 'F641 repeated repair', p_turnstile_verified => TRUE);
  RETURN NEXT is(v_again->>'task_id', v_recovered->>'task_id', 'repeated recovery reuses the repaired task');
  RETURN NEXT is((SELECT count(*) FROM public.workflow_binding_dispatches
    WHERE resource_type='marketing_lead_request' AND resource_id=v_lead_id),
    v_dispatch_count+1, 'repeated recovery does not create another repair dispatch');

  INSERT INTO public.marketing_demo_requests(email, company, created_at)
  VALUES(v_demo_email, 'F641 deterministic one', now()), (v_demo_email, 'F641 deterministic two', now());
  SELECT id INTO v_latest_id FROM public.marketing_demo_requests WHERE email=v_demo_email
   ORDER BY created_at DESC, id DESC LIMIT 1;
  v_demo := api.marketing_demo_request_create_v1(v_demo_email, 'F641 deterministic', p_turnstile_verified => TRUE);
  RETURN NEXT is(v_demo->>'id', v_latest_id::TEXT, 'demo duplicate deterministically chooses latest timestamp and id');
  v_demo := api.marketing_demo_request_create_v1(' ' || v_demo_email || ' ', 'F641 trim', p_turnstile_verified => TRUE);
  RETURN NEXT is(v_demo->>'id', v_latest_id::TEXT, 'demo duplicate retains btrim email identity');
  v_demo := api.marketing_demo_request_create_v1(upper(v_demo_email), 'F641 case', p_turnstile_verified => TRUE);
  RETURN NEXT ok(v_demo->>'ok'='true' AND NOT COALESCE((v_demo->>'deduped')::BOOLEAN, FALSE)
    AND (v_demo->>'id')::UUID IS DISTINCT FROM v_latest_id, 'demo email matching remains case-sensitive');
  INSERT INTO public.marketing_demo_requests(email, company, created_at)
  VALUES(v_expired_email, 'F641 expired', now()-make_interval(secs=>v_dedupe_seconds+1));
  v_demo := api.marketing_demo_request_create_v1(v_expired_email, 'F641 new window', p_turnstile_verified => TRUE);
  RETURN NEXT ok(v_demo->>'ok'='true' AND NOT COALESCE((v_demo->>'deduped')::BOOLEAN, FALSE),
    'demo policy window excludes expired identities');
  PERFORM public.upsert_settings_value_v1('marketing_demo_intake_policy',
    public.get_root_scope_type_key_v1(), NULL::UUID,
    jsonb_set(v_policy, '{dedupe,window_seconds}', '0'::JSONB), 1, 'Rollback-only F641 dedupe-disabled fixture');
  v_first := api.marketing_demo_request_create_v1(v_demo_email, 'F641 dedupe off one', p_turnstile_verified => TRUE);
  v_second := api.marketing_demo_request_create_v1(v_demo_email, 'F641 dedupe off two', p_turnstile_verified => TRUE);
  RETURN NEXT ok(v_first->>'ok'='true' AND v_second->>'ok'='true'
    AND v_first->>'id' IS DISTINCT FROM v_second->>'id', 'disabled dedupe keeps independent submissions');
  RETURN NEXT ok(NOT COALESCE((v_first->>'deduped')::BOOLEAN, FALSE)
    AND NOT COALESCE((v_second->>'deduped')::BOOLEAN, FALSE), 'disabled dedupe never claims duplicate reuse');
  PERFORM public.upsert_settings_value_v1('marketing_demo_intake_policy',
    public.get_root_scope_type_key_v1(), NULL::UUID, v_policy, 1, 'Restore rollback-only F641 fixture policy');
END;
$marketing_tests$;

SELECT * FROM pg_temp.marketing_duplicate_recovery_tests();

-- 11-15) A disabled binding must abort and roll back every scoped artifact.
UPDATE public.workflow_binding_stage_registry
   SET is_enabled = FALSE
 WHERE binding_key = 'marketing_lead'
   AND stage_key = 'review_requested';

SELECT throws_ok(
  $$SELECT public.marketing_lead_request_create_v1(
    'atomic-disabled@example.test', 'Atomic disabled', NULL, 'Ops', NULL, 'en',
    NULL, NULL, NULL, '{}'::jsonb, NULL, TRUE
  )$$,
  'P0001',
  'marketing_lead_followup_atomicity_failed',
  'disabled marketing binding aborts the complete lead statement'
);

SELECT is(
  (SELECT count(*) FROM public.marketing_demo_requests WHERE lower(email) = 'atomic-disabled@example.test'),
  0::bigint,
  'disabled binding leaves zero marketing lead rows'
);
SELECT is(
  (SELECT count(*) FROM public.workflow_runs
    WHERE context #>> '{binding_payload,task,metadata,email}' = 'atomic-disabled@example.test'),
  0::bigint,
  'disabled binding leaves zero workflow rows'
);
SELECT is(
  (SELECT count(*) FROM public.workflow_binding_dispatches
    WHERE context #>> '{binding_payload,task,metadata,email}' = 'atomic-disabled@example.test'),
  0::bigint,
  'disabled binding leaves zero dispatch rows'
);
SELECT is(
  (SELECT count(*) FROM public.tasks WHERE metadata->>'email' = 'atomic-disabled@example.test'),
  0::bigint,
  'disabled binding leaves zero task rows'
);

UPDATE public.workflow_binding_stage_registry
   SET is_enabled = TRUE
 WHERE binding_key = 'marketing_lead'
   AND stage_key = 'review_requested';

-- 16-20) A handler failure must also abort and roll back every scoped artifact.
UPDATE public.workflow_template_steps
   SET metadata = jsonb_set(
     COALESCE(metadata, '{}'::jsonb),
     '{task_path}',
     to_jsonb('$.context.binding_payload.missing'::text),
     TRUE
   )
 WHERE workflow_template_id = '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a106'::uuid;

SELECT throws_ok(
  $$SELECT public.marketing_lead_request_create_v1(
    'atomic-handler@example.test', 'Atomic handler', NULL, 'Ops', NULL, 'en',
    NULL, NULL, NULL, '{}'::jsonb, NULL, TRUE
  )$$,
  'P0001',
  'marketing_lead_followup_atomicity_failed',
  'failed marketing task handler aborts the complete lead statement'
);

SELECT is(
  (SELECT count(*) FROM public.marketing_demo_requests WHERE lower(email) = 'atomic-handler@example.test'),
  0::bigint,
  'handler failure leaves zero marketing lead rows'
);
SELECT is(
  (SELECT count(*) FROM public.workflow_runs
    WHERE context #>> '{binding_payload,task,metadata,email}' = 'atomic-handler@example.test'),
  0::bigint,
  'handler failure leaves zero workflow rows'
);
SELECT is(
  (SELECT count(*) FROM public.workflow_binding_dispatches
    WHERE context #>> '{binding_payload,task,metadata,email}' = 'atomic-handler@example.test'),
  0::bigint,
  'handler failure leaves zero dispatch rows'
);
SELECT is(
  (SELECT count(*) FROM public.tasks WHERE metadata->>'email' = 'atomic-handler@example.test'),
  0::bigint,
  'handler failure leaves zero task rows'
);

SELECT finish();

ROLLBACK;
