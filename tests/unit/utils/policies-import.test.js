describe('test helper policies import behavior', () => {
  const envKeys = ['DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_POOLER'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  afterEach(async () => {
    for (const key of envKeys) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('does not create a pool at import time when all DB env vars are missing', async () => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../utils/policies');

    expect(helper.pool).toBeNull();
    await expect(
      helper.upsertSettings('pod_policy', 'global', null, {}, 'unit-test'),
    ).rejects.toThrow(
      '[tests/utils/policies] DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER is required when no explicit client is provided',
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  test('initializes exported pool when a DB env var exists', async () => {
    process.env.DATABASE_URL = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));

    const helper = require('../../utils/policies');

    expect(helper.pool).toBeTruthy();
    await helper.pool.end();
  });

  test('normalizes pod_policy shorthand overrides to the canonical stored shape', () => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../utils/policies');

    expect(
      helper.normalizePodPolicy({
        enabled: true,
        completed: {
          photo_required: false,
          signature_required: true,
          min_artifact_count: 0,
        },
        exception: {
          min_artifact_count: 1,
        },
        binary_evidence: {
          storage_bucket: 'fieldops-evidence',
          max_items: 3,
        },
      }),
    ).toEqual({
      enabled: true,
      requirements: {
        completed: {
          photo_required: false,
          signature_required: true,
          min_artifact_count: 0,
        },
        exception: {
          min_artifact_count: 1,
        },
      },
      binary_evidence: {
        bucket_id: 'fieldops-evidence',
        max_items: 3,
      },
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  test('merges shorthand pod_policy overrides into canonical requirements branches', () => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../utils/policies');

    expect(
      helper.normalizePodPolicy({
        requirements: {
          completed: {
            photo_required: true,
          },
          exception: {
            exception_reason_required: true,
          },
        },
        completed: {
          signature_required: true,
        },
        exception: {
          notes_required_for_other: false,
        },
      }),
    ).toEqual({
      requirements: {
        completed: {
          photo_required: true,
          signature_required: true,
        },
        exception: {
          exception_reason_required: true,
          notes_required_for_other: false,
        },
      },
    });
  });

  test('keeps canonical binary_evidence.bucket_id when legacy storage_bucket is also provided', () => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../utils/policies');

    expect(
      helper.normalizePodPolicy({
        binary_evidence: {
          bucket_id: 'canonical-bucket',
          storage_bucket: 'legacy-bucket',
          max_items: 2,
        },
      }),
    ).toEqual({
      binary_evidence: {
        bucket_id: 'canonical-bucket',
        max_items: 2,
      },
    });
  });
});
