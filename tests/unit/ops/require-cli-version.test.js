const path = require('path');

const {
  EXACT_SEMVER_RE,
  parseArgs,
  resolveConfigPath,
  loadCliContract,
  getToolContract,
  validateVersion,
  buildContractResult,
} = require('../../../scripts/ops/ci/require-cli-version');

describe('require-cli-version', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('parses args and resolves the default config path', () => {
    expect(parseArgs(['--tool', 'vercel', '--format', 'github-output'])).toEqual({
      tool: 'vercel',
      config: '',
      format: 'github-output',
    });

    expect(resolveConfigPath('')).toBe(
      path.join(process.cwd(), 'config', 'ci', 'deploy-cli-contract.json'),
    );
  });

  test('loads configured CLI contracts', () => {
    const contract = loadCliContract();
    const tool = getToolContract(contract, 'vercel');

    expect(contract.tools.map((entry) => entry.toolId)).toEqual(
      expect.arrayContaining(['supabase', 'vercel', 'wrangler']),
    );
    expect(tool).toMatchObject({
      toolId: 'vercel',
      displayName: 'Vercel CLI',
      packageName: 'vercel',
      repoVar: 'VERCEL_CLI_VERSION',
      required: true,
      exactSemverRequired: true,
    });
  });

  test('validates exact semver-like versions from env-backed repo vars', () => {
    process.env.VERCEL_CLI_VERSION = '50.31.1';
    const contract = loadCliContract();
    const tool = getToolContract(contract, 'vercel');

    expect(EXACT_SEMVER_RE.test('50.31.1')).toBe(true);
    expect(validateVersion(tool)).toBe('50.31.1');
  });

  test('fails closed on missing or non-exact versions', () => {
    const contract = loadCliContract();
    const tool = getToolContract(contract, 'wrangler');

    expect(() => validateVersion(tool)).toThrow(
      'Missing WRANGLER_CLI_VERSION (repo variable). Pin the Wrangler CLI version for deterministic automation.',
    );

    process.env.WRANGLER_CLI_VERSION = '4';
    expect(() => validateVersion(tool)).toThrow(
      'WRANGLER_CLI_VERSION must be an exact semver-like version (got: 4).',
    );
  });

  test('builds installable package specs', () => {
    expect(buildContractResult({
      toolId: 'supabase',
      displayName: 'Supabase CLI',
      repoVar: 'SUPABASE_CLI_VERSION',
      packageName: 'supabase',
      exactSemverRequired: true,
    }, '2.67.3')).toEqual({
      tool_id: 'supabase',
      display_name: 'Supabase CLI',
      repo_var: 'SUPABASE_CLI_VERSION',
      version: '2.67.3',
      package_name: 'supabase',
      package_spec: 'supabase@2.67.3',
      exact_semver_required: '1',
    });
  });
});
