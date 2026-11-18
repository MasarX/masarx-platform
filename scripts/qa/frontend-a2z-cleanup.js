#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../utils/resolve-db-url');

loadEnv();

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    manifest: '',
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (token === '--manifest' && next) {
      out.manifest = next;
      i += 1;
    } else if (token.startsWith('--manifest=')) {
      out.manifest = token.split('=').slice(1).join('=');
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token.startsWith('--out=')) {
      out.out = token.split('=').slice(1).join('=');
    }
  }
  return out;
}

function resolveDatabaseUrl(env = process.env) {
  const candidates = [
    String(env.DATABASE_URL || '').trim(),
    String(env.DATABASE_URL_DIRECT || '').trim(),
    String(env.DATABASE_URL_POOLER || '').trim(),
  ].filter(Boolean);
  return candidates[0] || '';
}

async function resolveDatabaseUrlForCleanup(env = process.env) {
  return resolveDatabaseUrlWithFallback({
    env,
    logger: console,
    label: 'frontend-a2z-cleanup',
    connectionTimeoutEnv: 'UI_A2Z_DB_CONNECT_TIMEOUT_MS',
    maxWaitEnv: 'UI_A2Z_DB_CONNECT_MAX_WAIT_MS',
    retryDelayEnv: 'UI_A2Z_DB_CONNECT_RETRY_DELAY_MS',
  });
}

function parseManifestEntries(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry && typeof entry === 'object');
}

function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const kind = String(entry.kind || '').trim();
    const id = String(entry.id || '').trim();
    if (!kind || !id) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      id,
      label: String(entry.label || '').trim() || null,
      runId: String(entry.run_id || '').trim() || null,
      metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : null,
    });
  }
  return out;
}
function sortEntriesForCleanup(entries) {
  const kindPriority = {
    settings_view: 0,
    task: 1,
    label: 2,
    shipment: 3,
    workflow_template: 4,
  };
  return [...entries].sort((a, b) =>
    (kindPriority[a.kind] ?? 99) - (kindPriority[b.kind] ?? 99)
  );
}


async function cleanupShipment(client, id) {
  try {
    const removed = await client.query('DELETE FROM shipments WHERE id = $1::uuid', [id]);
    if (removed.rowCount > 0) {
      return { action: 'delete', ok: true, rowCount: removed.rowCount };
    }

    return { action: 'noop', ok: true, rowCount: 0 };
  } catch (error) {
    try {
      const soft = await client.query(
        "UPDATE shipments SET status = 'canceled' WHERE id = $1::uuid",
        [id]
      );
      if (soft.rowCount > 0) {
        return { action: 'soft-cancel', ok: true, rowCount: soft.rowCount, recoveredFrom: error.message };
      }
      return { action: 'failed', ok: false, rowCount: 0, error: error.message };
    } catch (fallbackError) {
      return {
        action: 'failed',
        ok: false,
        rowCount: 0,
        error: `${error.message}; fallback=${fallbackError.message}`,
      };
    }
  }
}

async function cleanupTask(client, id) {
  try {
    const removed = await client.query('DELETE FROM tasks WHERE id = $1::uuid', [id]);
    if (removed.rowCount > 0) {
      return { action: 'delete', ok: true, rowCount: removed.rowCount };
    }
    return { action: 'noop', ok: true, rowCount: 0 };
  } catch (error) {
    return { action: 'failed', ok: false, rowCount: 0, error: error.message };
  }
}

async function cleanupSettingsView(client, entry) {
  const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const scopeType = String(metadata.scope_type || '').trim();
  const scopeId = String(metadata.scope_id || '').trim() || null;
  const previousVersionId =
    String(metadata.previous_settings_version_id || '').trim() || null;
  if (!scopeType) {
    return { action: 'failed', ok: false, rowCount: 0, error: 'settings_view scope_type missing' };
  }

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `e2e:ui_table_views:${scopeType}:${scopeId ?? 'global'}`,
    ]);
    const current = await client.query(
      `SELECT settings_version_id::text, cached_value
         FROM public.settings
        WHERE category = 'ui_table_views'
          AND scope_type = $1
          AND scope_id IS NOT DISTINCT FROM $2::uuid
        FOR UPDATE`,
      [scopeType, scopeId],
    );
    if (String(current.rows?.[0]?.settings_version_id || '') !== entry.id) {
      const resourceKey = String(metadata.resource_key || '').trim();
      const viewId = String(metadata.view_id || '').trim();
      const activeViews = current.rows?.[0]?.cached_value?.resources?.[resourceKey]?.views;
      if (resourceKey && viewId && activeViews && typeof activeViews === 'object' && activeViews[viewId]) {
        throw new Error('settings_view fixture inherited by a newer version');
      }
      await client.query('COMMIT');
      return { action: 'noop', ok: true, rowCount: 0 };
    }

    if (previousVersionId) {
      const previous = await client.query(
        `SELECT value
           FROM public.settings_versions
          WHERE id = $1::uuid
            AND category = 'ui_table_views'
            AND scope_type = $2
            AND scope_id IS NOT DISTINCT FROM $3::uuid
          LIMIT 1`,
        [previousVersionId, scopeType, scopeId],
      );
      if (previous.rowCount !== 1) throw new Error('settings_view previous version missing');
      await client.query(
        `SELECT settings_version_id
           FROM public.upsert_settings_value_v1(
             'ui_table_views', $1, $2::uuid, $3::jsonb, 1, $4
           )
          LIMIT 1`,
        [scopeType, scopeId, JSON.stringify(previous.rows[0].value), `${entry.label}:recover`],
      );
      await client.query('COMMIT');
      return { action: 'restore', ok: true, rowCount: 1 };
    }

    const removed = await client.query(
      `DELETE FROM public.settings
        WHERE category = 'ui_table_views'
          AND scope_type = $1
          AND scope_id IS NOT DISTINCT FROM $2::uuid
          AND settings_version_id = $3::uuid`,
      [scopeType, scopeId, entry.id],
    );
    if (removed.rowCount !== 1) throw new Error('settings_view fixture row missing');
    await client.query(
      `UPDATE public.settings_versions
          SET effective_until = GREATEST(clock_timestamp(), effective_from + interval '1 microsecond')
        WHERE id = $1::uuid
          AND effective_until IS NULL`,
      [entry.id],
    );
    await client.query('COMMIT');
    return { action: 'delete', ok: true, rowCount: 1 };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore
    }
    return { action: 'failed', ok: false, rowCount: 0, error: String(error.message || error) };
  }
}

