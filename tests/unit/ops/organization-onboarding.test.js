const {
  withOrganizationOnboardingSource,
  flushOrganizationOnboarding,
  withOnboardingTransaction,
} = require('../../../scripts/utils/organization-onboarding');

function connection(source = 'previous-owner') {
  return {
    query: jest.fn(async (sql) => ({
      rows: sql.includes('current_setting') ? [{ source }] : [],
    })),
  };
}

test('entity setup restores its previous marker and flushes once before commit', async () => {
  const client = connection();
  const events = [];
  const query = client.query;
  client.query = jest.fn(async (sql, args) => {
    events.push(sql);
    return query(sql, args);
  });
  const result = await withOnboardingTransaction(client, async () => {
    const org = await withOrganizationOnboardingSource(client, async () => {
      events.push('organization upsert');
      return { id: 'org' };
    });
    events.push('client and sender setup');
    return org;
  });
  expect(result).toEqual({ id: 'org' });
  expect(events).toEqual([
    'BEGIN',
    "SELECT current_setting('app.organization_onboarding_source', true) AS source",
    "SELECT set_config('app.organization_onboarding_source', $1, true)",
    'organization upsert',
    "SELECT set_config('app.organization_onboarding_source', $1, true)",
    'client and sender setup',
    'SET CONSTRAINTS public.trg_organizations_deferred_onboarding_v1 IMMEDIATE',
    'COMMIT',
  ]);
  expect(client.query.mock.calls.filter(([sql]) => sql.includes('set_config')).map(([, args]) => args))
    .toEqual([['provision_demo_accounts_v1'], ['previous-owner']]);
});

test('an absent prior source is restored to the empty setting', async () => {
  const client = connection(null);
  await withOrganizationOnboardingSource(client, async () => 'org');
  expect(client.query).toHaveBeenLastCalledWith(
    "SELECT set_config('app.organization_onboarding_source', $1, true)", [''],
  );
});

test('fixture-owned transaction is never committed by marker or flush helpers', async () => {
  const client = connection();
  await withOrganizationOnboardingSource(client, async () => 'org');
  await flushOrganizationOnboarding(client);
  const queries = client.query.mock.calls.map(([sql]) => sql);
  expect(queries).not.toContain('BEGIN');
  expect(queries).not.toContain('COMMIT');
});

test('failed organization statement rolls back before any restoration query', async () => {
  const client = connection();
  const error = new Error('insert rejected');
  await expect(withOnboardingTransaction(client, () =>
    withOrganizationOnboardingSource(client, async () => { throw error; }),
  )).rejects.toBe(error);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    "SELECT current_setting('app.organization_onboarding_source', true) AS source",
    "SELECT set_config('app.organization_onboarding_source', $1, true)",
    'ROLLBACK',
  ]);
});

test('failed sender context is rolled back without running the completion flush', async () => {
  const client = connection();
  const error = new Error('sender rejected');
  await expect(withOnboardingTransaction(client, async () => {
    await withOrganizationOnboardingSource(client, async () => 'org');
    throw error;
  })).rejects.toBe(error);
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(client.query.mock.calls.some(([sql]) => sql.startsWith('SET CONSTRAINTS'))).toBe(false);
});

test('canonical completion rejection prevents commit', async () => {
  const client = connection();
  const error = new Error('plugin baseline blocked');
  client.query.mockImplementation(async (sql) => {
    if (sql.startsWith('SET CONSTRAINTS')) throw error;
    return { rows: [] };
  });
  await expect(withOnboardingTransaction(client, async () => 'org')).rejects.toBe(error);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN', 'SET CONSTRAINTS public.trg_organizations_deferred_onboarding_v1 IMMEDIATE', 'ROLLBACK',
  ]);
});

test('rollback failure preserves both errors rather than claiming cleanup', async () => {
  const client = connection();
  const original = new Error('setup rejected');
  const rollback = new Error('connection lost');
  client.query.mockImplementation(async (sql) => {
    if (sql === 'ROLLBACK') throw rollback;
    return { rows: [] };
  });
  try {
    await withOnboardingTransaction(client, async () => { throw original; });
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([original, rollback]);
  }
});

test('begin failure never executes entity writes', async () => {
  const client = connection();
  const action = jest.fn();
  client.query.mockRejectedValue(new Error('begin unavailable'));
  await expect(withOnboardingTransaction(client, action)).rejects.toThrow('begin unavailable');
  expect(action).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledTimes(1);
});
