'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { targetFile, git } = require('./target-policy.cjs');
const { sanitize, environmentSecrets } = require('./diagnostics.cjs');
const { run, retry, stage, writeReport } = require('./process.cjs');
const { collectStackDiagnostics } = require('./stack-diagnostics.cjs');
const { shardFiles, shardEnvironment, shardResults } = require('./pgtap.cjs');

const root = process.cwd();
const bucketSections = text => text.split(/(?=^\[)/m).filter(section => section.startsWith('[storage.buckets.')).join('\n');
function migrationInventory(files) {
  const names = files.filter(name => name.endsWith('.sql')).sort();
  if (!names.length || names.some(name => !/^\d+_[a-zA-Z0-9_.-]+\.sql$/.test(name))) throw new Error('Missing or malformed migrations');
  const versions = names.map(name => name.split('_')[0]);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration stamps');
  return versions;
}
function migrationProgress(files, summary, every = 50, now = Date.now) {
  let index = 0;
  const start = now();
  summary.migrationTotal = files.length;
  return { line(text) {
    const file = /Applying migration (\d+_[a-zA-Z0-9_.-]+\.sql)/.exec(text)?.[1];
    if (!file) return false;
    if (file !== files[index]) throw new Error(`Unexpected migration order: ${file}; expected ${files[index]}`);
    summary.currentMigration = file;
    index++;
    if (index === 1 || (index - 1) % every === 0) console.log(`[${new Date(now()).toISOString()}] Migrations ${index - 1}/${files.length} complete; file ${index}/${files.length}: ${file}; elapsed ${((now() - start) / 1000).toFixed(1)}s`);
    return index > 1;
  } };
}
function diskFloor(directory) {
  const stat = fs.statfsSync(directory);
  const free = Number(stat.bavail) * Number(stat.bsize);
  console.log(`Disk free GiB: ${(free / 2 ** 30).toFixed(2)}`);
  if (free < 6 * 2 ** 30) throw new Error('Less than 6 GiB free; backend qualification blocked');
}
function completePins(pins) {
  const expected = { database: 'supabase/postgres', auth: 'supabase/gotrue', storage: 'supabase/storage-api', gateway: 'supabase/kong', realtime: 'supabase/realtime' };
  return Array.isArray(pins) && pins.length === Object.keys(expected).length && Object.entries(expected).every(([role, image]) =>
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
  const policyFile = `${file}.policy.json`;
  const host = env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (!host.startsWith('unix://')) throw new Error('Digest guard requires the hosted Unix Docker socket');
  fs.writeFileSync(file, JSON.stringify(pins), { mode: 0o600 });
  const child = fork('scripts/ci-hosted/docker-images.cjs', [file, host.slice(7), policyFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Digest guard startup timed out')), 10000);
      child.once('error', reject); child.once('exit', () => reject(new Error('Digest guard exited')));
      child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid image guard port');
    return { child, policyFile, env: { ...env, DOCKER_HOST: `tcp://127.0.0.1:${port}`, DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '',
      SUPABASE_INTERNAL_IMAGE_REGISTRY: 'public.ecr.aws' } };
  } catch (error) { child.kill(); throw error; }
}
async function backendLint(summary, commands, execute, file = 'ci-reports/db-lint.json') {
  const lint = summary.lint = { ok: true, commands: [], findings: [] };
  try {
    await stage(summary, 'backend-lint', async () => {
      for (const command of commands) {
        const result = { script: command.script, ok: true };
        try { await execute(command); }
        catch (error) { result.ok = false; result.failure = { message: sanitize(error.message), ...error.failure }; lint.ok = false; }
        lint.commands.push(result);
      }
      try {
        const report = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof report.ok !== 'boolean' || !Array.isArray(report.findings)) throw new Error('Malformed lint report');
        lint.ok = lint.ok && report.ok;
        lint.findings = report.findings; lint.ignored = report.ignored;
        if (report.failure) lint.failure = report.failure;
      } catch (error) { lint.ok = false; lint.failure = sanitize(error.message); }
      if (!lint.ok) throw new Error('Backend lint failed; preserving findings while independent pgTAP shards continue');
    });
  } catch (error) { lint.ok = false; lint.failure ||= sanitize(error.message); console.error(sanitize(error.message)); }
}
async function qualify(diagnostic) {
  const pins = JSON.parse(fs.readFileSync('config/ci/hosted-supabase-images.json', 'utf8'));
  const pinState = imagePreflight(completePins(pins) ? '' : mainSwitch(), process.env.GITHUB_EVENT_NAME, new Date(), process.env.GITHUB_REF, pins);
  diagnostic.imagePolicy = { mode: pinState.qualificationOnly ? 'qualification-only' : 'digest-pinned', decision: 'not_started', allowed: 0, denied: 0, denials: [] };
  if (process.argv[2] === 'preflight') return;
  const shard = process.env.PGTAP_SHARD;
  const selected = shard ? shardFiles(fs.readdirSync('supabase/tests/pgtap'), shard) : undefined;
  if (shard && fs.existsSync('supabase/tests/pgtap/.pgtap-skip.json')) {
    const skip = JSON.parse(fs.readFileSync('supabase/tests/pgtap/.pgtap-skip.json', 'utf8'));
    if (!Array.isArray(skip) || skip.length) throw new Error('pgTAP shards cannot use a malformed/nonempty skip list');
  }
  const reportName = shard ? 'pgtap' : 'backend';
  diagnostic.stage = 'local-contracts';
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
  let started = false; let guard; let cliEnv = env; let dockerRoot;
  const summary = { stages: [], sha: process.env.GITHUB_SHA || 'unknown', migrations: 0, pgtap: 'NOT_RUN',
    ...(shard ? { shard, selected, files: [] } : {}),
    integration: 'SKIPPED_BY_DESIGN: local equivalence of the integration inventory is unproved',
    serviceImagePins: pinState.qualificationOnly ? 'PIN_NEEDED' : 'resolved SHA-256 indices', imageQualificationOnly: pinState.qualificationOnly, ok: false };
  fs.mkdirSync('ci-reports', { recursive: true });
  const checked = (command, args, commandEnv, timeout, options = {}) => run(command, args, { env: commandEnv, timeout, logFile: `ci-reports/${reportName}.log`, ...options });
  const timed = (name, action) => { diagnostic.stage = name; return stage(summary, name, action); };
  try {
    diagnostic.stage = 'docker-preflight';
    await checked('docker', ['info', '--format', '{{.ServerVersion}}'], env);
    dockerRoot = (await checked('docker', ['info', '--format', '{{.DockerRootDir}}'], env, undefined, { quiet: true })).trim();
    diskFloor(dockerRoot);
    if (!pinState.qualificationOnly) {
      if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) throw new Error('Digest-pinned startup requires the hosted Unix Docker daemon');
      diagnostic.stage = 'image-pull';
      for (const pin of pins) {
        diskFloor(dockerRoot);
        const reference = `public.ecr.aws/${pin.image}@${pin.digest}`;
        await timed(`image-pull:${pin.role}`, () => retry(`image-pull:${pin.role}`, () => checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 20 * 60000)));
        pin.runtimeId = (await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env, undefined, { quiet: true })).trim();
      }
      diagnostic.stage = 'image-guard';
      guard = await imageGuard(pins, path.join(temp, 'runtime-image-pins.json'), env);
      cliEnv = guard.env;
    }
    diagnostic.stage = 'cli-download';
    const asset = buildSupabaseCliAsset({ version: '2.116.0', platform: 'linux', arch: 'amd64' });
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('PIN_NEEDED: Supabase CLI archive checksum');
    const response = await fetch(asset.download_url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Supabase CLI public asset download failed');
    const archive = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(archive).digest('hex') !== asset.sha256) throw new Error('Supabase CLI checksum mismatch');
    const archivePath = path.join(temp, 'cli.tar.gz');
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    await checked('tar', ['-xzf', archivePath, '-C', bin, 'supabase'], env);
    env.SUPABASE_CLI_BIN = cli;
    // This workdir owns an empty DB. No remote profiles, seed files or cached schema are copied.
    const sb = path.join(temp, 'supabase');
    fs.mkdirSync(sb);
    fs.mkdirSync(path.join(sb, 'migrations'));
    diagnostic.stage = 'stack-configuration';
    const originalConfig = fs.readFileSync('supabase/config.toml', 'utf8');
    const buckets = bucketSections(originalConfig);
    fs.writeFileSync(path.join(sb, 'config.toml'), [
      `project_id = "${project}"`, '[api]', 'enabled = true', 'port = 54321', 'schemas = ["api"]',
      'extra_search_path = ["public", "extensions"]', '[db]', `port = ${config.dbPort}`,
      'shadow_port = 54320', `major_version = ${config.major}`, '[db.seed]', 'enabled = false',
      '[studio]', 'enabled = false', '[analytics]', 'enabled = false', '[auth]', 'enabled = true',
      'site_url = "http://127.0.0.1:3001"', '[storage]', 'enabled = true', '', buckets,
    ].join('\n'), { mode: 0o600 });
    diagnostic.stage = 'stack-start';
    started = true; // A partial start must also be stopped.
    console.log(`Stack service exclusions: ${lane.exclude.join(',')}`);
    await timed('stack-start', () => checked(cli, ['start', '--debug', '--workdir', temp, '-x', lane.exclude.join(',')], cliEnv, 6 * 60000));
    diagnostic.stage = 'stack-status';
    const status = JSON.parse(await checked(cli, ['status', '--workdir', temp, '-o', 'json'], cliEnv, undefined, { quiet: true }));
    if (!status.DB_URL) throw new Error('Local stack did not provide DB_URL');
    Object.assign(env, { DATABASE_URL: status.DB_URL, DATABASE_URL_DIRECT: status.DB_URL,
      SUPABASE_URL: status.API_URL || '', SUPABASE_ANON_KEY: status.ANON_KEY || '',
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY || '', WORKSPACE_NAME: project });
    local.assertLoopbackOnly(env, 'local stack');
    diagnostic.stage = 'database-connect';
    const { Client } = require('pg');
    const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 15000, query_timeout: 15000 });
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
      // The pinned CLI reuses one connection and batches statements per file, retaining migration history.
      const files = fs.readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort();
      const progress = migrationProgress(files, summary);
      let migrationError;
      try {
        await timed('migrations', () => checked(cli, ['migration', 'up', '--local', '--workdir', temp], cliEnv, 150 * 60000, {
          onLine: progress.line, idleMs: 10 * 60000,
          idleMessage: () => `No migration completed for 10 minutes; in progress: ${summary.currentMigration || '(connecting)'}`,
        }));
      } catch (error) { migrationError = error; throw error; }
      finally {
        let applied;
        try { applied = await db.query('select version from supabase_migrations.schema_migrations order by version'); }
        catch (error) {
          summary.migrations = 'UNKNOWN';
          summary.firstFailingMigration = summary.currentMigration || null;
          if (!migrationError) throw error;
        }
        if (applied) {
          summary.migrations = applied.rows.length;
          summary.migrationTotal = versions.length;
          summary.migrationsPerMinute = Number((summary.migrations / ((summary.stages.find(s => s.name === 'migrations').durationMs || 1) / 60000)).toFixed(2));
          summary.migrationFailed = migrationError && summary.currentMigration && summary.migrations < versions.length ? 1 : 0;
          summary.migrationNotRun = versions.length - summary.migrations - summary.migrationFailed;
          summary.firstFailingMigration = summary.migrationFailed ? files[summary.migrations] : null;
          if (summary.migrationFailed) console.error(`First failing migration: ${summary.firstFailingMigration}`);
          if (!migrationError && JSON.stringify(applied.rows.map(row => row.version)) !== JSON.stringify(versions)) throw new Error('Applied migration stamps do not match the complete source inventory');
        }
      }
      console.log(`Fresh migration replay: ${versions.length} files`);
      summary.currentMigration = null;
    } finally { await db.end(); }
    if (shard) {
      const databasePin = pins.find(pin => pin.role === 'database');
      local.writePsqlWrapper(bin, `public.ecr.aws/${databasePin.image}@${databasePin.digest}`);
      const testEnv = shardEnvironment(env, local.loadBackendLocalPgtapEnv(), project, config.dbPort, selected);
      diskFloor(dockerRoot);
      summary.pgtap = 'running';
      await timed(`pgtap:${shard}`, () => checked(process.execPath, ['scripts/ci-hosted/pgtap.cjs'], testEnv, 18 * 60000));
      const rows = JSON.parse(fs.readFileSync('ci-reports/pgtap-files.json', 'utf8'));
      if (JSON.stringify(rows.map(row => row.file)) !== JSON.stringify(selected) || rows.some(row => row.status !== 'passed')) throw new Error('Incomplete pgTAP shard results');
      summary.pgtap = 'passed';
      summary.ok = true;
    } else {
      diagnostic.stage = 'backend-lint';
      await backendLint(summary, local.loadBackendLocalPreSuiteCommands(), lint => checked('npm', ['run', lint.script], {
        ...env, ...lint.env, ENV_FILE: os.devNull, ENV_FILE_APPEND: '0', ENV_FILE_OVERRIDE: '0', MIGRATION_FIXTURE_GUARD_MODE: 'full',
      }, lint.timeout_ms));
      summary.pgtap = 'DEFERRED_TO_SHARDS';
      summary.ok = summary.lint.ok;
    }
    console.log(summary.integration);
    diagnostic.stage = 'complete';
  } catch (error) {
    if (summary.pgtap === 'running') summary.pgtap = 'failed';
    if (guard && fs.existsSync(guard.policyFile)) diagnostic.imagePolicy = { ...diagnostic.imagePolicy, ...JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')) };
    saveFailure(diagnostic, error, environmentSecrets(env)); // Persist before stack teardown and temporary-file removal.
    if (started && diagnostic.stage === 'stack-start') {
      diagnostic.startupDiagnostics = await stage(summary, 'stack-diagnostics', () => collectStackDiagnostics({
        project, env, dockerRoot, imagePolicy: diagnostic.imagePolicy, logFile: `ci-reports/${reportName}.log`,
      })).catch(diagnosticError => ({ error: sanitize(diagnosticError.message) }));
      saveFailure(diagnostic, error, environmentSecrets(env));
    }
    throw error;
  } finally {
    if (started) {
      try { await timed('stack-stop', () => checked(cli, ['stop', '--workdir', temp, '--no-backup'], cliEnv, 120000)); }
      catch (error) {
        summary.ok = false; process.exitCode = 1; console.error('Local stack teardown failed');
        summary.teardownFailure = { message: sanitize(error.message), ...error.failure };
        if (!diagnostic.failure) {
          diagnostic.stage = 'teardown';
          saveFailure(diagnostic, error, environmentSecrets(env));
        }
      }
    }
    if (guard) {
      summary.imagePolicy = JSON.parse(fs.readFileSync(guard.policyFile, 'utf8'));
      guard.child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { guard.child.kill('SIGKILL'); resolve(); }, 3000);
        guard.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync('ci-reports', { recursive: true });
    summary.failure = diagnostic.failure;
    if (shard) Object.assign(summary, shardResults(selected, fs.existsSync('ci-reports/pgtap-files.json')
      ? JSON.parse(fs.readFileSync('ci-reports/pgtap-files.json', 'utf8')) : []));
    writeReport(`ci-reports/${reportName}.json`, summary);
  }
}
function saveFailure(diagnostic, error, secrets) {
  if (diagnostic.stage === 'image-preflight') diagnostic.imagePolicy = { decision: 'denied', reason: sanitize(error.message, secrets) };
  diagnostic.failure = { message: sanitize(error.message, secrets), exitCode: null, signal: null, timeout: false, errorCode: error.code || null, ...error.failure };
  fs.mkdirSync('ci-reports', { recursive: true });
  fs.writeFileSync(`ci-reports/${process.env.PGTAP_SHARD ? 'pgtap' : 'backend'}-diagnostic.json`, `${JSON.stringify(diagnostic, null, 2)}\n`);
}
async function main() {
  const diagnostic = { sha: process.env.GITHUB_SHA || 'unknown', stage: 'image-preflight', imagePolicy: { decision: 'not_evaluated' } };
  try { await qualify(diagnostic); }
  catch (error) {
    if (!diagnostic.failure) saveFailure(diagnostic, error);
    throw error;
  }
}
if (require.main === module) main().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
module.exports = { bucketSections, migrationInventory, imagePreflight, completePins, mainSwitch, imageGuard, migrationProgress, diskFloor, backendLint };
