#!/usr/bin/env node
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

async function main() {
  loadEnv();
  const sql = process.argv.slice(2).join(' ').trim();
  if (!sql) {
    console.error('Usage: node scripts/ops/query.js <SQL>');
    process.exit(1);
  }
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    const res = await client.query(sql);
    if (Array.isArray(res)) {
      const last = res[res.length - 1] || { rows: [] };
      console.log(JSON.stringify(last.rows || [], null, 2));
    } else {
      console.log(JSON.stringify(res.rows, null, 2));
    }
  } catch (e) {
    console.error('Query error:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

