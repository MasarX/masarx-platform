#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * migration-repair-missing.js
 *
 * Fixes a common Supabase Cloud drift mode where the remote migration history
 * contains versions that are no longer present in the repo's supabase/migrations
 * directory (repo is SSOT).
 *
 * Additionally, repairs name drift for versions that exist locally but have a
 * mismatched `name` in the remote migration history table.
 *
 * In CI/GitHub Actions this script:
 *   - marks remote-only versions as reverted (so db push can proceed)
 *   - rewrites name drift by "revert then apply" for the affected versions,
 *     so the remote history matches the repo's migration filenames.
 *
 * Safety:
 * - By default, auto-repair only runs when GITHUB_ACTIONS/CI is true.
 * - For local/manual runs, set ALLOW_MIGRATION_REPAIR=1 to allow repair.
 * - Set MIGRATION_REPAIR_DRY_RUN=1 to print actions without mutating history.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');

function die(msg) {
  console.error(`[migration-repair-missing] ${msg}`);
  process.exit(1);
}

function normalizeDbUrl(raw) {
  return String(raw || '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function resolveDbUrlCandidates(env = process.env) {
  const direct = normalizeDbUrl(env.DATABASE_URL_DIRECT);
  const canonical = normalizeDbUrl(env.DATABASE_URL);
  const out = [];
  if (direct) out.push({ label: 'direct', url: direct });
  if (canonical && canonical !== direct) out.push({ label: 'canonical', url: canonical });
  return out;
}

function resolveConnectTimeoutMs(env = process.env) {
  const raw = String(env.MIGRATION_REPAIR_CONNECT_TIMEOUT_MS || '').trim();
  if (!raw) return 15000;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 15000;
  return Math.floor(num);
}

function createPgClient(dbUrl, env = process.env) {
  const client = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: resolveConnectTimeoutMs(env),
  });
  client.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    console.warn(`[migration-repair-missing] pg client emitted error event: ${message}`);
  });
  return client;
}

async function closePgClient(client, label) {
  if (!client || typeof client.end !== 'function') return;
  try {
    await client.end();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const context = String(label || 'pg-client').trim() || 'pg-client';
    console.warn(`[migration-repair-missing] ${context} shutdown warning: ${message}`);
  }
}

