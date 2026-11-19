'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitize } = require('./diagnostics.cjs');
const { assertLoopbackOnly } = require('../ops/ci/cloud-pool-db-local.js');
const { listAllActiveMigrations, detectFixtureMarkersInText } = require('../ops/ci/migration-fixture-guard.js');

function migrationIssues(files, env = process.env) {
  const issues = []; const versions = new Set();
  const since = Number.parseInt(env.DB_LINT_CONTENT_RULES_SINCE || '202511130000', 10) || 202511130000;
  const rules = [
    [/seed_client/i, 'Client-specific seeding belongs in scripts/data, not migrations.'],
    [/provider_[a-z0-9]+_defaults/, 'Use neutral settings category provider_defaults; avoid provider-specific categories.'],
    [/WHEN\s+p_step\.operation_name\s*=\s*'enqueue_notification'/i, 'Use operation_templates.call_type or step metadata for channel mapping.'],
  ];
  if (!files.length) issues.push('No active migration files');
  for (const file of files) {
    const name = path.basename(file); const version = /^(\d{10,14})_/.exec(name)?.[1];
    if (!/^\d{10,14}_[a-z0-9_-]+\.sql$/i.test(name)) issues.push(`${file}: invalid migration filename`);
    if (version && versions.has(version)) issues.push(`${file}: duplicate migration timestamp ${version}`);
    versions.add(version);
    const body = fs.readFileSync(file, 'utf8');
    for (const message of detectFixtureMarkersInText(body)) issues.push(`${file}: ${message}`);
    if (Number(version?.slice(0, 12)) >= since) {
      for (const [pattern, message] of rules) if (pattern.test(body)) issues.push(`${file}: ${message}`);
    }
  }
  return issues;
}

function invocation(env) {
  assertLoopbackOnly(env, 'database lint');
  if (!env.SUPABASE_CLI_BIN) throw new Error('SUPABASE_CLI_BIN must name the verified CLI');
  const parsed = new URL(env.DATABASE_URL || env.DATABASE_URL_DIRECT || '');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Invalid database lint URL protocol');
  if (['host', 'hostaddr', 'service', 'servicefile'].some(key => parsed.searchParams.has(key))) throw new Error('Database lint URL must specify its loopback host in the authority');
  let password = decodeURIComponent(parsed.password);
  const passwords = parsed.searchParams.getAll('password');
  if (passwords.length > 1 || (password && passwords.length && password !== passwords[0])) throw new Error('Ambiguous database password');
  if (passwords.length) password = passwords[0];
  const sslPasswords = parsed.searchParams.getAll('sslpassword');
  if (sslPasswords.length > 1 || password.includes('\0') || sslPasswords.some(value => value.includes('\0'))) throw new Error('Invalid database password');
  parsed.password = ''; parsed.searchParams.delete('password'); parsed.searchParams.delete('sslpassword');
  // The CLI treats a loopback port outside its configured ports as remote.
  parsed.searchParams.set('sslmode', 'disable');
  const allowed = ['APPDATA', 'CI', 'ComSpec', 'FORCE_COLOR', 'HOME', 'LOCALAPPDATA', 'NO_COLOR',
    'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'Path', 'PROCESSOR_ARCHITECTURE', 'SystemRoot',
    'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR'];
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.includes(key)));
  if (password) childEnv.PGPASSWORD = password;
  if (sslPasswords.length) childEnv.PGSSLPASSWORD = sslPasswords[0];
  return { command: env.SUPABASE_CLI_BIN, args: ['db', 'lint', '--db-url', parsed.toString(), '--level', 'error', '--fail-on', 'error'], env: childEnv };
}

function lintResult(stdout, exitCode, exceptions, ownership) {
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('Database lint did not exit normally');
  const entries = String(stdout).trim() ? JSON.parse(stdout) : [];
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.function !== 'string'
    || !Array.isArray(entry.issues) || entry.issues.some(issue => !issue || typeof issue.level !== 'string'))) {
    throw new Error('Malformed database lint JSON findings');
  }
  const ignored = []; const kept = [];
  for (const entry of entries) {
    const matches = exceptions.some(exception => (typeof exception.function === 'string' && exception.function === entry.function)
      || (typeof exception.pattern === 'string' && JSON.stringify(entry).includes(exception.pattern))
      || (typeof exception.extension === 'string' && ownership.get(entry.function) === exception.extension));
    (matches ? ignored : kept).push(entry);
  }
  const hasError = entry => entry.issues.some(issue => /error/i.test(issue.level));
  const triggering = entries.filter(hasError);
  return { kept, ignored, exitCode: kept.some(hasError) ? 1 : exitCode === 0 ? 0
    : triggering.length && triggering.every(entry => ignored.includes(entry)) ? 0 : exitCode };
}

async function runLint(report) {
  const issues = migrationIssues(listAllActiveMigrations());
  if (issues.length) throw new Error(`Migration lint failed:\n${issues.join('\n')}`);
  const spec = invocation(process.env);
  const exceptions = JSON.parse(fs.readFileSync('config/lint/db-lint-exceptions.json', 'utf8'));
  if (!Array.isArray(exceptions)) throw new Error('Malformed database lint exception registry');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT,
    connectionTimeoutMillis: 15000, query_timeout: 15000 });
  client.on('error', error => console.error(sanitize(error.message)));
  let ownership;
  try {
    await client.connect();
    const result = await client.query("SELECT n.nspname || '.' || p.proname AS function_name, e.extname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e' JOIN pg_extension e ON e.oid = d.refobjid");
    ownership = new Map(result.rows.map(row => [row.function_name, row.extname]));
  } finally { await client.end(); }
  const result = spawnSync(spec.command, spec.args, { env: spec.env, encoding: 'utf8', windowsHide: true,
    timeout: 540000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stderr) console.error(sanitize(result.stderr));
  if (result.error || result.signal) throw new Error(result.error?.message || `Database lint terminated: ${result.signal}`);
  let outcome;
  try { outcome = lintResult(result.stdout, result.status, exceptions, ownership); }
  catch (error) { console.error(sanitize(result.stdout)); throw error; }
  if (outcome.kept.length) console.log(sanitize(JSON.stringify(outcome.kept, null, 2)));
  console.log(`[db-lint] ${outcome.kept.length} retained findings; ${outcome.ignored.length} existing exceptions; exit ${outcome.exitCode}`);
  Object.assign(report, { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, ignored: outcome.ignored.length,
    findings: outcome.kept.flatMap(entry => entry.issues.map(issue => ({ function: sanitize(entry.function),
      message: sanitize(issue.message || ''), level: sanitize(issue.level), sqlState: issue.sqlState || null }))) });
  process.exitCode = outcome.exitCode;
}

async function main() {
  const report = { ok: false, findings: [] };
  try { await runLint(report); }
  catch (error) { report.failure = sanitize(error.message); throw error; }
  finally {
    fs.mkdirSync('ci-reports', { recursive: true });
    fs.writeFileSync('ci-reports/db-lint.json', JSON.stringify(report, null, 2));
  }
}

if (require.main === module) main().catch(error => { console.error(sanitize(error.message)); process.exitCode = 2; });
module.exports = { migrationIssues, invocation, lintResult };
