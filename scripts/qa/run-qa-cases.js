#!/usr/bin/env node
const { isDeepStrictEqual } = require('util');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const {
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  shouldUseSsl,
} = require('../ops/db-connect-smoke');
const { buildQaRunMetadata, createQaLogger } = require('./qa-log');

loadEnv();

const args = process.argv.slice(2);
const getArgValue = (name) => {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
};

const suiteFilter = getArgValue('suite');
const limitRaw = getArgValue('limit');
const limit = limitRaw ? Math.max(parseInt(limitRaw, 10), 1) : null;
const runKey = process.env.QA_RUN_KEY || 'qa:cases';
let qa = null;
async function resolveDatabaseUrlWithFallback(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const resolveCandidates = options.resolveCandidates || resolveDsnCandidates;
  const runSmoke = options.runSmoke || runConnectivitySmoke;

  const candidates = await resolveCandidates({ env });
  if (!candidates.length) return '';

  const result = await runSmoke({
    candidates,
    env,
    connectionTimeoutMs: parsePositiveInt(
      env.QA_CASES_CONNECT_ATTEMPT_TIMEOUT_MS,
      parsePositiveInt(env.DB_SMOKE_TIMEOUT_MS, 10000),
    ),
    maxWaitMs: parsePositiveInt(
      env.QA_CASES_CONNECT_TIMEOUT_MS,
      parsePositiveInt(env.DB_SMOKE_MAX_WAIT_MS, 120000),
    ),
    retryDelayMs: parsePositiveInt(
      env.QA_CASES_CONNECT_RETRY_DELAY_MS,
      parsePositiveInt(env.DB_SMOKE_RETRY_DELAY_MS, 2000),
    ),
    logger: {
      warn(message) {
        logger.warn(`[qa:cases] ${message}`);
      },
    },
  });
  if (result?.candidate?.name && result.candidate.name !== 'DATABASE_URL') {
    logger.warn(`[qa:cases] Connected via ${result.candidate.name} after fallback.`);
  }
  return String(result?.candidate?.dsn || '').trim();
}

