#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATION_SQL_NORMALIZATION_CONTRACT = 'masarx-migration-sql-normalization.v1';
const MIGRATION_SQL_ASCII_TRIM_CLASS = '[ \\t\\n\\r\\f\\v]';
const MIGRATION_SQL_ASCII_TRIM_PATTERN = new RegExp(
  `^${MIGRATION_SQL_ASCII_TRIM_CLASS}+|${MIGRATION_SQL_ASCII_TRIM_CLASS}+$`,
  'g',
);

function normalizePathForKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function normalizeMigrationSqlContent(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(MIGRATION_SQL_ASCII_TRIM_PATTERN, '');
}

function buildMigrationSqlNormalizationExpression(valueExpression = 'candidate.value') {
  const expression = String(valueExpression || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(expression)) {
    throw new Error('migration SQL normalization requires a trusted SQL identifier expression');
  }
  return [
    'btrim(',
    'replace(replace(',
    `case when left(${expression}, 1) = chr(65279) then substr(${expression}, 2) else ${expression} end,`,
    "E'\\r\\n', E'\\n'), E'\\r', E'\\n'),",
    "E' \\t\\n\\r\\f\\v')",
  ].join(' ');
}

function listMigrationFiles(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd, options.migrationsDir || path.join('supabase', 'migrations'));
  const fsImpl = options.fsImpl || fs;
  if (!fsImpl.existsSync(root)) return [];
  return fsImpl.readdirSync(root)
    .filter((name) => /\.sql$/i.test(name))
    .sort((a, b) => (a === b ? 0 : (a < b ? -1 : 1)))
    .map((name) => path.join(root, name));
}

function buildMigrationSchemaKey(cwd = process.cwd(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const files = listMigrationFiles(cwd, options);
  const hash = crypto.createHash('sha256');
  const entries = [];
  for (const filePath of files) {
    const name = path.basename(filePath);
    const content = fsImpl.readFileSync(filePath);
    const rawFileHash = crypto.createHash('sha256').update(content).digest('hex');
    const canonicalContent = normalizeMigrationSqlContent(content);
    const fileHash = crypto.createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
    hash.update(name);
    hash.update('\0');
    hash.update(fileHash);
    hash.update('\0');
    entries.push({
      name,
      relative_path: normalizePathForKey(path.relative(path.resolve(cwd), filePath)),
      sha256: fileHash,
      raw_sha256: rawFileHash,
      bytes: Buffer.byteLength(content),
    });
  }
  const digest = files.length ? hash.digest('hex') : crypto.createHash('sha256').update('no-migrations').digest('hex');
  return {
    schema_key: `supabase-migrations:${digest.slice(0, 32)}`,
    migration_head: entries.length ? entries[entries.length - 1].name : 'none',
    migration_count: entries.length,
    migrations_dir: normalizePathForKey(path.relative(path.resolve(cwd), path.resolve(cwd, options.migrationsDir || path.join('supabase', 'migrations')))),
    entries,
    source: 'supabase-migrations-content-sha256',
  };
}

function main() {
  const summary = buildMigrationSchemaKey(process.cwd());
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  MIGRATION_SQL_NORMALIZATION_CONTRACT,
  buildMigrationSchemaKey,
  buildMigrationSqlNormalizationExpression,
  listMigrationFiles,
  normalizeMigrationSqlContent,
};
