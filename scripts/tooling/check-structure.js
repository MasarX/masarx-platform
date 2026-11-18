#!/usr/bin/env node

/**
 * Repository structure guard.
 * Ensures we keep the Supabase-first layout without stray artefacts or
 * accidentally untracked configuration changes.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const errors = [];
const warnings = [];

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function gitLsFiles(patterns) {
  const args = ['ls-files', '--', ...patterns];
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitLsAllFiles() {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

function loadStructureRules() {
  const defaults = {
    forbidden_paths: [
      { path: 'supabase/supabase', message: 'Remove supabase/supabase; use the canonical directories instead.' },
      { path: 'docs/product/Exmaples', message: 'Remove docs/product/Exmaples; use docs/product/examples.' },
    ],
    forbidden_tracked_path_regexes: [],
    scripts_root_allowed_files: ['README.md'],
    scripts_root_message: 'scripts/ root must contain only README.md; move ad-hoc scripts into scripts/dev/ or scripts/tools/.',
  };

  const rulesPath = path.join(repoRoot, 'config', 'lint', 'structure-rules.json');
  if (!fs.existsSync(rulesPath)) {
    return defaults;
  }

  const loaded = readJsonSafe(rulesPath);
  if (!loaded || typeof loaded !== 'object') {
    warnings.push(`Unable to parse config/lint/structure-rules.json; using defaults.`);
    return defaults;
  }

  return {
    ...defaults,
    ...loaded,
    forbidden_paths: Array.isArray(loaded.forbidden_paths) ? loaded.forbidden_paths : defaults.forbidden_paths,
    forbidden_tracked_path_regexes: Array.isArray(loaded.forbidden_tracked_path_regexes)
      ? loaded.forbidden_tracked_path_regexes
      : defaults.forbidden_tracked_path_regexes,
    scripts_root_allowed_files: Array.isArray(loaded.scripts_root_allowed_files)
      ? loaded.scripts_root_allowed_files
      : defaults.scripts_root_allowed_files,
  };
}

const structureRules = loadStructureRules();

const forbiddenPaths = (structureRules.forbidden_paths || [])
  .map((entry) => {
    if (!entry) return null;
    if (typeof entry === 'string') return { path: entry, message: '' };
    if (typeof entry === 'object') {
      return { path: String(entry.path || '').trim(), message: String(entry.message || '').trim() };
    }
    return null;
  })
  .filter((entry) => entry && entry.path);

for (const relPath of forbiddenPaths) {
  const fullPath = path.join(repoRoot, relPath.path);
  if (fs.existsSync(fullPath)) {
    errors.push(relPath.message || `Remove ${relPath.path}; use the canonical directories instead.`);
  }
}

// Root scripts folder should stay layout-only; keep real scripts under subfolders.
try {
  const scriptsDir = path.join(repoRoot, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const allowed = new Set(
      (structureRules.scripts_root_allowed_files || [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
    );
    const rootFiles = fs.readdirSync(scriptsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    const extras = rootFiles.filter((name) => !allowed.has(name));
    if (extras.length > 0) {
      const msg = String(structureRules.scripts_root_message || '').trim()
        || 'scripts/ root must contain only README.md; move ad-hoc scripts into scripts/dev/ or scripts/tools/.';
      errors.push(`${msg} Found: ${extras.slice(0, 10).join(', ')}${extras.length > 10 ? ` (+${extras.length - 10} more)` : ''}`);
    }
  }
} catch (_) {
  // ignore
}

// Guard against tracked backup artefacts (keep them untracked under tmp/ when needed).
try {
  const tracked = gitLsAllFiles();
  const rules = (structureRules.forbidden_tracked_path_regexes || [])
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const id = String(r.id || '').trim() || 'rule';
      const reRaw = String(r.regex || '').trim();
      if (!reRaw) return null;
      let re;
      try { re = new RegExp(reRaw, 'i'); } catch (_) { return null; }
      const message = String(r.message || '').trim() || `Tracked files match forbidden pattern (${id}).`;
      return { id, re, message };
    })
    .filter(Boolean);

  for (const rule of rules) {
    const matches = tracked.filter((p) => rule.re.test(p));
    if (!matches.length) continue;
    errors.push(
      `${rule.message} Files: ${matches.slice(0, 20).join(', ')}${matches.length > 20 ? ` (+${matches.length - 20} more)` : ''}`
    );
  }
} catch (_) {
  // ignore
}

const trackedLogs = gitLsFiles(['logs', 'logs/**']);
if (trackedLogs.length > 0) {
  errors.push(`Logs directory must stay untracked. Files: ${trackedLogs.join(', ')}`);
}

const trackedTemp = gitLsFiles(['temp', 'temp/**', 'tmp', 'tmp/**', 'temp.txt']);
if (trackedTemp.length > 0) {
  errors.push(`Temporary artefacts detected: ${trackedTemp.join(', ')}`);
}

const trackedRootArtifacts = gitLsFiles([':(top)tmp-*', ':(top)temp-*', ':(top)-']);
if (trackedRootArtifacts.length > 0) {
  errors.push(
    `Root-level debug artefacts must not be tracked (use tmp/ or docs/ops/evidence instead). Files: ${trackedRootArtifacts.join(', ')}`
  );
}

const lockfileTracked = gitLsFiles(['package-lock.json']);
if (lockfileTracked.length === 0 || !fs.existsSync(path.join(repoRoot, 'package-lock.json'))) {
  errors.push('package-lock.json must exist and be tracked to guarantee deterministic installs.');
}

if (errors.length > 0) {
  console.error('[lint:structure] Repository layout issues detected:');
  errors.forEach((issue) => console.error(`  - ${issue}`));
  process.exit(1);
}

console.log('[lint:structure] Repository layout is clean.');

// ---- Dynamic DDL lint: flag time-bound RANGE partitions in new migrations ----
// Non-blocking for historical files. We only fail on newly added/modified migration files.

function gitDiffNames(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function readFileSafe(p) {
  try { return fs.readFileSync(path.join(repoRoot, p), 'utf8'); } catch (_) { return ''; }
}

// Changed or new files in working tree / index
const changedUnstaged = gitDiffNames(['diff', '--name-only']);
const changedStaged = gitDiffNames(['diff', '--name-only', '--cached']);
const untracked = gitDiffNames(['ls-files', '--others', '--exclude-standard']);
const changedSet = new Set([...changedUnstaged, ...changedStaged, ...untracked].filter((p) => p.endsWith('.sql')));

// All migration files (for warnings only)
const allMigrations = gitLsFiles(['supabase/migrations/**/*.sql']);

