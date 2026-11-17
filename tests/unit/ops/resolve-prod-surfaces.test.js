const {
  parseCsv,
  parseRepoSlug,
  getStageWorkflowFile,
  resolveSuccessfulStgSurfaces,
  resolveChangedProdOnlySurfaces,
  resolveProdSurfaces,
} = require('../../../scripts/ops/ci/resolve-prod-surfaces');
const { loadDeploySurfaceRegistry, compileRegistry } = require('../../../scripts/ops/ci/deploy-surface-registry');

function mockFetchResponse(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => json,
    text: async () => JSON.stringify(json || {}),
  };
}

describe('resolve-prod-surfaces', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('parseCsv normalizes, dedupes, and sorts', () => {
    expect(parseCsv('docs, db,docs,portal')).toEqual(['db', 'docs', 'portal']);
    expect(parseCsv('')).toEqual([]);
  });

  test('parseRepoSlug parses owner/repo', () => {
    expect(parseRepoSlug('MasarX/MasarX')).toEqual({ owner: 'MasarX', repo: 'MasarX' });
    expect(parseRepoSlug('invalid')).toEqual({ owner: '', repo: '' });
  });

  test('getStageWorkflowFile prefers stage mapping then fallback', () => {
    const mapped = getStageWorkflowFile(
      {
        deploy: {
          entrypoint: {
            workflow_file: 'fallback.yml',
            workflow_file_by_stage: { stg: 'stg.yml' },
          },
        },
      },
      'stg',
    );
    expect(mapped).toBe('stg.yml');

    const fallback = getStageWorkflowFile(
      {
        deploy: {
          entrypoint: {
            workflow_file: 'fallback.yml',
          },
        },
      },
      'stg',
    );
    expect(fallback).toBe('fallback.yml');
  });

  test('resolveSuccessfulStgSurfaces returns surfaces with successful stg runs', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        workflow_runs: [{ status: 'completed', conclusion: 'success' }],
      }),
    );

    const compiled = {
      surfaces: [
        {
          surface_id: 'db',
          deploy: {
            stages: ['stg', 'prod'],
            entrypoint: { workflow_file_by_stage: { stg: 'deploy-stg-promote.yml' } },
          },
        },
        {
          surface_id: 'docs',
          deploy: {
            stages: ['prod'],
            entrypoint: { workflow_file_by_stage: { prod: 'publish-public-docs.yml' } },
          },
        },
      ],
    };

    const out = await resolveSuccessfulStgSurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      sha: 'a'.repeat(40),
      compiled,
      logger: { warn: jest.fn() },
    });

    expect(out).toEqual(['db']);
  });

  test('resolveSuccessfulStgSurfaces fail-closes includes surface on lookup error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));
    const warn = jest.fn();
    const compiled = {
      surfaces: [
        {
          surface_id: 'db',
          deploy: {
            stages: ['stg', 'prod'],
            entrypoint: { workflow_file_by_stage: { stg: 'deploy-stg-promote.yml' } },
          },
        },
      ],
    };

    const out = await resolveSuccessfulStgSurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      sha: 'b'.repeat(40),
      compiled,
      logger: { warn },
    });

    expect(out).toEqual(['db']);
    expect(warn).toHaveBeenCalled();
  });

  test('resolveChangedProdOnlySurfaces detects docs changes', async () => {
    const { registry } = loadDeploySurfaceRegistry({});
    const compiled = compileRegistry(registry);

    global.fetch = jest.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/commits/')) {
        return mockFetchResponse({ parents: [{ sha: 'p'.repeat(40) }] });
      }
      if (u.includes('/compare/')) {
        return mockFetchResponse({ files: [{ filename: 'docs/api/openapi.json' }] });
      }
      throw new Error(`Unexpected URL ${u}`);
    });

    const out = await resolveChangedProdOnlySurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      sha: 'c'.repeat(40),
      compiled,
      logger: { warn: jest.fn() },
    });

    expect(out).toEqual(['docs']);
  });

  test('resolveChangedProdOnlySurfaces fail-closes to prod-only surfaces on errors', async () => {
    const { registry } = loadDeploySurfaceRegistry({});
    const compiled = compileRegistry(registry);
    global.fetch = jest.fn().mockRejectedValue(new Error('api down'));

    const out = await resolveChangedProdOnlySurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      sha: 'd'.repeat(40),
      compiled,
      logger: { warn: jest.fn() },
    });

    expect(out).toEqual(['docs']);
  });

  test('resolveProdSurfaces unions stg-success and changed prod-only surfaces', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/actions/workflows/deploy-stg-promote.yml/runs')) {
        return mockFetchResponse({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
      }
      if (u.includes('/actions/workflows/')) {
        return mockFetchResponse({ workflow_runs: [] });
      }
      if (u.includes('/commits/')) {
        return mockFetchResponse({ parents: [{ sha: 'e'.repeat(40) }] });
      }
      if (u.includes('/compare/')) {
        return mockFetchResponse({ files: [{ filename: 'docs/api/openapi.json' }] });
      }
      throw new Error(`Unexpected URL ${u}`);
    });

    const out = await resolveProdSurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      sha: 'f'.repeat(40),
      surfacesInput: '',
      logger: { warn: jest.fn() },
    });

    expect(out).toEqual(['db', 'docs']);
  });

  test('resolveProdSurfaces respects explicit surfaces override', async () => {
    global.fetch = jest.fn();
    const out = await resolveProdSurfaces({
      owner: 'MasarX',
      repo: 'MasarX',
      token: '',
      sha: '1'.repeat(40),
      surfacesInput: 'portal,docs,portal',
      logger: { warn: jest.fn() },
    });

    expect(out).toEqual(['docs', 'portal']);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
