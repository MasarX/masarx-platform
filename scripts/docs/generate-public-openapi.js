#!/usr/bin/env node
/**
 * generate-public-openapi.js
 * Regenerates the public OpenAPI spec from SSOT:
 *   - Curated core contract lives in docs/api/openapi.json (non-/api paths).
 *   - Compatibility mirror routes (/api/...) are derived from DB rows:
 *       api_route_packs + api_routes (global scope only), filtered by
 *       api_route_packs.public_docs_enabled = TRUE.
 *
 * Usage:
 *   node scripts/docs/generate-public-openapi.js
 *   node scripts/docs/generate-public-openapi.js --check
 *   node scripts/docs/generate-public-openapi.js --output docs/api/openapi.json
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');
const { loadEnv } = require('../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../utils/resolve-db-url');

loadEnv();

const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());

// GitHub-hosted runners (and some corporate networks) may not have IPv6 egress.
// Force IPv4-first resolution so pg connections don't fail with ENETUNREACH.
try {
  if (dns && typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  // ignore
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { check: false, output: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check') out.check = true;
    if (arg === '--output') out.output = args[i + 1] || null;
  }
  return out;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeComparableText(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

function computeContractVersion(spec) {
  const clone = JSON.parse(JSON.stringify(spec || {}));
  if (!clone.info || typeof clone.info !== 'object') {
    clone.info = {};
  }
  delete clone.info.version;
  const digest = crypto.createHash('sha256').update(stableStringify(clone), 'utf8').digest('hex').slice(0, 12);
  return `contract-${digest}`;
}

function loadPgClientCtor() {
  try {
    const pg = require('pg');
    if (!pg || typeof pg.Client !== 'function') {
      throw new Error('pg.Client is unavailable');
    }
    return pg.Client;
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = err && err.message ? String(err.message) : String(err);
    if (code === 'MODULE_NOT_FOUND' && msg.includes("'pg'")) {
      throw new Error(
        "Missing dependency 'pg'. Run `npm install` (or `npm ci`) before running docs:openapi:generate/check."
      );
    }
    throw err;
  }
}

function titleize(input) {
  const str = String(input || '').trim();
  if (!str) return '';
  return str
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

function extractPathParams(pathTemplate) {
  const params = [];
  const re = /{([A-Za-z0-9_]+)}/g;
  let match = re.exec(pathTemplate);
  while (match) {
    const name = match[1];
    if (name && !params.includes(name)) params.push(name);
    match = re.exec(pathTemplate);
  }
  return params;
}

function sanitizeOperationId(input) {
  return String(input || '')
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function buildCompatOperation(route) {
  const methodUpper = String(route.method || '').trim().toUpperCase();
  const methodLower = methodUpper.toLowerCase();
  const pathTemplate = String(route.path_template || '').trim();
  const packLabel = titleize(route.pack_name);
  const providerLabel = titleize(route.provider_name || '');

  const operationId = sanitizeOperationId(
    `${route.pack_name || 'pack'}_${route.route_name || `${methodUpper}_${pathTemplate}`}`
  );

  const summaryParts = [
    packLabel || 'Compatibility',
    providerLabel ? `(${providerLabel})` : null,
    `${methodUpper} ${pathTemplate}`,
  ].filter(Boolean);

  const parameters = [
    { $ref: '#/components/parameters/CorrelationIdHeader' },
    { $ref: '#/components/parameters/TraceparentHeader' },
    { $ref: '#/components/parameters/TracestateHeader' },
    { $ref: '#/components/parameters/CompanyIdHeader' },
    ...extractPathParams(pathTemplate).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
  ];

  const hasBody = ['post', 'put', 'patch'].includes(methodLower);

  const operation = {
    tags: ['API Gateway'],
    operationId: operationId || undefined,
    summary: summaryParts.join(' - '),
    description: [
      'Mirrored upstream endpoint. Request and response shape are route-policy driven.',
      'Routes with `delivery.mode=proxy` return the upstream response unchanged.',
      'Shipment-creating routes default to `delivery.mode=accepted_async` and run through the API Gateway shipment-create workflow: materialize request context, dispatch the provider call, wait for canonical shipment readback, and expose workflow/request/shipment lineage in Console.',
    ].join(' '),
    security: [
      { WebhookBearer: [] },
      { WebhookHeader: [] },
      { WebhookQueryToken: [] },
    ],
    parameters,
    ...(hasBody
      ? {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
      }
      : {}),
    responses: {
      200: {
        description: 'Upstream response (pass-through).',
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true },
          },
        },
      },
      400: {
        description: 'Bad request.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      401: {
        description: 'Unauthorized (missing/invalid token).',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      404: {
        description: 'Route not found (no matching mirror route).',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      429: {
        description: 'Rate limited.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      500: {
        description: 'Server error.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
    },
    'x-masarx-pack': route.pack_name || null,
    'x-masarx-route': route.route_name || null,
    'x-masarx-provider': route.provider_name || null,
  };

  return { methodLower, operation };
}

async function columnExists(client, { schema, table, column }) {
  const res = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND column_name = $3
      LIMIT 1
    `,
    [schema, table, column]
  );
  return res.rowCount > 0;
}

async function fetchCompatRoutes(client, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const hasPublicDocsFlag = await columnExists(client, {
    schema: 'public',
    table: 'api_route_packs',
    column: 'public_docs_enabled',
  });

  const allowlistRaw = String(env.PUBLIC_OPENAPI_PACKS || '').trim();
  const allowlist = allowlistRaw
    ? allowlistRaw.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  if (!hasPublicDocsFlag && allowlist.length === 0) {
    logger.warn?.(
      '[openapi] Missing api_route_packs.public_docs_enabled and PUBLIC_OPENAPI_PACKS is not set; fail-closing to zero compatibility packs.',
    );
    return [];
  }

  const whereClauses = [
    'p.enabled = TRUE',
    'r.enabled = TRUE',
    "r.scope_type = 'global'",
    'r.scope_id IS NULL',
    "r.path_template LIKE '/api/%'",
  ];

  const params = [];
  if (hasPublicDocsFlag) {
    whereClauses.push('p.public_docs_enabled = TRUE');
  } else {
    params.push(allowlist);
    whereClauses.push(`p.name = ANY($${params.length})`);
  }

  const sql = `
    SELECT
      p.name AS pack_name,
      p.description AS pack_description,
      r.route_name,
      r.method,
      r.path_template,
      pr.name AS provider_name
    FROM public.api_route_packs p
    JOIN public.api_routes r ON r.pack_id = p.id
    LEFT JOIN public.providers pr ON pr.id = r.provider_id
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY p.name ASC, r.method ASC, r.path_template ASC
  `;

  const res = await client.query(sql, params);
  return res.rows || [];
}

function sortPathsPreservingCore(paths) {
  const out = {};
  if (paths['/v1/webhook']) out['/v1/webhook'] = paths['/v1/webhook'];
  const rest = Object.keys(paths)
    .filter((k) => k !== '/v1/webhook')
    .sort((a, b) => a.localeCompare(b));
  for (const key of rest) out[key] = paths[key];
  return out;
}

function resolveOpenApiDbCandidatePolicy(env = process.env, explicitPolicy = '') {
  const requested = String(
    explicitPolicy
      || env.DOCS_OPENAPI_DB_CANDIDATE_POLICY
      || env.OPENAPI_DB_CANDIDATE_POLICY
      || env.DB_CONNECT_CANDIDATE_POLICY
      || '',
  ).trim();
  if (requested) return requested;

  // Shared CI lanes should stay on the pooler-safe ladder for docs generation.
  if (isTruthy(env.GITHUB_ACTIONS) || isTruthy(env.CI)) {
    return 'shared-lane-safe';
  }

  return '';
}

async function resolveDbConnection(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const candidatePolicy = resolveOpenApiDbCandidatePolicy(env, options.candidatePolicy);

  return resolveDatabaseUrlWithFallback({
    env,
    logger,
    candidatePolicy,
    connectionTimeoutEnvNames: [
      'DOCS_OPENAPI_DB_CONNECT_TIMEOUT_MS',
      'DB_CONNECT_TIMEOUT_MS',
    ],
    maxWaitEnvNames: [
      'DOCS_OPENAPI_DB_CONNECT_MAX_WAIT_MS',
      'DB_CONNECT_MAX_WAIT_MS',
    ],
    retryDelayEnvNames: [
      'DOCS_OPENAPI_DB_CONNECT_RETRY_DELAY_MS',
      'DB_CONNECT_RETRY_DELAY_MS',
    ],
    circuitBreakerRetryDelayEnvNames: [
      'DOCS_OPENAPI_DB_CONNECT_CIRCUIT_BREAKER_RETRY_DELAY_MS',
      'DB_CONNECT_CIRCUIT_BREAKER_RETRY_DELAY_MS',
    ],
    passwordSyncStabilizeEnvNames: [
      'DOCS_OPENAPI_DB_CONNECT_PASSWORD_SYNC_STABILIZE_MS',
      'DB_CONNECT_PASSWORD_SYNC_STABILIZE_MS',
    ],
  });
}

async function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);

  const openapiPath = args.output
    ? path.resolve(repoRoot, args.output)
    : path.join(repoRoot, 'docs', 'api', 'openapi.json');

  if (!fs.existsSync(openapiPath)) {
    throw new Error(`OpenAPI file not found at ${openapiPath}`);
  }

  const spec = readJson(openapiPath);
  if (!spec || typeof spec !== 'object') {
    throw new Error('Invalid OpenAPI JSON (root must be an object).');
  }
  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('Invalid OpenAPI JSON (missing paths object).');
  }

  const methodKeys = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const pickNonMethodKeys = (pathItem) => {
    const out = {};
    if (!pathItem || typeof pathItem !== 'object') return out;
    for (const [key, value] of Object.entries(pathItem)) {
      if (methodKeys.has(String(key || '').toLowerCase())) continue;
      out[key] = value;
    }
    return out;
  };

  const existingCompatPaths = {};
  const corePaths = {};
  for (const [key, value] of Object.entries(spec.paths)) {
    if (String(key || '').startsWith('/api/')) {
      if (value && typeof value === 'object') existingCompatPaths[key] = value;
      continue;
    }
    corePaths[key] = value;
  }

  const { dsn, candidateName } = await resolveDbConnection();
  const ClientCtor = loadPgClientCtor();
  const client = new ClientCtor({ connectionString: dsn });
  await client.connect();
  if (candidateName) {
    console.log(`[openapi] Using ${candidateName}.`);
  }
  try {
    const routes = await fetchCompatRoutes(client);

    const compatPaths = {};
    const seen = new Set();
    for (const route of routes) {
      const methodUpper = String(route.method || '').trim().toUpperCase();
      const pathTemplate = String(route.path_template || '').trim();
      const key = `${methodUpper} ${pathTemplate}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate compat route detected: ${key}`);
      }
      seen.add(key);

      const { methodLower, operation: fallbackOperation } = buildCompatOperation(route);
      const existingPathItem = existingCompatPaths[pathTemplate];
      const existingOperation = existingPathItem && existingPathItem[methodLower]
        ? existingPathItem[methodLower]
        : null;

      if (!compatPaths[pathTemplate]) {
        compatPaths[pathTemplate] = {
          ...pickNonMethodKeys(existingPathItem),
        };
      }
      compatPaths[pathTemplate][methodLower] = existingOperation || fallbackOperation;
    }

    spec.paths = {
      ...corePaths,
      ...compatPaths,
    };
  } finally {
    await client.end();
  }

  spec.paths = sortPathsPreservingCore(spec.paths);
  if (!spec.info || typeof spec.info !== 'object') {
    spec.info = {};
  }
  spec.info.version = computeContractVersion(spec);
  spec.info['x-versioning-policy'] = 'contract-<sha256(openapi_without_info.version)[:12]>';

  const next = stableStringify(spec);

  if (args.check) {
    const current = normalizeComparableText(fs.readFileSync(openapiPath, 'utf8'));
    const expected = normalizeComparableText(next);
    if (current !== expected) {
      console.error(`[openapi] Drift detected: ${path.relative(repoRoot, openapiPath)}`);
      console.error('[openapi] Re-run: node scripts/docs/generate-public-openapi.js');
      process.exit(1);
    }
    console.log(`[openapi] OK (no drift): ${path.relative(repoRoot, openapiPath)}`);
    return;
  }

  fs.writeFileSync(openapiPath, next, 'utf8');
  console.log(`[openapi] Wrote: ${path.relative(repoRoot, openapiPath)}`);
}

if (require.main === module) {
  main().catch((err) => {
    const message = err && err.message ? err.message : String(err || 'Unknown error');
    console.error('[openapi] FAILED:', message);
    if (isTruthy(process.env.OPENAPI_DEBUG)) {
      console.error(err);
    }
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  readJson,
  stableStringify,
  normalizeComparableText,
  computeContractVersion,
  sortPathsPreservingCore,
  resolveOpenApiDbCandidatePolicy,
  resolveDbConnection,
  buildCompatOperation,
  fetchCompatRoutes,
  main,
};
