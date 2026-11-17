#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { parseFlagArgs } = require('../../utils/cli-args');
const { loadEnv } = require('../../utils/load-env');

const DEFAULT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

function die(msg) {
  console.error(`[with-full-preview-stack] ${msg}`);
  process.exit(1);
}

function writeJson(targetPath, payload) {
  const fullPath = path.resolve(String(targetPath || '').trim());
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return fullPath;
}

function resolvePreviewStackMaxBufferBytes({
  env = process.env,
  maxBufferBytes,
  fallbackBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  const explicitBytes = Number(maxBufferBytes);
  if (Number.isFinite(explicitBytes) && explicitBytes > 0) {
    return Math.floor(explicitBytes);
  }

  const envBytes = Number(String(env?.PREVIEW_STACK_MAX_BUFFER_BYTES || '').trim());
  if (Number.isFinite(envBytes) && envBytes >= 1024 * 1024) {
    return Math.floor(envBytes);
  }

  return fallbackBytes;
}

function runPreviewStackCommand(
  cmd,
  args,
  { cwd = process.cwd(), env = process.env, label = cmd, maxBufferBytes } = {},
) {
  const resolvedMaxBufferBytes = resolvePreviewStackMaxBufferBytes({ env, maxBufferBytes });
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: resolvedMaxBufferBytes,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const logDir = path.resolve(cwd, '.tmp', 'preview-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const safeLabel = String(label || cmd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'step';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `${safeLabel}-${ts}.log`);
  fs.writeFileSync(logPath, output || '', 'utf8');

  const verbose = /^(1|true|yes|on)$/i.test(String(env?.PREVIEW_STACK_VERBOSE || '').trim());
  const lines = output ? output.split(/\r?\n/) : [];
  if (verbose && output) {
    process.stdout.write(output);
  } else {
    console.log(
      `[with-full-preview-stack] ${label}: output saved to ${path.relative(cwd, logPath)} (${lines.length} lines)`,
    );
  }

  if (res.error) {
    if (res.error.code === 'ENOBUFS') {
      const error = new Error(
        `${label} failed: child output exceeded maxBuffer=${resolvedMaxBufferBytes} bytes (log: ${path.relative(cwd, logPath)})`,
      );
      error.code = res.error.code;
      error.logPath = logPath;
      error.exitCode = typeof res.status === 'number' ? res.status : null;
      error.maxBufferBytes = resolvedMaxBufferBytes;
      throw error;
    }
    const error = new Error(`${label} failed: ${res.error.message}`);
    error.logPath = logPath;
    error.exitCode = typeof res.status === 'number' ? res.status : null;
    throw error;
  }
  if (res.status !== 0) {
    const tail = lines.slice(Math.max(0, lines.length - 160)).join('\n');
    if (tail) {
      console.error(`[with-full-preview-stack] ${label}: failure tail (last ${Math.min(160, lines.length)} lines)`);
      process.stderr.write(`${tail}\n`);
    }
    const error = new Error(`${label} failed with exit ${res.status} (log: ${path.relative(cwd, logPath)})`);
    error.logPath = logPath;
    error.exitCode = res.status;
    throw error;
  }

  return {
    logPath,
    outputLineCount: lines.length,
  };
}

function resolveHeadSha(cwd = process.cwd()) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(`Unable to resolve HEAD sha: ${res.error ? res.error.message : res.stderr || res.stdout}`);
  }
  return String(res.stdout || '').trim();
}

