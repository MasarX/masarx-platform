#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');
const { buildDbConnectionCandidates } = require('../utils/pg-candidates');

function die(msg, code = 1) {
  console.error(`[prega-db-dump] ${msg}`);
  process.exit(code);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    schema: false,
    data: false,
    file: '',
    lockWaitTimeout: String(process.env.PREGA_BACKUP_LOCK_WAIT_TIMEOUT || '').trim() || '30s',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--schema') out.schema = true;
    else if (token === '--data') out.data = true;
    else if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--file') out.file = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--file=')) out.file = token.split('=').slice(1).join('=').trim();
    else if (token === '--lock-wait-timeout')
      out.lockWaitTimeout = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--lock-wait-timeout=')) {
      out.lockWaitTimeout = token.split('=').slice(1).join('=').trim();
    }
  }

  return out;
}

function printUsage() {
  console.log('Usage: node scripts/ops/prega-db-dump.js [--schema|--data] --file <path> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --schema                      Dump public schema as plain SQL');
  console.log('  --data                        Dump data-only as custom compressed format');
  console.log('  --file <path>                 Output file path');
  console.log('  --lock-wait-timeout <value>   pg_dump lock wait timeout (default: 30s)');
  console.log('  --help, -h                    Show usage');
}

function rewriteSslmodeForPgDump(dbUrl) {
  return String(dbUrl || '').replace(/sslmode=no-verify/gi, 'sslmode=require');
}

function isRetryableDumpFailure(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('network is unreachable') ||
    text.includes('no route to host') ||
    text.includes('connection refused') ||
    text.includes('connection reset') ||
    text.includes('timeout') ||
    text.includes('could not connect to server') ||
    text.includes('server closed the connection unexpectedly')
  );
}

function isPgDumpMissingFailure(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('spawnsync pg_dump enoent') ||
    text.includes('pg_dump: command not found')
  );
}

function isServerVersionMismatchFailure(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('server version mismatch') ||
    (text.includes('server version:') && text.includes('pg_dump version:'))
  );
}

function ensureArgsValid(args) {
  if (!args.schema && !args.data) {
    throw new Error('Select one mode: --schema or --data.');
  }
  if (args.schema && args.data) {
    throw new Error('Select only one mode at a time: --schema or --data.');
  }
  if (!args.file) {
    throw new Error('Missing required --file argument.');
  }
}

async function buildCandidatesFromEnv(env = process.env) {
  const raw = [
    { name: 'DATABASE_URL', dsn: String(env.DATABASE_URL || '').trim() },
    { name: 'DATABASE_URL_DIRECT', dsn: String(env.DATABASE_URL_DIRECT || '').trim() },
    { name: 'DATABASE_URL_POOLER', dsn: String(env.DATABASE_URL_POOLER || '').trim() },
  ].filter((entry) => entry.dsn);

  const candidates = await buildDbConnectionCandidates(raw);
  return candidates.map((entry) => ({
    name: entry.name,
    dsn: rewriteSslmodeForPgDump(entry.dsn),
  }));
}

function buildPgDumpArgs({ dbUrl = '', targetFile = '', mode = 'schema', lockWaitTimeout = '' }) {
  const pgArgs = [
    '--dbname',
    dbUrl,
    '--file',
    targetFile,
    '--no-owner',
    '--no-privileges',
  ];
  if (String(lockWaitTimeout || '').trim()) {
    pgArgs.push(`--lock-wait-timeout=${String(lockWaitTimeout).trim()}`);
  }
  if (mode === 'schema') {
    pgArgs.push('--schema-only', '--schema=public');
  } else {
    pgArgs.push('--data-only', '--format=custom', '--compress=9');
  }
  return pgArgs;
}

function runPgDump(args = {}, dbUrl = '') {
  const targetFile = String(args.file || '').trim();
  const mode = args.schema ? 'schema' : 'data';
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const pgArgs = buildPgDumpArgs({
    dbUrl,
    targetFile,
    mode,
    lockWaitTimeout: args.lockWaitTimeout,
  });

  const result = spawnSync('pg_dump', pgArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (output) process.stdout.write(output);
  if (result.error) {
    return { ok: false, message: result.error.message, output };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, message: `pg_dump exited with status ${result.status}`, output };
  }
  return { ok: true };
}

function buildSupabaseDumpArgs({ dbUrl = '', targetFile = '', mode = 'schema' }) {
  const cliArgs = [
    path.join('scripts', 'ops', 'supabase-cli.js'),
    'dump',
    '--db-url',
    dbUrl,
    '--file',
    targetFile,
  ];
  if (mode === 'schema') {
    cliArgs.push('--schema', 'public');
  } else {
    cliArgs.push('--data-only');
  }
  return cliArgs;
}

