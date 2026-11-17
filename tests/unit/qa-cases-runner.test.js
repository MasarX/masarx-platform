const {
  buildQuarantineMetadata,
  resolveDatabaseUrlWithFallback,
} = require('../../scripts/qa/run-qa-cases');

describe('qa cases runner', () => {
  test('buildQuarantineMetadata returns null when case is not quarantined', () => {
    expect(buildQuarantineMetadata({})).toBeNull();
    expect(buildQuarantineMetadata({ quarantine_id: null })).toBeNull();
  });

  test('buildQuarantineMetadata normalizes quarantine fields', () => {
    const meta = buildQuarantineMetadata({
      quarantine_id: 'qa-123',
      quarantine_reason: 'flaky dependency',
      quarantine_owner: 'qa-team',
      quarantine_expires_at: '2030-01-01T00:00:00Z',
    });

    expect(meta).toEqual({
      id: 'qa-123',
      reason: 'flaky dependency',
      owner: 'qa-team',
      expires_at: '2030-01-01T00:00:00.000Z',
    });
  });

  test('buildQuarantineMetadata drops invalid timestamps', () => {
    const meta = buildQuarantineMetadata({
      quarantine_id: 'qa-456',
      quarantine_expires_at: 'not-a-date',
    });

    expect(meta).toEqual({
      id: 'qa-456',
      reason: null,
      owner: null,
      expires_at: null,
    });
  });

  test('resolveDatabaseUrlWithFallback returns empty string when no candidates exist', async () => {
    const dsn = await resolveDatabaseUrlWithFallback({
      env: {},
      resolveCandidates: async () => [],
      runSmoke: async () => {
        throw new Error('runSmoke should not be called');
      },
    });
    expect(dsn).toBe('');
  });

  test('resolveDatabaseUrlWithFallback uses shared smoke ladder and returns selected dsn', async () => {
    const warnings = [];
    const env = {
      QA_CASES_CONNECT_ATTEMPT_TIMEOUT_MS: '1234',
      QA_CASES_CONNECT_TIMEOUT_MS: '5678',
      QA_CASES_CONNECT_RETRY_DELAY_MS: '250',
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
    };
    const dsn = await resolveDatabaseUrlWithFallback({
      env,
      logger: { warn: (message) => warnings.push(message) },
      resolveCandidates: async () => [
        { name: 'DATABASE_URL', dsn: 'postgres://primary' },
        { name: 'DATABASE_URL_POOLER+ipv4host', dsn: 'postgres://fallback' },
      ],
      runSmoke: async (options) => {
        expect(options.env).toBe(env);
        expect(options.connectionTimeoutMs).toBe(1234);
        expect(options.maxWaitMs).toBe(5678);
        expect(options.retryDelayMs).toBe(250);
        expect(options.candidates).toHaveLength(2);
        return { candidate: { name: 'DATABASE_URL_POOLER+ipv4host', dsn: 'postgres://fallback' } };
      },
    });

    expect(dsn).toBe('postgres://fallback');
    expect(warnings).toContain('[qa:cases] Connected via DATABASE_URL_POOLER+ipv4host after fallback.');
  });
});
