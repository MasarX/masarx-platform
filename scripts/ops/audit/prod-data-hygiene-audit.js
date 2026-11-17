#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Client } = require('pg');
const { loadEnv } = require('../../utils/load-env');
const {
  evaluateOperatorAccounts,
  resolveEnvironmentName,
  resolveRequiredOperatorAccounts,
} = require('./operator-access-core');

const DEFAULT_BASELINE_PATH = path.join('config', 'ops', 'prod-canonical-baseline.json');
const DEFAULT_PROFILE = 'pre-live';
const SUPPORTED_PROFILES = new Set(['pre-live', 'dev-shared']);

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    profile: DEFAULT_PROFILE,
    baseline: DEFAULT_BASELINE_PATH,
    environment: '',
    json: false,
    checkF164PermissionResync: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--json') out.json = true;
    else if (token === '--check-f164-permission-resync') out.checkF164PermissionResync = true;
    else if (token === '--environment') out.environment = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--environment=')) out.environment = token.split('=').slice(1).join('=').trim();
    else if (token === '--profile') out.profile = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--profile=')) out.profile = token.split('=').slice(1).join('=').trim();
    else if (token === '--baseline') out.baseline = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--baseline=')) out.baseline = token.split('=').slice(1).join('=').trim();
  }

  out.profile = String(out.profile || '').trim() || DEFAULT_PROFILE;
  out.baseline = String(out.baseline || '').trim() || DEFAULT_BASELINE_PATH;
  return out;
}

