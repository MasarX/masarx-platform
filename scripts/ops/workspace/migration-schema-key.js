#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function normalizePathForKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function listMigrationFiles(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd, options.migrationsDir || path.join('supabase', 'migrations'));
  const fsImpl = options.fsImpl || fs;
  if (!fsImpl.existsSync(root)) return [];
  return fsImpl.readdirSync(root)
    .filter((name) => /\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
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
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    hash.update(name);
    hash.update('\0');
    hash.update(fileHash);
    hash.update('\0');
    entries.push({
      name,
      relative_path: normalizePathForKey(path.relative(path.resolve(cwd), filePath)),
      sha256: fileHash,
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
  buildMigrationSchemaKey,
  listMigrationFiles,
};
