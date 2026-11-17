'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, retry, stage, writeReport } = require('./process.cjs');
const { completePins, imageGuard } = require('./backend.cjs');
const { sanitize } = require('./diagnostics.cjs');

function shardFiles(files, value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value || '');
  if (!match || +match[1] > +match[2] || +match[2] > 64) throw new Error('Invalid pgTAP shard');
  const names = files.filter(file => file.endsWith('.sql')).sort();
  if (!names.length || new Set(names).size !== names.length || names.some(file => !/^[a-zA-Z0-9_.-]+\.sql$/.test(file))) throw new Error('Missing or malformed pgTAP inventory');
  const selected = names.filter((_, index) => index % +match[2] === +match[1] - 1);
  if (!selected.length) throw new Error('Empty pgTAP shard');
  return selected;
}

function validateSnapshot(snapshot, pins, sha, directory) {
  const pin = pins.find(row => row.role === 'database');
  const image = `public.ecr.aws/${pin.image}@${pin.digest}`;
  if (snapshot.sha !== sha || snapshot.image !== image) throw new Error('Snapshot candidate/image mismatch');
  for (const file of ['database.dump', 'roles.sql']) {
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') !== snapshot.files?.[file]) throw new Error(`Snapshot checksum mismatch: ${file}`);
  }
  return image;
}

async function tests() {
  const runner = require('../tests/run-pgtap-cloud.js');
  const local = require('../ops/ci/cloud-pool-db-local-pgtap.js');
  const rows = [];
  await local.runFullPgtap({ projectId: process.env.DB_LOCAL_PROJECT_ID, dbPort: process.env.DB_LOCAL_DB_PORT,
    runSuite: (candidates, full, env) => runner.runSuite(candidates, full, env, {
      async recordCaseResults(_suite, results) {
        rows.push(...results.map(row => ({ file: row.case_key, status: row.status, durationMs: row.duration_ms, error: sanitize(row.error_summary) })));
        fs.writeFileSync('ci-reports/pgtap-files.json', JSON.stringify(rows, null, 2));
      }, async close() {},
    }),
  });
}

