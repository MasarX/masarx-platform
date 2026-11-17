const { loadEnv } = require('../../scripts/utils/load-env');
const { attachPoolErrorGuard } = require('../../scripts/utils/pg-pool-guard');

// Load env for integration tests (DATABASE_URL, SUPABASE_URL, etc.)
loadEnv();
attachPoolErrorGuard();

// Keep long-running integration tests reasonable
jest.setTimeout(Number(process.env.JEST_TIMEOUT || 90000));

// Allow transient cloud/database failures (e.g., brief restarts) to be retried
// without masking real, deterministic test failures. Opt-in via env so local
// runs can choose between speed and resilience.
const retryRaw = process.env.JEST_RETRY_TIMES;
const retryTimes = retryRaw ? Number(retryRaw) : 1;
if (Number.isFinite(retryTimes) && retryTimes > 1) {
  jest.retryTimes(retryTimes, { logErrorsBeforeRetry: true });
}

