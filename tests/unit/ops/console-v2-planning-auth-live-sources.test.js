const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const migrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '202605041420_console_v2_planning_auth_live_sources_v1.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const policySeed = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'seed-raw', 'policies.js'),
  'utf8',
);
const planningSeed = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'seed-raw', 'planning-os.js'),
  'utf8',
);
const dataSource = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'data-source.ts'),
  'utf8',
);
describe('Console V2 Planning OS and auth-email live-source closure', () => {
  test('materializes Planning OS resource relations as RLS-backed service-sync tables', () => {
    for (const relation of ['planning_os_project_items', 'planning_os_execution_cards']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${relation}`);
      expect(migration).toContain(`ALTER TABLE public.${relation} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY ${relation}_select`);
      expect(migration).toContain("public.user_has_capability_v1('audit_log.read')");
      expect(migration).toContain(`GRANT INSERT, UPDATE, DELETE ON public.${relation} TO service_role`);
    }

    expect(migration).toContain("'planning_os_project_items'");
    expect(migration).toContain("'planning_os_execution_cards'");
    expect(migration).toContain("'Register Console V2 Planning OS and auth-email governance live resources'");
  });

  test('refreshes planning_os_config to match the current Planning OS status model', () => {
    const [, stages] = policySeed.match(/category: 'planning_os_config'.*?stages: \[([^\]]+)\]/);
    const stageNames = [...stages.matchAll(/'([^']+)'/g)].map(([, name]) => name);
    expect(stageNames).toHaveLength(11);

    for (const stage of stageNames) {
      expect(migration).toContain(`'${stage}'`);
    }

    expect(migration).toContain("'version', 2");
    expect(policySeed).toContain('version: 2');
    expect(migration).not.toContain("['Draft', 'Triaged', 'Ready for Execution', 'In Progress', 'Done', 'Audit Pending']");
    expect(planningSeed).not.toMatch(/status:\s*'(Draft|In Progress|Audit Pending)'/);
  });

  test('wires Console V2 Planning OS to backend-projected resources, not the retired seed accessor', () => {
    expect(dataSource).toContain("ui_list_resource_v1('planning_os_project_items', { page_size: 50 })");
    expect(dataSource).toContain("ui_list_resource_v1('planning_os_execution_cards', { page_size: 50 })");
    expect(planningSeed).toContain('demo-only fallback');
    expect(planningSeed).toContain('Live Console V2 reads backend-projected');
  });

  test('backs auth_email_url_policy with settings and a browser-safe registry view', () => {
    expect(migration).toContain("'auth_email_url_policy'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.auth_email_url_policy_rows_v1()');
    expect(migration).toContain("PERFORM public.assert_capability_v1('settings.read'");
    expect(migration).toContain('CREATE OR REPLACE VIEW public.auth_email_url_policy');
    expect(migration).toContain('WITH (security_invoker = true)');
    expect(migration).toContain("'relation', 'public.auth_email_url_policy'");
    expect(migration).toContain("'capability_read', 'settings.read'");

    for (const env of ['dev', 'stg', 'prod']) {
      expect(migration).toContain(`'config/ops/auth-email-url-policy.${env}.json'`);

    }
  });

  test('keeps settings and registry changes append-only through the settings helper', () => {
    expect(migration).toContain('public.upsert_settings_value_v1');
    expect(migration).toContain("'Refresh Planning OS stages to current GitHub Project 6 lifecycle for Console V2'");
    expect(migration).toContain("'Seed auth email URL policy mirror from config/ops/auth-email-url-policy.<env>.json'");
    expect(migration).not.toMatch(/UPDATE\s+public\.settings_versions/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.settings\s/i);
  });
});
