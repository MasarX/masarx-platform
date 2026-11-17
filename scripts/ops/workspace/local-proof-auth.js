#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../../utils/load-env');

const DEFAULT_LOCAL_DEMO_PASSWORD = 'EXAMPLE_PASSWORD';
function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token || !token.startsWith('--')) continue;
    if (token.includes('=')) {
      const [flag, ...rest] = token.split('=');
      const key = flag.replace(/^--/, '');
      const value = rest.join('=');
      out[key] = value;
      const alias = key.replace(/-/g, '_');
      if (alias !== key && out[alias] === undefined) out[alias] = value;
      continue;
    }
    const key = token.replace(/^--/, '');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      const alias = key.replace(/-/g, '_');
      if (alias !== key && out[alias] === undefined) out[alias] = true;
      continue;
    }
    out[key] = next;
    const alias = key.replace(/-/g, '_');
    if (alias !== key && out[alias] === undefined) out[alias] = next;
    i += 1;
  }
  return out;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function assertLocalSupabaseUrl(rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  if (!parsed) {
    throw new Error('[local-proof-auth] Missing or invalid SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL.');
  }
  const host = String(parsed.hostname || '').trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local auth proof helper is explicitly restricted to loopback Supabase runtimes.
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) {
    throw new Error(`[local-proof-auth] Refusing non-local Supabase URL host=${host}.`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function resolveManifestPath(args = {}, cwd = process.cwd()) {
  const explicit = String(args.manifest || args['manifest-path'] || args.manifest_path || '').trim();
  const envPath = String(process.env.DEMO_ACCOUNTS_PATH || '').trim();
  return path.resolve(cwd, explicit || envPath || path.join('tmp', 'demo-accounts.json'));
}

function resolveManifestOperator(manifest, requestedEmail = '') {
  const users = Array.isArray(manifest?.users) ? manifest.users : [];
  const requested = String(requestedEmail || '').trim().toLowerCase();
  if (requested) {
    const match = users.find((user) => String(user?.email || '').trim().toLowerCase() === requested);
    if (!match) {
      throw new Error(`[local-proof-auth] Requested operator is not present in the demo manifest: ${requested}`);
    }
    return {
      email: requested,
      user_type: match?.user_type || '',
    };
  }
  const operator = users.find((user) => String(user?.user_type || '').trim().toLowerCase() === 'ops_admin')
    || users.find((user) => String(user?.user_type || '').trim().toLowerCase() === 'super_admin')
    || users.find((user) => String(user?.email || '').trim());
  if (!operator?.email) {
    throw new Error('[local-proof-auth] Demo manifest does not contain an operator account.');
  }
  return {
    email: String(operator.email).trim().toLowerCase(),
    user_type: operator?.user_type || '',
  };
}

function resolvePassword({ args = {}, env = process.env, manifest = {} } = {}) {
  const explicit = String(args.password || '').trim();
  if (explicit) return explicit;
  const envPassword = String(env.DEMO_PASSWORD || env.WORKSPACE_LOCAL_START_DEMO_PASSWORD || '').trim();
  if (envPassword) return envPassword;
  const manifestPassword = String(manifest?.password || '').trim();
  if (manifestPassword) return manifestPassword;
  return DEFAULT_LOCAL_DEMO_PASSWORD;
}

function resolveSupabaseAuthEnv(env = process.env) {
  const supabaseUrl = assertLocalSupabaseUrl(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = String(
    env.SUPABASE_ANON_KEY ||
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ''
  ).trim();
  if (!anonKey) {
    throw new Error('[local-proof-auth] Missing SUPABASE_ANON_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }
  return { supabaseUrl, anonKey };
}

function resolvePasswordGrantRetryConfig(env = process.env) {
  const maxWaitMs = parsePositiveInt(
    env.DEMO_ACCOUNTS_SIGN_IN_MAX_WAIT_MS,
    parsePositiveInt(env.DEMO_ACCOUNTS_ADMIN_PROBE_MAX_WAIT_MS, 120_000),
  );
  const retryDelayMs = parsePositiveInt(
    env.DEMO_ACCOUNTS_SIGN_IN_RETRY_DELAY_MS,
    parsePositiveInt(env.DEMO_ACCOUNTS_ADMIN_PROBE_RETRY_DELAY_MS, 2_000),
  );
  return { maxWaitMs, retryDelayMs };
}

function isRetryablePasswordGrantError(error) {
  const message = String(error?.message || error || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  const status = Number(error?.status || 0);
  if (!message && !code && !status) return false;
  return (
    code === 'invalid_credentials' ||
    message.includes('invalid login credentials') ||
    message.includes('invalid_credentials') ||
    message.includes('tenant or user not found') ||
    message.includes('temporarily unavailable') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    status === 429 ||
    status >= 500
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyPasswordGrant({
  client,
  email,
  password,
  env = process.env,
  logger = console,
} = {}) {
  if (!client?.auth?.signInWithPassword) {
    throw new Error('[local-proof-auth] client.auth.signInWithPassword is required.');
  }
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '').trim();
  if (!trimmedEmail || !trimmedPassword) {
    throw new Error('[local-proof-auth] email and password are required.');
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
      try {
        await client.auth.signOut?.();
      } catch {
        // Best-effort cleanup only.
      }
      return { attempts, retried: attempts > 1 };
    }

    lastError = result?.error || new Error('Supabase password grant returned no session.');
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (!isRetryablePasswordGrantError(lastError) || remainingMs <= 0) {
      throw lastError;
    }

    logger.warn?.(
      `[local-proof-auth] Password grant not ready (${trimmedEmail}; attempt=${attempts}; remaining_ms=${remainingMs}): ${lastError.message || lastError}`,
    );
    try {
      await client.auth.signOut?.();
    } catch {
      // Best-effort cleanup only.
    }
    await sleep(Math.min(retryDelayMs, remainingMs));
  }
}

function runProvisionDemoAccounts({
  manifestPath,
  password,
  env = process.env,
  spawnSyncImpl = spawnSync,
  cwd = process.cwd(),
} = {}) {
  const manifestRel = path.relative(cwd, manifestPath) || path.join('tmp', 'demo-accounts.json');
  const result = spawnSyncImpl(
    process.execPath || 'node',
    [
      path.join('scripts', 'ops', 'provision-demo-accounts.js'),
      '--out',
      manifestRel,
      '--password',
      password,
    ],
    {
      cwd,
      env: {
        ...env,
        DEMO_ACCOUNTS_PROVISION_GUARD: 'enabled',
        DEMO_PASSWORD: password,
      },
      encoding: 'utf8',
    },
  );
  const code = typeof result.status === 'number' ? result.status : 1;
  if (code !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(
      `[local-proof-auth] Demo account bootstrap failed with code ${code}${details ? `: ${details}` : ''}`,
    );
  }
  return { code, manifestRel };
}

async function runLocalProofAuth(options = {}) {
  const args = options.args || parseArgs(options.argv || process.argv.slice(2));
  const cwd = options.cwd || process.cwd();
  const envFile = String(args['env-file'] || args.env_file || process.env.ENV_FILE || '').trim()
    || path.join('config', 'env', '.env.local');
  if (!process.env.ENV_FILE && fs.existsSync(path.resolve(cwd, envFile))) {
    process.env.ENV_FILE = envFile;
  }
  loadEnv();

  const manifestPath = resolveManifestPath(args, cwd);
  let manifest = readJson(manifestPath);
  const password = resolvePassword({ args, env: process.env, manifest });

  if (isTruthy(args.bootstrap)) {
    runProvisionDemoAccounts({
      manifestPath,
      password,
      env: {
        ...process.env,
        ENV_FILE: process.env.ENV_FILE || envFile,
      },
      spawnSyncImpl: options.spawnSyncImpl || spawnSync,
      cwd,
    });
    manifest = readJson(manifestPath);
  }

  if (!manifest) {
    throw new Error(`[local-proof-auth] Demo account manifest missing or invalid: ${manifestPath}`);
  }

  const operator = resolveManifestOperator(manifest, args.email);
  const { supabaseUrl, anonKey } = resolveSupabaseAuthEnv(process.env);
  const createClientImpl = options.createClientImpl || createClient;
  const client = createClientImpl(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const result = await verifyPasswordGrant({
    client,
    email: operator.email,
    password,
    env: process.env,
    logger: options.logger || console,
  });

  const summary = {
    event: 'local_operator_auth_proof_ok',
    email: operator.email,
    user_type: operator.user_type || null,
    manifest: path.relative(cwd, manifestPath),
    supabase_url: supabaseUrl,
    attempts: result.attempts,
    retried: result.retried,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  runLocalProofAuth().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_LOCAL_DEMO_PASSWORD,
  assertLocalSupabaseUrl,
  isRetryablePasswordGrantError,
  parseArgs,
  resolveManifestOperator,
  resolveManifestPath,
  resolvePassword,
  resolvePasswordGrantRetryConfig,
  resolveSupabaseAuthEnv,
  runLocalProofAuth,
  runProvisionDemoAccounts,
  verifyPasswordGrant,
};