function resolvePath(filePath) {
  const value = String(filePath || '').trim();
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function readBaselineConfig(filePath) {
  const absolutePath = resolvePath(filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  return { absolutePath, parsed };
}

function assertIdentifier(input, kind) {
  const value = String(input || '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Invalid ${kind} identifier: ${value}`);
  }
  return value;
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function compilePatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : []).map((entry) => {
    const source = String(entry || '').trim();
    if (!source) return null;
    try {
      return { source, regex: new RegExp(source, 'i') };
    } catch (error) {
      throw new Error(`Invalid regex pattern "${source}": ${error.message}`);
    }
  }).filter(Boolean);
}

function evaluateCountLimit(tableName, count, limit = {}) {
  const min = Number.isFinite(Number(limit.min)) ? Number(limit.min) : null;
  const max = Number.isFinite(Number(limit.max)) ? Number(limit.max) : null;
  const issues = [];

  if (min !== null && count < min) {
    issues.push(`${tableName} count ${count} is below baseline min ${min}`);
  }
  if (max !== null && count > max) {
    issues.push(`${tableName} count ${count} exceeds baseline max ${max}`);
  }
  return issues;
}

async function fetchTableCount(client, tableName) {
  const table = assertIdentifier(tableName, 'table');
  const sql = `SELECT COUNT(*)::bigint AS total FROM public.${quoteIdent(table)};`;
  const { rows } = await client.query(sql);
  return Number(rows[0]?.total || 0);
}

async function evaluateCountLimits(client, baseline = {}) {
  const limits = baseline.count_limits || {};
  const counts = {};
  const issues = [];

  for (const [tableName, limit] of Object.entries(limits)) {
    const total = await fetchTableCount(client, tableName);
    counts[tableName] = total;
    issues.push(...evaluateCountLimit(tableName, total, limit));
  }

  return { counts, issues };
}

async function evaluateCanonicalGlobalRoot(client, baseline = {}) {
  const expected = baseline.canonical_global_root || {};
  const expectedId = String(expected.id || '').trim();
  const expectedSlug = String(expected.slug || '').trim();
  const issues = [];
  const rows = [];

  const sql = `
    SELECT id::text AS id, slug
    FROM public.organizations
    ORDER BY created_at ASC, id ASC;
  `;
  const result = await client.query(sql);
  for (const row of result.rows || []) {
    rows.push({ id: String(row.id || ''), slug: String(row.slug || '') });
  }

  if (rows.length !== 1) {
    issues.push(`organizations must contain exactly 1 row (global root), found ${rows.length}`);
  }
  for (const row of rows) {
    if (expectedSlug && row.slug !== expectedSlug) {
      issues.push(`organization slug "${row.slug}" is non-canonical (expected "${expectedSlug}")`);
    }
    if (expectedId && row.id !== expectedId) {
      issues.push(`organization id "${row.id}" is non-canonical (expected "${expectedId}")`);
    }
  }

  return { rows, issues };
}

async function evaluateCanonicalGlobalRootPresence(client, baseline = {}) {
  const expected = baseline.canonical_global_root || {};
  const expectedId = String(expected.id || '').trim();
  const expectedSlug = String(expected.slug || '').trim();
  const issues = [];
  const rows = [];

  if (!expectedId && !expectedSlug) {
    return { rows, issues };
  }

  const filters = [];
  const params = [];
  if (expectedId) {
    params.push(expectedId);
    filters.push(`id::text = $${params.length}`);
  }
  if (expectedSlug) {
    params.push(expectedSlug);
    filters.push(`slug = $${params.length}`);
  }

  const sql = `
    SELECT id::text AS id, slug
    FROM public.organizations
    WHERE ${filters.join(' OR ')}
    ORDER BY created_at ASC, id ASC;
  `;
  const result = await client.query(sql, params);
  for (const row of result.rows || []) {
    rows.push({ id: String(row.id || ''), slug: String(row.slug || '') });
  }

  const matches = rows.filter((row) => (
    (!expectedId || row.id === expectedId)
    && (!expectedSlug || row.slug === expectedSlug)
  ));
  if (matches.length === 0) {
    issues.push(
      `canonical global root row is missing (expected id="${expectedId || 'n/a'}", slug="${expectedSlug || 'n/a'}")`,
    );
  } else if (matches.length > 1) {
    issues.push(`canonical global root row must be unique, found ${matches.length}`);
  }

  if (expectedId) {
    for (const row of rows.filter((entry) => entry.id === expectedId && expectedSlug && entry.slug !== expectedSlug)) {
      issues.push(`global root id "${row.id}" has non-canonical slug "${row.slug}"`);
    }
  }
  if (expectedSlug) {
    for (const row of rows.filter((entry) => entry.slug === expectedSlug && expectedId && entry.id !== expectedId)) {
      issues.push(`global root slug "${row.slug}" has non-canonical id "${row.id}"`);
    }
  }

  return { rows: matches, issues };
}

function splitMarkerKey(key) {
  const parts = String(key || '').trim().split('.');
  if (parts.length !== 2) {
    throw new Error(`Invalid forbidden_markers key "${key}". Expected "table.column".`);
  }
  const table = assertIdentifier(parts[0], 'table');
  const column = assertIdentifier(parts[1], 'column');
  return { table, column };
}

async function scanForbiddenMarkers(client, baseline = {}) {
  const markerMap = baseline.forbidden_markers || {};
  const findings = [];

  for (const [key, patterns] of Object.entries(markerMap)) {
    const { table, column } = splitMarkerKey(key);
    const compiled = compilePatterns(patterns);
    if (!compiled.length) continue;

    const sql = `
      SELECT ${quoteIdent(column)}::text AS value, COUNT(*)::bigint AS row_count
      FROM public.${quoteIdent(table)}
      WHERE ${quoteIdent(column)} IS NOT NULL
      GROUP BY 1;
    `;
    const { rows } = await client.query(sql);
    for (const row of rows || []) {
      const value = String(row.value || '');
      for (const pattern of compiled) {
        if (pattern.regex.test(value)) {
          findings.push({
            table,
            column,
            value_sha256: createHash('sha256').update(value).digest('hex'),
            value_length: value.length,
            row_count: Number(row.row_count || 0),
            pattern: pattern.source,
          });
        }
      }
    }
  }

  return findings;
}

async function evaluateRequiredGlobalDefaults(client) {
  const sql = `
    WITH required AS (
      SELECT category
      FROM public.settings_category_registry
      WHERE requires_global_default IS TRUE
    ),
    present AS (
      SELECT DISTINCT category
      FROM public.settings
      WHERE scope_type = 'global'
    )
    SELECT r.category
    FROM required r
    LEFT JOIN present p ON p.category = r.category
    WHERE p.category IS NULL
    ORDER BY r.category ASC;
  `;
  const { rows } = await client.query(sql);
  return (rows || []).map((row) => String(row.category || '')).filter(Boolean);
}

async function evaluateRequiredFunctions(client, signatures = []) {
  const missing = [];
  for (const signature of Array.isArray(signatures) ? signatures : []) {
    const sig = String(signature || '').trim();
    if (!sig) continue;
    const { rows } = await client.query('SELECT to_regprocedure($1)::text AS found_signature;', [sig]);
    const found = String(rows[0]?.found_signature || '').trim();
    if (!found) missing.push(sig);
  }
  return missing;
}

async function evaluateRequiredAuditEnabledTables(client, baseline = {}) {
  const requiredTables = Array.isArray(baseline.required_audit_enabled_tables)
    ? baseline.required_audit_enabled_tables
    : [];
  if (!requiredTables.length) return [];

  const { rows } = await client.query(
    `
      SELECT tc.table_name, tc.audit_enabled
      FROM public.table_contracts tc
      WHERE tc.table_schema = 'public'
        AND tc.table_name = ANY($1::text[])
    `,
    [requiredTables],
  );
  const byTable = new Map();
  for (const row of rows || []) {
    byTable.set(String(row.table_name || '').trim(), Boolean(row.audit_enabled));
  }

  const issues = [];
  for (const tableName of requiredTables) {
    const normalized = assertIdentifier(tableName, 'table');
    if (!byTable.has(normalized)) {
      issues.push(`${normalized} missing from table_contracts`);
      continue;
    }
    if (!byTable.get(normalized)) {
      issues.push(`${normalized} must have table_contracts.audit_enabled=true`);
    }
  }
  return issues;
}

async function evaluateF164PermissionResync(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SET LOCAL row_security = off');
    const { rows: columns } = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'supabase_migrations'
        AND table_name IN ('schema_migrations', 'applied_migrations')
      ORDER BY table_name, ordinal_position`);
    const tables = ['schema_migrations', 'applied_migrations']
      .filter((name) => columns.some((column) => column.table_name === name));
    if (!tables.length) throw new Error('F164 migration history unavailable');
    const stores = [];
    for (const table of tables) {
      const names = new Set(columns.filter((column) => column.table_name === table).map((column) => column.column_name));
      if (!names.has('version')) throw new Error('F164 migration history lacks version');
      const digestColumn = ['checksum', 'sha256', 'hash'].find((name) => names.has(name));
      const fields = ['version', ...(names.has('name') ? ['name'] : []), ...(digestColumn ? [digestColumn] : [])];
      const { rows: history } = await client.query(
        `SELECT ${fields.map(quoteIdent).join(', ')} FROM supabase_migrations.${quoteIdent(table)} WHERE version::text = $1`,
        ['202608161250'],
      );
      stores.push({ table, names, digestColumn, history });
    }
    if (stores.reduce((count, store) => count + store.history.length, 0) > 1) {
      throw new Error('F164 migration history is ambiguous across recorded authorities');
    }
    const { table, names, digestColumn, history } = stores.find((store) => store.history.length) || stores[0];
    const recordedName = names.has('name') ? history[0]?.name : null;
    const authorityKnown = history.length === 0 || Boolean(recordedName);
    if (recordedName != null && !/^(?:202608161250_)?b3_access_policy_kyc_permission_resync_v1(?:\.sql)?$/.test(String(recordedName))) {
      throw new Error('F164 migration name does not match expected authority');
    }
    const recordedDigest = digestColumn ? history[0]?.[digestColumn] : null;
    if (recordedDigest != null && !/^[a-f0-9]{32,128}$/i.test(String(recordedDigest))) {
      throw new Error('F164 recorded migration digest has unsupported format');
    }
    const { rows: definitions } = await client.query(
      "SELECT COUNT(*)::int AS total FROM public.lookup_definitions WHERE category = 'rbac_permission'",
    );
    if (Number(definitions[0]?.total) !== 1) throw new Error('F164 requires exactly one rbac_permission definition');
    const { rows: wildcards } = await client.query(`
      SELECT
        (lv.metadata->>'source' = 'access_policy_kyc_permission_resync_v1') IS TRUE AS affected,
        (lv.metadata->>'settings_category' = 'access_control_policy') IS TRUE AS policy_category,
        (btrim(lv.metadata->>'capability_key') = '*') IS TRUE AS wildcard_capability,
        (lv.status = 'active') IS TRUE AS active,
        COUNT(*)::int AS total
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission' AND btrim(lv.value) = '*'
      GROUP BY 1, 2, 3, 4`);
    const affectedCount = wildcards.filter((row) => row.affected).reduce((sum, row) => sum + Number(row.total), 0);
    const references = [];
    if (affectedCount) {
      const { rows: foreignKeys } = await client.query(`
        SELECT ns.nspname AS schema_name, rel.relname AS table_name, attr.attname AS column_name,
          cardinality(c.conkey) AS source_columns, cardinality(c.confkey) AS target_columns,
          target.attname AS target_column
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_attribute attr ON attr.attrelid = c.conrelid AND attr.attnum = c.conkey[1]
        JOIN pg_attribute target ON target.attrelid = c.confrelid AND target.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'public.lookup_values'::regclass
        ORDER BY ns.nspname, rel.relname, attr.attname`);
      for (const fk of foreignKeys) {
        if (Number(fk.source_columns) !== 1 || Number(fk.target_columns) !== 1 || fk.target_column !== 'id') {
          throw new Error('F164 reference accounting requires review of a non-ID or composite foreign key');
        }
        const schema = assertIdentifier(fk.schema_name, 'schema');
        const relation = assertIdentifier(fk.table_name, 'table');
        const column = assertIdentifier(fk.column_name, 'column');
        const { rows } = await client.query(`
          SELECT COUNT(*)::bigint AS total FROM ${quoteIdent(schema)}.${quoteIdent(relation)} ref
          JOIN public.lookup_values lv ON lv.id = ref.${quoteIdent(column)}
          JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
          WHERE ld.category = 'rbac_permission' AND btrim(lv.value) = '*'
            AND lv.metadata->>'source' = 'access_policy_kyc_permission_resync_v1'`);
        references.push({ schema, table: relation, column, count: Number(rows[0]?.total) });
      }
    }
    const unrelatedCount = wildcards.filter((row) => !row.affected).reduce((sum, row) => sum + Number(row.total), 0);
    return {
      version: '202608161250',
      history_table: `supabase_migrations.${table}`,
      migration_recorded: history.length === 1,
      recorded_name: recordedName == null ? null : String(recordedName),
      recorded_digest_column: digestColumn || null,
      recorded_digest: recordedDigest == null ? null : String(recordedDigest),
      affected_wildcards: affectedCount,
      unrelated_wildcards: unrelatedCount,
      provenance_counts: wildcards,
      references,
      reference_scope: 'declared single-column foreign keys to lookup_values.id only; not deletion authority',
      status: !authorityKnown ? 'unknown-migration-authority-review'
        : affectedCount ? 'affected-preserve-review' : unrelatedCount ? 'unattributed-wildcards-review'
        : history.length ? 'clean-existing-state' : 'compatible-pending-corrected-migration',
      ok: authorityKnown && affectedCount === 0 && unrelatedCount === 0,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runAudit(client, options = {}) {
  const profile = String(options.profile || DEFAULT_PROFILE).trim();
  const baseline = options.baseline || {};
  const environment = resolveEnvironmentName({
    explicitEnvironment: options.environment,
    env: options.env || process.env,
  });

  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`Unsupported audit profile "${profile}". Supported profiles: pre-live, dev-shared.`);
  }

  const countCheck = await evaluateCountLimits(client, baseline);
  const globalRootCheck = profile === 'pre-live'
    ? await evaluateCanonicalGlobalRoot(client, baseline)
    : await evaluateCanonicalGlobalRootPresence(client, baseline);
  const markerFindings = profile === 'pre-live'
    ? await scanForbiddenMarkers(client, baseline)
    : [];
  const missingRequiredDefaults = await evaluateRequiredGlobalDefaults(client);
  const missingFunctions = await evaluateRequiredFunctions(client, baseline.required_onboarding_functions || []);
  const missingAuditEnabledTables = await evaluateRequiredAuditEnabledTables(client, baseline);
  const requiredOperatorAccounts = resolveRequiredOperatorAccounts(baseline, environment);
  const operatorAudit = await evaluateOperatorAccounts(client, {
    requiredAccounts: requiredOperatorAccounts,
  });

  const issues = [
    ...(profile === 'pre-live' ? countCheck.issues : []),
    ...globalRootCheck.issues,
    ...missingAuditEnabledTables,
    ...operatorAudit.issues,
  ];

  for (const finding of markerFindings) {
    issues.push(
      `${finding.table}.${finding.column} contains a forbidden value (sha256=${finding.value_sha256}, length=${finding.value_length}, pattern ${finding.pattern}, rows=${finding.row_count})`,
    );
  }
  if (missingRequiredDefaults.length) {
    issues.push(
      `Missing required global defaults for categories: ${missingRequiredDefaults.join(', ')}`,
    );
  }
  if (missingFunctions.length) {
    issues.push(
      `Missing required onboarding functions: ${missingFunctions.join(', ')}`,
    );
  }

  const f164 = options.checkF164PermissionResync ? await evaluateF164PermissionResync(client) : null;
  if (f164 && !f164.ok) issues.push('F164 wildcard provenance requires preservation review; no rows changed');

  return {
    ...(f164 ? { f164_permission_resync: f164 } : {}),
    profile,
    environment,
    counts: countCheck.counts,
    canonical_org_rows: globalRootCheck.rows,
    marker_findings: markerFindings,
    missing_required_defaults: missingRequiredDefaults,
    missing_onboarding_functions: missingFunctions,
    missing_audit_enabled_tables: missingAuditEnabledTables,
    operator_access_audit: operatorAudit,
    issues,
    ok: issues.length === 0,
  };
}

function printUsage() {
  console.log('Usage: node scripts/ops/audit/prod-data-hygiene-audit.js [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --profile <name>            Audit profile (default: ${DEFAULT_PROFILE}; supported: pre-live, dev-shared)`);
  console.log(`  --baseline <path>           Baseline file path (default: ${DEFAULT_BASELINE_PATH})`);
  console.log('  --environment <dev|stg|prod> Optional target environment for operator account assertions');
  console.log('  --check-f164-permission-resync Read-only existing-state F164 audit');
  console.log('  --json                      Print JSON summary');
  console.log('  --help, -h                  Show usage');
}

