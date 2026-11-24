'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { assertLoopbackOnly } = require('../ops/ci/cloud-pool-db-local.js');

function prepareStack(workdir) {
  const source = path.resolve('supabase');
  const target = path.join(workdir, 'supabase');
  const config = fs.readFileSync(path.join(source, 'config.toml'), 'utf8');
  const project = 'nightly-' + randomBytes(8).toString('hex');
  if (!/^project_id\s*=/m.test(config) || !/^\[edge_runtime\]\r?\nenabled = false/m.test(config)) {
    throw new Error('Local Supabase configuration changed');
  }
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'config.toml'), config
    .replace(/^project_id\s*=.*$/m, 'project_id = "' + project + '"')
    .replace(/^(\[edge_runtime\]\r?\n)enabled = false/m, '$1enabled = true'), { mode: 0o600 });
  for (const child of ['migrations', 'functions', 'templates']) {
    const input = path.join(source, child);
    if (fs.existsSync(input)) fs.symlinkSync(input, path.join(target, child), 'dir');
  }
}

function stackEnvironment(status) {
  const values = { DATABASE_URL: status.DB_URL, DATABASE_URL_DIRECT: status.DB_URL,
    SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    EXPO_PUBLIC_SUPABASE_URL: status.API_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    VITE_SUPABASE_URL: status.API_URL, VITE_SUPABASE_ANON_KEY: status.ANON_KEY };
  if (!Object.values(values).every(value => typeof value === 'string' && /^\S+$/.test(value) && value === value.trim())) {
    throw new Error('Local Supabase status is missing fixture settings');
  }
  assertLoopbackOnly(values, 'nightly local Supabase');
  const db = new URL(values.DATABASE_URL);
  const api = new URL(values.SUPABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.search
      || !['http:', 'https:'].includes(api.protocol) || api.username || api.password) {
    throw new Error('Invalid local Supabase status');
  }
  return values;
}

async function waitForWeb(url) {
  assertLoopbackOnly({ SUPABASE_URL: url }, 'nightly browser target');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'manual' }).catch(() => null);
    if (response) {
      await response.body?.cancel();
      if (response.ok) return;
    }
    await delay(500);
  }
  throw new Error('Local browser target did not become ready');
}

if (require.main === module) {
  if (process.argv[2] === 'prepare') prepareStack(process.argv[3]);
  else if (process.argv[2] === 'env') {
    const values = stackEnvironment(JSON.parse(fs.readFileSync(0, 'utf8')));
    for (const [key, value] of Object.entries(values)) console.log(key + '=' + value);
  } else if (process.argv[2] === 'wait') {
    waitForWeb(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else throw new Error('Expected local Supabase prepare, env or wait');
}

module.exports = { stackEnvironment };
