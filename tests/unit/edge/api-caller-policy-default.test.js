const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const apiCallerPath = path.join(repoRoot, 'supabase', 'functions', 'api-caller', 'index.ts');
const migrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '202608161550_b3_outbound_egress_guarded_proxy_default_v1.sql',
);

const loadPolicyResolver = () => {
  const source = fs.readFileSync(apiCallerPath, 'utf8');
  const start = source.indexOf('const parseBoolean =');
  const end = source.indexOf('const resolveBodyForDispatch =');
  if (start < 0 || end <= start) {
    throw new Error('api-caller policy resolver source block was not found');
  }

  const compiled = ts.transpileModule(
    `${source.slice(start, end)}\nmodule.exports = { defaultEgressPolicy, resolveEgressPolicy };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: apiCallerPath });
  return module.exports;
};

describe('api-caller outbound transport policy defaults', () => {
  const { defaultEgressPolicy, resolveEgressPolicy } = loadPolicyResolver();

  test('defaults missing and legacy transport fields to guarded proxy', () => {
    expect(defaultEgressPolicy().transportMode).toBe('guarded_proxy');
    expect(resolveEgressPolicy({ enforce: true, policy: {} }).transportMode).toBe('guarded_proxy');
    expect(resolveEgressPolicy({
      enforce: true,
      organization_id: 'legacy-tenant',
      policy: { enforce_https_only: true },
    }).transportMode).toBe('guarded_proxy');
  });

  test('fails closed to guarded proxy for unrecognized transport values', () => {
    expect(resolveEgressPolicy({
      enforce: true,
      policy: { transport_mode: 'future_transport' },
    }).transportMode).toBe('guarded_proxy');
  });

  test('allows direct trusted-host mode only when policy explicitly selects it', () => {
    expect(resolveEgressPolicy({
      enforce: true,
      policy: { transport_mode: 'direct_trusted_host' },
    }).transportMode).toBe('direct_trusted_host');
  });

  test('keeps integration-plugin transport on guarded proxy', () => {
    expect(resolveEgressPolicy({
      enforce: true,
      managed_by: 'integration_plugin',
      policy: { transport_mode: 'direct_trusted_host' },
    }).transportMode).toBe('guarded_proxy');
  });

  test('reconciles the global row append-only while preserving its existing policy', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("public.resolve_settings(");
    expect(sql).toContain("'outbound_egress_policy'");
    expect(sql).toContain("v_current_policy || jsonb_build_object('transport_mode', 'guarded_proxy')");
    expect(sql).toContain('PERFORM public.upsert_settings_value_v1(');
    expect(sql).not.toMatch(/\bUPDATE\s+public\.settings\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+public\.settings/i);
  });
});