function resolveWorktreeId(args) {
  const explicit = String(args.id || '').trim();
  if (explicit) return explicit;
  const envId = String(process.env.WORKER_ID || '').trim();
  if (envId) return envId;
  return 'local-worker';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function upsertEnvFileVariable({ envPath, key, value }) {
  const filePath = path.resolve(process.cwd(), String(envPath || '').trim());
  const envKey = String(key || '').trim();
  const envValue = String(value || '').trim();
  if (!filePath || !envKey || !envValue) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${escapeRegExp(envKey)}\\s*=`);
  const nextLines = [];
  let replaced = false;
  for (const line of lines) {
    if (pattern.test(line)) {
      if (!replaced) {
        nextLines.push(`${envKey}=${shellQuote(envValue)}`);
        replaced = true;
      }
      continue;
    }
    nextLines.push(line);
  }
  if (!replaced) {
    nextLines.push(`${envKey}=${shellQuote(envValue)}`);
  }
  const normalized = nextLines.join('\n').replace(/\n+$/g, '\n');
  fs.writeFileSync(filePath, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8');
  console.log(`[with-full-preview-stack] Persisted ${envKey} to ${path.relative(process.cwd(), filePath)}.`);
}

function deriveVercelAutomationBypassSecret({ token }) {
  const digestHex = crypto
    .createHash('sha256')
    .update(`masarx-preview-automation-bypass:${String(token || '')}`)
    .digest('hex');
  // Vercel requires 32 alphanumeric characters for generate.secret.
  return digestHex.slice(0, 32);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function sleep(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveVercelBypassRetryConfig(env = process.env) {
  return {
    attempts: parsePositiveInt(env.VERCEL_BYPASS_RETRY_ATTEMPTS, 3),
    delayMs: parseNonNegativeInt(env.VERCEL_BYPASS_RETRY_DELAY_MS, 10000),
  };
}

function isTransientVercelBypassError(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return [
    'fetch failed',
    'network',
    'timeout',
    'timedout',
    'econnreset',
    'etimedout',
    'eai_again',
    'socket hang up',
    'client network socket disconnected',
  ].some((needle) => message.includes(needle));
}

function isTransientVercelBypassResult(result) {
  const status = Number(result && result.status ? result.status : 0);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function buildOrchestrateCommonArgs({ orchestratePath, worktreeId, sha, manifestPath, requiredSurfaces = '' }) {
  const list = [
    orchestratePath,
    '--topology', 'worktree',
    '--id', worktreeId,
    '--sha', sha,
    '--manifest', manifestPath,
  ];
  const normalizedRequiredSurfaces = String(requiredSurfaces || '').trim();
  if (normalizedRequiredSurfaces) {
    list.push('--required-surfaces', normalizedRequiredSurfaces);
  }
  return list;
}

function resolvePreviewStackSummaryPath({ args, worktreeId, sha }) {
  return path.resolve(
    process.cwd(),
    String(args['summary-out'] || `.tmp/preview-manifests/worktree-${worktreeId}-${sha}.summary.json`),
  );
}

async function patchProjectProtectionBypass({
  projectId,
  teamId,
  token,
  body,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available (Node >= 18.17 / 20 recommended)');
  }
  const id = String(projectId || '').trim();
  const team = String(teamId || '').trim();
  const bearer = String(token || '').trim();
  if (!id || !team || !bearer) {
    throw new Error('Missing projectId/teamId/token for Vercel protection bypass call');
  }
  const url = new URL(`https://api.vercel.com/v1/projects/${encodeURIComponent(id)}/protection-bypass`);
  url.searchParams.set('teamId', team);
  const res = await fetchImpl(url.toString(), {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'user-agent': 'masarx-preview-stack/1.0',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    ok: Boolean(res.ok),
    status: Number(res.status || 0),
    json,
    text,
  };
}

async function patchProjectProtectionBypassWithRetry(options = {}) {
  const retryConfig = resolveVercelBypassRetryConfig(options.env || process.env);
  let lastError = null;
  for (let attempt = 1; attempt <= retryConfig.attempts; attempt += 1) {
    try {
      const result = await patchProjectProtectionBypass(options);
      if (attempt >= retryConfig.attempts || !isTransientVercelBypassResult(result)) {
        return result;
      }
      console.warn(
        `[with-full-preview-stack] Vercel bypass API returned retryable status ${result.status}; ` +
        `retrying in ${retryConfig.delayMs}ms (attempt ${attempt + 1}/${retryConfig.attempts}).`,
      );
    } catch (error) {
      lastError = error;
      if (attempt >= retryConfig.attempts || !isTransientVercelBypassError(error)) {
        throw error;
      }
      console.warn(
        `[with-full-preview-stack] Vercel bypass API request failed transiently; ` +
        `retrying in ${retryConfig.delayMs}ms (attempt ${attempt + 1}/${retryConfig.attempts}).`,
      );
    }
    await sleep(retryConfig.delayMs);
  }
  throw lastError || new Error('Vercel bypass API retry exhausted');
}

function summarizeBypassFailure(result) {
  if (!result) return 'unknown';
  const status = Number(result.status || 0);
  const message = result && result.json && typeof result.json.error === 'object' && result.json.error
    ? String(result.json.error.message || '').trim()
    : '';
  return message ? `status=${status} message=${message}` : `status=${status}`;
}

async function ensureVercelAutomationBypassSecret({
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const existing = String(
    env.VERCEL_AUTOMATION_BYPASS_SECRET || env.VERCEL_PROTECTION_BYPASS_SECRET || '',
  ).trim();
  if (existing) {
    env.VERCEL_AUTOMATION_BYPASS_SECRET = existing;
    return { configured: true, source: 'env' };
  }

  const token = String(env.VERCEL_TOKEN || '').trim();
  const teamId = String(env.VERCEL_ORG_ID || '').trim();
  const projectIds = [
    String(env.VERCEL_PROJECT_ID_CONSOLE || '').trim(),
    String(env.VERCEL_PROJECT_ID_PORTAL || '').trim(),
  ].filter(Boolean);
  if (!token || !teamId || projectIds.length === 0) {
    return { configured: false, reason: 'missing_vercel_config' };
  }

  const bypassSecret = deriveVercelAutomationBypassSecret({ token });
  const failures = [];

  for (const projectId of projectIds) {
    try {
      const updateFirst = await patchProjectProtectionBypassWithRetry({
        projectId,
        teamId,
        token,
        env,
        body: {
          update: {
            secret: bypassSecret,
            isEnvVar: true,
            note: 'masarx-preview-automation-bypass',
          },
        },
        fetchImpl,
      });
      if (updateFirst.ok || updateFirst.status === 409) {
        continue;
      }

      const generate = await patchProjectProtectionBypassWithRetry({
        projectId,
        teamId,
        token,
        env,
        body: {
          generate: {
            secret: bypassSecret,
            note: 'masarx-preview-automation-bypass',
          },
        },
        fetchImpl,
      });
      if (!generate.ok && generate.status !== 409) {
        failures.push({ projectId, step: 'generate', detail: summarizeBypassFailure(generate) });
        continue;
      }

      const updateAfterGenerate = await patchProjectProtectionBypassWithRetry({
        projectId,
        teamId,
        token,
        env,
        body: {
          update: {
            secret: bypassSecret,
            isEnvVar: true,
            note: 'masarx-preview-automation-bypass',
          },
        },
        fetchImpl,
      });
      if (!updateAfterGenerate.ok && updateAfterGenerate.status !== 409) {
        failures.push({ projectId, step: 'update', detail: summarizeBypassFailure(updateAfterGenerate) });
      }
    } catch (err) {
      failures.push({
        projectId,
        step: 'request',
        detail: String(err && err.message ? err.message : err),
      });
    }
  }

  if (failures.length > 0) {
    return { configured: false, reason: 'api_failure', failures };
  }

  env.VERCEL_AUTOMATION_BYPASS_SECRET = bypassSecret;
  return { configured: true, source: 'generated' };
}

async function main() {
  loadEnv();
  const args = parseFlagArgs(process.argv.slice(2));
  const sha = String(args.sha || '').trim() || resolveHeadSha();
  const worktreeId = resolveWorktreeId(args);
  const manifestPath = path.resolve(
    process.cwd(),
    String(args.manifest || `.tmp/preview-manifests/worktree-${worktreeId}-${sha}.json`),
  );

  const orchestratePath = path.join(__dirname, '..', 'preview', 'orchestrate.js');
  const requiredSurfaces = String(args['required-surfaces'] || process.env.PREVIEW_REQUIRED_SURFACES || '').trim();
  const commonArgs = buildOrchestrateCommonArgs({
    orchestratePath,
    worktreeId,
    sha,
    manifestPath,
    requiredSurfaces,
  });
  const summaryPath = resolvePreviewStackSummaryPath({ args, worktreeId, sha });
  const summary = {
    generated_at: new Date().toISOString(),
    worktree_id: worktreeId,
    sha,
    manifest_path: manifestPath,
    summary_path: summaryPath,
    requested_mode: '',
    required_surfaces: requiredSurfaces
      ? requiredSurfaces.split(',').map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    phases: [],
    warnings: [],
    status: 'passed',
    error: '',
  };

  const prewarmOnly = String(args['prewarm-only'] || '') !== '';
  const deployAndTest = String(args['deploy-and-test'] || '') !== '';
  const teardownOnly = String(args.teardown || '') !== '';
  summary.requested_mode = teardownOnly
    ? 'teardown'
    : prewarmOnly && !deployAndTest
      ? 'prewarm-only'
      : deployAndTest
        ? 'deploy-and-test'
        : 'full';

  const runPhase = (phaseName, cmdArgs, label) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    try {
      const result = runPreviewStackCommand(process.execPath, cmdArgs, { label });
      summary.phases.push({
        phase: phaseName,
        status: 'passed',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        log_path: result.logPath ? path.relative(process.cwd(), result.logPath).replace(/\\/g, '/') : '',
        output_line_count: Number(result.outputLineCount || 0),
      });
      return result;
    } catch (error) {
      summary.phases.push({
        phase: phaseName,
        status: 'failed',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        log_path: error?.logPath ? path.relative(process.cwd(), error.logPath).replace(/\\/g, '/') : '',
        error: String(error?.message || error),
      });
      throw error;
    }
  };

  try {
    if (teardownOnly) {
      runPhase('teardown', [...commonArgs, '--mode', 'teardown'], 'preview teardown');
      writeJson(summaryPath, summary);
      console.log(`[with-full-preview-stack] Wrote ${path.relative(process.cwd(), summaryPath)}.`);
      return;
    }

    const bypassSetup = await ensureVercelAutomationBypassSecret({ env: process.env });
    if (bypassSetup.configured) {
      console.log('[with-full-preview-stack] Vercel automation bypass is configured for protected preview smoke.');
    } else if (bypassSetup.reason === 'api_failure') {
      const detail = Array.isArray(bypassSetup.failures)
        ? bypassSetup.failures
          .map((f) => `${f.projectId}:${f.step}:${f.detail}`)
          .join('; ')
        : 'unknown';
      summary.warnings.push(`vercel_automation_bypass:${detail}`);
      console.warn(`[with-full-preview-stack] Unable to provision Vercel automation bypass: ${detail}`);
    }

    runPhase('prewarm', [...commonArgs, '--mode', 'prewarm'], 'preview prewarm');
    if (prewarmOnly && !deployAndTest) {
      writeJson(summaryPath, summary);
      console.log(`[with-full-preview-stack] Wrote ${path.relative(process.cwd(), summaryPath)}.`);
      return;
    }

    runPhase('deploy', [...commonArgs, '--mode', 'deploy', '--reuse-prewarm', '1'], 'preview deploy');
    runPhase('verify', [...commonArgs, '--mode', 'verify'], 'preview verify');

    const bypassSecret = String(
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS_SECRET || '',
    ).trim();
    if (bypassSecret) {
      try {
        upsertEnvFileVariable({
          envPath: `${manifestPath}.env`,
          key: 'VERCEL_AUTOMATION_BYPASS_SECRET',
          value: bypassSecret,
        });
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        summary.warnings.push(`persist_bypass_secret:${message}`);
        console.warn(
          `[with-full-preview-stack] Unable to persist Vercel automation bypass secret to manifest env: ${message}`,
        );
      }
    }

    if (String(args.keep || '') === '') {
      runPhase('teardown', [...commonArgs, '--mode', 'teardown'], 'preview teardown');
    } else {
      summary.warnings.push('preview_resources_kept');
      console.log('[with-full-preview-stack] Keeping preview resources (--keep).');
    }
  } catch (error) {
    summary.status = 'failed';
    summary.error = String(error?.message || error);
    throw error;
  } finally {
    writeJson(summaryPath, summary);
    console.log(`[with-full-preview-stack] Wrote ${path.relative(process.cwd(), summaryPath)}.`);
  }
}

if (require.main === module) {
  // eslint-disable-next-line promise/prefer-await-to-then
  main().catch((err) => die(err && err.message ? err.message : String(err)));
}

module.exports = {
  buildOrchestrateCommonArgs,
  deriveVercelAutomationBypassSecret,
  patchProjectProtectionBypass,
  patchProjectProtectionBypassWithRetry,
  ensureVercelAutomationBypassSecret,
  isTransientVercelBypassError,
  isTransientVercelBypassResult,
  resolveVercelBypassRetryConfig,
  resolvePreviewStackSummaryPath,
  resolvePreviewStackMaxBufferBytes,
  runPreviewStackCommand,
  upsertEnvFileVariable,
};
