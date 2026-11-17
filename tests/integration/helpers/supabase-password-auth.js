const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePasswordGrantRetryConfig(env = process.env) {
  const maxWaitMs = parsePositiveInt(
    env.DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS,
    parsePositiveInt(env.DEMO_ACCOUNTS_ADMIN_PROBE_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS),
  );
  const retryDelayMs = parsePositiveInt(
    env.DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS,
    parsePositiveInt(env.DEMO_ACCOUNTS_ADMIN_PROBE_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  );
  return { maxWaitMs, retryDelayMs };
}

function isRetryablePasswordGrantError(error) {
  const message = String(error?.message || error || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  const status = Number(error?.status || 0);
  if (!message && !code && !status) return false;
  // Preview auth propagation can surface as an initial invalid-credentials
  // response immediately after provisioning or password reset.
  return (
    code === 'invalid_credentials'
    || message.includes('invalid login credentials')
    || message.includes('invalid_credentials')
    || message.includes('tenant or user not found')
    || message.includes('temporarily unavailable')
    || message.includes('fetch failed')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || status === 429
    || status >= 500
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function signInWithPasswordWithRetry({
  client,
  email,
  password,
  env = process.env,
  logger = console,
} = {}) {
  if (!client?.auth?.signInWithPassword) {
    throw new Error('[supabase-password-auth] client.auth.signInWithPassword is required');
  }
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '').trim();
  if (!trimmedEmail || !trimmedPassword) {
    throw new Error('[supabase-password-auth] email and password are required');
  }

  const { maxWaitMs, retryDelayMs } = resolvePasswordGrantRetryConfig(env);
  const deadlineAt = Date.now() + maxWaitMs;
  let attempts = 0;
  let lastError = null;

  while (true) {
    attempts += 1;
    const result = await client.auth.signInWithPassword({
      email: trimmedEmail,
      password: trimmedPassword,
    });
    if (!result?.error && result?.data?.session) {
      return {
        ...result,
        attempts,
        retried: attempts > 1,
      };
    }

    lastError = result?.error || new Error('Supabase password grant returned no session.');
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (!isRetryablePasswordGrantError(lastError) || remainingMs <= 0) {
      throw lastError;
    }

    logger.warn?.(
      `[supabase-password-auth] Password grant transiently unavailable (${trimmedEmail}; attempt=${attempts}; remaining_ms=${remainingMs}): ${lastError.message || lastError}`,
    );
    try {
      await client.auth.signOut();
    } catch {
      // Best-effort cleanup only.
    }
    await sleep(Math.min(retryDelayMs, remainingMs));
  }
}

module.exports = {
  resolvePasswordGrantRetryConfig,
  isRetryablePasswordGrantError,
  signInWithPasswordWithRetry,
};
