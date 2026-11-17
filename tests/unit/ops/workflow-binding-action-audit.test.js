const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateInventory,
  runAudit,
} = require('../../../scripts/ops/audit/workflow-binding-action-audit');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createFixtureRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-binding-audit-'));
  writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));

  const substratePath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202603091331_workflow_binding_policy_substrate_v1.sql',
  );
  const hybridPath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202603091341_workflow_binding_hybrid_followups_v1.sql',
  );
  const tenantSignupPath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202603091351_tenant_signup_workflow_binding_adoption_v1.sql',
  );
  const uiCommandPath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202603091361_ui_command_workflow_binding_awareness_v1.sql',
  );

  writeFile(
    substratePath,
    `
CREATE TABLE IF NOT EXISTS public.workflow_binding_registry ();
CREATE TABLE IF NOT EXISTS public.workflow_binding_stage_registry ();
CREATE TABLE IF NOT EXISTS public.workflow_binding_dispatches ();
CREATE OR REPLACE FUNCTION public.resolve_workflow_binding_v1() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.run_workflow_binding_stage_v1() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.bootstrap_workflow_binding_defaults_v1() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
SELECT * FROM public.resolve_scope_from_context('workflow_binding_policy', '{}'::jsonb);
SELECT * FROM public.resolve_settings_row('workflow_binding_policy', 'tenant', null);
CREATE OR REPLACE VIEW public.workflow_business_action_inventory_v1 AS SELECT 1;
INSERT INTO public.workflow_binding_registry(binding_key) VALUES
  ('customer_shipment_change'),
  ('marketing_lead'),
  ('tenant_signup');
    `.trim(),
  );

  writeFile(
    hybridPath,
    `
CREATE OR REPLACE FUNCTION public.public_tracking_enqueue_recipient_notification_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.run_workflow_binding_stage_v1(
    jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', v_binding_stage)
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.public_tracking_create_reviewer_task_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.run_workflow_binding_stage_v1(
    jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', 'review_requested')
  );
END;
$$;
CREATE OR REPLACE FUNCTION public.marketing_lead_request_create_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.run_workflow_binding_stage_v1(
    jsonb_build_object('binding_key', 'marketing_lead', 'stage_key', 'review_requested')
  );
END;
$$;
    `.trim(),
  );

  writeFile(
    tenantSignupPath,
    `
CREATE OR REPLACE FUNCTION public.tenant_signup_request_create_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.run_workflow_binding_stage_v1(
    jsonb_build_object('binding_key', 'tenant_signup', 'stage_key', 'review_requested')
  );
END;
$$;
    `.trim(),
  );

  writeFile(
    uiCommandPath,
    `
CREATE OR REPLACE FUNCTION public.ui_execute_command_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ui_execute_command_v1 workflow binding requires binding_key and stage_key for %', 'x';
  PERFORM public.run_workflow_binding_stage_v1('{}'::jsonb);
  RETURN jsonb_build_object('status', 'workflow_binding_started');
END;
$$;
    `.trim(),
  );

  writeFile(
    path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'),
    JSON.stringify(
      {
        registry_seed_file: 'supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql',
        inventory: [
          {
            key: 'workflow_binding_substrate',
            binding_key: 'customer_shipment_change',
            file: 'supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql',
            required_patterns: [
              'CREATE TABLE IF NOT EXISTS public\\.workflow_binding_registry',
              'CREATE TABLE IF NOT EXISTS public\\.workflow_binding_stage_registry',
              'CREATE TABLE IF NOT EXISTS public\\.workflow_binding_dispatches',
              'CREATE OR REPLACE FUNCTION public\\.resolve_workflow_binding_v1',
              'CREATE OR REPLACE FUNCTION public\\.run_workflow_binding_stage_v1',
              'CREATE OR REPLACE FUNCTION public\\.bootstrap_workflow_binding_defaults_v1',
              "FROM public\\.resolve_scope_from_context\\('workflow_binding_policy'",
              "FROM public\\.resolve_settings_row\\('workflow_binding_policy'",
              'CREATE OR REPLACE VIEW public\\.workflow_business_action_inventory_v1 AS',
            ],
            forbidden_patterns: [
              "resolve_settings_row_from_policy_context_v1\\('workflow_binding_policy'",
            ],
          },
          {
            key: 'customer_shipment_change_followups',
            binding_key: 'customer_shipment_change',
            file: 'supabase/migrations/202603091341_workflow_binding_hybrid_followups_v1.sql',
            required_patterns: [
              'CREATE OR REPLACE FUNCTION public\\.public_tracking_enqueue_recipient_notification_v1',
              'CREATE OR REPLACE FUNCTION public\\.public_tracking_create_reviewer_task_v1',
              'run_workflow_binding_stage_v1\\s*\\(',
              "'binding_key', 'customer_shipment_change'",
              "'stage_key', 'review_requested'",
            ],
          },
          {
            key: 'marketing_lead_review_request',
            binding_key: 'marketing_lead',
            file: 'supabase/migrations/202603091341_workflow_binding_hybrid_followups_v1.sql',
            required_patterns: [
              'CREATE OR REPLACE FUNCTION public\\.marketing_lead_request_create_v1',
              "'binding_key', 'marketing_lead'",
              "'stage_key', 'review_requested'",
            ],
          },
          {
            key: 'tenant_signup_review_request',
            binding_key: 'tenant_signup',
            file: 'supabase/migrations/202603091351_tenant_signup_workflow_binding_adoption_v1.sql',
            required_patterns: [
              'CREATE OR REPLACE FUNCTION public\\.tenant_signup_request_create_v1',
              'run_workflow_binding_stage_v1\\s*\\(',
              "'binding_key', 'tenant_signup'",
              "'stage_key', 'review_requested'",
            ],
          },
          {
            key: 'ui_command_workflow_binding_awareness',
            file: 'supabase/migrations/202603091361_ui_command_workflow_binding_awareness_v1.sql',
            required_patterns: [
              'CREATE OR REPLACE FUNCTION public\\.ui_execute_command_v1',
              'workflow binding requires binding_key and stage_key',
              'public\\.run_workflow_binding_stage_v1\\s*\\(',
              "'status', 'workflow_binding_started'",
            ],
          },
        ],
        guardrail: {
          watch_files: ['^supabase/migrations/.*\\.sql$'],
          business_action_markers: [
            'create_task_system_v1\\s*\\(',
            'run_workflow_binding_stage_v1\\s*\\(',
            'ui_execute_command_v1\\s*\\(',
          ],
          direct_action_markers: ['create_task_system_v1\\s*\\('],
          workflow_binding_markers: ['run_workflow_binding_stage_v1\\s*\\(', 'binding_key', 'stage_key'],
          ignore_files: [],
        },
      },
      null,
      2,
    ),
  );

  return repoRoot;
}

