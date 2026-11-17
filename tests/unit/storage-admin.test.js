const { afterEach, beforeEach, describe, expect, test } = require('@jest/globals');
const {
  resolveStorageAdminKey,
  resolveStorageAdminKeyCandidates,
  requestStorageWithAuthCandidates,
  ensureStorageBucket,
} = require('../integration/helpers/storage-admin');

const makeResponse = (status, body, headers = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('storage-admin helper', () => {
  const envKeys = [
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'STORAGE_FETCH_ATTEMPTS',
    'E2E_HTTP_RETRY_ATTEMPTS',
    'STORAGE_FETCH_BASE_DELAY_MS',
    'E2E_HTTP_RETRY_BASE_DELAY_MS',
    'STORAGE_FETCH_MAX_DELAY_MS',
    'E2E_HTTP_RETRY_MAX_DELAY_MS',
  ];

  const snapshot = {};
  const originalFetch = global.fetch;

  beforeEach(() => {
    for (const key of envKeys) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    global.fetch = jest.fn();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('resolveStorageAdminKey prefers compact JWT candidates over non-JWT secrets', () => {
    process.env.SUPABASE_SECRET_KEY = 'invalid_secret_not_jwt';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJh.eyJzdWIiOiJzZXJ2aWNlIn0.validsig';
    process.env.SERVICE_ROLE_KEY = ([Buffer.from("{\"d.norequest").toString("base64url"),Buffer.from("id").toString("base64url"),"sig"].join("."));

    const candidates = resolveStorageAdminKeyCandidates();
    const selected = resolveStorageAdminKey();

    expect(candidates[0]).toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(candidates.slice(0, 3)).toEqual([
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.SERVICE_ROLE_KEY,
      process.env.SUPABASE_SECRET_KEY,
    ]);
    expect(selected).toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
  });

  test('requestStorageWithAuthCandidates falls back to next key after auth signature failure', async () => {
    process.env.STORAGE_FETCH_ATTEMPTS = '4';
    process.env.STORAGE_FETCH_BASE_DELAY_MS = '1';
    process.env.STORAGE_FETCH_MAX_DELAY_MS = '1';
    process.env.E2E_HTTP_RETRY_ATTEMPTS = '4';
    process.env.E2E_HTTP_RETRY_BASE_DELAY_MS = '1';
    process.env.E2E_HTTP_RETRY_MAX_DELAY_MS = '1';

    const badResp = makeResponse(401, 'invalid compact jws');
    const goodResp = makeResponse(200, 'ok');
    global.fetch
      .mockResolvedValueOnce(badResp)
      .mockResolvedValueOnce(goodResp);

    const result = await requestStorageWithAuthCandidates({
      url: 'https://example.test/storage/v1/bucket',
      init: { method: 'POST', headers: { 'content-type': 'application/json' } },
      options: {
        storageAdminKeyCandidates: ['bad-token', 'eyJo.ZXh0.m9J9'],
        allowFallbackOnStorageAuthError: true,
        fetchAttempts: 1,
      },
    });

    expect(result.storageAdminKey).toBe('eyJo.ZXh0.m9J9');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('requestStorageWithAuthCandidates always sets authorization header for non-JWT key candidates', async () => {
    const okResp = makeResponse(200, 'ok');
    global.fetch.mockResolvedValueOnce(okResp);

    await requestStorageWithAuthCandidates({
      url: 'https://example.test/storage/v1/bucket',
      init: { method: 'POST', headers: { 'content-type': 'application/json' } },
      options: {
        storageAdminKeyCandidates: ['non-jwt-secret-key'],
        fetchAttempts: 1,
      },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = global.fetch.mock.calls[0];
    expect(requestInit.headers.authorization).toBe('Bearer non-jwt-secret-key');
    expect(requestInit.headers.apikey).toBe('non-jwt-secret-key');
  });

  test('requestStorageWithAuthCandidates falls back when storage API reports missing authorization header', async () => {
    const missingAuthResp = makeResponse(
      400,
      JSON.stringify({
        statusCode: '400',
        error: 'Error',
        message: "headers must have required property 'authorization'",
      }),
    );
    const okResp = makeResponse(200, 'ok');
    global.fetch
      .mockResolvedValueOnce(missingAuthResp)
      .mockResolvedValueOnce(okResp);

    const result = await requestStorageWithAuthCandidates({
      url: 'https://example.test/storage/v1/bucket',
      init: { method: 'POST', headers: { 'content-type': 'application/json' } },
      options: {
        storageAdminKeyCandidates: ['bad-key', 'good-key'],
        allowFallbackOnStorageAuthError: true,
        fetchAttempts: 1,
      },
    });

    expect(result.storageAdminKey).toBe('good-key');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('requestStorageWithAuthCandidates returns tolerated duplicate response without throwing', async () => {
    const duplicateResp = makeResponse(
      409,
      JSON.stringify({ error: 'Duplicate', message: 'The resource already exists' }),
    );
    global.fetch.mockResolvedValueOnce(duplicateResp);

    const result = await requestStorageWithAuthCandidates({
      url: 'https://example.test/storage/v1/bucket',
      init: { method: 'POST', headers: { 'content-type': 'application/json' } },
      options: {
        storageAdminKeyCandidates: ['eyJo.ZXh0.m9J9'],
        tolerateStatuses: [409],
        fetchAttempts: 1,
      },
    });

    expect(result.resp.status).toBe(409);
    expect(result.toleratedStatus).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('ensureStorageBucket accepts duplicate bucket response as success', async () => {
    const duplicateResp = makeResponse(
      400,
      JSON.stringify({
        statusCode: '409',
        error: 'Duplicate',
        message: 'The resource already exists',
      }),
    );
    global.fetch.mockResolvedValueOnce(duplicateResp);

    await expect(
      ensureStorageBucket({
        supabaseUrl: 'https://example.test',
        bucket: 'labels',
        storageAdminKeyCandidates: ['eyJo.ZXh0.m9J9'],
      }),
    ).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
