-- pgTAP: exposed workflow progression is scope-aware, capability-gated, and worker-private.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(42);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.workflow_templates'::regclass
      AND c.conname = 'workflow_templates_scope_type_id_shape_ck'
      AND c.contype = 'c'
  ),
  'workflow_templates has canonical scope type/id shape constraint'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts lc
    WHERE lc.table_schema = 'public'
      AND lc.table_name = 'workflow_templates'
      AND lc.column_name = 'scope_type'
      AND lc.lookup_category = 'scope_type'
      AND cardinality(lc.allowed_values) = 4
      AND lc.allowed_values @> ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]
      AND lc.allowed_values <@ ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]
  )
  AND NOT public.constraint_has_literal_allowlist_v1(
    (
      SELECT pg_get_constraintdef(c.oid)
      FROM pg_constraint c
      WHERE c.conrelid = 'public.workflow_templates'::regclass
        AND c.conname = 'workflow_templates_scope_type_id_shape_ck'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.workflow_template_scope_contract_valid_v1(text,uuid)'
    )
      AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0
          AND a.privilege_type = 'EXECUTE'
      )
  )
  AND has_function_privilege(
    'authenticated',
    'public.workflow_template_scope_contract_valid_v1(text,uuid)',
    'EXECUTE'
  )
  AND pg_get_functiondef(
    to_regprocedure('public.workflow_template_scope_contract_valid_v1(text,uuid)')
  ) ~ 'lookup_column_contracts'
  AND pg_get_functiondef(
    to_regprocedure('public.workflow_template_scope_contract_valid_v1(text,uuid)')
  ) ~ 'scope_type_registry'
  AND pg_get_functiondef(
    to_regprocedure('public.workflow_template_scope_contract_valid_v1(text,uuid)')
  ) ~* 'r\.is_enabled\s*=\s*true'
  AND pg_get_functiondef(to_regprocedure('public.workflow_template_scope_allowed(text,uuid)'))
    ~ 'workflow_template_scope_contract_valid_v1',
  'workflow template scope validation is lookup-backed and contains no literal constraint allowlist'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.run_workflow_engine_worker()'::regprocedure
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute run_workflow_engine_worker'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.run_workflow_engine_worker()', 'EXECUTE'),
  'anon cannot execute run_workflow_engine_worker'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.run_workflow_engine_worker()', 'EXECUTE'),
  'authenticated cannot execute run_workflow_engine_worker'
);
SELECT ok(
  NOT has_function_privilege('service_role', 'public.run_workflow_engine_worker()', 'EXECUTE'),
  'service_role cannot execute run_workflow_engine_worker'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)'::regprocedure
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute the internal workflow progress helper'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'anon cannot execute the internal workflow progress helper'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot execute the internal workflow progress helper'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'service_role retains the internal workflow progress helper'
);
SELECT ok(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
      has_function_privilege(
        'edge_label_renderer_role',
        'public.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)',
        'EXECUTE'
      )
    ELSE TRUE
  END,
  'existing edge label renderer access is preserved when the role exists'
);
SELECT is(
  (
    SELECT col_description(
      'public.workflow_templates'::regclass,
      a.attnum
    )
    FROM pg_attribute a
    WHERE a.attrelid = 'public.workflow_templates'::regclass
      AND a.attname = 'scope_type'
  ),
  'Canonical values: global, tenant, client, sender.',
  'workflow_templates.scope_type comment names exactly the canonical values'
);

