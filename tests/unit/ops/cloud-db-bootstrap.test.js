const fs = require('fs');
const os = require('os');
const path = require('path');

const mockSpawnSync = jest.fn();
const mockResolveDsnCandidates = jest.fn();
const mockRunConnectivitySmoke = jest.fn();
const mockClientInstances = [];
let queryResponses = [];

jest.mock('child_process', () => ({
  spawnSync: (...args) => mockSpawnSync(...args),
}));

jest.mock('../../../scripts/ops/db-connect-smoke', () => ({
  parsePositiveInt: (value, fallback) => {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  },
  resolveDsnCandidates: (...args) => mockResolveDsnCandidates(...args),
  runConnectivitySmoke: (...args) => mockRunConnectivitySmoke(...args),
  shouldUseSsl: () => false,
}));

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation((config) => {
    const instance = {
      config,
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockImplementation(async () => {
        const next = queryResponses.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockClientInstances.push(instance);
    return instance;
  }),
}));

const {
  ensureCloudDbBootstrap,
  getLatestRepoMigrationVersion,
  hasTable,
  hasSchemaMigrationVersion,
  resolveBootstrapMode,
} = require('../../../scripts/ops/cloud-db-bootstrap');

function makeRepoRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-db-bootstrap-'));
  fs.mkdirSync(path.join(repoRoot, 'supabase', 'migrations'), { recursive: true });
  return repoRoot;
}

describe('cloud-db-bootstrap', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockResolveDsnCandidates.mockReset();
    mockRunConnectivitySmoke.mockReset();
    mockClientInstances.length = 0;
    queryResponses = [];
  });

  test('empty metadata checks need no client and real query failure still closes it', async () => {
    expect(await hasTable({ qualifiedName: '' })).toBe(false);
    expect(await hasSchemaMigrationVersion({ version: '' })).toBe(true);
    expect(mockClientInstances).toHaveLength(0);
    queryResponses = [new Error('synthetic query failure')];
    await expect(hasTable({ connectionString: 'postgres://fixture', qualifiedName: 'public.fixture',
      env: { DB_SMOKE_TIMEOUT_MS: '1234' } })).rejects.toThrow('synthetic query failure');
    expect(mockClientInstances).toHaveLength(1);
    expect(mockClientInstances[0].config).toEqual({
      connectionString: 'postgres://fixture', connectionTimeoutMillis: 1234, ssl: undefined,
    });
    expect(mockClientInstances[0].end).toHaveBeenCalledTimes(1);
  });

  test('getLatestRepoMigrationVersion returns the latest timestamped migration', () => {
    const repoRoot = makeRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, 'supabase', 'migrations', '202603101530_example.sql'),
      '-- example\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'supabase', 'migrations', '202603111200_another.sql'),
      '-- example\n',
      'utf8',
    );

    expect(getLatestRepoMigrationVersion(repoRoot)).toBe('202603111200');
  });

  test('runs supabase-cli push when the baseline schema is missing', async () => {
    const repoRoot = makeRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, 'supabase', 'migrations', '202603101530_example.sql'),
      '-- example\n',
      'utf8',
    );

    mockResolveDsnCandidates.mockResolvedValue([{ name: 'pooler', dsn: 'postgres://db.example/postgres' }]);
    mockRunConnectivitySmoke.mockResolvedValue({
      candidate: { name: 'pooler', dsn: 'postgres://db.example/postgres' },
    });
    mockSpawnSync.mockReturnValue({ status: 0 });

    queryResponses = [{ rows: [{ reg: null }] }];

    const env = {};
    const logger = { warn: jest.fn(), log: jest.fn() };

    const result = await ensureCloudDbBootstrap({
      env,
      logger,
      repoRoot,
      qaRunId: 'qa-run-1',
    });

    expect(env.DATABASE_URL).toBe('postgres://db.example/postgres');
    expect(env.PG_CONN_STRING).toBe('postgres://db.example/postgres');
    expect(env.DB_SMOKE_SELECTED_DSN_NAME).toBe('pooler');
    expect(result.selectedCandidateName).toBe('pooler');
    expect(result.bootstrapped).toBe(true);
    expect(result.bootstrapReason).toBe('baseline_missing');
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mockSpawnSync.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([path.join('scripts', 'ops', 'supabase-cli.js'), 'push']);
    expect(options.env.SUPABASE_DB_PUSH_INCLUDE_ALL).toBe('0');
    expect(options.env.QA_RUN_ID).toBe('qa-run-1');
    expect(logger.warn).toHaveBeenCalledWith(
      '[cloud-db-bootstrap] DB baseline schema missing (scope_type_registry). Running migrations via supabase-cli push.',
    );
  });

  test('skips push when the baseline exists and the latest migration is already applied', async () => {
    const repoRoot = makeRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, 'supabase', 'migrations', '202603111200_latest.sql'),
      '-- latest\n',
      'utf8',
    );

    mockResolveDsnCandidates.mockResolvedValue([{ name: 'primary', dsn: 'postgres://db.example/postgres' }]);
    mockRunConnectivitySmoke.mockResolvedValue({
      candidate: { name: 'primary', dsn: 'postgres://db.example/postgres' },
    });
    queryResponses = [
      { rows: [{ reg: 'public.scope_type_registry' }] },
      { rows: [{ reg: 'supabase_migrations.schema_migrations' }] },
      { rows: [{ present: true }] },
    ];

    const env = {};
    const logger = { warn: jest.fn(), log: jest.fn() };

    const result = await ensureCloudDbBootstrap({
      env,
      logger,
      repoRoot,
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.bootstrapReason).toBe('');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('shared deploy environments fail closed instead of running db push when schema is behind', async () => {
    const repoRoot = makeRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, 'supabase', 'migrations', '202603111200_latest.sql'),
      '-- latest\n',
      'utf8',
    );

    mockResolveDsnCandidates.mockResolvedValue([{ name: 'primary', dsn: 'postgres://db.example/postgres' }]);
    mockRunConnectivitySmoke.mockResolvedValue({
      candidate: { name: 'primary', dsn: 'postgres://db.example/postgres' },
    });
    queryResponses = [
      { rows: [{ reg: 'public.scope_type_registry' }] },
      { rows: [{ reg: 'supabase_migrations.schema_migrations' }] },
      { rows: [{ present: false }] },
    ];

    const env = { TARGET_DEPLOY_ENV: 'mobile-dev' };
    const logger = { warn: jest.fn(), log: jest.fn() };

    await expect(
      ensureCloudDbBootstrap({
        env,
        logger,
        repoRoot,
      }),
    ).rejects.toThrow(/Shared deploy environment "mobile-dev" is behind repo migrations/);

    expect(resolveBootstrapMode(env)).toBe('shared-strict');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
