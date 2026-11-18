const {
  buildFixtureProfile,
  buildShipmentWebhookPolicy,
  isRetryableFixtureBootstrapConcurrencyError,
  isRetryableFixtureBootstrapError,
  resolveDatabaseUrl,
  resolveFixtureBootstrapRetryConfig,
  withFixtureBootstrapRetry,
  upsertSettingValue,
} = require('../../../scripts/tests/bootstrap/lib/integration-fixtures');

describe('integration fixture bootstrap helpers', () => {
  test('geocoding upsert uses only the canonical versioned writer', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const value = { version: 1, provider_priority: [] };
    await upsertSettingValue(client, {
      category: 'geocoding_policy', scopeType: 'client',
      scopeId: '00000000-0000-4000-8000-000000000001', value,
      schemaVersion: 1, changeReason: 'owned fixture regression',
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('public.upsert_settings_value_v1(');
    expect(client.query.mock.calls[0][1]).toEqual([
      'geocoding_policy', 'client', '00000000-0000-4000-8000-000000000001',
      JSON.stringify(value), 1, 'owned fixture regression',
    ]);
  });

  test.each(['makeGeoEnabled', 'makeGeoDisabled'])('%s removes obsolete enabled before canonical save', name => {
    const fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('../../../scripts/tests/bootstrap/lib/integration-fixtures'), 'utf8');
    const start = source.indexOf('const ' + name + ' = (base) => {');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf('\n    };', start)))
      .toMatch(/delete next\.enabled;\s*return next;/);
  });
  test.each([
    ['test', ['test', 'test-foreign']],
    ['Custom_Profile', ['custom_profile', 'test', 'test-foreign']],
  ])('pgTAP provisions required tenant profiles serially (%s)', async (prefix, expected) => {
    const calls = [];
    let active = false;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../../scripts/tests/bootstrap/lib/integration-fixtures', () => ({
        buildFixtureProfile,
        runCli: async ({ env }) => {
          expect(active).toBe(false);
          active = true;
          calls.push(env);
          await Promise.resolve();
          active = false;
        },
      }));
      try {
        const { runPgtapFixtureProfiles } = require('../../../scripts/tests/bootstrap/seed-pgtap-fixtures');
        await runPgtapFixtureProfiles({ INTEGRATION_FIXTURE_PREFIX: prefix, DATABASE_URL: 'owned-dsn', DEPLOY_ENV: 'local' });
      } finally { jest.dontMock('../../../scripts/tests/bootstrap/lib/integration-fixtures'); }
    });
    expect(calls.map(env => env.INTEGRATION_FIXTURE_PREFIX)).toEqual(expected);
    expect(calls.every(env => env.DATABASE_URL === 'owned-dsn' && env.DEPLOY_ENV === 'local')).toBe(true);
  });

  test('buildFixtureProfile normalizes prefix and emits expected fixture keys', () => {
    const profile = buildFixtureProfile({ INTEGRATION_FIXTURE_PREFIX: 'Test_Profile' });
    expect(profile.prefix).toBe('test_profile');
    expect(profile.organizations.alpha.slug).toBe('test_profile-org-alpha');
    expect(profile.clients.twoOne.slug).toBe('test_profile-client-2-1');
    expect(profile.webhook.basic.token).toBe('EXAMPLE_PASSWORD');
    expect(profile.webhook.clientAckA.token).toBe('test_profile-client-a-ack-token');
    expect(profile.webhook.clientAckB.token).toBe('test_profile-EXAMPLE_PASSWORD');
    expect(buildFixtureProfile().webhook.clientAckA.token).toBe('client-a-ack-token');
    expect(buildFixtureProfile().webhook.clientAckB.token).toBe('EXAMPLE_PASSWORD');
  });

  test('buildShipmentWebhookPolicy emits canonical typed shipment bindings', () => {
    expect(buildShipmentWebhookPolicy()).toMatchObject({
      version: 3,
      workflow: {
        intent: 'shipment.create',
        templates_by_intent: {
          'shipment.create': { template_name: 'webhook_shipment_create_v1' },
          'shipment.delete': { template_name: 'shipment_delete_v1' },
          'shipment.reschedule': { template_name: 'shipment_reschedule_v1' },
        },
      },
    });
  });

  test('resolveDatabaseUrl resolves DSN from env ladder', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a' })).toBe('postgres://a');
    expect(resolveDatabaseUrl({ DATABASE_URL_DIRECT: 'postgres://b' })).toBe('postgres://b');
    expect(resolveDatabaseUrl({ DATABASE_URL_POOLER: 'postgres://c' })).toBe('postgres://c');
  });

  test('resolveDatabaseUrl throws when no database DSN is present', () => {
    expect(() => resolveDatabaseUrl({})).toThrow('DATABASE_URL');
  });

  test('resolveFixtureBootstrapRetryConfig reads env-driven retry knobs', () => {
    expect(
      resolveFixtureBootstrapRetryConfig({
        PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '90000',
        PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '1500',
        PGTAP_FIXTURE_BOOTSTRAP_CONNECT_TIMEOUT_MS: '7000',
      }),
    ).toEqual({
      maxWaitMs: 90000,
      retryDelayMs: 1500,
      connectionTimeoutMs: 7000,
    });
  });

  test('isRetryableFixtureBootstrapError treats transient preview db failures as retryable', () => {
    expect(
      isRetryableFixtureBootstrapError({
        code: 'XX000',
        message: 'DbHandler exited. Check logs for more information.',
      }),
    ).toBe(true);
    expect(isRetryableFixtureBootstrapError(new Error('Tenant or user not found'))).toBe(true);
    expect(isRetryableFixtureBootstrapError(new Error('syntax error at or near select'))).toBe(false);
  });

  test('isRetryableFixtureBootstrapConcurrencyError treats deadlocks and serialization conflicts as retryable', () => {
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '40P01',
        message: 'deadlock detected',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '40001',
        message: 'could not serialize access due to concurrent update',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '55P03',
        message: 'lock not available',
      }),
    ).toBe(true);
    expect(
      isRetryableFixtureBootstrapConcurrencyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      }),
    ).toBe(false);
  });

  test('withFixtureBootstrapRetry retries transient fixture bootstrap failures', async () => {
    const sleepCalls = [];
    let fakeNow = 0;
    let attempts = 0;

    const result = await withFixtureBootstrapRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('DbHandler exited. Check logs for more information.'), {
            code: 'XX000',
          });
        }
        return 'ok';
      },
      {
        env: {
          PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '10000',
          PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '250',
        },
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([250, 500]);
  });

  test('withFixtureBootstrapRetry retries deadlock failures', async () => {
    const sleepCalls = [];
    let fakeNow = 0;
    let attempts = 0;

    const result = await withFixtureBootstrapRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) {
          throw Object.assign(new Error('deadlock detected'), {
            code: '40P01',
          });
        }
        return 'ok';
      },
      {
        env: {
          PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS: '10000',
          PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS: '300',
        },
        now: () => fakeNow,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
          fakeNow += ms;
        },
        logger: { warn: jest.fn() },
      },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([300]);
  });
});
