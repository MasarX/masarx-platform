const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { resolveStorageAdminKey } = require('./storage-admin');

loadEnv();

let cachedServiceClient = null;

function getServiceClient() {
  if (cachedServiceClient) return cachedServiceClient;
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = resolveStorageAdminKey();
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  cachedServiceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedServiceClient;
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const unique = new Set();
  for (const entry of paths) {
    const value = String(entry || '').trim();
    if (value) unique.add(value);
  }
  return Array.from(unique);
}

function isNotFoundMessage(message) {
  return /not found|resource.*not exist|does not exist/i.test(String(message || ''));
}

async function removeStoragePaths({ bucket, paths, chunkSize = 100, ignoreMissing = true } = {}) {
  const bucketId = String(bucket || '').trim();
  const normalized = normalizePaths(paths);
  if (!bucketId || !normalized.length) {
    return { requested: normalized.length, removed: 0, skipped: true };
  }

  const client = getServiceClient();
  if (!client) {
    return { requested: normalized.length, removed: 0, skipped: true, reason: 'missing_service_client' };
  }

  const safeChunkSize = Math.max(1, Number(chunkSize) || 100);
  let removed = 0;
  for (let offset = 0; offset < normalized.length; offset += safeChunkSize) {
    const chunk = normalized.slice(offset, offset + safeChunkSize);
    const { data, error } = await client.storage.from(bucketId).remove(chunk);
    if (error) {
      if (ignoreMissing && isNotFoundMessage(error.message || error.error_description)) {
        continue;
      }
      throw new Error(`storage cleanup failed for bucket ${bucketId}: ${error.message || String(error)}`);
    }
    if (Array.isArray(data)) {
      removed += data.length;
    } else {
      removed += chunk.length;
    }
  }

  return { requested: normalized.length, removed };
}

module.exports = {
  removeStoragePaths,
};
