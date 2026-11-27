'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { assertLoopbackOnly } = require('../ops/ci/cloud-pool-db-local.js');
const target = require('../../config/ci/nightly-target.json');

function query(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 60000 }).trim();
  } catch (error) {
    if (command === 'git' && args[0] === 'config' && error.status === 1) return '';
    throw error;
  }
}

function assertFreshMain(sha, url = target.origin, run = query) {
  if (run('git', ['remote', 'get-url', 'origin']).trim() !== url) throw new Error('Nightly requires the public origin');
  if (run('git', ['config', '--name-only', '--get-regexp',
    '^(credential\\.|http\\..*extraheader$|url\\..*insteadof$|core\\.sshcommand$)']).trim()) {
    throw new Error('Nightly checkout has Git credential or URL overrides');
  }
  const clean = ['status', '--porcelain', '--ignored', '--untracked-files=normal', '--', '.'];
  if (process.env.NIGHTLY_JOB) clean.push(':(exclude,top)' + path.basename(process.env.NIGHTLY_JOB));
  if (run('git', clean).trim()) throw new Error('Nightly requires a clean checkout without ignored files');
  const row = run('git', ['-c', 'credential.helper=', 'ls-remote', '--exit-code', url, 'refs/heads/main']).trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || row !== sha + '\trefs/heads/main') {
    throw new Error('Nightly checkout does not match current public main');
  }
}

function assertPortsFree(run = query) {
  const ports = new Set(target.ports.map(String));
  const listeners = run('ss', ['-H', '-ltn']).split('\n').filter(Boolean);
  if (listeners.some(line => ports.has(line.trim().split(/\s+/)[3]?.split(':').at(-1)))) {
    throw new Error('A nightly fixture port is already in use');
  }
}

function assertPublishedPorts(containers) {
  const bindings = containers.flatMap(container => Object.values(container || {}).flatMap(value => value || []));
  if (!bindings.length || bindings.some(binding =>
    binding.HostIp !== '127.0.0.1' || !/^[1-9]\d{0,4}$/.test(binding.HostPort) || +binding.HostPort > 65535)) {
    throw new Error('Supabase did not publish ports exclusively on IPv4 loopback');
  }
  return bindings.length;
}

function checkDockerBindings(project, run = query) {
  const ids = run('docker', ['ps', '--filter', 'label=com.supabase.cli.project=' + project, '--format', '{{.ID}}'])
    .trim().split(/\s+/).filter(Boolean);
  if (!ids.length || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Supabase project containers are missing');
  const lines = run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', ...ids]).trim().split('\n');
  if (lines.length !== ids.length) throw new Error('Supabase binding evidence is incomplete');
  console.log('Verified IPv4 loopback bindings: ' + assertPublishedPorts(lines.map(line => JSON.parse(line))));
}

function checkFixtureNetwork(network, run = query) {
  const driver = run('docker', ['network', 'inspect', '--format',
    '{{.Driver}} {{index .Options "com.docker.network.bridge.host_binding_ipv4"}}', network]);
  if (driver.trim() !== 'bridge 127.0.0.1') throw new Error('Nightly requires a loopback-only fixture bridge');
}

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
    .replace(/^(\[(?:studio|inbucket)\]\r?\n)enabled = true/mg, '$1enabled = false')
    .replace(/^(\[edge_runtime\]\r?\n)enabled = false/m, '$1enabled = true'), { mode: 0o600 });
  for (const child of ['migrations', 'functions', 'templates']) {
    const input = path.join(source, child);
    if (fs.existsSync(input)) fs.symlinkSync(input, path.join(target, child), 'dir');
  }
  return project;
}

function stackEnvironment(status) {
  const values = { DATABASE_URL: status.DB_URL, DATABASE_URL_DIRECT: status.DB_URL,
    SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    WEBHOOK_DB_JWT: status.SERVICE_ROLE_KEY,
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
  if (process.argv[2] === 'prepare') console.log(prepareStack(process.argv[3]));
  else if (process.argv[2] === 'fresh-main') assertFreshMain(process.argv[3]);
  else if (process.argv[2] === 'ports-free') assertPortsFree();
  else if (process.argv[2] === 'network') checkFixtureNetwork(process.argv[3]);
  else if (process.argv[2] === 'bindings') checkDockerBindings(process.argv[3]);
  else if (process.argv[2] === 'env') {
    const values = stackEnvironment(JSON.parse(fs.readFileSync(0, 'utf8')));
    for (const [key, value] of Object.entries(values)) console.log(key + '=' + value);
  } else if (process.argv[2] === 'wait') {
    waitForWeb(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else throw new Error('Expected local Supabase prepare, env or wait');
}

module.exports = { assertFreshMain, assertPortsFree, assertPublishedPorts, checkDockerBindings, checkFixtureNetwork, stackEnvironment };
