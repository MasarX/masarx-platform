'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, fork } = require('node:child_process');
const { targetFile, git } = require('./target-policy.cjs');

const root = process.cwd();
const bucketSections = text => text.split(/(?=^\[)/m).filter(section => section.startsWith('[storage.buckets.')).join('\n');
function migrationInventory(files) {
  const names = files.filter(name => name.endsWith('.sql')).sort();
  if (!names.length || names.some(name => !/^\d+_[a-zA-Z0-9_.-]+\.sql$/.test(name))) throw new Error('Missing or malformed migrations');
  const versions = names.map(name => name.split('_')[0]);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration stamps');
  return versions;
}
function checked(command, args, env, timeout = 600000) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const last = [...`${result.stdout || ''}\n${result.stderr || ''}`.matchAll(/Applying migration (\d+_[a-zA-Z0-9_.-]+\.sql)/g)].at(-1)?.[1];
    if (last) console.error(`First failing migration: ${last}`);
    // Do not print captured process output: it can contain disposable credentials or fixture data.
    throw new Error(`${path.basename(command)} ${args[0]} failed${last ? ` (${last})` : ''}`);
  }
  return String(result.stdout || '');
}
function diskFloor(directory) {
  const stat = fs.statfsSync(directory);
  const free = Number(stat.bavail) * Number(stat.bsize);
  console.log(`Disk free GiB: ${(free / 2 ** 30).toFixed(2)}`);
  if (free < 6 * 2 ** 30) throw new Error('Less than 6 GiB free; backend qualification blocked');
}
function completePins(pins) {
  const expected = { database: 'supabase/postgres', auth: 'supabase/gotrue', storage: 'supabase/storage-api', gateway: 'supabase/kong' };
  return Array.isArray(pins) && pins.length === 4 && Object.entries(expected).every(([role, image]) =>
    pins.filter(pin => pin.role === role && pin.image === image && /^[a-zA-Z0-9_.-]+$/.test(pin.tag)
      && /^sha256:[a-f0-9]{64}$/.test(pin.digest)).length === 1);
}
function mainSwitch(env = process.env, read = git, file = targetFile) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') return '';
  read(['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/ci-policy/main']);
  const base = read(['rev-parse', 'refs/ci-policy/main']).trim();
  return file('config/ci/hosted-db-first-qualification.txt', base, read);
}
function imagePreflight(text, event, now = new Date(), ref = process.env.GITHUB_REF, pins = []) {
  if (completePins(pins)) return { qualificationOnly: false };
  const match = /^allow-unpinned-service-images-until=(\d{4}-\d{2}-\d{2})$/.exec(text.trim());
  const validDate = match && !Number.isNaN(Date.parse(match[1])) && new Date(match[1]).toISOString().slice(0, 10) === match[1];
  if (!validDate || event !== 'workflow_dispatch' || ref !== 'refs/heads/main' || now.toISOString().slice(0, 10) > match[1]) {
    throw new Error('PIN_NEEDED: service-image digest set incomplete; only a dated switch fetched from refs/heads/main permits manual qualification');
  }
  console.log('::warning title=Unpinned qualification only::Protected main permits temporary tag pulls; this is not digest-pinned acceptance.');
  return { qualificationOnly: true };
}
async function imageGuard(pins, file, env) {
  const host = env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (!host.startsWith('unix://')) throw new Error('Digest guard requires the hosted Unix Docker socket');
  fs.writeFileSync(file, JSON.stringify(pins), { mode: 0o600 });
  const child = fork('scripts/ci-hosted/docker-images.cjs', [file, host.slice(7)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Digest guard startup timed out')), 10000);
      child.once('error', reject); child.once('exit', () => reject(new Error('Digest guard exited')));
      child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid image guard port');
    return { child, env: { ...env, DOCKER_HOST: `tcp://127.0.0.1:${port}`, DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '',
      SUPABASE_INTERNAL_IMAGE_REGISTRY: 'public.ecr.aws' } };
  } catch (error) { child.kill(); throw error; }
}
async function main() {
  const pins = JSON.parse(fs.readFileSync('config/ci/hosted-supabase-images.json', 'utf8'));
  const pinState = imagePreflight(completePins(pins) ? '' : mainSwitch(), process.env.GITHUB_EVENT_NAME, new Date(), process.env.GITHUB_REF, pins);
  if (process.argv[2] === 'preflight') return;
  // Reuse the existing loopback, version, client-image and full-pgTAP contracts.
  const local = require('../ops/ci/cloud-pool-db-local.js');
  const { buildSupabaseCliAsset } = require('../ops/ci/supabase-cli-asset.js');
  const config = local.readSupabaseConfig();
  const lane = local.loadLaneConfig();
  if (String(config.major) !== String(lane.psqlClientMajor)) throw new Error('Postgres/psql major mismatch');
  local.assertLoopbackOnly(process.env, 'hosted environment');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-supabase-'));
  fs.chmodSync(temp, 0o700);
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const project = `hosted-${crypto.randomBytes(8).toString('hex')}`;
  const env = { ...process.env, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0',
    QA_RUN_ID: '', NX_DAEMON: 'false', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const cli = path.join(bin, 'supabase');
  let started = false; let guard; let cliEnv = env;
  const summary = { sha: process.env.GITHUB_SHA || 'unknown', migrations: 0, pgtap: 'NOT_RUN',
    integration: 'SKIPPED_BY_DESIGN: local equivalence of the integration inventory is unproved',
    serviceImagePins: pinState.qualificationOnly ? 'PIN_NEEDED' : 'resolved SHA-256 indices', imageQualificationOnly: pinState.qualificationOnly, ok: false };
  try {
    checked('docker', ['info', '--format', '{{.ServerVersion}}'], env);
    const dockerRoot = checked('docker', ['info', '--format', '{{.DockerRootDir}}'], env).trim();
    diskFloor(dockerRoot);
    if (!pinState.qualificationOnly) {
      if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) throw new Error('Digest-pinned startup requires the hosted Unix Docker daemon');
      for (const pin of pins) {
        diskFloor(dockerRoot);
        const reference = `public.ecr.aws/${pin.image}@${pin.digest}`;
        checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 20 * 60000);
        pin.runtimeId = checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env).trim();
      }
      guard = await imageGuard(pins, path.join(temp, 'runtime-image-pins.json'), env);
      cliEnv = guard.env;
    }
    const asset = buildSupabaseCliAsset({ version: '2.116.0', platform: 'linux', arch: 'amd64' });
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('PIN_NEEDED: Supabase CLI archive checksum');
    const response = await fetch(asset.download_url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Supabase CLI public asset download failed');
    const archive = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(archive).digest('hex') !== asset.sha256) throw new Error('Supabase CLI checksum mismatch');
    const archivePath = path.join(temp, 'cli.tar.gz');
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    checked('tar', ['-xzf', archivePath, '-C', bin, 'supabase'], env);
    env.SUPABASE_CLI_BIN = cli;
    // This workdir owns an empty DB. No remote profiles, seed files or cached schema are copied.
    const sb = path.join(temp, 'supabase');
    fs.mkdirSync(sb);
    fs.mkdirSync(path.join(sb, 'migrations'));
    const originalConfig = fs.readFileSync('supabase/config.toml', 'utf8');
    const buckets = bucketSections(originalConfig);
    fs.writeFileSync(path.join(sb, 'config.toml'), [
      `project_id = "${project}"`, '[api]', 'enabled = true', 'port = 54321', 'schemas = ["api"]',
      'extra_search_path = ["public", "extensions"]', '[db]', `port = ${config.dbPort}`,
      'shadow_port = 54320', `major_version = ${config.major}`, '[db.seed]', 'enabled = false',
      '[studio]', 'enabled = false', '[analytics]', 'enabled = false', '[auth]', 'enabled = true',
      'site_url = "http://127.0.0.1:3001"', '[storage]', 'enabled = true', '', buckets,
    ].join('\n'), { mode: 0o600 });
    started = true; // A partial start must also be stopped.
    checked(cli, ['start', '--workdir', temp, '-x', lane.exclude.join(',')], cliEnv, 20 * 60000);
    const status = JSON.parse(checked(cli, ['status', '--workdir', temp, '-o', 'json'], cliEnv));
    if (!status.DB_URL) throw new Error('Local stack did not provide DB_URL');
    Object.assign(env, { DATABASE_URL: status.DB_URL, DATABASE_URL_DIRECT: status.DB_URL,
      SUPABASE_URL: status.API_URL || '', SUPABASE_ANON_KEY: status.ANON_KEY || '',
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY || '', WORKSPACE_NAME: project });
    local.assertLoopbackOnly(env, 'local stack');
    const { Client } = require('pg');
    const db = new Client({ connectionString: env.DATABASE_URL });
    await db.connect();
    try {
      const history = await db.query("select to_regclass('supabase_migrations.schema_migrations') as history");
      if (history.rows[0].history) {
        const before = await db.query('select count(*)::int as n from supabase_migrations.schema_migrations');
        if (before.rows[0].n !== 0) throw new Error('Database is not empty of application migrations');
      }
      const versions = migrationInventory(fs.readdirSync('supabase/migrations'));
      fs.rmdirSync(path.join(sb, 'migrations'));
      fs.symlinkSync(path.join(root, 'supabase/migrations'), path.join(sb, 'migrations'), 'dir');
      diskFloor(dockerRoot);
      // The CLI orders stamps, records history and stops on the first SQL error. No retry.
      checked(cli, ['migration', 'up', '--local', '--workdir', temp], cliEnv, 100 * 60000);
      const applied = await db.query('select version from supabase_migrations.schema_migrations order by version');
      if (JSON.stringify(applied.rows.map(row => row.version)) !== JSON.stringify(versions)) throw new Error('Applied migration stamps do not match the complete source inventory');
      summary.migrations = versions.length;
      console.log(`Fresh migration replay: ${versions.length} files`);
    } finally { await db.end(); }
    for (const lint of local.loadBackendLocalPreSuiteCommands()) {
      checked('npm', ['run', lint.script], { ...env, ...lint.env, ENV_FILE: os.devNull,
        ENV_FILE_APPEND: '0', ENV_FILE_OVERRIDE: '0', MIGRATION_FIXTURE_GUARD_MODE: 'full' }, lint.timeout_ms);
    }
    if (fs.existsSync('supabase/tests/pgtap')) {
      const files = fs.readdirSync('supabase/tests/pgtap').filter(n => n.endsWith('.sql'));
      if (!files.length) throw new Error('Present pgTAP directory is empty');
      const skipFile = 'supabase/tests/pgtap/.pgtap-skip.json';
      if (fs.existsSync(skipFile)) {
        const skip = JSON.parse(fs.readFileSync(skipFile, 'utf8'));
        if (!Array.isArray(skip) || skip.length) throw new Error('Full pgTAP cannot use a malformed/nonempty skip list');
      }
      checked('docker', ['pull', lane.psqlClientImage], env, 10 * 60000);
      local.writePsqlWrapper(bin, lane.psqlClientImage);
      Object.assign(env, { PGTAP_FULL_LOCAL_QUALIFICATION: '1', PGTAP_ONLY_FILES: '', PGTAP_TEST_FILES: '',
        PGTAP_NODE_FILE_RETRIES: '0', PGTAP_RETRY_TRANSIENT: '0', PGTAP_RETRY_DEADLOCKS: '0',
        PGTAP_NODE_FILE_MAX_WAIT_MS: '0', PGTAP_FILES_PER_SESSION: '1',
        DB_LOCAL_PROJECT_ID: project, DB_LOCAL_DB_PORT: String(config.dbPort) });
      diskFloor(dockerRoot);
      checked(process.execPath, ['scripts/ops/ci/cloud-pool-db-local-pgtap.js'], env, 40 * 60000);
      summary.pgtap = `passed: ${files.length} files, no filters/retries`;
    } else summary.pgtap = 'SKIPPED_BY_DESIGN: pgTAP directory absent';
    console.log(summary.integration);
    summary.ok = true;
  } finally {
    if (started) {
      const stop = spawnSync(cli, ['stop', '--workdir', temp, '--no-backup'], { env: cliEnv, stdio: 'ignore', timeout: 120000 });
      if (stop.error || stop.status !== 0) { summary.ok = false; process.exitCode = 1; console.error('Local stack teardown failed'); }
    }
    if (guard) {
      guard.child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { guard.child.kill('SIGKILL'); resolve(); }, 3000);
        guard.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync('ci-reports', { recursive: true });
    fs.writeFileSync('ci-reports/backend.json', `${JSON.stringify(summary, null, 2)}\n`);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { bucketSections, migrationInventory, imagePreflight, completePins, mainSwitch };
