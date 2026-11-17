#!/usr/bin/env node
/**
 * require-env.js
 *
 * Small CI helper to fail fast when required environment variables are missing,
 * with optional "equals" assertions for fixed guard values.
 *
 * Usage:
 *   node scripts/ops/ci/require-env.js --keys "A,B,C"
 *   node scripts/ops/ci/require-env.js --keys "A,B" --equals "FLAG=enabled"
 */
/* eslint-disable no-console */

function die(msg) {
  console.error(`[require-env] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { keys: [], equals: [] };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--keys') {
      out.keys.push(String(args[++i] || '').trim());
      continue;
    }
    if (a.startsWith('--keys=')) {
      out.keys.push(a.split('=').slice(1).join('=').trim());
      continue;
    }
    if (a === '--equals') {
      out.equals.push(String(args[++i] || '').trim());
      continue;
    }
    if (a.startsWith('--equals=')) {
      out.equals.push(a.split('=').slice(1).join('=').trim());
      continue;
    }
  }

  const keys = out.keys
    .flatMap((s) => String(s || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  const equals = out.equals
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  return { keys, equals };
}

function checkEnv({ env, keys, equals }) {
  const e = env && typeof env === 'object' ? env : {};
  const requiredKeys = new Set(Array.isArray(keys) ? keys : []);
  const equalsChecks = Array.isArray(equals) ? equals : [];

  for (const entry of equalsChecks) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    requiredKeys.add(entry.slice(0, idx));
  }

  const missing = [];
  for (const k of requiredKeys) {
    const v = String(e[k] || '').trim();
    if (!v) missing.push(k);
  }

  const mismatched = [];
  for (const entry of equalsChecks) {
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      mismatched.push(`${entry} (invalid equals assertion; expected KEY=value)`);
      continue;
    }
    const key = entry.slice(0, idx);
    const expected = entry.slice(idx + 1);
    const actual = String(e[key] || '').trim();
    if (actual !== expected) mismatched.push(`${key}=${actual || '<empty>'} (expected ${expected})`);
  }

  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

function main() {
  const { keys, equals } = parseArgs(process.argv.slice(2));
  if (!keys.length && !equals.length) die('No requirements provided. Use --keys and/or --equals.');

  const res = checkEnv({ env: process.env, keys, equals });
  if (!res.ok) {
    const parts = [];
    if (res.missing.length) parts.push(`Missing: ${res.missing.join(', ')}`);
    if (res.mismatched.length) parts.push(`Mismatch: ${res.mismatched.join(', ')}`);
    die(parts.join(' | '));
  }

  console.log('[require-env] OK');
}

if (require.main === module) main();

module.exports = { parseArgs, checkEnv };

