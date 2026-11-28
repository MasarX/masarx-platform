#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

function parseArgs(argv) {
  const out = {};
  const parts = argv.slice(2);
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.replace(/^--/, '');
    if (key.includes('=')) {
      const [k, v] = key.split('=');
      out[k] = v;
      continue;
    }
    const next = parts[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function printHelp() {
  console.log('Dump compose_label_payload(<job_id>) to a JSON file.');
  console.log('');
  console.log('Usage:');
  console.log('  ENV_FILE=path/to/cloud-config node scripts/render/dump-label-payload.js --job-id <uuid> [--out <path>]');
  console.log('');
  console.log('Options:');
  console.log('  --job-id <uuid>   Required label_jobs.id');
  console.log('  --out <path>      Output path (default: tmp/label-renderer/payload_<job_id>.json)');
  console.log('  --pretty          Pretty-print JSON');
  console.log('  --help            Show this help');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  loadEnv();

  const jobId = args['job-id'] || args.job_id || args.jobId;
  if (!jobId || !isUuid(jobId)) {
    console.error('Missing or invalid --job-id <uuid>');
    printHelp();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set (set ENV_FILE=path/to/cloud-config or export DATABASE_URL)');
    process.exit(1);
  }

  const outPath =
    args.out ||
    args.output ||
    path.join('tmp', 'label-renderer', `payload_${jobId}.json`);

  const resolvedOut = path.resolve(process.cwd(), String(outPath));
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'select compose_label_payload($1::uuid) as payload',
      [jobId]
    );
    const payload = rows[0] ? rows[0].payload : null;
    if (!payload) {
      console.error(`No payload returned for job_id=${jobId}`);
      process.exit(1);
    }
    const pretty = Boolean(args.pretty);
    const json = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    fs.writeFileSync(resolvedOut, `${json}\n`, 'utf8');
    console.log(`wrote ${resolvedOut}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