async function hasDialog360ReplyWebhookPolicy(dbUrl) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `
        SELECT
          to_regclass('public.webhook_sources') AS webhook_sources,
          to_regclass('public.settings') AS settings
      `,
    );
    const hasTables =
      Boolean(tables && tables[0] && tables[0].webhook_sources) &&
      Boolean(tables && tables[0] && tables[0].settings);
    if (!hasTables) return false;

    const res = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM public.webhook_sources ws
          JOIN public.settings s
            ON s.category = 'webhook_ingest_policy'
           AND s.scope_type = 'source'
           AND s.scope_id = ws.id
          WHERE ws.source_identifier = 'dialog360_reply'
        ) AS present
      `,
    );
    return Boolean(res.rows && res.rows[0] && res.rows[0].present);
  } finally {
    await closePgClient(client, 'hasDialog360ReplyWebhookPolicy');
  }
}

async function upsertSchemaMigrationRow(dbUrl, version, name) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    try {
      await insertSchemaMigrationRow(client, version, name);
    } catch (err) {
      if (!isMissingSchemaMigrationsTableError(err)) {
        throw err;
      }
      await ensureSchemaMigrationsTable(client);
      await insertSchemaMigrationRow(client, version, name);
    }
    return true;
  } catch (err) {
    if (isMissingSchemaMigrationsTableError(err)) {
      return false;
    }
    throw err;
  } finally {
    await closePgClient(client, 'upsertSchemaMigrationRow');
  }
}

function isMissingSchemaMigrationsTableError(error) {
  const code = String(error && error.code || '').trim();
  const msg = String(error && error.message ? error.message : error);
  return (
    code === '42P01' ||
    (/supabase_migrations\.schema_migrations/i.test(msg) && /does not exist/i.test(msg))
  );
}

async function ensureSchemaMigrationsTable(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query(`
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    )
  `);
}

async function insertSchemaMigrationRow(client, version, name) {
  await client.query(
    `
      INSERT INTO supabase_migrations.schema_migrations(version, name)
      VALUES ($1, $2)
      ON CONFLICT (version) DO UPDATE
        SET name = EXCLUDED.name
    `,
    [String(version || '').trim(), String(name || '').trim()],
  );
}

function normalizeBaseName(name) {
  if (!name) return '';
  let n = String(name).trim();
  n = n.replace(/\.sql$/i, '');
  n = n.replace(/^\d{8,}[_-]/, '');
  return n.trim();
}

function resolveRepairConfigPath(env = process.env) {
  const raw = String(env.MIGRATION_REPAIR_RULES_PATH || 'config/ops/migration-repair-rules.json').trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function loadRepairRules(env = process.env) {
  const filePath = resolveRepairConfigPath(env);
  if (!fs.existsSync(filePath)) {
    die(`Missing migration repair rules config at ${filePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    die(`Invalid migration repair rules config at ${filePath}: ${error.message}`);
  }

  const version = Number(parsed && parsed.version);
  if (version !== 1) {
    die(`Unsupported migration repair rules version ${String(parsed && parsed.version || '<missing>')} (expected 1).`);
  }

  const rules = Array.isArray(parsed && parsed.rules) ? parsed.rules : [];
  const seen = new Set();
  return rules.map((rule, index) => {
    const normalized = rule && typeof rule === 'object' ? rule : null;
    if (!normalized) {
      die(`migration repair rule[${index}] must be an object`);
    }
    const entry = {
      version: String(normalized.version || '').trim(),
      mode: String(normalized.mode || '').trim(),
      probe_handler: String(normalized.probe_handler || '').trim(),
      sql_path: String(normalized.sql_path || '').trim(),
      description: String(normalized.description || '').trim(),
    };
    if (!entry.version) die(`migration repair rule[${index}] missing version`);
    if (seen.has(entry.version)) die(`migration repair rules duplicate version ${entry.version}`);
    seen.add(entry.version);
    if (!entry.mode) die(`migration repair rule ${entry.version} missing mode`);
    if (!['history_only_mark_applied', 'pre_push_apply_sql'].includes(entry.mode)) {
      die(`migration repair rule ${entry.version} has unsupported mode ${entry.mode}`);
    }
    if (!entry.probe_handler) die(`migration repair rule ${entry.version} missing probe_handler`);
    if (entry.mode === 'pre_push_apply_sql' && !entry.sql_path) {
      die(`migration repair rule ${entry.version} missing sql_path`);
    }
    return entry;
  });
}