async function main() {
  const shard = process.env.PGTAP_SHARD;
  const selected = shardFiles(fs.readdirSync('supabase/tests/pgtap'), shard);
  const skipFile = 'supabase/tests/pgtap/.pgtap-skip.json';
  if (fs.existsSync(skipFile)) {
    const skip = JSON.parse(fs.readFileSync(skipFile, 'utf8'));
    if (!Array.isArray(skip) || skip.length) throw new Error('pgTAP shards cannot use a malformed/nonempty skip list');
  }
  const pins = JSON.parse(fs.readFileSync('config/ci/hosted-supabase-images.json', 'utf8'));
  if (!completePins(pins)) throw new Error('Complete reviewed image digests are required');
  const snapshotDir = path.resolve('ci-reports/database-snapshot');
  const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8'));
  const image = validateSnapshot(snapshot, pins, process.env.GITHUB_SHA, snapshotDir);
  const local = require('../ops/ci/cloud-pool-db-local.js');
  const config = local.readSupabaseConfig();
  local.assertLoopbackOnly(process.env, 'pgTAP shard');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtap-shard-'));
  const project = `pgtap-${crypto.randomBytes(8).toString('hex')}`;
  const container = `supabase_db_${project}`;
  const env = { ...process.env, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0',
    QA_RUN_ID: '', WORKSPACE_NAME: project, DB_LOCAL_PROJECT_ID: project, DB_LOCAL_DB_PORT: String(config.dbPort),
    PGTAP_FULL_LOCAL_QUALIFICATION: '1', PGTAP_ONLY_FILES: selected.join(','), PGTAP_TEST_FILES: '',
    PGTAP_NODE_FILE_RETRIES: '0', PGTAP_RETRY_TRANSIENT: '0', PGTAP_RETRY_DEADLOCKS: '0',
    PGTAP_NODE_FILE_MAX_WAIT_MS: '0', PGTAP_FILES_PER_SESSION: '1',
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${config.dbPort}/postgres`,
    DATABASE_URL_DIRECT: `postgresql://postgres@127.0.0.1:${config.dbPort}/postgres`,
    PATH: `${temp}${path.delimiter}${process.env.PATH}` };
  const report = { sha: process.env.GITHUB_SHA, shard, stages: [], selected, files: [], ok: false };
  let guard; let started = false;
  const checked = (command, args, commandEnv = env, timeout) => run(command, args, { env: commandEnv, timeout, logFile: 'ci-reports/pgtap.log' });
  try {
    await stage(report, 'image-pull:database', () => retry('image-pull:database', () => checked('docker', ['pull', '--platform', 'linux/amd64', image], env, 5 * 60000)));
    const pin = { ...pins.find(row => row.role === 'database') };
    pin.runtimeId = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { env, quiet: true })).trim();
    guard = await imageGuard([pin], path.join(temp, 'pins.json'), env);
    const settings = Object.entries(snapshot.settings).flatMap(([name, value]) => ['-c', `${name}=${value}`]);
    await stage(report, 'stack-start:database-only', async () => {
      started = true;
      await checked('docker', ['run', '-d', '--pull=never', '--name', container,
        '-e', 'POSTGRES_USER=ci_snapshot_restore', '-e', 'POSTGRES_DB=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
        '--tmpfs', '/docker-entrypoint-initdb.d', '-v', `${snapshotDir}:/snapshot:ro`,
        '-p', `127.0.0.1:${config.dbPort}:5432`, image, 'postgres', '-D', '/etc/postgresql',
        '-c', 'hba_file=/var/lib/postgresql/data/pg_hba.conf', ...settings], guard.env);
      await checked('docker', ['exec', container, 'sh', '-ec',
        'for i in $(seq 1 90); do pg_isready -h 127.0.0.1 -U ci_snapshot_restore -d postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'], guard.env, 100000);
    });
    await stage(report, 'database-restore', async () => {
      await checked('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'ci_snapshot_restore', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '/snapshot/roles.sql'], guard.env);
      // Force disconnect extension workers before replacing the bootstrap database.
      await checked('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'ci_snapshot_restore', '-d', 'template1', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE postgres WITH (FORCE)'], guard.env);
      await checked('docker', ['exec', container, 'pg_restore', '-h', '127.0.0.1', '-U', 'ci_snapshot_restore', '-d', 'template1', '--create', '--exit-on-error', '/snapshot/database.dump'], guard.env);
      const count = (await run('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-Atc', 'select count(*) from supabase_migrations.schema_migrations'], { env: guard.env, quiet: true })).trim();
      if (+count !== snapshot.migrations) throw new Error('Restored migration history differs from the built database');
    });
    // Use psql from the running pinned image; translate only its loopback port for docker exec.
    fs.writeFileSync(path.join(temp, 'psql'), `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2).map(value=>value.replace('127.0.0.1:${config.dbPort}/','127.0.0.1:5432/'));\nconst result=spawnSync('docker',['exec','-i','${container}','psql',...args],{stdio:'inherit'});\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
    await stage(report, `pgtap:${shard}`, () => checked(process.execPath, [__filename, 'tests'], env, 18 * 60000));
    const rows = JSON.parse(fs.readFileSync('ci-reports/pgtap-files.json', 'utf8'));
    if (JSON.stringify(rows.map(row => row.file)) !== JSON.stringify(selected) || rows.some(row => row.status !== 'passed')) throw new Error('Incomplete pgTAP shard results');
    report.ok = true;
  } catch (error) {
    report.failure = { message: sanitize(error.message), ...error.failure };
    if (started) await checked('docker', ['logs', container]).catch(() => {});
    throw error;
  } finally {
    if (fs.existsSync('ci-reports/pgtap-files.json')) report.files = JSON.parse(fs.readFileSync('ci-reports/pgtap-files.json', 'utf8'));
    report.run = report.files.length;
    report.passed = report.files.filter(row => row.status === 'passed').length;
    report.failed = report.files.filter(row => row.status === 'failed').length;
    report.notRun = selected.filter(file => !report.files.some(row => row.file === file));
    if (started) {
      try { await checked('docker', ['rm', '-fv', container]); }
      catch (error) { report.ok = false; report.failure ||= { message: sanitize(error.message), ...error.failure }; process.exitCode = 1; }
    }
    if (guard) { guard.child.kill('SIGKILL'); report.imagePolicy = JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')); }
    fs.rmSync(temp, { recursive: true, force: true });
    writeReport('ci-reports/pgtap.json', report);
  }
}
if (require.main === module) (process.argv[2] === 'tests' ? tests() : main()).catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
module.exports = { shardFiles, validateSnapshot };