describe('workflow-binding-action-audit', () => {
  const tempDirs = [];

  afterEach(() => {
    delete process.env.WORKFLOW_BINDING_AUDIT_FILES;
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  test('evaluateInventory passes for the binding substrate and migration adopters', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'), 'utf8'),
    );

    const result = evaluateInventory(config, repoRoot);
    expect(result.issues).toEqual([]);
    expect(result.findings).toHaveLength(5);
  });

  test('evaluateInventory fails closed on the legacy hardcoded resolver pattern', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    const substratePath = path.join(
      repoRoot,
      'supabase',
      'migrations',
      '202603091331_workflow_binding_policy_substrate_v1.sql',
    );
    fs.appendFileSync(
      substratePath,
      "\nSELECT * FROM public.resolve_settings_row_from_policy_context_v1('workflow_binding_policy', '{}'::jsonb);\n",
      'utf8',
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'), 'utf8'),
    );

    const result = evaluateInventory(config, repoRoot);
    expect(result.issues.some((issue) => issue.includes('forbidden pattern'))).toBe(true);
  });

  test('runAudit rejects changed files with unregistered direct business actions', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    const directPath = path.join(repoRoot, 'supabase', 'migrations', '202603099999_direct_task.sql');
    writeFile(
      directPath,
      `
CREATE OR REPLACE FUNCTION public.some_direct_business_action() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.create_task_system_v1('{}'::jsonb);
END;
$$;
      `.trim(),
    );

    process.env.WORKFLOW_BINDING_AUDIT_FILES = 'supabase/migrations/202603099999_direct_task.sql';

    expect(() =>
      runAudit({
        repoRoot,
        configFile: path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'),
        changedOnly: false,
        json: false,
      }),
    ).toThrow(/not registered/i);
  });

  test('runAudit accepts registered changed files that dispatch through bindings', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    process.env.WORKFLOW_BINDING_AUDIT_FILES =
      'supabase/migrations/202603091341_workflow_binding_hybrid_followups_v1.sql';

    const result = runAudit({
      repoRoot,
      configFile: path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'),
      changedOnly: false,
      json: false,
    });

    expect(result.ok).toBe(true);
    expect(result.changed_findings).toHaveLength(1);
  });

  test('runAudit accepts changed related files registered under an inventory entry', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    const configPath = path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.inventory[0].related_files = [
      'supabase/migrations/202603101020_workflow_binding_entry_point_fix_v1.sql',
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    writeFile(
      path.join(
        repoRoot,
        'supabase',
        'migrations',
        '202603101020_workflow_binding_entry_point_fix_v1.sql',
      ),
      `
CREATE OR REPLACE FUNCTION public.run_workflow_binding_stage_v1() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.start_workflow_run('{}'::jsonb);
END;
$$;
      `.trim(),
    );

    process.env.WORKFLOW_BINDING_AUDIT_FILES =
      'supabase/migrations/202603101020_workflow_binding_entry_point_fix_v1.sql';

    const result = runAudit({
      repoRoot,
      configFile: configPath,
      changedOnly: false,
      json: false,
    });

    expect(result.ok).toBe(true);
    expect(result.changed_findings).toHaveLength(1);
    expect(result.changed_findings[0].covered).toBe(true);
  });
});
