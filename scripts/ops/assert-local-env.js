#!/usr/bin/env node
/* eslint-disable no-console */
// objectives:allow LOCALHOST Justification: guard ensures DATABASE_URL is local-only for dev tooling; no tenant- or client-specific routing
// Asserts that DATABASE_URL points to a local endpoint (localhost/127.0.0.1)
const { loadEnv } = require('../utils/load-env');

loadEnv();

function die(msg) { console.error(`[assert-local-env] ${msg}`); process.exit(1); }

function parsePgHost(dsn) {
  const m = (dsn || '').match(/^[a-z]+:\/\/[^@]+@([^/:?#]+)(?::\d+)?\//i);
  return m ? m[1] : '';
}

(function main() {
  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) die('Missing DATABASE_URL');
  const host = parsePgHost(dbUrl);
  if (!host) die('Could not parse DATABASE_URL host');
  // objectives:allow LOCALHOST Justification: enforce local-only DATABASE_URL (localhost/127.0.0.1) for safety checks
  if (!['localhost', '127.0.0.1'].includes(host)) {
    die(`DATABASE_URL must be local; got host=${host}`);
  }
  console.log('[assert-local-env] Local environment validated');
})();
