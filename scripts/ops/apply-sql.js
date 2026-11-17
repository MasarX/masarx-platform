#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/ops/apply-sql.js <file.sql>');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`[apply-sql] File not found: ${abs}`);
    process.exit(1);
  }
  loadEnv();
  const sql = fs.readFileSync(abs, 'utf8');
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('[apply-sql] DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log(`[apply-sql] Applied ${abs}`);
  } catch (err) {
    console.error(`[apply-sql] Failed applying ${abs}: ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
