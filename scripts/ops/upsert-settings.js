#!/usr/bin/env node
/**
 * Upsert settings for any category/scope.
 *
 * Writes a new settings_versions row (closing the previous current row when present),
 * then updates settings (cache) to point to the new version.
 *
 * Usage:
 *   ENV_FILE=path/to/cloud-config \
 *   node scripts/ops/upsert-settings.js \
 *     --category basket_policy \
 *     --scope-type client \
 *     --scope-id <uuid> \
 *     --patch '{"enabled":true}' \
 *     --change-reason "enable basket assignment" \
 *     [--dry-run]
 *
 * Value input (choose one):
 *   --value <json> | --value-file <path>
 *   --patch <json> | --patch-file <path>   (merges into existing cached_value; {} when missing)
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const {
  upsertSettings,
  deepMerge,
} = require('../utils/settings-upsert');

function argVal(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readJsonArgOrFile({ jsonArg, fileArg, label }) {
  if (jsonArg != null) {
    const raw = String(jsonArg).trim();
    if (!raw) throw new Error(`--${label} is empty`);
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in --${label}: ${e.message}`);
    }
  }
  if (fileArg != null) {
    const abs = path.resolve(String(fileArg));
    if (!fs.existsSync(abs)) throw new Error(`${label} file not found: ${abs}`);
    const raw = fs.readFileSync(abs, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in ${label} file: ${e.message}`);
    }
  }
  return undefined;
}

async function main() {
  loadEnv();
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required (use ENV_FILE or export).');
  }

  const category = String(argVal('category') || '').trim();
  const scopeType = String(argVal('scope-type') || '').trim();
  const scopeId = (argVal('scope-id') || '').trim() || null;
  const changeReason = String(
    argVal('change-reason') || 'upsert via scripts/ops/upsert-settings.js',
  ).trim();
  const dryRun = hasFlag('dry-run');

  if (!category) throw new Error('--category is required');
  if (!scopeType) throw new Error('--scope-type is required');

  const valueJson = readJsonArgOrFile({
    jsonArg: argVal('value'),
    fileArg: argVal('value-file'),
    label: 'value',
  });
  const patchJson = readJsonArgOrFile({
    jsonArg: argVal('patch'),
    fileArg: argVal('patch-file'),
    label: 'patch',
  });
  if ((valueJson == null) === (patchJson == null)) {
    throw new Error(
      'Provide exactly one of: --value/--value-file OR --patch/--patch-file',
    );
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const res = await upsertSettings({
      db,
      category,
      scopeType,
      scopeId,
      value: valueJson,
      patch: patchJson,
      changeReason,
    });

    if (dryRun) {
      await db.query('ROLLBACK');
      console.log(
        `[upsert-settings] DRY RUN: would write ${category} (${scopeType}:${scopeId || 'NULL'}) -> version ${res.settingsVersionNumber}`,
      );
      return;
    }

    await db.query('COMMIT');
    console.log(
      `[upsert-settings] OK: ${category} (${scopeType}:${scopeId || 'NULL'}) -> version ${res.settingsVersionNumber}`,
    );
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[upsert-settings] Failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  deepMerge,
};
