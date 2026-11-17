#!/usr/bin/env node
/**
 * migration-fixture-guard.js
 *
 * Fail-closed guard for fixture leakage in active migrations.
 *
 * Scope:
 * - Scans active migration files under supabase/migrations (non-archive).
 * - Mode `changed` (default): scans changed files only.
 * - Mode `full`: scans the full active migration chain.
 * - Blocks test/demo fixture markers that should exist only in test bootstrap paths.
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveBaseRef } = require('./changed-migrations-regex');
const { parseNameStatus } = require('./migration-guards');

const FIXTURE_RULES = [
  {
    pattern: /['"`]test-client-[^'"`\s]+['"`]/i,
    message: 'Fixture slug `test-client-*` is forbidden in active migrations.',
  },
  {
    pattern: /['"`]test-org-[^'"`\s]+['"`]/i,
    message: 'Fixture slug `test-org-*` is forbidden in active migrations.',
  },
  {
    pattern: /['"`]test-token-[^'"`\s]+['"`]/i,
    message: 'Fixture token `test-token-*` is forbidden in active migrations.',
  },
  {
    pattern: /client-a-ack-token|client-b-ack-token/i,
    message: 'ACK fixture tokens are forbidden in active migrations.',
  },
  {
    pattern: /e5e9cafd-e2fc-4a55-8294-dd792ec8303a|d68fbb7c-9b5e-4a1d-8df0-57e78a57c993|d1a90236-2ed4-4b55-9bc3-16a7500eea93|ffb856c6-9c61-45aa-a259-0ee8816567b1/i,
    message: 'Known fixture UUID marker is forbidden in active migrations.',
  },
  {
    pattern: /['"`]automation-qa-org['"`]/i,
    message: 'Demo organization slug `automation-qa-org` is forbidden in active migrations.',
  },
  {
    pattern: /['"`]demo-fixture-org['"`]/i,
    message: 'Demo organization slug `demo-fixture-org` is forbidden in active migrations.',
  },
  {
    pattern: /['"`]geo-ci-[^'"`\s]+['"`]/i,
    message: 'Fixture marker `geo-ci-*` is forbidden in active migrations.',
  },
  {
    pattern: /used only in tests|deterministic test data|canonical test .*fixture/i,
    message: 'Test-only fixture comments are forbidden in active migrations.',
  },
];

function die(message) {
  console.error(`[migration-fixture-guard] ${message}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  const code = typeof res.status === 'number' ? res.status : 1;
  return { ok: code === 0, code, out: String(res.stdout || ''), err: String(res.stderr || '') };
}

function normalizePath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function isActiveMigrationPath(filePath) {
  const p = normalizePath(filePath);
  if (!p) return false;
  if (!p.startsWith('supabase/migrations/')) return false;
  if (!p.toLowerCase().endsWith('.sql')) return false;
  return !p.startsWith('supabase/migrations/archive/');
}

function listChangedActiveMigrations({ baseRef, headRef = 'HEAD' }) {
  const res = git(['diff', '--name-status', '-M', baseRef, headRef, '--', 'supabase/migrations'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!res.ok) {
    throw new Error((res.err || '').trim() || `git diff failed (${res.code})`);
  }

  const entries = parseNameStatus(res.out);
  const changed = new Set();

  for (const entry of entries) {
    const status = String(entry.status || '').trim().toUpperCase();
    if (!status) continue;

    if (status === 'A' || status === 'M') {
      const p = normalizePath(entry.path);
      if (isActiveMigrationPath(p)) changed.add(p);
      continue;
    }

    if (status === 'R' || status === 'C') {
      const newPath = normalizePath(entry.newPath);
      if (isActiveMigrationPath(newPath)) changed.add(newPath);
    }
  }

  return Array.from(changed.values()).sort();
}

function listAllActiveMigrations({ rootDir = path.join(process.cwd(), 'supabase', 'migrations') } = {}) {
  const out = [];
  const normalizedRoot = path.resolve(rootDir);
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relFromCwd = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
      const relFromRoot = path.relative(normalizedRoot, fullPath).replace(/\\/g, '/');
      const relPath = relFromCwd.startsWith('supabase/migrations/')
        ? relFromCwd
        : `supabase/migrations/${relFromRoot}`;
      if (entry.isDirectory()) {
        if (entry.name === 'archive' || entry.name.startsWith('.')) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isActiveMigrationPath(relPath)) continue;
      out.push(relPath);
    }
  };
  walk(rootDir);
  return out.sort();
}

function resolveScanMode(env = process.env) {
  if (isTruthy(env.MIGRATION_FIXTURE_GUARD_FULL_CHAIN)) return 'full';
  const raw = String(env.MIGRATION_FIXTURE_GUARD_MODE || 'changed').trim().toLowerCase();
  if (raw === 'changed' || raw === 'full') return raw;
  throw new Error(`Unsupported MIGRATION_FIXTURE_GUARD_MODE="${raw}" (expected changed|full).`);
}

function detectFixtureMarkersInText(text) {
  const body = String(text || '');
  const matches = [];
  for (const rule of FIXTURE_RULES) {
    if (rule.pattern.test(body)) {
      matches.push(rule.message);
    }
  }
  return matches;
}

function scanChangedMigrations(files) {
  const findings = [];
  for (const filePath of Array.isArray(files) ? files : []) {
    let body = '';
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      findings.push({
        filePath,
        issues: [`Failed to read file: ${error.message}`],
      });
      continue;
    }
    const issues = detectFixtureMarkersInText(body);
    if (issues.length) {
      findings.push({ filePath, issues });
    }
  }
  return findings;
}

function main() {
  if (isTruthy(process.env.MIGRATION_FIXTURE_GUARD_SKIP)) {
    console.warn('[migration-fixture-guard] MIGRATION_FIXTURE_GUARD_SKIP=1; skipping checks.');
    return;
  }

  const mode = resolveScanMode(process.env);
  let files = [];
  if (mode === 'full') {
    try {
      files = listAllActiveMigrations();
    } catch (error) {
      die(`Unable to enumerate active migrations: ${error.message}`);
    }
  } else {
    const baseRef = resolveBaseRef({ baseArg: process.env.MIGRATION_FIXTURE_GUARD_BASE_REF || '' });
    if (!baseRef) {
      die('Unable to resolve base ref (expected HEAD^1 or origin/$GITHUB_BASE_REF).');
    }

    try {
      files = listChangedActiveMigrations({ baseRef, headRef: process.env.MIGRATION_FIXTURE_GUARD_HEAD_REF || 'HEAD' });
    } catch (error) {
      die(`Unable to list changed migrations: ${error.message}`);
    }
  }

  if (!files.length) {
    const emptyMessage = mode === 'full'
      ? '[migration-fixture-guard] No active migrations detected.'
      : '[migration-fixture-guard] No changed active migrations detected.';
    console.log(emptyMessage);
    return;
  }

  const findings = scanChangedMigrations(files);
  if (!findings.length) {
    console.log('[migration-fixture-guard] OK.');
    return;
  }

  console.error('[migration-fixture-guard] FAILED.');
  for (const finding of findings) {
    for (const issue of finding.issues) {
      console.error(`- ${finding.filePath}: ${issue}`);
    }
  }
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  detectFixtureMarkersInText,
  isActiveMigrationPath,
  listAllActiveMigrations,
  listChangedActiveMigrations,
  resolveScanMode,
  scanChangedMigrations,
};