// Patterns indicating time-bound hard-coding in partition DDL
const hardDatePartitionName = /CREATE\s+TABLE\s+\w+_20\d{2}_(?:\d{2}|w\d{2})\s+PARTITION\s+OF/gi;
const hardDateBounds = /FOR\s+VALUES\s+FROM\s*\('\d{4}-\d{2}-\d{2}'\)\s+TO\s*\('\d{4}-\d{2}-\d{2}'\)/gi;

function scanFileForTimeBoundDDL(relPath, isBlocking) {
  const sql = readFileSafe(relPath);
  if (!sql) return;
  let matched = false;
  if (sql.match(hardDatePartitionName)) { matched = true; }
  if (sql.match(hardDateBounds)) { matched = true; }
  if (matched) {
    const msg = `${relPath} contains time-bound RANGE partition DDL. Use create_next_partitions() + helpers instead.`;
    if (isBlocking) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }
}

// Fail only for new/modified migrations
for (const p of changedSet) {
  if (p.startsWith('supabase/migrations/')) {
    scanFileForTimeBoundDDL(p, true);
  }
}

// Emit non-blocking warnings for historical files (informational)
for (const p of allMigrations) {
  if (!changedSet.has(p)) {
    scanFileForTimeBoundDDL(p, false);
  }
}

if (warnings.length) {
  console.warn('[lint:structure] Warnings (non-blocking):');
  for (const w of warnings) console.warn(`  - ${w}`);
}

if (errors.length) {
  console.error('[lint:structure] Errors:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('[lint:structure] No time-bound partition DDL in new migrations.');

// --- Overlay guard: prevent committing local overlay markers in supabase/config.toml ---
try {
  const cfg = fs.readFileSync(path.join(repoRoot, 'supabase', 'config.toml'), 'utf8');
  if (/AUTO-OVERLAY-BEGIN/.test(cfg)) {
    console.error('[lint:structure] Local overlay detected in supabase/config.toml. Run `npm run local:stop` before committing.');
    process.exit(1);
  }
} catch (_) {
  // ignore
}