DO $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sibling_client UUID := gen_random_uuid();
  v_foreign_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_sibling_sender UUID := gen_random_uuid();
  v_foreign_sender UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();
  v_ops_user UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_sender_user UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_client_template UUID := gen_random_uuid();
  v_global_template UUID := gen_random_uuid();
  v_foreign_template UUID := gen_random_uuid();
  v_sibling_client_template UUID := gen_random_uuid();
  v_sibling_sender_template UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_foreign_run UUID := gen_random_uuid();
  v_contextless_run UUID := gen_random_uuid();
  v_missing_run UUID := gen_random_uuid();
  v_inconsistent_run UUID := gen_random_uuid();
  v_template_scope_run UUID := gen_random_uuid();
  v_missing_template UUID := gen_random_uuid();
  v_result JSONB;
  v_result_run UUID;
  v_producer_context JSONB;
  v_command_template UUID;
  v_foreign_before TEXT;
  v_foreign_after TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'Workflow access org', 'workflow-access-' || left(v_org::TEXT, 8)),
    (v_foreign_org, 'Workflow access foreign org', 'workflow-access-foreign-' || left(v_foreign_org::TEXT, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status) VALUES
    (v_client, v_org, 'Workflow access client', 'workflow-access-client-' || left(v_client::TEXT, 8), 'active'),
    (v_sibling_client, v_org, 'Workflow access sibling client', 'workflow-access-sibling-client-' || left(v_sibling_client::TEXT, 8), 'active'),
    (v_foreign_client, v_foreign_org, 'Workflow access foreign client', 'workflow-access-foreign-client-' || left(v_foreign_client::TEXT, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, status) VALUES
    (v_sender, v_client, 'Workflow access sender', 'active'),
    (v_sibling_sender, v_client, 'Workflow access sibling sender', 'active'),
    (v_foreign_sender, v_foreign_client, 'Workflow access foreign sender', 'active');

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id
  ) VALUES
    (v_client_user, v_org, 'workflow-access-client-' || left(v_client_user::TEXT, 8) || '@example.test', 'Workflow Access Client', 'client_admin', 'client', v_client),
    (v_ops_user, v_org, 'workflow-access-ops-' || left(v_ops_user::TEXT, 8) || '@example.test', 'Workflow Access Ops', 'ops_admin', 'tenant', NULL),
    (v_platform_user, v_org, 'workflow-access-platform-' || left(v_platform_user::TEXT, 8) || '@example.test', 'Workflow Access Platform', 'super_admin', 'platform', NULL),
    (v_sender_user, v_org, 'workflow-access-sender-' || left(v_sender_user::TEXT, 8) || '@example.test', 'Workflow Access Sender', 'super_admin', 'sender', v_sender);

  INSERT INTO public.workflow_templates (
    id, name, description, version, status, scope_type, scope_id
  ) VALUES
    (v_template, 'workflow_access_' || left(v_template::TEXT, 8), 'pgTAP workflow access', 1, 'active', 'tenant', v_org),
    (v_client_template, 'workflow_access_client_' || left(v_client_template::TEXT, 8), 'pgTAP client workflow access', 1, 'active', 'client', v_client),
    (v_global_template, 'workflow_access_global_' || left(v_global_template::TEXT, 8), 'pgTAP global workflow access', 1, 'active', 'global', NULL),
    (v_foreign_template, 'workflow_access_foreign_' || left(v_foreign_template::TEXT, 8), 'pgTAP foreign workflow access', 1, 'active', 'tenant', v_foreign_org),
    (v_sibling_client_template, 'workflow_access_sibling_client_' || left(v_sibling_client_template::TEXT, 8), 'pgTAP sibling client workflow access', 1, 'active', 'client', v_sibling_client),
    (v_sibling_sender_template, 'workflow_access_sibling_sender_' || left(v_sibling_sender_template::TEXT, 8), 'pgTAP sibling sender workflow access', 1, 'active', 'sender', v_sibling_sender);

  PERFORM set_config('app.workflow_run_id', v_run::TEXT, TRUE);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata, completed_at
  ) VALUES (
    v_run, v_client_template, 1, 'test', 'completed',
    jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
    jsonb_build_object('fixture', 'own'), now()
  );

  PERFORM set_config('app.workflow_run_id', v_foreign_run::TEXT, TRUE);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata, completed_at
  ) VALUES (
    v_foreign_run, v_foreign_template, 1, 'test', 'completed',
    jsonb_build_object('organization_id', v_foreign_org, 'client_id', v_foreign_client, 'sender_id', v_foreign_sender),
    jsonb_build_object('fixture', 'foreign'), now()
  );

  PERFORM set_config('app.workflow_run_id', v_inconsistent_run::TEXT, TRUE);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata, completed_at
  ) VALUES (
    v_inconsistent_run, v_template, 1, 'test', 'completed',
    jsonb_build_object('organization_id', v_foreign_org, 'client_id', v_client, 'sender_id', v_sender),
    jsonb_build_object('fixture', 'inconsistent'), now()
  );

  PERFORM set_config('app.workflow_run_id', v_template_scope_run::TEXT, TRUE);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata, completed_at
  ) VALUES (
    v_template_scope_run, v_foreign_template, 1, 'test', 'completed',
    jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
    jsonb_build_object('fixture', 'foreign_template'), now()
  );

  PERFORM set_config('app.workflow_run_id', v_contextless_run::TEXT, TRUE);
  INSERT INTO public.workflow_runs (
    id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, metadata, completed_at
  ) VALUES (
    v_contextless_run, v_global_template, 1, 'test', 'completed',
    '{}'::JSONB,
    jsonb_build_object('fixture', 'contextless'), now()
  );

  SELECT md5(to_jsonb(wr)::TEXT)
    INTO v_foreign_before
    FROM public.workflow_runs wr
   WHERE wr.id = v_foreign_run;

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_client_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_run
    ),
    'same-scope authenticated caller can passively progress a run'
  );

  PERFORM throws_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_foreign_run
    ),
    '42501',
    'workflow progress access denied',
    'foreign workflow run is denied generically'
  );

  EXECUTE 'RESET ROLE';
  SELECT md5(to_jsonb(wr)::TEXT)
    INTO v_foreign_after
    FROM public.workflow_runs wr
   WHERE wr.id = v_foreign_run;
  PERFORM is(v_foreign_after, v_foreign_before, 'foreign run is not mutated after denial');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM throws_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_missing_run
    ),
    '42501',
    'workflow progress access denied',
    'missing workflow run is denied with the same generic error'
  );
  PERFORM throws_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_inconsistent_run
    ),
    '42501',
    'workflow progress access denied',
    'inconsistent workflow lineage is denied generically'
  );
  PERFORM throws_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_template_scope_run
    ),
    '42501',
    'workflow progress access denied',
    'own-lineage run backed by a foreign template is denied generically'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_foreign_run
    ),
    'claim-aware service caller is preserved'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_platform_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_contextless_run
    ),
    'platform caller can passively progress an existing contextless global run'
  );
  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{"source":"platform"}'::JSONB, 25, 1);$sql$,
      v_foreign_run
    ),
    'platform caller can explicitly progress an existing cross-tenant run'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_client_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM throws_ok(
    format(
      $sql$SELECT public.ui_start_workflow_run_v1('%s'::UUID, '{}'::JSONB, TRUE);$sql$,
      v_missing_template
    ),
    '42501',
    'workflow template access denied',
    'ui_start_workflow_run_v1 hides missing template existence'
  );
  PERFORM throws_ok(
    format(
      $sql$SELECT public.ui_start_workflow_run_v1('%s'::UUID, '{}'::JSONB, TRUE);$sql$,
      v_foreign_template
    ),
    '42501',
    'workflow template access denied',
    'ui_start_workflow_run_v1 hides foreign template existence'
  );
  PERFORM throws_ok(
    format(
      $sql$SELECT public.ui_start_workflow_run_v1('%s'::UUID, '{}'::JSONB, TRUE);$sql$,
      v_sibling_client_template
    ),
    '42501',
    'workflow template access denied',
    'client caller cannot start a sibling-client template'
  );
  v_result := public.ui_start_workflow_run_v1(
    v_client_template,
    jsonb_build_object('fixture', 'ui_start'),
    TRUE
  );
  EXECUTE 'RESET ROLE';
  v_result_run := (v_result->>'workflow_run_id')::UUID;
  SELECT wr.context
    INTO v_producer_context
    FROM public.workflow_runs wr
   WHERE wr.id = v_result_run;
  PERFORM is(
    v_producer_context->>'client_id',
    v_client::TEXT,
    'ui_start_workflow_run_v1 stamps current client lineage'
  );
  PERFORM ok(
    NOT (v_producer_context ? 'sender_id'),
    'ui_start_workflow_run_v1 strips absent sender lineage'
  );

  PERFORM set_config('request.jwt.claim.sub', v_sender_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM throws_ok(
    format(
      $sql$SELECT public.ui_start_workflow_run_v1('%s'::UUID, '{}'::JSONB, TRUE);$sql$,
      v_sibling_sender_template
    ),
    '42501',
    'workflow template access denied',
    'sender caller cannot start a sibling-sender template'
  );
  v_result := public.ui_execute_command_v1(
    'shipments.print_labels',
    'shipments',
    ARRAY[gen_random_uuid()::TEXT],
    NULL,
    1,
    '{"workflow_start":{"inline_kick_enabled":false}}'::JSONB
  );
  EXECUTE 'RESET ROLE';
  v_result_run := (v_result->>'workflow_run_id')::UUID;
  SELECT wr.context, wr.workflow_template_id
    INTO v_producer_context, v_command_template
    FROM public.workflow_runs wr
   WHERE wr.id = v_result_run;
  PERFORM is(
    v_producer_context->>'client_id',
    v_client::TEXT,
    'ui_execute_command_v1 bulk print stamps current client lineage'
  );
  PERFORM is(
    v_producer_context->>'sender_id',
    v_sender::TEXT,
    'ui_execute_command_v1 bulk print stamps current sender lineage'
  );

  UPDATE public.workflow_templates
     SET scope_type = 'tenant', scope_id = v_foreign_org
   WHERE id = v_command_template;
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_sender_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM throws_ok(
    $sql$SELECT public.ui_execute_command_v1(
      'shipments.print_labels', 'shipments', ARRAY[gen_random_uuid()::TEXT], NULL, 1,
      '{"workflow_start":{"inline_kick_enabled":false}}'::JSONB
    );$sql$,
    '42501',
    'workflow template access denied',
    'ui_execute_command_v1 denies a foreign referenced template generically'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);

  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'sender',
    v_sender,
    jsonb_build_object(
      'denies',
      jsonb_build_array(
        jsonb_build_object(
          'capability_key', 'workflow_runs.write',
          'scope_type', 'sender',
          'scope_id', v_sender::TEXT,
          'reason', 'pgTAP read-only workflow poll'
        )
      )
    ),
    1,
    'pgTAP workflow progression read/write split'
  );
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';

  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_client_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(
    public.user_has_capability_v1('workflow_runs.read', 'sender', v_sender),
    'read-only fixture retains workflow_runs.read'
  );
  PERFORM ok(
    NOT public.user_has_capability_v1('workflow_runs.write', 'sender', v_sender),
    'read-only fixture denies workflow_runs.write'
  );
  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{}'::JSONB, 25, 1);$sql$,
      v_run
    ),
    'empty operation result requires read capability only'
  );
  PERFORM throws_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{"source":"explicit"}'::JSONB, 25, 1);$sql$,
      v_run
    ),
    '42501',
    'Capability denied: workflow_runs.write',
    'nonempty operation result requires write capability'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'sender',
    v_sender,
    jsonb_build_object('denies', '[]'::JSONB),
    2,
    'pgTAP restore write-capable workflow progression'
  );
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_ops_user::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM lives_ok(
    format(
      $sql$SELECT api.progress_workflow_run_until_wait_v1('%s'::UUID, '{"source":"explicit"}'::JSONB, 25, 1);$sql$,
      v_run
    ),
    'write-capable same-tenant caller can submit explicit operation result'
  );

  PERFORM ok(NOT public.workflow_template_scope_allowed('', NULL), 'blank scope is rejected');
  PERFORM ok(NOT public.workflow_template_scope_allowed(' tenant', v_org), 'whitespace scope is rejected');
  PERFORM ok(NOT public.workflow_template_scope_allowed('GLOBAL', NULL), 'uppercase scope is rejected');
  PERFORM ok(NOT public.workflow_template_scope_allowed('global', v_org), 'global scope with id is rejected');
  PERFORM ok(NOT public.workflow_template_scope_allowed('tenant', NULL), 'tenant scope without id is rejected');
  EXECUTE 'RESET ROLE';

  PERFORM throws_ok(
    format(
      $sql$INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id) VALUES ('invalid_scope_%s', 'pgTAP invalid', 1, 'draft', ' tenant', '%s'::UUID);$sql$,
      left(gen_random_uuid()::TEXT, 8),
      v_org
    ),
    '23514',
    'Invalid lookup value for public.workflow_templates.scope_type: " tenant" is not an allowed value for category "scope_type"',
    'whitespace-padded template scope is rejected by the lookup contract'
  );
  PERFORM throws_ok(
    format(
      $sql$INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id) VALUES ('invalid_global_%s', 'pgTAP invalid', 1, 'draft', 'global', '%s'::UUID);$sql$,
      left(gen_random_uuid()::TEXT, 8),
      v_org
    ),
    '23514',
    'new row for relation "workflow_templates" violates check constraint "workflow_templates_scope_type_id_shape_ck"',
    'global template scope with id is rejected by the constraint'
  );
END;
$test$;

SELECT * FROM finish();
ROLLBACK;