function resolveRuleSqlPath(rule) {
  const raw = String(rule && rule.sql_path || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function listLocalMigrations() {
  const dir = path.join(process.cwd(), 'supabase', 'migrations');
  if (!fs.existsSync(dir)) die(`Missing supabase/migrations directory at ${dir}`);

  const versions = new Set();
  const baseByVersion = new Map();

  const crawl = (p) => {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (e.name === 'archive' || e.name.startsWith('.')) continue;
        crawl(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.sql')) continue;
      const m = e.name.match(/^(\d{10,14})_([a-z0-9_-]+)\.sql$/i);
      if (!m) continue;
      const version = m[1];
      const base = m[2];
      versions.add(version);
      if (!baseByVersion.has(version)) {
        baseByVersion.set(version, base);
      }
    }
  };

  crawl(dir);
  return { versions, baseByVersion };
}

async function listRemoteMigrations(dbUrl) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    let res;
    try {
      res = await client.query('select version, name from supabase_migrations.schema_migrations order by version');
    } catch (e1) {
      try {
        res = await client.query('select version, name from supabase_migrations.applied_migrations order by version');
      } catch (e2) {
        const code = String(e2 && e2.code || '').trim();
        const msg = String(e2 && e2.message || '').toLowerCase();
        // Fresh projects may not have supabase_migrations yet; nothing to repair pre-push.
        if (code === '42p01' || msg.includes('does not exist')) {
          console.log('[migration-repair-missing] Remote migration history table missing (fresh DB). Skipping repair.');
          return [];
        }
        // Preserve earlier error context for diagnostics.
        const prev = String(e1 && e1.message || '').trim();
        if (prev) {
          console.warn(`[migration-repair-missing] schema_migrations query failed: ${prev}`);
        }
        throw e2;
      }
    }
    return res.rows
      .map((r) => ({
        version: String(r.version || '').trim(),
        name: String(r.name || '').trim(),
      }))
      .filter((r) => Boolean(r.version));
  } finally {
    await closePgClient(client, 'listRemoteMigrations');
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function runRepair(status, versions) {
  if (!versions.length) return;
  const nodeCmd = process.execPath || 'node';
  const args = [path.join('scripts', 'ops', 'supabase-cli.js'), 'migration:repair', '--status', status, ...versions];
  const res = spawnSync(nodeCmd, args, { stdio: 'inherit', env: process.env });
  if (res.error) die(`repair error: ${res.error.message}`);
  if (res.status !== 0) die(`repair exited with status ${res.status}`);
}

async function hasLabelTemplateBackfillOrphanOrgReferences(dbUrl) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `
        SELECT
          to_regclass('public.label_jobs') AS label_jobs,
          to_regclass('public.labels') AS labels,
          to_regclass('public.organizations') AS organizations
      `,
    );
    const hasTables =
      Boolean(tables && tables[0] && tables[0].label_jobs) &&
      Boolean(tables && tables[0] && tables[0].labels) &&
      Boolean(tables && tables[0] && tables[0].organizations);
    if (!hasTables) return false;

    const res = await client.query(
      `
        WITH referenced_templates AS (
          SELECT DISTINCT
            lj.template_id AS id,
            lj.organization_id AS organization_id
          FROM public.label_jobs lj
          WHERE lj.template_id IS NOT NULL

          UNION

          SELECT DISTINCT
            l.layout_template_id AS id,
            l.organization_id AS organization_id
          FROM public.labels l
          WHERE l.layout_template_id IS NOT NULL
        )
        SELECT EXISTS (
          SELECT 1
          FROM referenced_templates rt
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.organizations o
            WHERE o.id = rt.organization_id
          )
        ) AS present
      `,
    );
    return Boolean(res && res.rows && res.rows[0] && res.rows[0].present);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/relation .*public\\.(label_jobs|labels|organizations).* does not exist/i.test(msg)) {
      return false;
    }
    throw err;
  } finally {
    await closePgClient(client, 'hasLabelTemplateBackfillOrphanOrgReferences');
  }
}

async function hasLabelsPrintWorkflowV2ReferencedSteps(dbUrl) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `
        SELECT
          to_regclass('public.workflow_templates') AS workflow_templates,
          to_regclass('public.workflow_template_steps') AS workflow_template_steps,
          to_regclass('public.workflow_runs') AS workflow_runs,
          to_regclass('public.workflow_run_steps') AS workflow_run_steps
      `,
    );
    const hasTables =
      Boolean(tables && tables[0] && tables[0].workflow_templates) &&
      Boolean(tables && tables[0] && tables[0].workflow_template_steps) &&
      Boolean(tables && tables[0] && tables[0].workflow_runs) &&
      Boolean(tables && tables[0] && tables[0].workflow_run_steps);
    if (!hasTables) return false;

    const res = await client.query(
      `
        WITH source_template AS (
          SELECT id
          FROM public.workflow_templates
          WHERE name = 'labels_print_workflow_v2'
          LIMIT 1
        )
        SELECT EXISTS (
          SELECT 1
          FROM public.workflow_template_steps wts
          JOIN source_template st
            ON st.id = wts.workflow_template_id
          WHERE EXISTS (
                  SELECT 1
                  FROM public.workflow_runs wr
                  WHERE wr.current_step_id = wts.id
                )
             OR EXISTS (
                  SELECT 1
                  FROM public.workflow_run_steps wrs
                  WHERE wrs.workflow_template_step_id = wts.id
                )
        ) AS present
      `,
    );
    return Boolean(res && res.rows && res.rows[0] && res.rows[0].present);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/relation .*public\.(workflow_templates|workflow_template_steps|workflow_runs|workflow_run_steps).* does not exist/i.test(message)) {
      return false;
    }
    throw error;
  } finally {
    await closePgClient(client, 'hasLabelsPrintWorkflowV2ReferencedSteps');
  }
}

