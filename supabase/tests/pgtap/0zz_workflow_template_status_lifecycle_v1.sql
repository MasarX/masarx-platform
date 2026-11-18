BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(20);
SELECT has_function('public', 'ui_set_workflow_template_status_v1', ARRAY['uuid','text','text'],
  'public workflow template status seam exists');
SELECT has_function('api', 'ui_set_workflow_template_status_v1', ARRAY['uuid','text','text'],
  'browser API workflow template status seam exists');
SELECT function_privs_are('public', 'ui_set_workflow_template_status_v1',
  ARRAY['uuid','text','text'], 'authenticated', ARRAY['EXECUTE'],
  'authenticated may execute only the dedicated public seam');
SELECT function_privs_are('api', 'ui_set_workflow_template_status_v1',
  ARRAY['uuid','text','text'], 'authenticated', ARRAY['EXECUTE'],
  'authenticated may execute the API seam');
SELECT ok(NOT has_table_privilege('authenticated', 'public.workflow_templates', 'INSERT'),
  'authenticated direct insert is revoked');
SELECT ok(NOT has_table_privilege('authenticated', 'public.workflow_templates', 'UPDATE'),
  'authenticated direct update is revoked');
SELECT ok(NOT has_table_privilege('authenticated', 'public.workflow_templates', 'DELETE'),
  'authenticated direct delete is revoked');
SELECT is((SELECT array_agg(lv.value ORDER BY lv.value)::text FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='workflow_status' AND lv.status='active'),
  ARRAY['active','archived','draft']::text[]::text,
  'canonical lifecycle vocabulary contains only draft active archived');
SELECT throws_ok(
  $$SELECT public.ui_assert_generic_mutation_relation_v1('public.driver_compliance_events'::regclass)$$,
  '42501', 'Compliance events require dedicated append-only RPCs',
  'existing append-only compliance event guard remains enforced');
SELECT throws_ok(
  $$SELECT public.ui_assert_generic_mutation_relation_v1('public.workflow_templates'::regclass)$$,
  '42501', 'Workflow template mutations require dedicated lifecycle RPCs',
  'generic workflow template mutation is denied');
CREATE FUNCTION pg_temp.workflow_template_status_behavior_v1() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_denied UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_other_template UUID := gen_random_uuid();
  v_result JSONB;
  v_first_published TIMESTAMPTZ;
  v_correlation UUID;
  v_decisions BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (v_org,'Workflow Template Lifecycle','workflow-template-lifecycle-'||left(v_org::text,8));
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (v_client,v_org,'Lifecycle Client','lifecycle-client-'||left(v_client::text,8),'active'),
    (v_other_client,v_org,'Other Lifecycle Client','other-lifecycle-'||left(v_other_client::text,8),'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id) VALUES
    (v_operator,v_org,'lifecycle-operator-'||left(v_operator::text,8)||'@example.com','Lifecycle Operator','client_admin','client',v_client),
    (v_denied,v_org,'lifecycle-denied-'||left(v_denied::text,8)||'@example.com','Lifecycle Denied','sender_user','client',v_client);
  INSERT INTO public.workflow_templates(id,name,description,version,status,scope_type,scope_id,created_by) VALUES
    (v_template,'lifecycle_template_'||left(v_template::text,8),'Lifecycle test',1,'draft','client',v_client,v_operator),
    (v_other_template,'other_lifecycle_template_'||left(v_other_template::text,8),'Other lifecycle test',1,'draft','client',v_other_client,v_operator);

  PERFORM set_config('request.jwt.claim.sub',v_operator::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_operator,'role','service_role')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';

  v_result := api.ui_set_workflow_template_status_v1(v_template,'active','publish reviewed template');
  v_correlation := (v_result->>'correlation_id')::uuid;
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT published_at INTO v_first_published FROM public.workflow_templates WHERE id=v_template;
  RETURN NEXT ok(v_result @> '{"changed":true,"previous_status":"draft","next_status":"active"}'::jsonb
    AND v_first_published IS NOT NULL,'draft to active sets the first published timestamp through the API seam');

  SELECT count(*) INTO v_decisions FROM public.decision_log
   WHERE resource_type='workflow_template' AND resource_id=v_template;
  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := public.ui_set_workflow_template_status_v1(v_template,'active','same status');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(v_result @> '{"changed":false}'::jsonb AND v_decisions=(SELECT count(*) FROM public.decision_log WHERE resource_type='workflow_template' AND resource_id=v_template),
    'same status is a no-op with no additional decision evidence');

  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := public.ui_set_workflow_template_status_v1(v_template,'archived','retire reviewed template');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT status='archived' AND retired_at IS NOT NULL AND published_at=v_first_published FROM public.workflow_templates WHERE id=v_template),
    'active to archived sets retired_at and preserves first published_at');

  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := public.ui_set_workflow_template_status_v1(v_template,'draft','reopen as draft');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT status='draft' AND retired_at IS NULL AND published_at=v_first_published FROM public.workflow_templates WHERE id=v_template),
    'archived to draft clears retired_at and preserves first published_at');

  RETURN NEXT ok(
    EXISTS(SELECT 1 FROM public.decision_log WHERE resource_type='workflow_template' AND resource_id=v_template AND correlation_id=v_correlation)
    AND EXISTS(SELECT 1 FROM public.domain_events WHERE resource_type='workflow_template' AND resource_id=v_template AND correlation_id=v_correlation)
    AND EXISTS(SELECT 1 FROM public.audit_table_changes WHERE table_name='workflow_templates' AND pk->>'id'=v_template::text AND correlation_id=v_correlation),
    'decision domain event and row audit share the transition correlation');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.decision_log WHERE resource_type='workflow_template' AND resource_id=v_template
    AND decision_reason='publish reviewed template' AND decision_inputs->>'actor_user_id'=v_operator::text),
    'decision evidence retains the authenticated actor and required reason');

  PERFORM set_config('request.jwt.claim.sub',v_denied::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_denied,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT public.ui_set_workflow_template_status_v1(%L::uuid,%L,%L)',v_template,'draft','denied'),
    '42501','Capability denied: workflow_runs.write','workflow_runs.write is required before template access');

  PERFORM set_config('request.jwt.claim.sub',v_operator::text,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_operator,'role','authenticated')::text,TRUE);
  RETURN NEXT throws_ok(format('SELECT public.ui_set_workflow_template_status_v1(%L::uuid,%L,%L)',v_template,'active','activate'),
    '42501','Capability denied: system.write','activation requires system.write');
  RETURN NEXT throws_ok(format('SELECT public.ui_set_workflow_template_status_v1(%L::uuid,%L,%L)',v_other_template,'draft','inspect foreign scope'),
    'P0002','ui_set_workflow_template_status_v1 template unavailable','out-of-scope templates use a uniform unavailable error');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT count(*)=3 FROM public.decision_log WHERE resource_type='workflow_template' AND resource_id=v_template)
    AND (SELECT count(*)=3 FROM public.domain_events WHERE resource_type='workflow_template' AND resource_id=v_template),
    'three actual transitions create exactly three decisions and three domain events');
END;
$test$;

SELECT * FROM pg_temp.workflow_template_status_behavior_v1();

SELECT * FROM finish();
ROLLBACK;