async function main() {
  try {
    loadEnv();
  } catch {
    // best effort; explicit env var checks happen below
  }

  const args = parseArgs();
  if (args.help) {
    printUsage();
    return;
  }

  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for prod data hygiene audit.');
  }

  const baselineResult = readBaselineConfig(args.baseline);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
      const result = await runAudit(client, {
        profile: args.profile,
        baseline: baselineResult.parsed,
        environment: args.environment,
        env: process.env,
        checkF164PermissionResync: args.checkF164PermissionResync,
      });

    if (args.json) {
      console.log(JSON.stringify({
        baseline_path: baselineResult.absolutePath,
        ...result,
      }, null, 2));
    } else {
      console.log('[prod-data-hygiene-audit] Summary');
      console.log(`- profile: ${result.profile}`);
      console.log(`- environment: ${result.environment || 'n/a'}`);
      console.log(`- baseline: ${path.relative(process.cwd(), baselineResult.absolutePath)}`);
      Object.entries(result.counts || {}).forEach(([table, total]) => {
        console.log(`- count.${table}: ${total}`);
      });
      console.log(`- missing_required_defaults: ${result.missing_required_defaults.length}`);
      console.log(`- missing_onboarding_functions: ${result.missing_onboarding_functions.length}`);
      console.log(`- missing_audit_enabled_tables: ${result.missing_audit_enabled_tables.length}`);
      console.log(`- operator_accounts_required: ${result.operator_access_audit.required}`);
      console.log(`- operator_accounts_issues: ${result.operator_access_audit.issues.length}`);
      console.log(`- forbidden_marker_findings: ${result.marker_findings.length}`);
    }

    if (!result.ok) {
      console.error('[prod-data-hygiene-audit] FAILED');
      for (const issue of result.issues) {
        console.error(`- ${issue}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log('[prod-data-hygiene-audit] OK');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[prod-data-hygiene-audit] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  compilePatterns,
  evaluateCountLimit,
  evaluateF164PermissionResync,
  evaluateRequiredAuditEnabledTables,
  parseArgs,
  runAudit,
  splitMarkerKey,
};