async function hasMarketplaceNetworkRegistryRls(dbUrl) {
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    const { rows: objects } = await client.query(
      `
        SELECT
          to_regclass('public.marketplace_registry_entries') AS marketplace_registry_entries,
          to_regclass('public.marketplace_request_kinds') AS marketplace_request_kinds,
          to_regclass('public.marketplace_requests') AS marketplace_requests,
          to_regprocedure('public.marketplace_system_org_id_v1()') AS marketplace_system_org_id_v1,
          to_regprocedure('public.marketplace_can_read_request_v1(uuid,text)') AS marketplace_can_read_request_v1,
          to_regprocedure('public.marketplace_can_read_contract_v1(uuid,uuid)') AS marketplace_can_read_contract_v1
      `,
    );
    const row = objects && objects[0] ? objects[0] : {};
    const hasObjects =
      Boolean(row.marketplace_registry_entries) &&
      Boolean(row.marketplace_request_kinds) &&
      Boolean(row.marketplace_requests) &&
      Boolean(row.marketplace_system_org_id_v1) &&
      Boolean(row.marketplace_can_read_request_v1) &&
      Boolean(row.marketplace_can_read_contract_v1);
    if (!hasObjects) return false;

    const { rows: rlsRows } = await client.query(
      `
        SELECT relname, relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND relname IN ('marketplace_registry_entries', 'marketplace_request_kinds', 'marketplace_requests')
      `,
    );
    const rlsByTable = new Map(
      (rlsRows || []).map((entry) => [String(entry.relname || '').trim(), Boolean(entry.relrowsecurity)]),
    );
    const hasRls =
      rlsByTable.get('marketplace_registry_entries') === true &&
      rlsByTable.get('marketplace_request_kinds') === true &&
      rlsByTable.get('marketplace_requests') === true;
    if (!hasRls) return false;

    const { rows: policyRows } = await client.query(
      `
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND (
            (tablename = 'marketplace_registry_entries' AND policyname IN ('marketplace_registry_entries_service_policy', 'marketplace_registry_entries_read_policy'))
            OR (tablename = 'marketplace_request_kinds' AND policyname IN ('marketplace_request_kinds_service_policy', 'marketplace_request_kinds_read_policy'))
            OR (tablename = 'marketplace_requests' AND policyname IN ('marketplace_requests_service_policy', 'marketplace_requests_read_policy'))
          )
      `,
    );
    const expectedPolicies = new Set([
      'marketplace_registry_entries:marketplace_registry_entries_service_policy',
      'marketplace_registry_entries:marketplace_registry_entries_read_policy',
      'marketplace_request_kinds:marketplace_request_kinds_service_policy',
      'marketplace_request_kinds:marketplace_request_kinds_read_policy',
      'marketplace_requests:marketplace_requests_service_policy',
      'marketplace_requests:marketplace_requests_read_policy',
    ]);
    for (const policy of policyRows || []) {
      const table = String(policy.tablename || '').trim();
      const name = String(policy.policyname || '').trim();
      expectedPolicies.delete(`${table}:${name}`);
    }
    return expectedPolicies.size === 0;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (
      /relation .*public\.(marketplace_registry_entries|marketplace_request_kinds|marketplace_requests).* does not exist/i.test(message) ||
      /function public\.(marketplace_system_org_id_v1|marketplace_can_read_request_v1|marketplace_can_read_contract_v1).* does not exist/i.test(message)
    ) {
      return false;
    }
    throw error;
  } finally {
    await closePgClient(client, 'hasMarketplaceNetworkRegistryRls');
  }
}

