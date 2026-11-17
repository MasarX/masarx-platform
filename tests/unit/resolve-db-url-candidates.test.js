jest.mock('../../scripts/utils/pg-candidates', () => ({
  applyPinnedDbSelectionPreference: jest.fn((candidates) => candidates),
  buildPinnedDbSelectionCandidate: jest.fn(() => null),
  buildDbConnectionCandidates: jest.fn(async (raw) =>
    (Array.isArray(raw) ? raw : []).filter((entry) => String(entry?.dsn || '').trim()),
  ),
}));

const { resolveDbCandidates } = require('../../scripts/utils/resolve-db-url');
const { buildDbConnectionCandidates } = require('../../scripts/utils/pg-candidates');

describe('resolve-db-url candidate ordering', () => {
  test('prioritizes synced + pooler candidates before raw/direct fallbacks', async () => {
    const env = {
      DATABASE_URL: 'postgres://raw-main',
      DATABASE_URL_DIRECT: 'postgres://raw-direct',
      DATABASE_URL_POOLER: 'postgres://raw-pooler',
      SYNCED_DB_URL: 'postgres://synced-main',
      SYNCED_DB_URL_DIRECT: 'postgres://synced-direct',
      SYNCED_DB_URL_POOLER: 'postgres://synced-pooler',
    };

    const candidates = await resolveDbCandidates(env);

    expect(buildDbConnectionCandidates).toHaveBeenCalledTimes(1);
    const [rawCandidates] = buildDbConnectionCandidates.mock.calls[0];
    expect(rawCandidates).toEqual([
      { name: 'SYNCED_DB_URL_POOLER', dsn: 'postgres://synced-pooler' },
      { name: 'DATABASE_URL_POOLER', dsn: 'postgres://raw-pooler' },
      { name: 'SYNCED_DB_URL', dsn: 'postgres://synced-main' },
      { name: 'DATABASE_URL', dsn: 'postgres://raw-main' },
      { name: 'SYNCED_DB_URL_DIRECT', dsn: 'postgres://synced-direct' },
      { name: 'DATABASE_URL_DIRECT', dsn: 'postgres://raw-direct' },
    ]);
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      'SYNCED_DB_URL_POOLER',
      'DATABASE_URL_POOLER',
      'SYNCED_DB_URL',
      'DATABASE_URL',
      'SYNCED_DB_URL_DIRECT',
      'DATABASE_URL_DIRECT',
    ]);
  });
});
