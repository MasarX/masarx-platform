#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const { loadEnv } = require('../../utils/load-env');
const { getProjectAuthConfig } = require('../workspace/supabase-api');
const {
  resolveEnvironment,
  resolvePolicyPath,
  evaluateAuthEmailUrlConfig,
  readPolicyConfig,
  writeJson,
} = require('../auth/auth-email-url-policy');

const DEFAULT_SUMMARY_PATH = path.resolve(
  process.cwd(),
  'tmp',
  'auth-email-url-audit-summary.json',
);
const DEFAULT_AUTH_CONFIG_READ_MAX_WAIT_MS = 120_000;
const DEFAULT_AUTH_CONFIG_READ_RETRY_DELAY_MS = 5_000;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    json: false,
  };
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
  out.json = Boolean(out.json);
  return out;
}

function resolveProjectRef(args = {}, env = process.env) {
  const explicit = String(args['af38b526-f5c1-468d-88fb-86677fbe872a'] || args.project_ref || '').trim();
  if (explicit) return explicit;
  const fromEnv = String(env.SUPABASE_PROJECT_ID || '').trim();
  if (fromEnv) return fromEnv;
  throw new Error('[auth-email-url-audit] Missing SUPABASE_PROJECT_ID (or pass --af38b526-f5c1-468d-88fb-86677fbe872a).');
}

function resolveSummaryPath(args = {}) {
  const explicit = String(args['summary-out'] || args.summary_out || '').trim();
  if (explicit) return path.resolve(process.cwd(), explicit);
  return DEFAULT_SUMMARY_PATH;
}

function parsePositiveMs(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

function resolveReadRetryOptions(args = {}, env = process.env) {
  const maxWaitMs = parsePositiveMs(
    args['read-max-wait-ms']
      || args.read_max_wait_ms
      || env.AUTH_EMAIL_URL_AUDIT_READ_MAX_WAIT_MS,
    DEFAULT_AUTH_CONFIG_READ_MAX_WAIT_MS,
  );
  const retryDelayMs = parsePositiveMs(
    args['read-retry-delay-ms']
      || args.read_retry_delay_ms
      || env.AUTH_EMAIL_URL_AUDIT_READ_RETRY_DELAY_MS,
    DEFAULT_AUTH_CONFIG_READ_RETRY_DELAY_MS,
  );
  return {
    maxWaitMs,
    retryDelayMs: Math.min(retryDelayMs, maxWaitMs),
  };
}

function sleep(ms) {
  const n = Number(ms || 0);
  if (!n || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function isRetryableAuthConfigReadError(error) {
  const status = Number(error?.status || 0);
  if ([408, 409, 423, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('unable to fetch project auth config') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket')
  );
}

async function readProjectAuthConfigWithRetries({
  projectRef,
  token,
  maxWaitMs = DEFAULT_AUTH_CONFIG_READ_MAX_WAIT_MS,
  retryDelayMs = DEFAULT_AUTH_CONFIG_READ_RETRY_DELAY_MS,
  fetchAuthConfig = getProjectAuthConfig,
  sleepFn = sleep,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
  let attempts = 0;
  let lastError;

  while (true) {
    attempts += 1;
    try {
      const current = await fetchAuthConfig(projectRef, token);
      return {
        current,
        attempts,
        retried: attempts > 1,
      };
    } catch (error) {
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (!isRetryableAuthConfigReadError(error) || remainingMs <= 0) {
        throw error;
      }
      await sleepFn(Math.min(Math.max(1, Number(retryDelayMs) || 0), remainingMs));
    }
  }
}

function printUsage() {
  console.log('Usage: node scripts/ops/audit/auth-email-url-audit.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --environment <dev|stg|prod>  Target environment (default: inferred from DEPLOY_ENV)');
  console.log('  --policy <path>               Policy file path (default: config/ops/auth-email-url-policy.<env>.json)');
  console.log('  --af38b526-f5c1-468d-88fb-86677fbe872a <ref>           Supabase project ref (default: SUPABASE_PROJECT_ID)');
  console.log('  --summary-out <path>          Summary output path');
  console.log('  --read-max-wait-ms <ms>       Max wait window for transient auth-config read retries');
  console.log('  --read-retry-delay-ms <ms>    Retry delay for transient auth-config read retries');
  console.log('  --json                        Print JSON summary to stdout');
  console.log('  --help, -h                    Show usage');
}

async function main() {
  try {
    loadEnv();
  } catch {
    // best-effort only
  }

  const args = parseArgs();
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const environment = resolveEnvironment(args, process.env);
  const policyPath = resolvePolicyPath(environment, args.policy);
  const projectRef = resolveProjectRef(args, process.env);
  const readRetryOptions = resolveReadRetryOptions(args, process.env);
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  if (!token) {
    throw new Error('[auth-email-url-audit] Missing SUPABASE_ACCESS_TOKEN.');
  }

  const policyRaw = readPolicyConfig(policyPath);
  const readResult = await readProjectAuthConfigWithRetries({
    projectRef,
    token,
    maxWaitMs: readRetryOptions.maxWaitMs,
    retryDelayMs: readRetryOptions.retryDelayMs,
  });
  const current = readResult.current;
  const evaluation = evaluateAuthEmailUrlConfig({
    policy: policyRaw,
    actual: current,
    expectedEnvironment: environment,
  });

  const summary = {
    generated_at: new Date().toISOString(),
    environment,
    project_ref: projectRef,
    policy_path: policyPath,
    read_attempts: readResult.attempts,
    read_retried: readResult.retried,
    read_retry_window_ms: readRetryOptions.maxWaitMs,
    ok: evaluation.ok,
    issues: evaluation.issues,
    warnings: evaluation.warnings,
    actual: {
      site_url: evaluation.actual.site_url,
      additional_redirect_urls: evaluation.actual.additional_redirect_urls,
      source: evaluation.actual.source,
    },
    policy: {
      site_url: evaluation.policy.site_url,
      additional_redirect_urls: evaluation.policy.additional_redirect_urls,
      banned_redirect_hosts: evaluation.policy.banned_redirect_hosts,
    },
  };

  const summaryPath = resolveSummaryPath(args);
  writeJson(summaryPath, summary);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[auth-email-url-audit] Summary written to ${summaryPath}`);
    if (!summary.ok) {
      console.log(`[auth-email-url-audit] FAIL (${summary.issues.length} issues)`);
      for (const issue of summary.issues) console.log(`- ${issue}`);
    } else {
      console.log('[auth-email-url-audit] PASS');
    }
    if (summary.warnings.length > 0) {
      console.log(`[auth-email-url-audit] WARN (${summary.warnings.length})`);
      for (const warning of summary.warnings) console.log(`- ${warning}`);
    }
  }

  if (!summary.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parsePositiveMs,
  parseArgs,
  resolveReadRetryOptions,
  resolveProjectRef,
  resolveSummaryPath,
  isRetryableAuthConfigReadError,
  readProjectAuthConfigWithRetries,
};