async function applySqlFile(dbUrl, filePath) {
  const file = String(filePath || '').trim();
  if (!file) throw new Error('applySqlFile: filePath is required.');
  const sql = fs.readFileSync(file, 'utf8');
  const client = createPgClient(dbUrl);
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await closePgClient(client, 'applySqlFile');
  }
}

async function main() {
  loadEnv();
  const candidates = resolveDbUrlCandidates(process.env);
  if (!candidates.length) {
    die('DATABASE_URL or DATABASE_URL_DIRECT is not set (expected ENV_FILE=config/env/.env.cloud or exported env vars).');
  }

  const local = listLocalMigrations();

  let dbUrl = '';
  let remote = [];
  const errors = [];
  for (const candidate of candidates) {
    try {
      remote = await listRemoteMigrations(candidate.url);
      dbUrl = candidate.url;
      break;
    } catch (err) {
      errors.push({
        label: candidate.label,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  if (!dbUrl) {
    const summary = errors.map((e) => `${e.label}: ${e.message}`).join('; ');
    const inCi = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
    if (inCi) {
      console.warn(`[migration-repair-missing] Unable to inspect remote migration history (skipping repair): ${summary}`);
      return;
    }
    die(`Unable to inspect remote migration history: ${summary}`);
  }

  const remoteVersions = remote.map((r) => r.version);
  const localVersions = Array.from(local.versions);

  const missing = remoteVersions.filter((v) => !local.versions.has(v));
  const mismatched = remote
    .filter((r) => local.baseByVersion.has(r.version))
    .map((r) => {
      const localBase = local.baseByVersion.get(r.version) || '';
      const remoteNameRaw = String(r.name || '').trim();
      const remoteBase = normalizeBaseName(remoteNameRaw);
      return {
        version: r.version,
        localBase,
        remoteBase,
        remoteNameRaw,
      };
    })
    .filter((r) => {
      if (!r.localBase) return false;
      // Supabase CLI can treat (version,name) as the applied identity; if the
      // version exists but the stored name does not match the repo SSOT, it may
      // try to reapply the migration and fail on duplicate versions.
      const expected = String(r.localBase || '').trim();
      const actual = String(r.remoteNameRaw || '').trim();
      if (!actual) return true;
      return expected.toLowerCase() !== actual.toLowerCase();
    });

  const locallyMissing = localVersions.filter((v) => !remoteVersions.includes(v));
  const repairRules = loadRepairRules(process.env);
  const repairProbeHandlers = {
    dialog360_reply_webhook_policy_present: hasDialog360ReplyWebhookPolicy,
    label_template_orphan_org_references_present: hasLabelTemplateBackfillOrphanOrgReferences,
    labels_print_workflow_v2_referenced_steps_present: hasLabelsPrintWorkflowV2ReferencedSteps,
    marketplace_network_registry_rls_present: hasMarketplaceNetworkRegistryRls,
  };
  const autoApplied = [];
  const prePushFixes = [];

  for (const rule of repairRules) {
    if (!locallyMissing.includes(rule.version)) continue;
    const probeHandler = repairProbeHandlers[rule.probe_handler];
    if (typeof probeHandler !== 'function') {
      die(`Unsupported migration repair probe handler "${rule.probe_handler}" for version ${rule.version}`);
    }
    const matched = await probeHandler(dbUrl);
    if (!matched) continue;

    if (rule.mode === 'history_only_mark_applied') {
      autoApplied.push({
        version: rule.version,
        name: local.baseByVersion.get(rule.version) || normalizeBaseName(rule.version),
        description: rule.description,
      });
      continue;
    }

    const sqlPath = resolveRuleSqlPath(rule);
    if (!sqlPath || !fs.existsSync(sqlPath)) {
      die(`migration repair rule ${rule.version} points to missing SQL file ${sqlPath || '<empty>'}`);
    }
    prePushFixes.push({
      version: rule.version,
      sqlPath,
      description: rule.description,
    });
  }

  if (!missing.length && !mismatched.length && !autoApplied.length && !prePushFixes.length) {
    console.log('[migration-repair-missing] No remote migration history repairs needed.');
    process.exit(0);
  }

  const dryRun = process.env.MIGRATION_REPAIR_DRY_RUN === '1';

  const allowRepair =
    process.env.ALLOW_MIGRATION_REPAIR === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.CI === 'true';

  if (!allowRepair) {
    die(
      `Remote migration history needs repair (remote_only=${missing.length} name_mismatches=${mismatched.length} history_only=${autoApplied.length} preflight_fixes=${prePushFixes.length}). ` +
      `Set ALLOW_MIGRATION_REPAIR=1 to repair (or run in CI/GitHub Actions).`,
    );
  }

  if (autoApplied.length) {
    console.log(`[migration-repair-missing] Repairing ${autoApplied.length} missing local versions (history-only applied)...`);
    if (dryRun) {
      autoApplied.forEach((m) => console.log(`- ${m.version}: ${m.name}`));
    } else {
      for (const m of autoApplied) {
        const ok = await upsertSchemaMigrationRow(dbUrl, m.version, m.name);
        if (!ok) {
          runRepair('applied', [m.version]);
        }
      }
    }
  }

  if (prePushFixes.length) {
    console.log(`[migration-repair-missing] Applying ${prePushFixes.length} pre-push repair fix(es)...`);
    for (const fix of prePushFixes) {
      const label = `${fix.version}${fix.description ? ` (${fix.description})` : ''}`;
      if (dryRun) {
        console.log(`- would apply pre-push fix: ${label} -> ${path.basename(fix.sqlPath)}`);
        continue;
      }
      console.log(`[migration-repair-missing] Applying pre-push fix ${label} via ${path.basename(fix.sqlPath)}...`);
      await applySqlFile(dbUrl, fix.sqlPath);
    }
  }

  if (missing.length) {
    console.log(`[migration-repair-missing] Repairing ${missing.length} remote-only versions (status=reverted)...`);
    if (dryRun) {
      console.log('[migration-repair-missing] Dry-run; would revert:', missing.join(', '));
    } else {
      for (const part of chunk(missing, 75)) {
        runRepair('reverted', part);
      }
    }
  }

  if (mismatched.length) {
    console.log(`[migration-repair-missing] Repairing ${mismatched.length} version/name mismatches (align name)...`);
    if (dryRun) {
      mismatched.slice(0, 25).forEach((m) => {
        console.log(`- ${m.version}: remote=${m.remoteNameRaw || '<empty>'} local=${m.localBase}`);
      });
      if (mismatched.length > 25) console.log(`- ...and ${mismatched.length - 25} more`);
    } else {
      const fallback = [];
      for (const m of mismatched) {
        const ok = await upsertSchemaMigrationRow(dbUrl, m.version, m.localBase);
        if (!ok) fallback.push(m.version);
      }
      if (fallback.length) {
        for (const part of chunk(fallback, 50)) {
          runRepair('reverted', part);
          runRepair('applied', part);
        }
      }
    }
  }

  console.log('[migration-repair-missing] Repair complete.');
}

if (require.main === module) {
  main().catch((err) => {
    die(err && err.message ? err.message : String(err));
  });
}

module.exports = {
  hasMarketplaceNetworkRegistryRls,
  normalizeDbUrl,
  resolveDbUrlCandidates,
  resolveConnectTimeoutMs,
  resolveRepairConfigPath,
  isMissingSchemaMigrationsTableError,
  loadRepairRules,
  resolveRuleSqlPath,
};
