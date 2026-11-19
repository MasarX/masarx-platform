#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const { loadEnv } = require('../../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../../utils/resolve-db-url');
const { upsertSettings } = require('../../utils/settings-upsert');
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
const AUTH_EMAIL_URL_POLICY_CATEGORY = 'auth_email_url_policy';
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

function normalizeStringList(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return Array.from(
    new Set(
      input
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeRepoRelativePath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  const relative = path.relative(process.cwd(), resolved);
  const normalized = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : raw;
  return normalized.replace(/\\/g, '/');
}

function resolveAuditStatus(summary = {}) {
  const issues = Array.isArray(summary.issues) ? summary.issues : [];
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  if (summary.ok === false || issues.length > 0) return 'red';
  if (warnings.length > 0) return 'yellow';
  return 'green';
}

function buildAuthEmailPolicyMirrorEntry(summary = {}) {
  const environment = String(summary.environment || '').trim().toLowerCase();
  if (!environment) {
    throw new Error('[auth-email-url-audit] Mirror payload requires summary.environment.');
  }

  const policy = summary.policy && typeof summary.policy === 'object'
    ? summary.policy
    : {};
  const siteUrl = String(policy.site_url || '').trim();
  const redirectUrls = normalizeStringList(policy.additional_redirect_urls);
  const bannedRedirectHosts = normalizeStringList(policy.banned_redirect_hosts);
  const sourceFile = normalizeRepoRelativePath(
    summary.policy_path || `config/ops/auth-email-url-policy.${environment}.json`,
  );
  const issues = Array.isArray(summary.issues) ? summary.issues.slice() : [];
  const warnings = Array.isArray(summary.warnings) ? summary.warnings.slice() : [];

  return {
    env: environment,
    callback_urls: siteUrl ? [siteUrl] : [],
    redirect_urls: redirectUrls,
    source_file: sourceFile,
    last_audit_at: summary.generated_at || null,
    audit_status: resolveAuditStatus(summary),
    policy: {
      environment,
      site_url: siteUrl,
      additional_redirect_urls: redirectUrls,
      banned_redirect_hosts: bannedRedirectHosts,
    },
    metadata: {
      source: sourceFile,
      project_ref: String(summary.project_ref || '').trim(),
      actual: summary.actual && typeof summary.actual === 'object' ? { ...summary.actual } : {},
      ok: summary.ok === true,
      issues,
      warnings,
      read_attempts: Number(summary.read_attempts || 0),
      read_retried: summary.read_retried === true,
      read_retry_window_ms: Number(summary.read_retry_window_ms || 0),
    },
  };
}

function mergeAuthEmailUrlPolicySetting(currentValue = {}, nextEntry = {}) {
  const environment = String(nextEntry.env || '').trim().toLowerCase();
  if (!environment) {
    throw new Error('[auth-email-url-audit] Mirror entry requires env.');
  }

  const base = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
    ? currentValue
    : {};
  const existingPolicies = Array.isArray(base.policies) ? base.policies : [];
  let replaced = false;
  const policies = existingPolicies.map((entry) => {
    const entryEnv = String(entry && entry.env ? entry.env : '').trim().toLowerCase();
    if (entryEnv !== environment) return entry;
    replaced = true;
    return nextEntry;
  });
  if (!replaced) policies.push(nextEntry);

  return {
    ...base,
    version: Number.isInteger(base.version) && base.version > 0 ? base.version : 1,
    policies,
  };
}

function getPgPoolCtor() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`[auth-email-url-audit] Missing pg dependency required for --mirror-to-db: ${message}`);
  }
}

async function readCurrentAuthEmailPolicySetting(db) {
  const result = await db.query(
    `SELECT s.cached_value
       FROM public.settings s
      WHERE s.category = $1
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
      LIMIT 1`,
    [AUTH_EMAIL_URL_POLICY_CATEGORY],
  );
  return result.rowCount > 0 && result.rows[0].cached_value
    ? result.rows[0].cached_value
    : {};
}

async function mirrorAuthEmailAuditToDb({
  summary,
  resolveDatabaseUrl = resolveDatabaseUrlWithFallback,
  poolCtor,
} = {}) {
  if (!summary || typeof summary !== 'object') {
    throw new Error('[auth-email-url-audit] summary is required for --mirror-to-db.');
  }

  const dbResolution = await resolveDatabaseUrl({
    env: process.env,
    logger: console,
    label: 'auth-email-url-audit',
    connectionTimeoutEnv: 'AUTH_EMAIL_URL_AUDIT_DB_CONNECT_TIMEOUT_MS',
    maxWaitEnv: 'AUTH_EMAIL_URL_AUDIT_DB_CONNECT_MAX_WAIT_MS',
    retryDelayEnv: 'AUTH_EMAIL_URL_AUDIT_DB_CONNECT_RETRY_DELAY_MS',
  });

  const Pool = poolCtor || getPgPoolCtor();
  const pool = new Pool({ connectionString: dbResolution.dsn });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const currentValue = await readCurrentAuthEmailPolicySetting(db);
    const nextEntry = buildAuthEmailPolicyMirrorEntry(summary);
    const nextValue = mergeAuthEmailUrlPolicySetting(currentValue, nextEntry);
    const writeResult = await upsertSettings({
      db,
      category: AUTH_EMAIL_URL_POLICY_CATEGORY,
      scopeType: 'global',
      value: nextValue,
      changeReason: `Mirror auth email URL audit result for ${nextEntry.env}`,
    });
    await db.query('COMMIT');
    return {
      category: AUTH_EMAIL_URL_POLICY_CATEGORY,
      environment: nextEntry.env,
      db_candidate: dbResolution.candidateName,
      db_attempts: dbResolution.attempts,
      settings_version_id: writeResult.settingsVersionId,
      settings_version_number: writeResult.settingsVersionNumber,
    };
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // best-effort rollback only
    }
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
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
  console.log('  --mirror-to-db                Also mirror this audit result into auth_email_url_policy settings');
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

  if (args.mirror_to_db || args['mirror-to-db']) {
    summary.mirror_to_db = await mirrorAuthEmailAuditToDb({ summary });
    writeJson(summaryPath, summary);
  }

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
  normalizeRepoRelativePath,
  resolveAuditStatus,
  buildAuthEmailPolicyMirrorEntry,
  mergeAuthEmailUrlPolicySetting,
  readCurrentAuthEmailPolicySetting,
  mirrorAuthEmailAuditToDb,
  isRetryableAuthConfigReadError,
  readProjectAuthConfigWithRetries,
};
