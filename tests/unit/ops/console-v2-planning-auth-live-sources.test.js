const fs = require('fs');
const path = require('path');
const { STATUS_OPTIONS } = require('../../../scripts/ops/planning-os/config');

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
const planningModule = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'modules', 'platform', 'planning-os.tsx'),
  'utf8',
);
const planningTest = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'modules', 'platform', '__tests__', 'planning-os.test.tsx'),
  'utf8',
);
const dataSource = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'data-source.ts'),
  'utf8',
);
const planningDataSourceSlice = dataSource.slice(
  dataSource.indexOf('PLATFORM - Planning OS'),
  dataSource.indexOf('auth_email_url_policy:', dataSource.indexOf('PLATFORM - Planning OS')),
);

function readPolicy(env) {
  return JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'config', 'ops', `auth-email-url-policy.${env}.json`),
      'utf8',
    ),
  );
}

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
    const stageNames = STATUS_OPTIONS.map((option) => option.name);
    expect(stageNames).toHaveLength(11);

    for (const stage of stageNames) {
      expect(migration).toContain(`'${stage}'`);
      expect(policySeed).toContain(`'${stage}'`);
      expect(planningTest).toContain(`'${stage}'`);
    }

    expect(migration).toContain("'version', 2");
    expect(policySeed).toContain('version: 2');
    expect(migration).not.toContain("['Draft', 'Triaged', 'Ready for Execution', 'In Progress', 'Done', 'Audit Pending']");
    expect(planningSeed).not.toMatch(/status:\s*'(Draft|In Progress|Audit Pending)'/);
  });

  test('wires Console V2 Planning OS to backend-projected resources, not the retired seed accessor', () => {
    expect(planningModule).toContain("useResourceList<ProjectItem>('planning_os_project_items')");
    expect(planningModule).toContain("useResourceList<ExecutionCard>('planning_os_execution_cards')");
    expect(planningModule).not.toContain('api.seed.planningOsModule');
    expect(planningTest).toContain('Live backend projected work item');

    expect(planningDataSourceSlice).toContain('public.planning_os_project_items');
    expect(planningDataSourceSlice).toContain('public.planning_os_execution_cards');
    expect(planningDataSourceSlice).toContain('sync-console-v2-mirror.js');
    expect(planningDataSourceSlice).not.toContain('FE-only');
    expect(planningDataSourceSlice).not.toContain('not part of the canonical Supabase schema yet');

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
      const policy = readPolicy(env);
      expect(migration).toContain(`'config/ops/auth-email-url-policy.${env}.json'`);
      expect(migration).toContain(`'${policy.site_url}'`);
      for (const redirectUrl of policy.additional_redirect_urls) {
        expect(migration).toContain(`'${redirectUrl}'`);
      }
      for (const bannedHost of policy.banned_redirect_hosts) {
        expect(migration).toContain(`'${bannedHost}'`);
      }
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
