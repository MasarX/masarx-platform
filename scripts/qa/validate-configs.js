/**
 * Validate DB configs against JSON Schemas.
 * Usage: ENV_FILE=config/env/.env.cloud npm run validate:configs
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const { loadEnv } = require('../utils/load-env');

loadEnv();

// Use 2020-12 validator; schemas in docs/ops/schemas declare the 2020-12 meta-schema.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaDir = path.join(__dirname, '..', '..', 'docs', 'ops', 'schemas');

function readSchema(file) {
  const p = path.join(schemaDir, file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Load schemas
const schemas = {
  webhookIngest: readSchema('webhook_ingest_policy.schema.json'),
  opTemplates: readSchema('operation_templates.schema.json'),
  mapInbound: readSchema('mapping_configs.webhook_inbound.schema.json'),
  mapResponse: readSchema('mapping_configs.webhook_response.schema.json'),
  mapProviderResponse: readSchema('mapping_configs.provider_response.schema.json'),
  mapRequest: readSchema('mapping_configs.request_render.schema.json'),
  mapEvent: readSchema('mapping_configs.event_extraction.schema.json'),
};

// Compile validators
const v = {
  webhookIngest: ajv.compile(schemas.webhookIngest),
  opTemplates: ajv.compile(schemas.opTemplates),
  mapInbound: ajv.compile(schemas.mapInbound),
  mapResponse: ajv.compile(schemas.mapResponse),
  mapProviderResponse: ajv.compile(schemas.mapProviderResponse),
  mapRequest: ajv.compile(schemas.mapRequest),
  mapEvent: ajv.compile(schemas.mapEvent),
};

function formatErrors(errors) {
  return (errors || []).map((e) => `${e.instancePath || '<root>'} ${e.message}`).join('; ');
}

function isConnectivityError(err) {
  const code = String(err && err.code ? err.code : '').trim().toUpperCase();
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ENETDOWN',
      'ENOTFOUND',
      'EAI_AGAIN',
    ].includes(code)
  ) {
    return true;
  }
  const msg = String((err && err.message) || '');
  return /connection terminated unexpectedly|econnreset|econnrefused|etimedout|timeout|network is unreachable|host is unreachable|name or service not known/i.test(
    msg,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRestRetryConfig() {
  const retriesRaw =
    process.env.VALIDATE_CONFIGS_REST_RETRIES ||
    process.env.VALIDATE_CONFIGS_RETRIES ||
    '3';
  const delayRaw =
    process.env.VALIDATE_CONFIGS_REST_RETRY_DELAY_MS ||
    process.env.VALIDATE_CONFIGS_RETRY_DELAY_MS ||
    '1000';
  const timeoutRaw = process.env.VALIDATE_CONFIGS_REST_TIMEOUT_MS || '15000';

  const retries = Math.max(1, parseInt(retriesRaw, 10));
  const delayMs = Math.max(0, parseInt(delayRaw, 10));
  const timeoutMs = Math.max(1, parseInt(timeoutRaw, 10));

  return { retries, delayMs, timeoutMs };
}

async function fetchWithRetry(url, options, label) {
  const cfg = resolveRestRetryConfig();
  let lastErr = null;

  for (let attempt = 1; attempt <= cfg.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } catch (err) {
      lastErr = err;
      const cause = err && err.cause ? err.cause : null;
      const connectivity = isConnectivityError(err) || isConnectivityError(cause);
      if (!connectivity) {
        throw err;
      }

      if (attempt < cfg.retries) {
        const target = label ? String(label) : String(url);
        console.warn(`[validate:configs] REST fetch retry ${attempt}/${cfg.retries}: ${target}`);
        await sleep(cfg.delayMs * attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

function resolveConnectionStrings() {
  const primary = String(process.env.DATABASE_URL || '').trim();
  const direct = String(process.env.DATABASE_URL_DIRECT || '').trim();
  const list = [];
  if (primary) list.push(primary);
  if (direct && direct !== primary) list.push(direct);
  return list;
}

function shouldUseSsl(connectionString) {
  const mode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (['require', 'verify-ca', 'verify-full'].includes(mode)) return true;
  return true;
}

function collectSettingsIssues(rows, issues) {
  for (const row of rows) {
    const value = row.value ?? row.cached_value;
    const ok = v.webhookIngest(value);
    if (!ok) {
      issues.push({
        area: 'webhook_ingest_policy',
        scope: `${row.scope_type}:${row.scope_id}`,
        errors: formatErrors(v.webhookIngest.errors),
      });
    }
  }
}

function collectMappingIssues(rows, issues) {
  for (const row of rows) {
    let validator = null;
    switch (row.mapping_type) {
      case 'provider_response':
        validator = v.mapProviderResponse; break;
      case 'webhook_inbound':
        validator = v.mapInbound; break;
      case 'webhook_response':
        validator = v.mapResponse; break;
      case 'request_render':
        validator = v.mapRequest; break;
      case 'event_extraction':
        validator = v.mapEvent; break;
      default:
        issues.push({
          area: 'mapping_configs',
          id: row.id,
          key: row.mapping_key,
          errors: `unknown mapping_type: ${row.mapping_type}`,
        });
        continue;
    }
    const ok = validator(row.mapping_config || {});
    if (!ok) {
      issues.push({
        area: `mapping_configs:${row.mapping_type}`,
        id: row.id,
        key: row.mapping_key,
        errors: formatErrors(validator.errors),
      });
    }
  }
}

function collectOperationIssues(rows, issues) {
  for (const row of rows) {
    const doc = {
      provider_id: row.provider_id,
      operation_name: row.operation_name,
      method: row.method,
      url_template: row.url_template,
      headers_template: row.headers_template || undefined,
      body_template: row.body_template || undefined,
      request_mappings: row.request_mappings || undefined,
      mapping_config_id: row.mapping_config_id || null,
      timeout_seconds: row.timeout_seconds ?? null,
    };
    const ok = v.opTemplates(doc);
    if (!ok) {
      issues.push({
        area: 'operation_templates',
        id: row.id,
        name: row.operation_name,
        errors: formatErrors(v.opTemplates.errors),
      });
    }
  }
}

async function runDbValidation(connectionString) {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  const issues = [];

  const client = await pool.connect();
  try {
    // Validate webhook_ingest_policy (settings)
    const { rows: settingsRows } = await client.query(
      "SELECT scope_type, scope_id::text, category, cached_value FROM settings WHERE category='webhook_ingest_policy'"
    );
    collectSettingsIssues(settingsRows, issues);

    // Validate mapping_configs
    const { rows: mappingRows } = await client.query(
      'SELECT id::text, mapping_type, mapping_key, mapping_config FROM mapping_configs'
    );
    collectMappingIssues(mappingRows, issues);

    // Validate operation_templates
    const { rows: opRows } = await client.query(
      `SELECT id::text,
              provider_id::text,
              operation_name,
              method,
              url_template,
              headers_template,
              body_template,
              request_mappings,
              mapping_config_id::text,
              timeout_seconds
       FROM operation_templates`
    );
    collectOperationIssues(opRows, issues);
  } finally {
    client.release();
    await pool.end();
  }

  return issues;
}

function getRestBaseUrl() {
  const raw = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return `${raw}/rest/v1`;
}

function getRestHeaders() {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    accept: 'application/json',
  };
}

async function fetchAllRest(baseUrl, table, options = {}) {
  const pageSize = Math.max(1, parseInt(process.env.VALIDATE_CONFIGS_PAGE_SIZE || '1000', 10));
  const rows = [];
  const headers = getRestHeaders();
  let offset = 0;
  while (true) {
    const url = new URL(`${baseUrl}/${table}`);
    if (options.select) url.searchParams.set('select', options.select);
    if (options.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        url.searchParams.set(key, value);
      }
    }
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const res = await fetchWithRetry(url, { headers }, `${table} offset=${offset}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`REST ${table} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const batch = await res.json();
    rows.push(...batch);
    if (!Array.isArray(batch) || batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function runRestValidation() {
  const baseUrl = getRestBaseUrl();
  if (!baseUrl) {
    throw new Error('SUPABASE_URL is required for REST validation.');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for REST validation.');
  }

  const issues = [];
  const settingsRows = await fetchAllRest(baseUrl, 'settings', {
    select: 'scope_type,scope_id,category,cached_value',
    filters: { category: 'eq.webhook_ingest_policy' },
  });
  const normalizedSettings = settingsRows.map((row) => ({
    ...row,
    scope_id: String(row.scope_id),
  }));
  collectSettingsIssues(normalizedSettings, issues);

  const mappingRows = await fetchAllRest(baseUrl, 'mapping_configs', {
    select: 'id,mapping_type,mapping_key,mapping_config',
  });
  collectMappingIssues(mappingRows, issues);

  const opRows = await fetchAllRest(baseUrl, 'operation_templates', {
    select: 'id,provider_id,operation_name,method,url_template,headers_template,body_template,request_mappings,mapping_config_id,timeout_seconds',
  });
  const normalizedOps = opRows.map((row) => ({
    ...row,
    provider_id: row.provider_id == null ? null : String(row.provider_id),
    mapping_config_id: row.mapping_config_id == null ? null : String(row.mapping_config_id),
  }));
  collectOperationIssues(normalizedOps, issues);

  return issues;
}

function reportIssues(issues) {
  if (issues.length > 0) {
    console.error('\nConfig validation failed:');
    for (const i of issues) {
      console.error('-', JSON.stringify(i));
    }
    process.exit(1);
  } else {
    console.log('All configs valid.');
  }
}

async function main() {
  const attempts = Math.max(1, parseInt(process.env.VALIDATE_CONFIGS_RETRIES || '3', 10));
  const delayMs = Math.max(0, parseInt(process.env.VALIDATE_CONFIGS_RETRY_DELAY_MS || '1000', 10));
  let lastError = null;
  const connectionStrings = resolveConnectionStrings();
  const useRestOnly = /^(1|true|yes)$/i.test(String(process.env.VALIDATE_CONFIGS_USE_REST || '').trim());

  if (useRestOnly) {
    const issues = await runRestValidation();
    reportIssues(issues);
    return;
  }

  if (!connectionStrings.length) {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const issues = await runRestValidation();
      reportIssues(issues);
      return;
    }
    throw new Error('Missing DATABASE_URL for config validation.');
  }

  for (let i = 1; i <= attempts; i += 1) {
    for (let j = 0; j < connectionStrings.length; j += 1) {
      const connectionString = connectionStrings[j];
      try {
        if (i > 1 || j > 0) {
          console.warn(`[validate:configs] Retry ${i}/${attempts} using ${j === 0 ? 'pooler' : 'direct'} connection`);
        }
        const issues = await runDbValidation(connectionString);
        reportIssues(issues);
        return;
      } catch (err) {
        lastError = err;
        const connectivity = isConnectivityError(err);
        if (!connectivity) {
          throw err;
        }

        // Fast-path: if DB connectivity is degraded and we have a service role key,
        // fall back to REST so CI doesn't flake on transient network/IPv6 issues.
        if (j >= connectionStrings.length - 1 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          console.warn('[validate:configs] DB connectivity degraded; falling back to REST.');
          try {
            const issues = await runRestValidation();
            reportIssues(issues);
            return;
          } catch (restErr) {
            const dbMsg = String(err && err.message ? err.message : err);
            const restMsg = String(restErr && restErr.message ? restErr.message : restErr);
            throw new Error(`DB connectivity failed (${dbMsg}); REST fallback failed (${restMsg})`);
          }
        }
        if (j < connectionStrings.length - 1) {
          continue;
        }
      }
    }
    if (i < attempts) {
      await sleep(delayMs * i);
    }
  }

  if (lastError) {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('[validate:configs] DB validation failed; falling back to REST.');
      const issues = await runRestValidation();
      reportIssues(issues);
      return;
    }
    throw lastError;
  }
}

main().catch((err) => {
  console.error('Validator error:', err.message);
  process.exit(2);
});
