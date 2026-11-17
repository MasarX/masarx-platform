const fs = require('fs');
const path = require('path');

const readMigration = (name) =>
  fs.readFileSync(
    path.join(process.cwd(), 'supabase', 'migrations', name),
    'utf8',
  );

const extractDollarFunction = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = sql.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error(`Missing ${name}`);
  return sql.slice(start, end + 4);
};

const replaceExactly = (value, before, after) => {
  const first = value.indexOf(before);
  if (first < 0 || value.indexOf(before, first + 1) >= 0) {
    throw new Error('Expected one producer context block');
  }
  return value.replace(before, after);
};

describe('workflow progress access boundary migration', () => {
  const migration = readMigration(
    '202609041020_workflow_progress_access_boundary_v1.sql',
  );
  const lookupRepair = readMigration(
    '202609041100_final_qualification_lookup_contract_repairs_v1.sql',
  );
  const uiStartSource = readMigration(
    '202601192200_ui_start_workflow_run_v1.sql',
  );
  const uiCommandSource = readMigration(
    '202604061940_b07_uc085_route_closeout_v1.sql',
  );
  const bulkActions = fs.readFileSync(
    path.join(process.cwd(), 'packages', 'ui', 'src', 'bulk-actions.tsx'),
    'utf8',
  );

  test('locks and rejects noncanonical workflow template scopes before adding the exact shape constraint', () => {
    const transactionLock = migration.indexOf(
      "SELECT pg_advisory_xact_lock(hashtext('202609041020_workflow_progress_access_boundary_v1'));",
    );
    expect(migration.indexOf("SET LOCAL lock_timeout = '30s';")).toBeLessThan(
      transactionLock,
    );
    expect(
      migration.indexOf(
        'SET LOCAL search_path TO public, extensions, pg_temp;',
      ),
    ).toBeLessThan(transactionLock);
    expect(migration).not.toContain('pg_advisory_lock(');
    expect(migration).not.toContain('pg_advisory_unlock(');
    expect(migration).toContain(
      'LOCK TABLE public.workflow_templates IN SHARE ROW EXCLUSIVE MODE;',
    );
    expect(migration).toMatch(
      /workflow_templates wt[\s\S]+\) IS NOT TRUE[\s\S]+workflow_templates contains invalid legacy scope rows/,
    );
    expect(migration).toContain(
      'ADD CONSTRAINT workflow_templates_scope_type_id_shape_ck',
    );
    expect(migration).toContain("scope_type = 'global' AND scope_id IS NULL");
    expect(migration).toContain(
      "scope_type IN ('tenant', 'client', 'sender') AND scope_id IS NOT NULL",
    );
    expect(migration).toContain(
      "IS 'Canonical values: global, tenant, client, sender.';",
    );
  });

  test('repairs workflow scope validation through the lookup registry', () => {
    expect(lookupRepair).toMatch(
      /'public',\s*'workflow_templates',\s*'scope_type',\s*'scope_type'/,
    );
    expect(lookupRepair).toContain(
      "ARRAY['global', 'tenant', 'client', 'sender']::TEXT[]",
    );
    expect(lookupRepair).toContain(
      "SELECT public.apply_lookup_column_contracts('public');",
    );
    expect(lookupRepair).toContain(
      'DROP CONSTRAINT IF EXISTS workflow_templates_scope_type_id_shape_ck',
    );
    expect(lookupRepair).toContain(
      'public.workflow_template_scope_contract_valid_v1(',
    );
    expect(lookupRepair).toContain('public.scope_type_registry');
    expect(lookupRepair).toContain('AND r.is_enabled = TRUE');
    expect(lookupRepair).not.toContain('public.lookup_value_meta_bool(');
    const repairedScopeFunction = lookupRepair.match(
      /CREATE OR REPLACE FUNCTION public\.workflow_template_scope_allowed[\s\S]+?\$function\$;/,
    )?.[0];
    expect(repairedScopeFunction).toBeTruthy();
    expect(repairedScopeFunction).toContain('workflow_template_scope_contract_valid_v1');
    expect(repairedScopeFunction).not.toContain("p_scope_type IN ('tenant', 'client', 'sender')");
  });

  test('keeps scope authorization exact without normalizing malformed inputs', () => {
    const scopeFunction = migration.match(
      /CREATE OR REPLACE FUNCTION public\.workflow_template_scope_allowed[\s\S]+?\$function\$;/,
    )?.[0];
    expect(scopeFunction).toBeTruthy();
    expect(scopeFunction).not.toMatch(/lower\([^)]*p_scope_type/);
    expect(scopeFunction).not.toMatch(/btrim\([^)]*p_scope_type/);
    expect(scopeFunction).not.toMatch(/COALESCE\([^)]*p_scope_type/);
    expect(scopeFunction).toContain(') IS NOT TRUE THEN');
  });

  test('locks the run before claim-aware service, platform, or exact-lineage authorization', () => {
    const apiFunction = migration.match(
      /CREATE OR REPLACE FUNCTION api\.progress_workflow_run_until_wait_v1[\s\S]+?\$function\$;/,
    )?.[0];
    expect(apiFunction).toBeTruthy();
    expect(apiFunction).toMatch(
      /SELECT wr\.context, wt\.scope_type, wt\.scope_id[\s\S]+JOIN public\.workflow_templates wt ON wt\.id = wr\.workflow_template_id[\s\S]+FOR UPDATE OF wr;/,
    );
    expect(apiFunction.indexOf('FOR UPDATE OF wr;')).toBeLessThan(
      apiFunction.indexOf('IF NOT v_is_service THEN'),
    );
    expect(apiFunction).toContain(
      'v_is_service BOOLEAN := public.request_role_is_service_v1();',
    );
    expect(apiFunction).toContain(
      'v_is_platform BOOLEAN := public.is_platform_user();',
    );
    expect(apiFunction).toMatch(
      /'workflow_runs\.read',[\s\S]+public\.get_root_scope_type_key_v1\(\),[\s\S]+NULL/,
    );
    expect(apiFunction).toMatch(
      /'workflow_runs\.write',[\s\S]+public\.get_root_scope_type_key_v1\(\),[\s\S]+NULL/,
    );
    expect(apiFunction).toMatch(
      /IF NOT public\.workflow_template_scope_allowed\(v_template_scope_type, v_template_scope_id\) THEN\s+RAISE EXCEPTION 'workflow progress access denied' USING ERRCODE = '42501';/,
    );
    expect(
      apiFunction.indexOf(
        'public.workflow_template_scope_allowed(v_template_scope_type, v_template_scope_id)',
      ),
    ).toBeLessThan(
      apiFunction.indexOf("public.assert_capability_v1('workflow_runs.read'"),
    );
    expect(apiFunction).toContain(
      "public.assert_capability_v1('workflow_runs.read', v_target_type, v_target_id)",
    );
    expect(apiFunction).toContain(
      "public.assert_capability_v1('workflow_runs.write', v_target_type, v_target_id)",
    );
  });

  test('preserves both producer bodies except exact template scope checks and strip-null lineage', () => {
    const startBefore = `  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  );`;
    const startAfter = `${startBefore.slice(0, -1)} || jsonb_strip_nulls(jsonb_build_object(
    'client_id', public.current_user_client_id(),
    'sender_id', public.current_user_sender_id()
  ));`;
    const startExpected = [
      [
        '  v_scope_id UUID := public.current_user_scope_id();',
        `  v_scope_id UUID := public.current_user_scope_id();
  v_is_service BOOLEAN := public.request_role_is_service_v1();`,
      ],
      [
        "  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);",
        `  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  IF NOT v_is_service AND NOT EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.id = p_workflow_template_id
      AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
  ) THEN
    RAISE EXCEPTION 'workflow template access denied' USING ERRCODE = '42501';
  END IF;`,
      ],
      [startBefore, startAfter],
    ].reduce(
      (value, [before, after]) => replaceExactly(value, before, after),
      extractDollarFunction(uiStartSource, 'public.ui_start_workflow_run_v1'),
    );
    const commandBefore = `    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    );`;
    const commandAfter = `${commandBefore.slice(0, -1)} || jsonb_strip_nulls(jsonb_build_object(
      'client_id', public.current_user_client_id(),
      'sender_id', public.current_user_sender_id()
    ));`;
    const commandTemplateBefore = `    SELECT id INTO v_template_id
      FROM public.workflow_templates
     WHERE name = v_command->>'workflow_key'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;`;
    const commandTemplateAfter = `    SELECT wt.id, wt.scope_type, wt.scope_id
      INTO v_template_id, v_template_scope_type, v_template_scope_id
      FROM public.workflow_templates wt
     WHERE wt.name = v_command->>'workflow_key'
       AND wt.status = 'active'
     ORDER BY wt.version DESC
     LIMIT 1;

    IF v_template_id IS NULL AND v_is_service THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    IF v_template_id IS NULL OR (
      NOT v_is_service
      AND NOT public.workflow_template_scope_allowed(v_template_scope_type, v_template_scope_id)
    ) THEN
      RAISE EXCEPTION 'workflow template access denied' USING ERRCODE = '42501';
    END IF;`;
    const commandExpected = [
      [
        '  v_scope_id UUID := public.current_user_scope_id();',
        `  v_scope_id UUID := public.current_user_scope_id();
  v_is_service BOOLEAN := public.request_role_is_service_v1();`,
      ],
      [
        '  v_template_id UUID;',
        `  v_template_id UUID;
  v_template_scope_type TEXT;
  v_template_scope_id UUID;`,
      ],
      [commandTemplateBefore, commandTemplateAfter],
      [commandBefore, commandAfter],
    ].reduce(
      (value, [before, after]) => replaceExactly(value, before, after),
      extractDollarFunction(uiCommandSource, 'public.ui_execute_command_v1'),
    );

    expect(
      extractDollarFunction(migration, 'public.ui_start_workflow_run_v1'),
    ).toBe(startExpected);
    expect(
      extractDollarFunction(migration, 'public.ui_execute_command_v1'),
    ).toBe(commandExpected);
  });
  test('propagates authorization errors and seals public worker ACLs', () => {
    expect(migration).toMatch(/WHEN SQLSTATE '42501' THEN\s+RAISE;/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.progress_workflow_run_until_wait_v1[\s\S]+FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.progress_workflow_run_until_wait_v1[\s\S]+TO service_role;/,
    );
    expect(migration).toContain("rolname = 'edge_label_renderer_role'");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.run_workflow_engine_worker\(\)[\s\S]+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION api\.progress_workflow_run_until_wait_v1[\s\S]+TO authenticated, service_role;/,
    );
  });

  test('keeps passive print polls free of synthetic operation results and propagates SQL authorization errors', () => {
    expect(bulkActions).not.toContain('ui.print.poll');
    expect(bulkActions).toContain(
      'if (String(code ?? "").trim() === "42501") {',
    );
    expect(bulkActions).toMatch(
      /if \(String\(code \?\? ""\)\.trim\(\) === "42501"\) \{\s+throw error;/,
    );
  });
});