async function fetchCases(client) {
  const clauses = ['c.enabled = true'];
  const params = [];
  if (suiteFilter) {
    params.push(suiteFilter);
    clauses.push(`c.suite_key = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitSql = limit ? `LIMIT ${limit}` : '';
  const sql = `
    SELECT
      c.id,
      c.suite_key,
      c.case_key,
      c.handler_key,
      c.input,
      c.expected,
      c.assertions,
      c.tags,
      c.metadata,
      q.id AS quarantine_id,
      q.reason AS quarantine_reason,
      q.owner AS quarantine_owner,
      q.expires_at AS quarantine_expires_at
    FROM qa.qa_cases c
    LEFT JOIN LATERAL (
      SELECT id, reason, owner, expires_at
      FROM qa.qa_quarantines q
      WHERE q.case_id = c.id
        AND q.enabled = true
        AND (q.expires_at IS NULL OR q.expires_at > now())
      ORDER BY q.expires_at NULLS FIRST, q.created_at DESC
      LIMIT 1
    ) q ON TRUE
    ${where}
    ORDER BY c.suite_key, c.case_key
    ${limitSql}
  `;
  const { rows } = await client.query(sql, params);
  return rows;
}

async function executeSqlScalar(client, qaCase) {
  const input = qaCase.input || {};
  const sql = input.sql;
  if (!sql) {
    throw new Error('sql_scalar handler requires input.sql');
  }
  const params = Array.isArray(input.params) ? input.params : [];
  const { rows } = await client.query(sql, params);
  const row = rows[0] || null;
  const observed = row ? Object.values(row)[0] : null;
  const expected = qaCase.expected ?? input.expected ?? null;
  const passed = isDeepStrictEqual(observed, expected);
  return {
    passed,
    observed,
    expected,
    diff: passed ? null : { expected, observed },
  };
}

async function executeCase(client, qaCase) {
  const handlerKey = String(qaCase.handler_key || '').trim();
  if (handlerKey === 'sql_scalar') {
    return executeSqlScalar(client, qaCase);
  }
  throw new Error(`Unsupported handler_key "${handlerKey}"`);
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildQuarantineMetadata(qaCase) {
  if (!qaCase.quarantine_id) return null;
  return {
    id: qaCase.quarantine_id,
    reason: qaCase.quarantine_reason || null,
    owner: qaCase.quarantine_owner || null,
    expires_at: formatTimestamp(qaCase.quarantine_expires_at),
  };
}

async function main() {
  let resolvedDbUrl = '';
  try {
    resolvedDbUrl = await resolveDatabaseUrlWithFallback();
  } catch (error) {
    console.error('[qa:cases] Failed to resolve database connection:', error.message);
    process.exit(1);
  }
  if (!resolvedDbUrl) {
    console.error('[qa:cases] DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER is required.');
    process.exit(1);
  }
  qa = createQaLogger({ runId: process.env.QA_RUN_ID });
  const pool = new Pool({
    connectionString: resolvedDbUrl,
    connectionTimeoutMillis: parsePositiveInt(process.env.DB_SMOKE_TIMEOUT_MS, 10000),
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
  });
  let runId = qa.getRunId();
  const ownsRun = !runId;
  if (!runId) {
    runId = await qa.startRun(runKey, buildQaRunMetadata());
  }

  let failures = 0;
  let noCases = false;
  const suiteResults = new Map();
  const client = await pool.connect();
  try {
    const cases = await fetchCases(client);
    if (!cases.length) {
      noCases = true;
      if (ownsRun) {
        await qa.finishRun('passed', { caseCount: 0 }, null);
      }
    }

    for (const qaCase of cases) {
      const startedAt = Date.now();
      let status = 'passed';
      let errorSummary = null;
      let observed = null;
      let expected = qaCase.expected ?? null;
      let diff = null;
      const quarantine = buildQuarantineMetadata(qaCase);

      if (quarantine) {
        status = 'skipped';
        errorSummary = quarantine.reason ? `quarantined: ${quarantine.reason}` : 'quarantined';
      } else {
        try {
          const result = await executeCase(client, qaCase);
          if (!result.passed) {
            status = 'failed';
            failures += 1;
          }
          observed = result.observed ?? null;
          expected = result.expected ?? expected;
          diff = result.diff ?? null;
        } catch (err) {
          status = 'failed';
          failures += 1;
          errorSummary = err.message;
        }
      }

      const suiteKey = qaCase.suite_key;
      const results = suiteResults.get(suiteKey) || [];
      const resultMetadata = {
        handler_key: qaCase.handler_key,
        tags: qaCase.tags || [],
      };
      if (quarantine) {
        resultMetadata.quarantine = quarantine;
      }
      results.push({
        case_key: qaCase.case_key,
        status,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        observed,
        expected,
        diff,
        metadata: resultMetadata,
        error_summary: errorSummary,
      });
      suiteResults.set(suiteKey, results);
    }
  } finally {
    client.release();
    await pool.end();
  }

  if (noCases) {
    await qa.close();
    console.log('[qa:cases] No enabled cases found.');
    process.exit(0);
  }

  for (const [suiteKey, results] of suiteResults.entries()) {
    await qa.recordCaseResults(suiteKey, results);
  }

  const caseCount = Array.from(suiteResults.values()).reduce((acc, list) => acc + list.length, 0);
  if (ownsRun) {
    await qa.finishRun(
      failures ? 'failed' : 'passed',
      { caseCount },
      failures ? 'QA cases failed' : null,
    );
  }
  await qa.close();

  if (failures) {
    console.error(`[qa:cases] ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log('[qa:cases] All cases passed.');
  process.exit(0);
}

if (require.main === module) {
  main().catch(async (err) => {
    if (qa) {
      await qa.close();
    }
    console.error('[qa:cases] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildQuarantineMetadata,
  resolveDatabaseUrlWithFallback,
};
