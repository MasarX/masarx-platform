const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  ensureStorageBucket,
  isStorageAuthFailure,
} = require('./storage-admin');

loadEnv();

let cachedProbe = null;

async function probeStorageAuth({ force = false } = {}) {
  if (!force && cachedProbe) return cachedProbe;

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceToken = require('./storage-admin').resolveStorageAdminKey();

  if (!supabaseUrl || !serviceToken) {
    cachedProbe = {
      ready: false,
      skipped: true,
      reason: 'missing_env',
      status: 0,
      message: 'SUPABASE_URL/storage admin key missing',
    };
    return cachedProbe;
  }

  try {
    await ensureStorageBucket({
      supabaseUrl,
      bucket: 'labels',
      storageAdminKey: serviceToken,
    });

    cachedProbe = {
      ready: true,
      status: 200,
      message: 'ok',
      signatureFailure: false,
      bucket: 'labels',
      ensured: true,
    };
    return cachedProbe;
  } catch (error) {
    const message = String(error?.message || error || 'storage probe failed');
    const status = Number(error?.storageStatus || 0);
    cachedProbe = {
      ready: false,
      status,
      message,
      signatureFailure: isStorageAuthFailure(status, message),
    };
    return cachedProbe;
  }
}

module.exports = {
  probeStorageAuth,
  isStorageSignatureFailure: isStorageAuthFailure,
};
