#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../utils/load-env');

(async () => {
  loadEnv();
  const { Client } = require('pg');
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
  if (!dbUrl) { console.error('DATABASE_URL missing'); process.exit(2); }
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    let res;
    try {
      res = await c.query('select name, executed_at from supabase_migrations.schema_migrations order by executed_at, name');
    } catch (_) {
      res = await c.query('select name from supabase_migrations.schema_migrations order by name');
    }
    for (const r of res.rows) console.log(r.name);
  } catch (e) {
    console.error('query_failed', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();