function runSupabaseDump(args = {}, dbUrl = '') {
  const targetFile = String(args.file || '').trim();
  const mode = args.schema ? 'schema' : 'data';
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const cliArgs = buildSupabaseDumpArgs({
    dbUrl,
    targetFile,
    mode,
  });
  const result = spawnSync(process.execPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (output) process.stdout.write(output);
  if (result.error) {
    return { ok: false, message: result.error.message, output };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, message: `supabase db dump exited with status ${result.status}`, output };
  }
  return { ok: true };
}

function runDockerPgDump(args = {}, dbUrl = '') {
  const targetFile = String(args.file || '').trim();
  const mode = args.schema ? 'schema' : 'data';
  const image = String(process.env.PREGA_BACKUP_PGDUMP_DOCKER_IMAGE || '').trim() || 'postgres:17';
  const targetAbs = path.resolve(targetFile);
  const cwd = process.cwd();
  const rel = path.relative(cwd, targetAbs);
  const insideCwd = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const hostMount = insideCwd ? cwd : path.dirname(targetAbs);
  const containerFile = insideCwd
    ? `/workspace/${rel.split(path.sep).join('/')}`
    : `/workspace/${path.basename(targetAbs)}`;
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });

  const pgArgs = buildPgDumpArgs({
    dbUrl,
    targetFile: containerFile,
    mode,
    lockWaitTimeout: args.lockWaitTimeout,
  });

  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${hostMount}:/workspace`,
    image,
    'pg_dump',
    ...pgArgs,
  ];

  const result = spawnSync('docker', dockerArgs, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    return { ok: false, message: `docker pg_dump failed to start: ${result.error.message}` };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, message: `docker pg_dump exited with status ${result.status}` };
  }
  return { ok: true };
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (args.help) {
    printUsage();
    return;
  }
  ensureArgsValid(args);

  const candidates = await buildCandidatesFromEnv(process.env);
  if (!candidates.length) {
    die('No database URL candidates available (DATABASE_URL/DIRECT/POOLER).');
  }

  const errors = [];
  for (const candidate of candidates) {
    console.log(`[prega-db-dump] Trying ${candidate.name} (${args.schema ? 'schema' : 'data'})...`);
    const outcome = runPgDump(args, candidate.dsn);
    if (outcome.ok) {
      console.log(`[prega-db-dump] Wrote ${args.file}`);
      return;
    }
    if (isPgDumpMissingFailure(outcome.message)) {
      console.warn(
        '[prega-db-dump] Local pg_dump is unavailable; retrying with supabase db dump fallback...',
      );
      const supabaseOutcome = runSupabaseDump(args, candidate.dsn);
      if (supabaseOutcome.ok) {
        console.log(`[prega-db-dump] Wrote ${args.file}`);
        return;
      }
      errors.push(`${candidate.name} (supabase fallback): ${supabaseOutcome.message}`);
      if (!isRetryableDumpFailure(supabaseOutcome.message)) {
        break;
      }
      console.warn(
        `[prega-db-dump] Retryable supabase fallback failure on ${candidate.name}; trying next candidate...`,
      );
      continue;
    }
    if (isServerVersionMismatchFailure(outcome.output || outcome.message)) {
      console.warn(
        '[prega-db-dump] Local pg_dump/server version mismatch detected; retrying with containerized pg_dump...',
      );
      const dockerOutcome = runDockerPgDump(args, candidate.dsn);
      if (dockerOutcome.ok) {
        console.log(`[prega-db-dump] Wrote ${args.file}`);
        return;
      }
      errors.push(`${candidate.name} (docker fallback): ${dockerOutcome.message}`);
      if (!isRetryableDumpFailure(dockerOutcome.message)) {
        break;
      }
      console.warn(`[prega-db-dump] Retryable docker fallback failure on ${candidate.name}; trying next candidate...`);
      continue;
    }
    errors.push(`${candidate.name}: ${outcome.message}`);
    if (!isRetryableDumpFailure(outcome.message)) {
      break;
    }
    console.warn(`[prega-db-dump] Retryable failure on ${candidate.name}; trying next candidate...`);
  }

  die(`Backup failed across DB URL candidates.\n${errors.join('\n')}`);
}

if (require.main === module) {
  main().catch((error) => {
    die(error && error.message ? error.message : String(error));
  });
}

module.exports = {
  buildSupabaseDumpArgs,
  buildPgDumpArgs,
  buildCandidatesFromEnv,
  ensureArgsValid,
  isPgDumpMissingFailure,
  isServerVersionMismatchFailure,
  parseArgs,
  rewriteSslmodeForPgDump,
};
