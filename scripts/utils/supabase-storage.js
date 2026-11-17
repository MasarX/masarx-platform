const { createClient } = require('@supabase/supabase-js');

function normalizeSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(err) {
  const message = String(err?.message || err?.error_description || err?.error || err || '')
    .toLowerCase()
    .trim();
  if (!message) return false;

  // Network/transient failures.
  if (
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('eai_again') ||
    message.includes('socket hang up')
  ) {
    return true;
  }

  // Fresh Supabase projects can briefly return readiness errors while storage provisions.
  if (
    message.includes('missing tenant config') ||
    message.includes('missing tenant configuration') ||
    (message.includes('tenant') && message.includes('config') && message.includes('missing'))
  ) {
    return true;
  }

  return false;
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 200, maxDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableError(err)) {
        throw err;
      }
      const delayMs =
        Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs) + Math.floor(Math.random() * 50);
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('retry failed');
}

function createServiceClient({ supabaseUrl, serviceRoleKey }) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base) throw new Error('[supabase-storage] supabaseUrl is required');
  if (!serviceRoleKey) throw new Error('[supabase-storage] serviceRoleKey is required');

  return createClient(base, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function removeStoragePathsWithClient(client, bucket, paths, { batchSize = 200 } = {}) {
  const list = Array.isArray(paths) ? paths.map(String).map((s) => s.trim()).filter(Boolean) : [];
  if (!bucket || !list.length) return { removed: 0 };

  let removed = 0;
  for (let idx = 0; idx < list.length; idx += batchSize) {
    const batch = list.slice(idx, idx + batchSize);
    const { error } = await client.storage.from(bucket).remove(batch);
    if (error) {
      const msg = error.message || error.error_description || String(error);
      throw new Error(`[supabase-storage] remove failed: ${msg}`);
    }
    removed += batch.length;
  }

  return { removed };
}

async function removeStoragePaths(
  { supabaseUrl, serviceRoleKey, bucket, paths },
  { batchSize = 200, bestEffort = false, retry } = {},
) {
  try {
    const client = createServiceClient({ supabaseUrl, serviceRoleKey });
    const exec = async () => removeStoragePathsWithClient(client, bucket, paths, { batchSize });
    return await withRetry(exec, retry);
  } catch (err) {
    if (bestEffort) return { removed: 0, error: err };
    throw err;
  }
}

async function listStorageKeysV2WithClient(
  client,
  bucket,
  prefix,
  { limit = 1000, retry, maxPages = 50 } = {},
) {
  const keys = [];
  let cursor = undefined;
  const normalizedPrefix = String(prefix || '').trim();

  for (let page = 0; page < maxPages; page += 1) {
    const exec = async () =>
      client.storage.from(bucket).listV2({
        prefix: normalizedPrefix,
        limit,
        with_delimiter: false,
        cursor,
      });
    const { data, error } = await withRetry(exec, retry);
    if (error) {
      const msg = error.message || error.error_description || String(error);
      throw new Error(`[supabase-storage] listV2 failed: ${msg}`);
    }

    const objects = Array.isArray(data?.objects) ? data.objects : [];
    for (const obj of objects) {
      const key = obj?.key;
      if (key) keys.push(String(key));
    }

    if (!data?.hasNext) break;
    const next = data?.nextCursor;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return keys;
}

async function removeStoragePrefix(
  { supabaseUrl, serviceRoleKey, bucket, prefix },
  { batchSize = 200, bestEffort = false, retry, listLimit = 1000, maxPages = 50 } = {},
) {
  try {
    const client = createServiceClient({ supabaseUrl, serviceRoleKey });
    const keys = await listStorageKeysV2WithClient(client, bucket, prefix, {
      limit: listLimit,
      retry,
      maxPages,
    });
    if (!keys.length) return { removed: 0, keys: 0 };

    const result = await removeStoragePathsWithClient(client, bucket, keys, { batchSize });
    return { ...result, keys: keys.length };
  } catch (err) {
    if (bestEffort) return { removed: 0, keys: 0, error: err };
    throw err;
  }
}

module.exports = {
  createServiceClient,
  normalizeSupabaseUrl,
  removeStoragePaths,
  removeStoragePrefix,
};
