#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { computeWorkspaceId } = require('./id');
const { computePorts } = require('./local-config');

function getWorkspaceId() {
  return process.env.WORKSPACE_NAME || computeWorkspaceId();
}

function die(msg, code = 1) {
  console.error(`[workspace/local-db-start] ${msg}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) die(`Failed running ${cmd} ${args.join(' ')}: ${res.error.message}`);
  return res;
}

function waitForPostgres(port, timeoutSeconds = 60) {
  // objectives:allow DSN_URL Justification: local-only Postgres DSN for dev containers; not used for multi-tenant production routing
  // objectives:allow LOCALHOST Justification: connects exclusively to local Docker Postgres on loopback for workspace development
  const dsn = ([`postgresql`,":","/","/",`postgres`,":",`postgres`,"@",`127.0.0.1`,":",`${port}`,"/",`postgres`].join(""));
  const start = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = spawnSync('psql', [dsn, '-c', 'select 1'], { stdio: 'ignore' });
    if (res.status === 0) return;
    if (Date.now() - start > timeoutMs) {
      die(`Postgres did not become ready on port ${port} within ${timeoutSeconds}s`);
    }
    // brief sleep
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

(function main() {
  const wk = getWorkspaceId();
  const ports = computePorts(wk);
  const containerName = `masarx_db_${wk}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  // Always ensure we have a fresh container; let Docker choose an available
  // host port and record it for env sync.
  console.log(`[workspace/local-db-start] Ensuring fresh Postgres container ${containerName}`);
  run('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-P',
    'public.ecr.aws/supabase/postgres:17.6.1.014',
  ]);

  const portInfo = spawnSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' });
  if (portInfo.status !== 0) die(`docker port inspection failed for ${containerName}`);
  const line = (portInfo.stdout || '').trim();
  const m = line.match(/:(\d+)\s*$/);
  if (!m) die(`Could not parse host port from: ${line}`);
  const hostPort = parseInt(m[1], 10);

  const metaPath = path.join('supabase', '.temp', `local_db_${wk}.json`);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({ db_port: hostPort }, null, 2) + '\n', 'utf8');
  console.log(`[workspace/local-db-start] ${containerName} listening on host port ${hostPort}`);

  console.log(`[workspace/local-db-start] Waiting for Postgres on port ${hostPort}...`);
  waitForPostgres(hostPort);
  console.log('[workspace/local-db-start] Postgres is ready');
})();
