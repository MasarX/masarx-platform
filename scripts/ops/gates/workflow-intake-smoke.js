#!/usr/bin/env node
/**
 * workflow-intake-smoke.js
 *
 * Post-deploy smoke for shared environments (stg/prod-safe):
 * - Validates the cloud target is configured (DATABASE_URL present).
 * - Executes a minimal webhook intake roundtrip via workflow_intake_webhook().
 * - Uses a transaction and ROLLBACK to avoid persistent writes.
 */
/* eslint-disable no-console */
const { Client } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../../utils/resolve-db-url');
const {
  isRetryableDbConnectError,
  parsePositiveInt,
} = require('../db-connect-smoke');

loadEnv();

function die(msg) {
  console.error(`[workflow-intake-smoke] ${msg}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) die(`Missing required env var: ${name}`);
  return value;
}

function resolveDatabaseUrl(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : {};
  const preferred = String(sourceEnv.PG_CONN_STRING || '').trim();
  if (preferred) return preferred;
  return String(sourceEnv.DATABASE_URL || '').trim() || requireEnv('DATABASE_URL');
}

function resolveRetryConfig(env = process.env) {
  return {
    maxWaitMs: parsePositiveInt(
      env.WORKFLOW_INTAKE_SMOKE_DB_MAX_WAIT_MS || env.DB_SMOKE_MAX_WAIT_MS,
      120000,
    ),
    retryDelayMs: parsePositiveInt(
      env.WORKFLOW_INTAKE_SMOKE_DB_RETRY_DELAY_MS || env.DB_SMOKE_RETRY_DELAY_MS,
      2000,
    ),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkflowIntakeSmokeOnce(options = {}) {
  const {
    connectionString,
    clientFactory = (config) => new Client(config),
    uuidFactory = randomUUID,
    logger = console,
  } = options;
  const databaseUrl = String(connectionString || '').trim();
  if (!databaseUrl) {
    throw new Error('Missing workflow-intake-smoke connection string');
  }

  const client = clientFactory({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const organizationId = uuidFactory();
    const clientId = uuidFactory();
    const mappingId = uuidFactory();
    const sourceId = uuidFactory();

    const orgSlug = `ci-gate-org-${organizationId.slice(0, 8)}`;
    const clientSlug = `ci-gate-client-${clientId.slice(0, 8)}`;
    const sourceIdentifier = `ci-gate-source-${sourceId.slice(0, 8)}`;
    const token = `ci-gate-${uuidFactory()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'CI Gate Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, orgSlug],
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'CI Gate Client', $3::text, 'standard', 'active')`,
      [clientId, organizationId, clientSlug],
    );

    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'CI gate mapping')`,
      [mappingId, `ci-gate-${Date.now()}`],
    );

    await client.query(
      `INSERT INTO webhook_sources (
         id, organization_id, source_identifier, name, provider_type,
         auth_token, mapping_config_id, enabled
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'CI Gate Source', 'provider',
         $4::text, $5::uuid, TRUE
       )`,
      [sourceId, organizationId, sourceIdentifier, token, mappingId],
    );

    const payload = {
      event: { id: `evt-${uuidFactory()}`, type: 'shipment.created' },
      data: { smoke: true },
    };
    const rawBody = JSON.stringify(payload);

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, '{}'::jsonb, $2::text, $3::jsonb) AS ack`,
      [token, rawBody, JSON.stringify(payload)],
    );

    const ack = rows[0]?.ack || null;
    const status = Number(ack?.status);
    if (!Number.isFinite(status)) {
      throw new Error(
        `Invalid/missing ack.status from workflow_intake_webhook (got: ${JSON.stringify(ack)})`,
      );
    }

    // Global default intake should accept with 202 when only global policy applies.
    if (status !== 202) {
      throw new Error(`Unexpected ack.status=${status}; expected 202. ack=${JSON.stringify(ack)}`);
    }

    logger.log?.(
      `[workflow-intake-smoke] OK ack.status=${status} response_mode=${ack?.response_mode || '<none>'}`,
    );
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (e) {
      logger.warn?.('[workflow-intake-smoke] rollback failed:', e?.message || String(e));
    }
    await client.end();
  }
}

async function runWorkflowIntakeSmokeWithRetry(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleep;
  const { maxWaitMs, retryDelayMs } = resolveRetryConfig(env);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const startedAt = nowFn();
  const explicitConnectionString = String(options.connectionString || '').trim();
  const resolver = options.resolveDatabaseUrlWithFallbackFn || resolveDatabaseUrlWithFallback;
  const selected = explicitConnectionString
    ? { dsn: explicitConnectionString, candidateName: 'explicit' }
    : await resolver({
      env: {
        ...env,
        DB_SMOKE_SYNC_DB_PASSWORD: '0',
        DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: '0',
      },
      logger,
      candidatePolicy: env.DB_CONNECT_CANDIDATE_POLICY,
      maxWaitMs,
      retryDelayMs,
    });
  const connectionString = String(selected?.dsn || '').trim();
  if (!connectionString) throw new Error('Shared DB candidate ladder returned no selected DSN');
  const deadlineAt = startedAt + maxWaitMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      await runWorkflowIntakeSmokeOnce({
        ...options,
        connectionString,
        logger,
      });
      return {
        attempts,
        candidateName: String(selected?.candidateName || '').trim(),
      };
    } catch (error) {
      const remainingMs = Math.max(0, deadlineAt - nowFn());
      if (!isRetryableDbConnectError(error) || remainingMs <= 0) {
        if (remainingMs <= 0 && isRetryableDbConnectError(error)) {
          throw new Error(
            `workflow intake smoke did not become ready within retry window: ${error.message || error}`,
          );
        }
        throw error;
      }
      logger.warn?.(
        `[workflow-intake-smoke] transient DB readiness delay (attempt=${attempts}; remaining_ms=${remainingMs}): ${error.message || error}`,
      );
      await sleepFn(Math.min(retryDelayMs, remainingMs));
    }
  }
}

async function main() {
  await runWorkflowIntakeSmokeWithRetry({
    env: process.env,
    logger: console,
  });
}

if (require.main === module) {
  main().catch((err) => {
    die(err?.message || String(err));
  });
}

module.exports = {
  resolveDatabaseUrl,
  resolveRetryConfig,
  runWorkflowIntakeSmokeOnce,
  runWorkflowIntakeSmokeWithRetry,
  main,
};
