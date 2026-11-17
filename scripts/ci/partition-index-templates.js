#!/usr/bin/env node

const { loadEnv } = require('../utils/load-env');
const { spawnSync } = require('child_process');

loadEnv();

const db = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!db) {
  console.error('[index-templates] DATABASE_URL(_DIRECT) not set');
  process.exit(1);
}

function runPsql(sql) {
  const res = spawnSync('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--dbname', db, '-c', sql], { stdio: 'pipe', encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(res.stdout || '');
    console.error(res.stderr || '');
    process.exit(res.status || 1);
  }
  return res.stdout;
}

console.log('[index-templates] Applying partition index templates to all RANGE partitions...');
const out = runPsql('SELECT * FROM public.apply_partition_index_templates();');
console.log(out);

console.log('[index-templates] Done.');