async function cleanupLabel(client, id) {
  try {
    const removed = await client.query('DELETE FROM labels WHERE id = $1::uuid', [id]);
    if (removed.rowCount > 0) {
      return { action: 'delete', ok: true, rowCount: removed.rowCount };
    }
    return { action: 'noop', ok: true, rowCount: 0 };
  } catch (error) {
    return { action: 'failed', ok: false, rowCount: 0, error: error.message };
  }
}

async function cleanupWorkflowTemplate(client, id) {
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM workflow_template_steps WHERE template_id = $1::uuid', [id]);
    const removed = await client.query('DELETE FROM workflow_templates WHERE id = $1::uuid', [id]);
    await client.query('COMMIT');
    if (removed.rowCount > 0) {
      return { action: 'delete', ok: true, rowCount: removed.rowCount };
    }
    return { action: 'noop', ok: true, rowCount: 0 };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore
    }

    try {
      const archived = await client.query(
        "UPDATE workflow_templates SET status = 'archived' WHERE id = $1::uuid",
        [id]
      );
      if (archived.rowCount > 0) {
        return { action: 'soft-archive', ok: true, rowCount: archived.rowCount, recoveredFrom: error.message };
      }
      return { action: 'failed', ok: false, rowCount: 0, error: error.message };
    } catch (fallbackError) {
      return {
        action: 'failed',
        ok: false,
        rowCount: 0,
        error: `${error.message}; fallback=${fallbackError.message}`,
      };
    }
  }
}

async function runCleanup({ manifestPath, outPath }) {
  const report = {
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    status: 'ok',
    totals: {
      entries: 0,
      processed: 0,
      success: 0,
      failed: 0,
    },
    entries: [],
    blockers: [],
  };

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    report.status = 'blocked';
    report.blockers.push('manifest_missing');
    return report;
  }

  const parsed = sortEntriesForCleanup(dedupeEntries(parseManifestEntries(manifestPath)));
  report.totals.entries = parsed.length;
  if (parsed.length === 0) {
    report.status = 'ok';
    return report;
  }

  const configuredDatabaseUrl = resolveDatabaseUrl(process.env);
  if (!configuredDatabaseUrl) {
    report.status = 'blocked';
    report.blockers.push('database_url_missing');
    return report;
  }

  let dbResolution;
  try {
    dbResolution = await resolveDatabaseUrlForCleanup(process.env);
  } catch (error) {
    report.status = 'blocked';
    report.blockers.push(`database_connect_failed:${String(error.message || error)}`);
    return report;
  }

  const pool = new Pool({ connectionString: dbResolution.dsn });
  const client = await pool.connect();
  try {
    console.log(
      `[frontend-a2z-cleanup] DB connected via ${dbResolution.candidateName} (attempts=${dbResolution.attempts}).`,
    );
    for (const entry of parsed) {
      let cleanupResult;
      if (entry.kind === 'settings_view') {
        cleanupResult = await cleanupSettingsView(client, entry);
      } else if (entry.kind === 'task') {
        cleanupResult = await cleanupTask(client, entry.id);
      } else if (entry.kind === 'label') {
        cleanupResult = await cleanupLabel(client, entry.id);
      } else if (entry.kind === 'shipment') {
        cleanupResult = await cleanupShipment(client, entry.id);
      } else if (entry.kind === 'workflow_template') {
        cleanupResult = await cleanupWorkflowTemplate(client, entry.id);
      } else {
        cleanupResult = {
          action: 'unsupported_kind',
          ok: false,
          rowCount: 0,
          error: `unsupported kind ${entry.kind}`,
        };
      }

      report.entries.push({
        ...entry,
        cleanup: cleanupResult,
      });
      report.totals.processed += 1;
      if (cleanupResult.ok) report.totals.success += 1;
      else report.totals.failed += 1;
    }
  } finally {
    client.release();
    await pool.end();
  }

  if (report.totals.failed > 0) {
    report.status = 'partial';
  }

  if (outPath) {
    const resolved = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

async function main() {
  try {
    const args = parseArgs();
    const report = await runCleanup({ manifestPath: args.manifest, outPath: args.out });
    if (args.out) {
      console.log(`[frontend-a2z-cleanup] wrote ${path.resolve(process.cwd(), args.out)}`);
    }
    if (report.status === 'blocked') {
      process.exitCode = 2;
      return;
    }
    if (report.status === 'partial') {
      process.exitCode = 3;
      return;
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`[frontend-a2z-cleanup] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseManifestEntries,
  dedupeEntries,
  resolveDatabaseUrl,
  sortEntriesForCleanup,
  cleanupTask,
  cleanupSettingsView,
  resolveDatabaseUrlForCleanup,
  runCleanup,
};
