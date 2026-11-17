jest.mock('../../../scripts/utils/resolve-db-url', () => ({
  resolveDatabaseUrlWithFallback: jest.fn(async () => ({
    dsn: 'postgres://selected',
    candidateName: 'DATABASE_URL_POOLER+hostaddr',
  })),
}));

const {
  fetchCompatRoutes,
  normalizeComparableText,
  resolveDbConnection,
  resolveOpenApiDbCandidatePolicy,
  stableStringify,
} = require('../../../scripts/docs/generate-public-openapi');
const { resolveDatabaseUrlWithFallback } = require('../../../scripts/utils/resolve-db-url');

describe('generate-public-openapi', () => {
  test('resolveOpenApiDbCandidatePolicy defaults CI lanes to shared-lane-safe and honors explicit override', () => {
    expect(resolveOpenApiDbCandidatePolicy({ GITHUB_ACTIONS: 'true' })).toBe('shared-lane-safe');
    expect(resolveOpenApiDbCandidatePolicy({ CI: '1' })).toBe('shared-lane-safe');
    expect(
      resolveOpenApiDbCandidatePolicy({ DOCS_OPENAPI_DB_CANDIDATE_POLICY: 'default', GITHUB_ACTIONS: 'true' }),
    ).toBe('default');
    expect(resolveOpenApiDbCandidatePolicy({})).toBe('');
  });

  test('resolveDbConnection delegates to the shared DB fallback helper with docs-openapi policy', async () => {
    const env = { GITHUB_ACTIONS: 'true' };
    const logger = { warn: jest.fn(), log: jest.fn() };
    const connection = await resolveDbConnection({ env, logger });

    expect(resolveDatabaseUrlWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        logger,
        candidatePolicy: 'shared-lane-safe',
        connectionTimeoutEnvNames: ['DOCS_OPENAPI_DB_CONNECT_TIMEOUT_MS', 'DB_CONNECT_TIMEOUT_MS'],
      }),
    );
    expect(connection).toEqual({
      dsn: 'postgres://selected',
      candidateName: 'DATABASE_URL_POOLER+hostaddr',
    });
  });

  test('normalizeComparableText removes BOM and normalizes CRLF before drift checks', () => {
    expect(normalizeComparableText('\uFEFF{\r\n  "ok": true\r\n}\r\n')).toBe('{\n  "ok": true\n}\n');
  });

  test('stableStringify emits normalized trailing-newline JSON', () => {
    expect(stableStringify({ ok: true })).toBe('{\n  "ok": true\n}\n');
  });

  test('fetchCompatRoutes fail-closes to zero compat packs when visibility column is absent and no allowlist is set', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }),
    };
    const logger = { warn: jest.fn() };

    const routes = await fetchCompatRoutes(client, {
      env: {},
      logger,
    });

    expect(routes).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[openapi] Missing api_route_packs.public_docs_enabled and PUBLIC_OPENAPI_PACKS is not set; fail-closing to zero compatibility packs.',
    );
  });

  test('fetchCompatRoutes uses PUBLIC_OPENAPI_PACKS allowlist when visibility column is absent', async () => {
    const rows = [{ pack_name: 'logestechs_v2_mirror', method: 'GET', path_template: '/api/example' }];
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: rows.length, rows }),
    };

    const routes = await fetchCompatRoutes(client, {
      env: { PUBLIC_OPENAPI_PACKS: 'logestechs_v2_mirror' },
      logger: { warn: jest.fn() },
    });

    expect(routes).toEqual(rows);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain('p.name = ANY($1)');
    expect(client.query.mock.calls[1][1]).toEqual([['logestechs_v2_mirror']]);
  });
});
