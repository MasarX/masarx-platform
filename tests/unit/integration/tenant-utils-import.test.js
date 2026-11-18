const { EventEmitter } = require('events');

describe('integration helper tenant-utils import behavior', () => {
  const envKey = 'DATABASE_URL';
  const originalDatabaseUrl = process.env[envKey];

  function createQueryClient(transactionStatus, snapshot = {}) {
    const connection = new EventEmitter();
    const query = jest.fn().mockImplementation(async (sql) => {
      if (/^SELECT current_user::text/.test(sql)) {
        const result = { rows: [{ current_role: 'postgres', session_role: 'postgres', ...snapshot }] };
        connection.emit('readyForQuery', { status: transactionStatus });
        return result;
      }
      return { rows: [] };
    });
    return { connection, query };
  }

  test.each([
    [['label_design.read'], undefined, 'tenant', 'org'],
    [[], { scopeType: 'client', scopeId: 'client' }, 'client', 'client'],
  ])('explicit policy fixture preserves siblings and pins schema: %j', async (capabilities, options, scopeType, scopeId) => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('T', { current_role: 'authenticated' });
    const original = client.query.getMockImplementation();
    const policy = { roles: [{ key: 'ops_admin', capability_keys: ['*'] }],
      assignments: { user_type: { ops_admin: ['ops_admin'] }, user_id: { sibling: ['ops_admin'] } },
      resource_map: { lookup_values: { read: 'system.write' } } };
    client.query.mockImplementation(async (sql, values) => {
      if (sql.includes('resolve_access_control_policy_v1')) return { rows: [{ policy, schema_version: 7 }] };
      return original(sql, values);
    });
    await helper.setFixtureUserPolicyCapabilities(client, 'org', 'actor', capabilities, options);
    const [, resolvedValues] = client.query.mock.calls.find(([sql]) => sql.includes('resolve_access_control_policy_v1'));
    const [, values] = client.query.mock.calls.find(([sql]) => sql.includes('upsert_settings_value_v1'));
    const written = JSON.parse(values[2]);
    expect(resolvedValues).toEqual([scopeType, scopeId]);
    expect(values.slice(0, 2)).toEqual([scopeType, scopeId]);
    expect(values[3]).toBe(7);
    expect(written.roles.slice(0, -1)).toEqual(policy.roles);
    expect(written.roles.at(-1).capability_keys).toEqual(capabilities);
    expect(written.assignments.user_id.actor).toEqual([written.roles.at(-1).key]);
    expect(written.assignments.user_id.sibling).toEqual(['ops_admin']);
    expect(written.assignments.user_type).toEqual(policy.assignments.user_type);
    expect(written.resource_map).toEqual(policy.resource_map);
    expect(policy.assignments.user_id).not.toHaveProperty('actor');
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('SET LOCAL ROLE authenticated');
    await helper.pool.end();
  });

  test('explicit policy fixture rolls back failed writes behind caller savepoint', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('T', { current_role: 'authenticated' });
    const original = client.query.getMockImplementation();
    const failure = new Error('policy write failed');
    client.query.mockImplementation(async (sql, values) => {
      if (sql.includes('resolve_access_control_policy_v1')) return { rows: [{ policy: { roles: [] }, schema_version: 7 }] };
      if (sql.includes('upsert_settings_value_v1')) throw failure;
      return original(sql, values);
    });
    await expect(helper.setFixtureUserPolicyCapabilities(client, 'org', 'actor', [])).rejects.toBe(failure);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^ROLLBACK TO SAVEPOINT fixture_admin_scope_\d+$/),
      expect.stringMatching(/^RELEASE SAVEPOINT fixture_admin_scope_\d+$/),
    ]));
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    await helper.pool.end();
  });

  afterEach(async () => {
    process.env[envKey] = originalDatabaseUrl;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('does not throw at import time when DATABASE_URL is missing', async () => {
    delete process.env[envKey];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../integration/helpers/tenant-utils');

    expect(helper.DATABASE_URL).toBeNull();
    expect(helper.pool).toBeNull();
    expect(() => helper.assertDatabaseUrl('tenant-utils')).toThrow(
      '[tests] DATABASE_URL is required for tenant-utils',
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  test('initializes exported pool when DATABASE_URL exists', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));

    const helper = require('../../integration/helpers/tenant-utils');

    expect(helper.DATABASE_URL).toContain('postgresql://');
    expect(helper.pool).toBeTruthy();
    await helper.pool.end();
  });

  test('fixture admin scope owns an autocommit client transaction and restores context', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('I', {
      current_role: 'authenticated',
      jwt_claims: '{"role":"authenticated","sub":"user-1"}',
      jwt_sub: 'user-1',
      jwt_role: 'authenticated',
    });
    const { query } = client;
    const operation = jest.fn().mockResolvedValue('fixture-result');

    await expect(helper.withFixtureAdminContext(client, operation)).resolves.toBe('fixture-result');

    expect(operation).toHaveBeenCalledWith(client);
    expect(query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => /^SAVEPOINT /.test(sql))).toHaveLength(0);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      'SET LOCAL ROLE NONE',
      'SET LOCAL ROLE authenticated',
    ]));
    expect(query.mock.calls.filter(([sql]) => sql === 'SET LOCAL ROLE NONE')).toHaveLength(2);
    await helper.pool.end();
  });

  test('fixture admin scope preserves an active caller transaction behind a savepoint', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('T', {
      current_role: 'authenticated',
      jwt_claims: '{"role":"authenticated","sub":"user-1"}',
      jwt_sub: 'user-1',
      jwt_role: 'authenticated',
    });
    const { query } = client;

    await helper.withFixtureAdminContext(client, async () => 'fixture-result');

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringMatching(/^SAVEPOINT fixture_admin_scope_\d+$/),
      expect.stringMatching(/^RELEASE SAVEPOINT fixture_admin_scope_\d+$/),
    ]));
    expect(statements).not.toContain('BEGIN');
    expect(statements).not.toContain('COMMIT');
    await helper.pool.end();
  });

  test('fixture admin scope pins Pool work to one owned connection', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('I');
    const { query } = client;
    const release = jest.fn();
    client.release = release;
    const queryTarget = {
      connect: jest.fn().mockResolvedValue(client),
      end: jest.fn(),
      query: jest.fn(),
      totalCount: 1,
    };
    const operation = jest.fn().mockResolvedValue('pool-result');

    await expect(helper.withFixtureAdminContext(queryTarget, operation)).resolves.toBe('pool-result');

    expect(queryTarget.connect).toHaveBeenCalledTimes(1);
    expect(queryTarget.query).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledWith(client);
    expect(query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
    expect(release).toHaveBeenCalledWith(undefined);
    await helper.pool.end();
  });

  test('fixture admin scope rejects missing operations before touching the connection', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = { query: jest.fn() };

    await expect(helper.withFixtureAdminContext(client)).rejects.toThrow(
      'withFixtureAdminContext requires an operation callback',
    );
    expect(client.query).not.toHaveBeenCalled();
    await helper.pool.end();
  });

  test('fixture admin scope fails closed for an already aborted transaction', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('E');
    const operation = jest.fn();

    await expect(helper.withFixtureAdminContext(client, operation)).rejects.toThrow(
      'withFixtureAdminContext cannot enter an aborted transaction',
    );

    expect(operation).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    await helper.pool.end();
  });

  test('fixture admin scope restores context after fixture failures', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));
    const helper = require('../../integration/helpers/tenant-utils');
    const client = createQueryClient('T', {
      current_role: 'service_role',
      jwt_claims: '{"role":"service_role","sub":"worker-1"}',
      jwt_sub: 'worker-1',
      jwt_role: 'service_role',
    });
    const { query } = client;
    const fixtureError = new Error('fixture failed');

    await expect(
      helper.withFixtureAdminContext(client, async () => {
        throw fixtureError;
      }),
    ).rejects.toBe(fixtureError);

    expect(query.mock.calls.filter(([sql]) => sql === 'SET LOCAL ROLE NONE')).toHaveLength(1);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^ROLLBACK TO SAVEPOINT fixture_admin_scope_\d+$/),
      expect.stringMatching(/^RELEASE SAVEPOINT fixture_admin_scope_\d+$/),
    ]));
    await helper.pool.end();
  });
});
