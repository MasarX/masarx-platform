#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');

loadEnv();

function die(msg) { console.error(`[apply-migrations-fast] ${msg}`); process.exit(1); }

function runPsql(dbUrl, file) {
  const args = [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', file];
  const res = spawnSync('psql', args, { stdio: 'inherit' });
  if (res.status !== 0) die(`Failed applying ${file}`);
}

function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) die('DATABASE_URL is required (ensure ENV_FILE is set)');
  const migDir = path.join(process.cwd(), 'supabase', 'migrations');
  if (!fs.existsSync(migDir)) die(`Migrations dir not found: ${migDir}`);
  const files = fs
    .readdirSync(migDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();
  if (!files.length) {
    console.log('[apply-migrations-fast] No migrations found');
    return;
  }
  console.log(`[apply-migrations-fast] Applying ${files.length} migrations via psql`);
  for (const f of files) {
    const p = path.join(migDir, f);
    console.log(`[apply-migrations-fast] -> ${f}`);
    runPsql(dbUrl, p);
  }
  console.log('[apply-migrations-fast] All migrations applied successfully');
}

main();

