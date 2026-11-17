#!/usr/bin/env node
/**
 * classify-fixture-migrations.js
 *
 * Inventory and optionally archive fixture-focused migrations.
 *
 * Usage:
 *   node scripts/ops/migrations/classify-fixture-migrations.js
 *   node scripts/ops/migrations/classify-fixture-migrations.js --json
 *   node scripts/ops/migrations/classify-fixture-migrations.js --write docs/ops/evidence/prega-fixture-migration-inventory.json
 *   node scripts/ops/migrations/classify-fixture-migrations.js --move-fixture-only --apply
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migrationsRoot = path.join(repoRoot, 'supabase', 'migrations');
const archiveRoot = path.join(repoRoot, 'supabase', 'migrations', 'archive', 'pre-ga-fixtures');

const FIXTURE_MARKERS = [
  /['"`]test-client-[^'"`\s]+['"`]/i,
  /['"`]test-org-[^'"`\s]+['"`]/i,
  /['"`]test-token-[^'"`\s]+['"`]/i,
  /client-a-ack-token|EXAMPLE_PASSWORD/i,
  /canonical test .*fixture|used only in tests|deterministic test data/i,
  /mock mode|for test environment/i,
  /WHERE\s+.*slug\s*=\s*'test-/i,
];

const SCHEMA_CHANGE_MARKERS = [
  /\bCREATE\s+TABLE\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/i,
  /\bCREATE\s+FUNCTION\b/i,
  /\bCREATE\s+INDEX\b/i,
  /\bCREATE\s+TYPE\b/i,
  /\bALTER\s+TYPE\b/i,
  /\bCREATE\s+TRIGGER\b/i,
  /\bCREATE\s+OR\s+REPLACE\s+VIEW\b/i,
  /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\bCREATE\s+POLICY\b/i,
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    asJson: false,
    writePath: '',
    moveFixtureOnly: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--json') out.asJson = true;
    else if (token === '--move-fixture-only') out.moveFixtureOnly = true;
    else if (token === '--apply') out.apply = true;
    else if (token === '--write') out.writePath = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--write=')) out.writePath = token.split('=').slice(1).join('=').trim();
  }
  return out;
}

function listActiveMigrationFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name === 'archive' || entry.name.startsWith('.')) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.sql')) continue;
      if (!relPath.startsWith('supabase/migrations/')) continue;
      out.push(fullPath);
    }
  };
  walk(rootDir);
  return out.sort();
}

function classifyBody(body) {
  const fixtureMarkers = FIXTURE_MARKERS.filter((pattern) => pattern.test(body)).length;
  const schemaMarkers = SCHEMA_CHANGE_MARKERS.filter((pattern) => pattern.test(body)).length;

  if (fixtureMarkers === 0) return { className: 'clean', fixtureMarkers, schemaMarkers };
  if (schemaMarkers === 0) return { className: 'fixture_only', fixtureMarkers, schemaMarkers };
  return { className: 'mixed', fixtureMarkers, schemaMarkers };
}

function classifyMigrations(files) {
  const results = [];
  for (const filePath of files) {
    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    let body = '';
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      results.push({
        file: relPath,
        class: 'error',
        fixtureMarkers: 0,
        schemaMarkers: 0,
        error: error.message,
      });
      continue;
    }
    const classification = classifyBody(body);
    results.push({
      file: relPath,
      class: classification.className,
      fixtureMarkers: classification.fixtureMarkers,
      schemaMarkers: classification.schemaMarkers,
    });
  }
  return results;
}

function summarize(results) {
  const summary = {
    total: 0,
    clean: 0,
    fixture_only: 0,
    mixed: 0,
    error: 0,
  };
  for (const row of results) {
    summary.total += 1;
    if (row.class in summary) summary[row.class] += 1;
  }
  return summary;
}

function moveFixtureOnly(results, options = {}) {
  const apply = Boolean(options.apply);
  const moves = [];
  for (const row of results) {
    if (row.class !== 'fixture_only') continue;
    const source = path.join(repoRoot, row.file);
    const destination = path.join(archiveRoot, path.basename(row.file));
    moves.push({
      from: path.relative(repoRoot, source).replace(/\\/g, '/'),
      to: path.relative(repoRoot, destination).replace(/\\/g, '/'),
      applied: false,
    });
    if (!apply) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    moves[moves.length - 1].applied = true;
  }
  return moves;
}

function main() {
  const args = parseArgs();
  const files = listActiveMigrationFiles(migrationsRoot);
  const results = classifyMigrations(files);
  const summary = summarize(results);

  let moves = [];
  if (args.moveFixtureOnly) {
    moves = moveFixtureOnly(results, { apply: args.apply });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    summary,
    results,
    moves,
  };

  if (args.writePath) {
    const outputFile = path.isAbsolute(args.writePath)
      ? args.writePath
      : path.join(repoRoot, args.writePath);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[classify-fixture-migrations] Wrote inventory to ${path.relative(repoRoot, outputFile)}`);
  }

  if (args.asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('[classify-fixture-migrations] Summary');
  console.log(`- total: ${summary.total}`);
  console.log(`- clean: ${summary.clean}`);
  console.log(`- fixture_only: ${summary.fixture_only}`);
  console.log(`- mixed: ${summary.mixed}`);
  console.log(`- error: ${summary.error}`);

  if (moves.length) {
    console.log(`[classify-fixture-migrations] ${args.apply ? 'Applied' : 'Planned'} moves: ${moves.length}`);
    moves.slice(0, 50).forEach((move) => {
      console.log(`- ${move.from} -> ${move.to}${move.applied ? '' : ' (dry-run)'}`);
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyBody,
  classifyMigrations,
  listActiveMigrationFiles,
  summarize,
};
