#!/usr/bin/env node
/**
 * migration-guards.js
 *
 * Fast PR/merge-queue guardrails for append-only migrations.
 *
 * Checks:
 * - Append-only: prevents modifying/deleting/renaming migrations that already exist on the base ref.
 * - Version collision: prevents adding a migration whose version prefix already exists on the base ref
 *   (common merge queue failure: duplicate supabase_migrations.schema_migrations PK).
 *
 * Runs without npm deps; uses `git` only.
 *
 * Escape hatch:
 * - Set MIGRATION_GUARDS_SKIP=1 to skip (CI emergency only).
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { resolveBaseRef } = require('./changed-migrations-regex');
const defaultPreGaOverrideConfigPath = path.resolve(
  process.cwd(),
  process.env.MIGRATION_GUARDS_PRE_GA_CONFIG || 'config/ops/pre-ga-rebaseline.json',
);

function die(msg) {
  console.error(`[migration-guards] ${msg}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function parseIsoDateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(`${raw}T23:59:59.999Z`);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPreGaOverrideConfig(configPath = defaultPreGaOverrideConfigPath) {
  const target = String(configPath || '').trim();
  if (!target) {
    return {
      exists: false,
      active: false,
      expiresOn: '',
      approvers: [],
      reason: 'missing_config_path',
      configPath: target,
    };
  }

  try {
    const body = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(body);
    const active = Boolean(parsed && parsed.active === true);
    const expiresOn = String(parsed && parsed.expires_on ? parsed.expires_on : '').trim();
    const approvers = Array.isArray(parsed && parsed.approvers)
      ? parsed.approvers.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return {
      exists: true,
      active,
      expiresOn,
      approvers,
      reason: '',
      configPath: target,
    };
  } catch (error) {
    return {
      exists: false,
      active: false,
      expiresOn: '',
      approvers: [],
      reason: `invalid_config: ${error.message || error}`,
      configPath: target,
    };
  }
}

function resolvePreGaOverrideStatus(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const configPath = options.configPath || defaultPreGaOverrideConfigPath;
  const requested = isTruthy(env.MIGRATION_GUARDS_PRE_GA_OVERRIDE);
  const config = readPreGaOverrideConfig(configPath);

  if (!requested) {
    return {
      enabled: false,
      reason: 'not_requested',
      requested: false,
      configPath: config.configPath,
      config,
    };
  }

  if (!config.exists) {
    return {
      enabled: false,
      reason: config.reason || 'config_missing',
      requested: true,
      configPath: config.configPath,
      config,
    };
  }

  if (!config.active) {
    return {
      enabled: false,
      reason: 'config_inactive',
      requested: true,
      configPath: config.configPath,
      config,
    };
  }

  const expiresMs = parseIsoDateMs(config.expiresOn);
  if (expiresMs != null && nowMs > expiresMs) {
    return {
      enabled: false,
      reason: `config_expired:${config.expiresOn}`,
      requested: true,
      configPath: config.configPath,
      config,
    };
  }

  return {
    enabled: true,
    reason: 'enabled',
    requested: true,
    configPath: config.configPath,
    config,
  };
}

function parseArgs(argvIn) {
  const out = { base: '', head: 'HEAD' };
  const argv = Array.isArray(argvIn) ? argvIn : process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '').trim();
    if (!a) continue;
    if (a === '--base') out.base = String(argv[++i] || '').trim();
    else if (a.startsWith('--base=')) out.base = a.split('=').slice(1).join('=').trim();
    else if (a === '--head') out.head = String(argv[++i] || '').trim();
    else if (a.startsWith('--head=')) out.head = a.split('=').slice(1).join('=').trim();
  }
  return out;
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  const code = typeof res.status === 'number' ? res.status : 1;
  return { ok: code === 0, code, out: String(res.stdout || ''), err: String(res.stderr || '') };
}

function extractMigrationVersion(filePath) {
  const p = String(filePath || '').trim();
  if (!p.startsWith('supabase/migrations/')) return '';
  const m = p.match(/\/(\d{10,14})_[^/]+\.sql$/i);
  return m ? m[1] : '';
}

function parseNameStatus(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    const parts = raw.split('\t').filter((p) => p !== '');
    if (!parts.length) continue;
    const status = String(parts[0] || '').trim();
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (parts.length < 3) continue;
      out.push({ status: status[0], oldPath: parts[1], newPath: parts[2] });
      continue;
    }
    if (parts.length < 2) continue;
    out.push({ status: status[0], path: parts[1] });
  }
  return out;
}

function listPathsAtRef(ref, prefix) {
  const r = String(ref || '').trim();
  const p = String(prefix || '').trim();
  if (!r || !p) return [];
  const res = git(['ls-tree', '-r', '--name-only', r, '--', p], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!res.ok) {
    throw new Error((res.err || '').trim() || `git ls-tree failed (${res.code})`);
  }
  return res.out
    .split(/\r?\n/)
    .map((l) => String(l || '').trim())
    .filter(Boolean);
}

function buildBaseMigrationIndex(baseRef) {
  const paths = listPathsAtRef(baseRef, 'supabase/migrations');
  const basePaths = new Set();
  const byVersion = new Map();
  for (const p of paths) {
    if (!String(p).toLowerCase().endsWith('.sql')) continue;
    basePaths.add(p);
    const version = extractMigrationVersion(p);
    if (!version) continue;
    if (!byVersion.has(version)) byVersion.set(version, p);
  }
  return { basePaths, byVersion };
}

function detectViolations({ diffEntries, basePaths, baseByVersion }) {
  const violations = {
    modifiedBase: [],
    deletedBase: [],
    renamedBase: [],
    versionCollisions: [],
  };

  const entries = Array.isArray(diffEntries) ? diffEntries : [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const status = String(e.status || '').trim().toUpperCase();
    if (!status) continue;

    const path = e.path ? String(e.path).trim() : '';
    const oldPath = e.oldPath ? String(e.oldPath).trim() : '';
    const newPath = e.newPath ? String(e.newPath).trim() : '';

    const considerNew = (p) => {
      if (!p || !String(p).toLowerCase().endsWith('.sql')) return;
      const version = extractMigrationVersion(p);
      if (!version) return;
      const basePath = baseByVersion.get(version);
      if (basePath && basePath !== p) {
        violations.versionCollisions.push({ version, basePath, newPath: p });
      }
    };

    if (status === 'M') {
      if (path && basePaths.has(path)) violations.modifiedBase.push(path);
      continue;
    }
    if (status === 'D') {
      if (path && basePaths.has(path)) violations.deletedBase.push(path);
      continue;
    }
    if (status === 'R' || status === 'C') {
      if (oldPath && basePaths.has(oldPath)) {
        violations.renamedBase.push({ oldPath, newPath });
      }
      considerNew(newPath);
      continue;
    }
    if (status === 'A') {
      considerNew(path);
      continue;
    }
  }

  return violations;
}

function hasViolations(v) {
  if (!v || typeof v !== 'object') return false;
  return (
    (v.modifiedBase || []).length > 0 ||
    (v.deletedBase || []).length > 0 ||
    (v.renamedBase || []).length > 0 ||
    (v.versionCollisions || []).length > 0
  );
}

function formatViolations(v) {
  const lines = [];

  const modified = Array.isArray(v.modifiedBase) ? v.modifiedBase : [];
  if (modified.length) {
    lines.push('Append-only violation: modified base migrations:');
    modified.slice(0, 25).forEach((p) => lines.push(`- ${p}`));
    if (modified.length > 25) lines.push(`- ...and ${modified.length - 25} more`);
  }

  const deleted = Array.isArray(v.deletedBase) ? v.deletedBase : [];
  if (deleted.length) {
    lines.push('Append-only violation: deleted base migrations:');
    deleted.slice(0, 25).forEach((p) => lines.push(`- ${p}`));
    if (deleted.length > 25) lines.push(`- ...and ${deleted.length - 25} more`);
  }

  const renamed = Array.isArray(v.renamedBase) ? v.renamedBase : [];
  if (renamed.length) {
    lines.push('Append-only violation: renamed/moved base migrations:');
    renamed.slice(0, 25).forEach((r) => lines.push(`- ${r.oldPath} -> ${r.newPath}`));
    if (renamed.length > 25) lines.push(`- ...and ${renamed.length - 25} more`);
  }

  const collisions = Array.isArray(v.versionCollisions) ? v.versionCollisions : [];
  if (collisions.length) {
    lines.push('Migration version collision(s) with base branch:');
    collisions.slice(0, 25).forEach((c) => lines.push(`- ${c.version}: base=${c.basePath} new=${c.newPath}`));
    if (collisions.length > 25) lines.push(`- ...and ${collisions.length - 25} more`);
    lines.push('Fix: rename the new migration timestamp prefix to a unique value (never edit base migrations).');
  }

  return lines;
}

function main() {
  if (isTruthy(process.env.MIGRATION_GUARDS_SKIP)) {
    console.warn('[migration-guards] MIGRATION_GUARDS_SKIP=1; skipping checks.');
    return;
  }

  const preGaOverride = resolvePreGaOverrideStatus();
  if (preGaOverride.enabled) {
    console.warn(
      `[migration-guards] MIGRATION_GUARDS_PRE_GA_OVERRIDE=1 and active config detected (${preGaOverride.configPath}); bypassing append-only checks for approved pre-GA rebaseline.`,
    );
    return;
  }
  if (preGaOverride.requested) {
    console.warn(
      `[migration-guards] MIGRATION_GUARDS_PRE_GA_OVERRIDE requested but not effective (${preGaOverride.reason}); continuing with strict checks.`,
    );
  }

  const args = parseArgs();
  const baseRef = resolveBaseRef({ baseArg: args.base });
  if (!baseRef) die('Unable to resolve base ref (expected merge commit with HEAD^1 or origin/$GITHUB_BASE_REF).');
  const headRef = String(args.head || '').trim() || 'HEAD';

  let baseIndex;
  try {
    baseIndex = buildBaseMigrationIndex(baseRef);
  } catch (e) {
    die(`Unable to inspect base migrations at ${baseRef}: ${e.message}`);
  }

  const diffRes = git(['diff', '--name-status', '-M', baseRef, headRef, '--', 'supabase/migrations'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!diffRes.ok) {
    die((diffRes.err || '').trim() || `git diff failed (${diffRes.code})`);
  }

  const entries = parseNameStatus(diffRes.out)
    .map((e) => {
      if (e.path) return { ...e, path: String(e.path).replace(/\\/g, '/') };
      return {
        ...e,
        oldPath: String(e.oldPath || '').replace(/\\/g, '/'),
        newPath: String(e.newPath || '').replace(/\\/g, '/'),
      };
    })
    .filter((e) => {
      const p = e.path || e.newPath || e.oldPath || '';
      return String(p).toLowerCase().endsWith('.sql');
    });

  if (!entries.length) {
    console.log('[migration-guards] No migration changes detected.');
    return;
  }

  const violations = detectViolations({
    diffEntries: entries,
    basePaths: baseIndex.basePaths,
    baseByVersion: baseIndex.byVersion,
  });

  if (!hasViolations(violations)) {
    console.log('[migration-guards] OK.');
    return;
  }

  console.error('[migration-guards] FAILED.');
  formatViolations(violations).forEach((l) => console.error(l));
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
}

module.exports = {
  detectViolations,
  extractMigrationVersion,
  formatViolations,
  hasViolations,
  parseIsoDateMs,
  parseNameStatus,
  readPreGaOverrideConfig,
  resolvePreGaOverrideStatus,
};
