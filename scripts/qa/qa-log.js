const os = require('os');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

function buildQaRunMetadata() {
  const env = process.env;
  const ciProvider = env.GITHUB_ACTIONS ? 'github' : (env.CI ? 'ci' : 'local');
  return {
    ciProvider,
    gitSha: env.GITHUB_SHA || env.CI_COMMIT_SHA || env.GIT_COMMIT || null,
    gitRef: env.GITHUB_REF || env.CI_COMMIT_REF_NAME || env.GIT_REF || null,
    triggeredBy: env.GITHUB_ACTOR || env.BUILD_USER || env.USERNAME || env.USER || null,
    metadata: {
      ci: String(env.CI || '').toLowerCase() === 'true',
      github: env.GITHUB_ACTIONS ? {
        run_id: env.GITHUB_RUN_ID || null,
        workflow: env.GITHUB_WORKFLOW || null,
        job: env.GITHUB_JOB || null,
        server_url: env.GITHUB_SERVER_URL || null,
        repository: env.GITHUB_REPOSITORY || null,
      } : null,
      node: process.version,
      platform: process.platform,
      hostname: os.hostname(),
    },
  };
}

function createNoopLogger() {
  return {
    startRun: async () => null,
    finishRun: async () => {},
    startStep: async () => null,
    finishStep: async () => {},
    recordCaseResults: async () => 0,
    close: async () => {},
    setRunId: () => {},
    getRunId: () => null,
  };
}

function normalizeText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function shouldDisableOnError(err) {
  const code = err && err.code;
  if (code === '3F000' || code === '42P01' || code === '42883') return true;
  const msg = String(err && err.message || '').toLowerCase();
  return (
    msg.includes('schema "qa" does not exist') ||
    msg.includes('relation "qa.') ||
    msg.includes('function qa.')
  );
}

function shouldDisableOnConnectivityError(err) {
  const code = String(err && err.code || '').trim().toUpperCase();
  if ([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
    '57014',
    '57P01',
    '57P02',
    '57P03',
  ].includes(code)) {
    return true;
  }
  const msg = String(err && err.message || '').toLowerCase();
  return (
    msg.includes('tenant or user not found') ||
    msg.includes('password authentication failed') ||
    msg.includes('getaddrinfo enotfound') ||
    msg.includes('i/o timeout') ||
    msg.includes('statement timeout') ||
    msg.includes('timeout expired') ||
    msg.includes('could not translate host name') ||
    msg.includes('connection terminated unexpectedly') ||
    msg.includes('terminating connection due to administrator command') ||
    msg.includes('the database system is starting up')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createQaLogger(options = {}) {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || options.disabled) {
    return createNoopLogger();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let runId = normalizeText(options.runId);
  let disabled = false;
  let warned = false;

  if (pool && typeof pool.on === 'function') {
    pool.on('error', (err) => {
      disabled = true;
      if (!warned) {
        warned = true;
        const summary = normalizeText(err && err.message) || 'background pool error';
        console.warn(`[qa-log] QA pool background error; disabling QA logging for this run: ${summary}`);
      }
    });
  }

  async function safeQuery(text, params) {
    if (disabled) return null;
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (shouldDisableOnError(err)) {
        disabled = true;
        if (!warned) {
          warned = true;
          console.warn('[qa-log] QA schema not available; disabling QA logging for this run.');
        }
        return null;
      }
      if (runId && shouldDisableOnConnectivityError(err)) {
        disabled = true;
        if (!warned) {
          warned = true;
          console.warn('[qa-log] QA logging connection failed; disabling QA logging for this run.');
        }
        return null;
      }
      throw err;
    }
  }

  async function startRun(runKey, runInfo = {}) {
    if (runId) return runId;
    const info = runInfo || {};
    const query = 'SELECT qa.qa_start_run($1, $2, $3, $4, $5, $6::jsonb, $7) AS run_id';
    const params = [
      normalizeText(runKey),
      normalizeText(info.ciProvider),
      normalizeText(info.gitSha),
      normalizeText(info.gitRef),
      normalizeText(info.triggeredBy),
      info.metadata || {},
      normalizeText(info.requestContextId),
    ];

    const maxWaitMs = 5 * 60 * 1000;
    const start = Date.now();
    let attempt = 0;
    let delayMs = 2000;

    while (true) {
      attempt += 1;
      try {
        const res = await safeQuery(query, params);
        runId = res && res.rows && res.rows[0] ? res.rows[0].run_id : null;
        return runId;
      } catch (err) {
        if (!shouldDisableOnConnectivityError(err)) throw err;
        const elapsed = Date.now() - start;
        if (elapsed >= maxWaitMs) {
          disabled = true;
          if (!warned) {
            warned = true;
            console.warn('[qa-log] QA run start failed (db not ready); disabling QA logging for this run.');
          }
          return null;
        }
        if (!warned) {
          warned = true;
          console.warn('[qa-log] QA run start blocked (db not ready); retrying...');
        } else {
          console.warn(`[qa-log] QA run start retry ${attempt} (elapsed ${Math.round(elapsed / 1000)}s)`);
        }
        await sleep(delayMs);
        delayMs = Math.min(15000, Math.round(delayMs * 1.5));
      }
    }
  }

  async function finishRun(status, metadata = {}, errorSummary = null) {
    if (!runId) return;
    await safeQuery(
      'SELECT qa.qa_finish_run($1, $2, $3::jsonb, $4)',
      [runId, normalizeText(status), metadata || {}, normalizeText(errorSummary)],
    );
  }

  async function startStep(stepKey, metadata = {}) {
    if (!runId) return null;
    const res = await safeQuery(
      'SELECT qa.qa_start_step($1, $2, $3::jsonb) AS step_id',
      [runId, normalizeText(stepKey), metadata || {}],
    );
    return res && res.rows && res.rows[0] ? res.rows[0].step_id : null;
  }

  async function finishStep(stepId, status, metadata = {}, errorSummary = null) {
    if (!runId || !stepId) return;
    await safeQuery(
      'SELECT qa.qa_finish_step($1, $2, $3::jsonb, $4)',
      [stepId, normalizeText(status), metadata || {}, normalizeText(errorSummary)],
    );
  }

  async function recordCaseResults(suiteKey, results) {
    if (!runId) return 0;
    if (!normalizeText(suiteKey)) return 0;
    if (!Array.isArray(results) || results.length === 0) return 0;
    const payload = JSON.stringify(results);
    const res = await safeQuery(
      'SELECT qa.qa_record_case_results($1, $2, $3::jsonb) AS inserted',
      [runId, normalizeText(suiteKey), payload],
    );
    return res && res.rows && res.rows[0] ? res.rows[0].inserted || 0 : 0;
  }

  async function close() {
    await pool.end();
  }

  return {
    startRun,
    finishRun,
    startStep,
    finishStep,
    recordCaseResults,
    close,
    setRunId: (value) => { runId = normalizeText(value); },
    getRunId: () => runId,
  };
}

module.exports = {
  buildQaRunMetadata,
  createQaLogger,
  shouldDisableOnConnectivityError,
  shouldDisableOnError,
};
