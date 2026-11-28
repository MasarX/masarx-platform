'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { fork } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { targetFile, git } = require('./target-policy.cjs');
const { sanitize, environmentSecrets } = require('./diagnostics.cjs');
const { run, stage, writeReport } = require('./process.cjs');
const { captureDatabaseLog, collectStackDiagnostics, isHostedPgtap, needsHostedDatabaseInit } = require('./stack-diagnostics.cjs');
const { shardFiles, shardEnvironment, shardResults, hostedBatches } = require('./pgtap.cjs');
const { integrationEdgeEnvironment, integrationFunctionConfig, integrationShardFiles, integrationCoverage,
  exceptionFile, restoreIntegrationDatabase, runIntegration } = require('./integration.cjs');
const { isJwtSignedWithSecret } = require('../ops/workspace/edge-db-jwt.js');

const { prepareImages } = require('./images.cjs');
const { install } = require('./tasks.cjs');
const { buildSupabaseCliAsset } = require('../ops/ci/supabase-cli-asset.js');

const root = process.cwd();
const HOSTED_PORT_MIN = 15420;
const HOSTED_PORT_MAX = 15431;
const CLONE_COMMAND_TIMEOUT = 15000;
const bucketSections = text => text.split(/(?=^\[)/m).filter(section => section.startsWith('[storage.buckets.')).join('\n');
function canBindPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '0.0.0.0', () => server.close(error => error ? reject(error) : resolve(true)));
  });
}
async function hostedStackPorts(probe = canBindPort, withMail = false) {
  // Keep Docker's published ports away from the default Linux ephemeral range.
  const ports = [];
  for (let port = HOSTED_PORT_MIN; port <= HOSTED_PORT_MAX; port++) {
    if (await probe(port)) ports.push(port);
    if (ports.length === (withMail ? 4 : 3)) {
      const [shadowPort, apiPort, dbPort, mailPort] = ports;
      return { shadowPort, apiPort, dbPort, ...(withMail ? { mailPort } : {}) };
    }
  }
  throw new Error(`Could not find ${withMail ? 'four' : 'three'} free hosted Supabase ports in ${HOSTED_PORT_MIN}-${HOSTED_PORT_MAX}`);
}
async function installHostedCli(checked, env, temp, bin) {
  const asset = buildSupabaseCliAsset({ version: '2.116.0', platform: 'linux', arch: 'amd64' });
  if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '')) throw new Error('PIN_NEEDED: Supabase CLI archive checksum');
  const response = await fetch(asset.download_url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Supabase CLI public asset download failed');
  const archive = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(archive).digest('hex') !== asset.sha256) throw new Error('Supabase CLI checksum mismatch');
  const archivePath = path.join(temp, 'cli.tar.gz');
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  await checked('tar', ['-xzf', archivePath, '-C', bin, 'supabase'], env);
  return asset.sha256;
}
function writeHostedStackConfig(workdir, project, { shadowPort, apiPort, dbPort }, major, auth, seed = false) {
  const sb = path.join(workdir, 'supabase');
  fs.mkdirSync(path.join(sb, 'migrations'), { recursive: true });
  const config = [
    `project_id = "${project}"`, '[api]', 'enabled = true', `port = ${apiPort}`, 'schemas = ["api"]',
    'extra_search_path = ["public", "extensions"]', '[db]', `port = ${dbPort}`,
    `shadow_port = ${shadowPort}`, `major_version = ${major}`, '[db.seed]', `enabled = ${seed}`,
    '[studio]', 'enabled = false', '[analytics]', 'enabled = false', '[auth]', 'enabled = true',
    ...auth, '[storage]', 'enabled = true', '', bucketSections(fs.readFileSync('supabase/config.toml', 'utf8')),
  ].join('\n');
  fs.writeFileSync(path.join(sb, 'config.toml'), config, { mode: 0o600 });
  return config;
}
async function disableHostedAutovacuum(databaseUrl, dbPort, admin, db, wait = delay) {
  const target = new URL(databaseUrl);
  const port = Number(target.port);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost'].includes(target.hostname)
    || port < HOSTED_PORT_MIN || port > HOSTED_PORT_MAX || port !== dbPort
    || ['host', 'hostaddr', 'service', 'servicefile'].some(key => target.searchParams.has(key))) {
    throw new Error('Autovacuum setup requires the disposable CI loopback database on its allocated port');
  }
  const reloaded = await admin("ALTER SYSTEM SET autovacuum = 'off'", 'SELECT pg_reload_conf()');
  if (reloaded.trim() !== 't') throw new Error('Could not reload autovacuum configuration for the disposable CI database');
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await db.query('SHOW autovacuum');
    if (result.rows[0]?.autovacuum === 'off') return 'off';
    if (attempt < 19) await wait(250);
  }
  throw new Error('Disposable CI database did not report autovacuum=off before migration replay');
}
async function waitForCronPause(db, wait = delay) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await db.query("SELECT setting, context FROM pg_settings WHERE name = 'cron.launch_active_jobs'");
    const setting = result.rows[0];
    if (setting?.context !== 'sighup') throw new Error('Missing reloadable pg_cron launch control');
    if (setting.setting === 'off') return;
    if (attempt < 19) await wait(250);
  }
  throw new Error('pg_cron did not acknowledge the launch pause');
}

// Worker clones can spend seconds pre-zeroing each new WAL segment on a slow disk; the shard's database is discarded with its job.
async function disableHostedWalInitZero(admin) {
  if ((await admin('ALTER SYSTEM SET wal_init_zero = off', 'SELECT pg_reload_conf()')).trim() !== 't') {
    throw new Error('Could not reload WAL segment setup for the disposable CI database');
  }
}

async function configureHostedDatabase(admin, db, disposableShard) {
  const commands = ["ALTER SYSTEM SET cron.launch_active_jobs = 'off'"];
  if (disposableShard) {
    commands.push(
      'ALTER SYSTEM SET log_connections = on',
      'ALTER SYSTEM SET log_disconnections = on',
      "ALTER SYSTEM SET log_line_prefix = '%h %m [%p] %b %qapp=%a user=%u db=%d '",
    );
  }
  // Each ALTER SYSTEM needs its own psql -c to stay outside a transaction block.
  const reloaded = await admin(...commands, 'SELECT pg_reload_conf()');
  if (reloaded.trim() !== 't') throw new Error('Could not reload the disposable CI database configuration');
  await waitForCronPause(db);
}

async function reloadHostedCloneLogging(admin, command, level) {
  if ((await admin(command, 'SELECT pg_reload_conf()')).trim() !== 't') {
    throw new Error('Could not reload Postgres clone logging');
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await admin('SHOW log_min_messages')).trim() === level) return;
    if (attempt < 19) await delay(250);
  }
  throw new Error(`Postgres clone logging did not reach ${level}`);
}

// A backend can exit on its own between the scan and its signal, so count what is left instead of trusting each signal.
const releasePostgres = "DO $$BEGIN PERFORM pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = 'postgres'; END$$";
const postgresConnections = "SELECT count(*) FROM pg_stat_activity WHERE datname = 'postgres'";

async function releasePostgresConnections(admin, message) {
  if ((await admin(releasePostgres, postgresConnections)).trim() !== '0') throw new Error(message);
}

async function cloneHostedDatabases(admin, databases, created, restore = admin) {
  if (!databases.length) return;
  const { owner, limit, explicitAcl } = JSON.parse(await admin(`SELECT json_build_object(
    'owner', quote_ident(pg_get_userbyid(datdba)), 'limit', datconnlimit, 'explicitAcl', datacl IS NOT NULL)
    FROM pg_database WHERE datname = 'postgres'`));
  try {
    await admin('ALTER DATABASE postgres ALLOW_CONNECTIONS false');
    await releasePostgresConnections(admin, 'Could not release connections to the migrated template');
    for (const database of databases) {
      // Avoid the forced checkpoints that can exhaust the clone deadline.
      await admin(`CREATE DATABASE ${database} TEMPLATE postgres STRATEGY WAL_LOG OWNER ${owner} CONNECTION LIMIT ${limit}`);
      created.push(database);
      if (explicitAcl) {
        const grants = JSON.parse(await admin(`SELECT coalesce(json_agg(format('GRANT %s ON DATABASE %I TO %s%s',
          privilege_type, '${database}', CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grantee)) END,
          CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)), '[]')
          FROM pg_database CROSS JOIN LATERAL aclexplode(datacl) WHERE datname = 'postgres'`));
        await admin(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC, ${owner}`, ...grants);
      }
      const settings = JSON.parse(await admin(`SELECT coalesce(json_agg(json_build_array(
        format('SELECT set_config(%L, %L, false)', split_part(setting, '=', 1), substr(setting, strpos(setting, '=') + 1)),
        CASE WHEN setrole = 0 THEN format('ALTER DATABASE %I SET %I FROM CURRENT', '${database}', split_part(setting, '=', 1))
        ELSE format('ALTER ROLE %I IN DATABASE %I SET %I FROM CURRENT', pg_get_userbyid(setrole), '${database}',
          split_part(setting, '=', 1)) END)), '[]')
        FROM pg_db_role_setting CROSS JOIN LATERAL unnest(setconfig) AS setting
        WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = 'postgres')`));
      if (settings.length) await admin(...settings.flat());
    }
  } finally {
    await restore('ALTER DATABASE postgres ALLOW_CONNECTIONS true');
  }
}

function timeHostedCloneCommand(summary, admin, ...commands) {
  const clone = /^CREATE DATABASE (pgtap_worker_\d+) TEMPLATE /.exec(commands[0]);
  if (!clone) return admin(...commands);
  return stage(summary, `database-clone:${clone[1]}`, () => admin(...commands));
}

function dropHostedDatabases(summary, admin, databases) {
  return stage(summary, 'database-clone-cleanup', async () => {
    // Each drop gets its own stage, so a slow drop is visible by name inside the combined cleanup.
    for (const database of databases) {
      await stage(summary, `database-clone-drop:${database}`, () => admin(`DROP DATABASE ${database} WITH (FORCE)`));
    }
  });
}

async function withHostedCloneIsolation(admin, restore, clone) {
  const { rolconnlimit, rolsuper, logLevel, restoreLogging } = JSON.parse(await admin(`SELECT json_build_object(
    'rolconnlimit', rolconnlimit, 'rolsuper', rolsuper, 'logLevel', setting,
    'restoreLogging', CASE WHEN sourcefile = current_setting('data_directory') || '/postgresql.auto.conf'
      THEN format('ALTER SYSTEM SET log_min_messages = %L', setting) ELSE 'ALTER SYSTEM RESET log_min_messages' END)
    FROM pg_roles CROSS JOIN pg_settings WHERE rolname = 'postgres' AND name = 'log_min_messages'`));
  if (rolsuper) throw new Error('Cannot isolate the hosted pgTAP clone: the postgres role is a superuser');
  if (!Number.isInteger(rolconnlimit) || rolsuper !== false) throw new Error('Missing pre-clone postgres role settings');
  const errors = [];
  const attemptRestore = async step => {
    try { await step(); } catch (error) { errors.push(error); }
  };
  let cloneError;
  let loggingChanged = false;
  try {
    // Reject the Docker health probe before it can block on the template database lock.
    await admin('ALTER ROLE postgres CONNECTION LIMIT 0');
    // DEBUG2 records postmaster forks by PID.
    loggingChanged = true;
    await reloadHostedCloneLogging(admin, "ALTER SYSTEM SET log_min_messages = 'debug2'", 'debug2');
    // Retain any template reopen error without overriding the original clone error.
    await clone(command => attemptRestore(() => restore(command)));
  } catch (error) {
    cloneError = error;
    throw error;
  } finally {
    await attemptRestore(async () => {
      const restoredLimit = await restore(`ALTER ROLE postgres CONNECTION LIMIT ${rolconnlimit}`,
        "SELECT rolconnlimit FROM pg_roles WHERE rolname = 'postgres'");
      if (restoredLimit.trim() !== String(rolconnlimit)) throw new Error('Postgres did not restore the postgres role connection limit');
    });
    if (loggingChanged) await attemptRestore(() => reloadHostedCloneLogging(restore, restoreLogging, logLevel));
    if (errors.length) {
      const restoreError = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Postgres clone restoration failed');
      if (!cloneError) throw restoreError;
      cloneError.restoreError = restoreError;
    }
  }
}

async function withHostedCloneServices({ checked, env, project, summary, remaining = () => CLONE_COMMAND_TIMEOUT }, clone) {
  const cloneBudget = () => Math.min(CLONE_COMMAND_TIMEOUT, remaining());
  const services = (await checked('docker', ['ps', '--filter', `label=com.supabase.cli.project=${project}`, '--format', '{{.Names}}'],
    env, cloneBudget(), { quiet: true })).trim().split(/\s+/).filter(name => name && name !== `supabase_db_${project}`)
    .map(container => {
      const service = container.slice(0, -(project.length + 1));
      if (container !== `${service}_${project}` || !/^supabase_[a-z0-9_]+$/.test(service)) {
        throw new Error('Unexpected auxiliary container name in hosted clone window');
      }
      return { container, service };
    });
  if (!services.length) return clone();

  async function changeServices(step, options, timeout) {
    const results = await Promise.allSettled(services.map(({ container, service }) =>
      stage(summary, `database-clone-${step}:${service}`, async () => {
        try {
          await checked('docker', [step, ...options, container], env, timeout, { quiet: true, printQuietFailure: false });
        } catch (error) {
          const timedOut = Boolean(error.failure?.timeout);
          const failure = new Error(`Docker ${step} ${timedOut ? 'timed out' : 'failed'} for ${service}`);
          failure.failure = { timeout: timedOut };
          throw failure;
        }
      })));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      const error = new Error(failures.map(failure => failure.message).join('; '));
      error.failure = { timeout: failures.some(failure => failure.failure.timeout) };
      throw error;
    }
  }

  // The job tears down its disposable stack on a failed stop. Starting then could race a pending stop.
  await changeServices('stop', ['--time', '1'], cloneBudget());
  let cloneError;
  try {
    return await clone();
  } catch (error) {
    cloneError = error;
    throw error;
  } finally {
    try { await changeServices('start', [], CLONE_COMMAND_TIMEOUT); }
    catch (error) {
      if (!cloneError) throw error;
      console.error(error.message);
    }
  }
}

const integrationSnapshot = 'integration_pristine';

async function snapshotIntegrationDatabase({ checked, env, admin, dockerRoot, project, summary }) {
  const size = Number((await admin("SELECT pg_database_size('postgres')")).trim());
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Could not measure the pristine integration database');
  diskFloor(dockerRoot, size);
  await withHostedCloneServices({ checked, env, project, summary }, () =>
    withHostedCloneIsolation(admin, admin, restore =>
      cloneHostedDatabases(admin, [integrationSnapshot], [], restore)));
  return (await admin(`SELECT oid FROM pg_database WHERE datname = '${integrationSnapshot}'`)).trim();
}

async function activateIntegrationDatabase(admin, expectedOid) {
  if (!/^[1-9]\d*$/.test(expectedOid)) throw new Error('Missing pristine integration database identity');
  await admin('ALTER DATABASE postgres ALLOW_CONNECTIONS false');
  await releasePostgresConnections(admin, 'Could not release pgTAP database connections');
  // Keep the local services' normal database name and switch both names atomically.
  await admin(`ALTER DATABASE postgres RENAME TO pgtap_completed;
    ALTER DATABASE ${integrationSnapshot} RENAME TO postgres`);
  const actualOid = (await admin("SELECT oid FROM pg_database WHERE datname = 'postgres'")).trim();
  if (actualOid !== expectedOid) throw new Error('The integration database does not match the pristine snapshot');
}

function availableMemory() {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  if (!match) throw new Error('Hosted runner did not report MemAvailable');
  return Number(match[1]) * 1024;
}

// On the standard 16 GB runner, reserve 2 GiB for the OS, Docker and the
// running database stack, then budget another 512 MiB of headroom per worker.
// This is a conservative admission budget; the sampled minimum validates it in CI.
const PGTAP_MEMORY_FLOOR = 2 * 2 ** 30;
const PGTAP_WORKER_HEADROOM = 512 * 2 ** 20;
const PGTAP_WORKER_CAP = 4;
const PGTAP_TIMEOUT = 18 * 60000;
const DATABASE_JOB_TIMEOUT = 20 * 60000;
const LOG_CAPTURE_MARGIN = 120000;

function pgtapDeadline(shardStartedAt, jobStartedAt) {
  const shardDeadline = shardStartedAt + PGTAP_TIMEOUT;
  const jobStartedAtMs = Number(jobStartedAt) * 1000;
  if (!Number.isSafeInteger(jobStartedAtMs) || jobStartedAtMs <= 0) return shardDeadline;
  return Math.min(shardDeadline, jobStartedAtMs + DATABASE_JOB_TIMEOUT - LOG_CAPTURE_MARGIN);
}

function hostedWorkerLimit(value, cores) {
  if (value === 'nproc') return Math.min(cores, PGTAP_WORKER_CAP);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid PGTAP_WORKERS; use nproc or a positive integer');
  return Math.min(cores, PGTAP_WORKER_CAP, Number(value));
}

function hostedWorkerCount(requested, available) {
  const fit = Math.min(requested, Math.max(0, Math.floor((available - PGTAP_MEMORY_FLOOR) / PGTAP_WORKER_HEADROOM)));
  if (requested && !fit) {
    throw new Error(`insufficient memory for ${requested} workers: ${available} bytes available; at least ${PGTAP_MEMORY_FLOOR + PGTAP_WORKER_HEADROOM} required for one`);
  }
  return fit;
}

async function runHostedShard({ selected, checked, testEnv, admin, summary, dockerRoot, project, logFile, remaining }) {
  const runSerial = () => checked(process.execPath, ['scripts/ci-hosted/pgtap.cjs'], testEnv, remaining());
  const cores = Number((await checked('nproc', [], testEnv, Math.min(15000, remaining()), { quiet: true })).trim());
  if (!Number.isSafeInteger(cores) || cores < 1) throw new Error('Invalid hosted runner core count');
  const requested = hostedWorkerLimit(testEnv.PGTAP_WORKERS, cores);
  if (requested === 1) return runSerial();
  let minAvailableBytes = availableMemory();
  const count = hostedWorkerCount(requested, minAvailableBytes);
  if (count === 1) return runSerial();
  const { setup, serial, workers } = hostedBatches(selected, count);
  if (workers.length < 2) return runSerial();
  const databases = workers.slice(1).map((_, index) => `pgtap_worker_${index + 1}`);
  console.log(`pgTAP chose ${workers.length} workers from ${requested} requested on ${cores} cores with ${minAvailableBytes} bytes available`);
  const groups = [];
  const created = [];
  const report = 'ci-reports/pgtap-files.json';
  const execute = async (group, files, database = 'postgres', prepareOnly = false) => {
    if (!files.length) return;
    const groupReport = `ci-reports/pgtap-${group}.json`;
    const groupLog = `ci-reports/pgtap-${group}.log`;
    fs.rmSync(groupReport, { force: true });
    fs.writeFileSync(groupLog, '');
    groups.push({ group, files: prepareOnly ? [] : files, groupReport, groupLog });
    const url = new URL(testEnv.DATABASE_URL);
    url.pathname = `/${database}`;
    const dsn = url.href;
    await checked(process.execPath, ['scripts/ci-hosted/pgtap.cjs'], {
      ...testEnv, DATABASE_URL: dsn, DATABASE_URL_DIRECT: dsn, DATABASE_URL_POOLER: '', PG_CONN_STRING: '',
      PGTAP_HOSTED_GROUP: group, PGTAP_HOSTED_PREPARE_ONLY: prepareOnly ? '1' : '0',
      PGTAP_ONLY_FILES: files.join(','),
    }, remaining(), { logFile: groupLog });
  };
  fs.rmSync(report, { force: true });
  const memory = setInterval(() => { minAvailableBytes = Math.min(minAvailableBytes, availableMemory()); }, 1000);
  try {
    const [setupResult] = await Promise.allSettled([execute('setup', setup.length ? setup : selected.slice(0, 1), 'postgres', !setup.length)]);
    if (setupResult.status === 'rejected' && !fs.existsSync('ci-reports/pgtap-setup.json')) throw setupResult.reason;
    const boundedAdmin = (...commands) => admin(Math.min(CLONE_COMMAND_TIMEOUT, remaining()), ...commands);
    const cloneAdmin = (...commands) => timeHostedCloneCommand(summary, boundedAdmin, ...commands);
    const migratedDatabaseBytes = Number((await cloneAdmin("SELECT pg_database_size('postgres')")).trim());
    if (!Number.isSafeInteger(migratedDatabaseBytes) || migratedDatabaseBytes < 1) throw new Error('Could not measure migrated database size');
    summary.migratedDatabaseBytes = migratedDatabaseBytes;
    console.log(`Migrated database size: ${migratedDatabaseBytes} bytes`);
    diskFloor(dockerRoot, databases.length * migratedDatabaseBytes);
    const restoreAdmin = (...commands) => admin(CLONE_COMMAND_TIMEOUT, ...commands);
    let results;
    try {
      await withHostedCloneServices({ checked, env: testEnv, project, summary, remaining }, async () => {
        await withHostedCloneIsolation(cloneAdmin, restoreAdmin, async restoreTemplate => {
          await cloneHostedDatabases(cloneAdmin, databases, created, restoreTemplate);
        });
      });
      diskFloor(dockerRoot);
      results = await Promise.allSettled(workers.map((files, index) => execute(`worker-${index}`, files, index === 0 ? 'postgres' : databases[index - 1])));
    } finally {
      if (created.length) await dropHostedDatabases(summary, boundedAdmin, created);
    }
    // Shared state and database catalog assertions see only the canonical database and no concurrent tests.
    const [serialResult] = await Promise.allSettled([execute('worker-0-serial', serial)]);
    const failures = [setupResult, ...results, serialResult].filter(result => result.status === 'rejected');
    if (failures.length) throw failures[0].reason;
  } finally {
    clearInterval(memory);
    minAvailableBytes = Math.min(minAvailableBytes, availableMemory());
    summary.workerMemory = { cores, workers: workers.length, totalBytes: os.totalmem(), minAvailableBytes, floorBytes: PGTAP_MEMORY_FLOOR };
    console.log(`pgTAP worker memory: ${JSON.stringify(summary.workerMemory)}`);
    const rows = groups.flatMap(({ group, files, groupReport, groupLog }) => {
      fs.appendFileSync(logFile, fs.readFileSync(groupLog));
      const actual = fs.existsSync(groupReport) ? JSON.parse(fs.readFileSync(groupReport, 'utf8')) : [];
      if (actual.some((row, index) => row?.file !== files[index])) throw new Error(`Unexpected pgTAP file in ${group}`);
      console.log(`pgTAP ${group}: ${actual.length}/${files.length} files executed: ${actual.map(row => row.file).join(', ')}`);
      return actual;
    });
    const order = new Map(selected.map((file, index) => [file, index]));
    fs.writeFileSync(report, JSON.stringify(rows.sort((a, b) => order.get(a.file) - order.get(b.file)), null, 2));
    fs.writeFileSync('ci-reports/pgtap-timings.json', JSON.stringify({
      measuredDateUtc: new Date().toISOString().slice(0, 10), runCount: 1,
      seconds: Object.fromEntries(rows.map(row => [row.file, row.durationMs / 1000])),
    }, null, 2));
    console.log(`pgTAP shard: ${rows.length}/${selected.length} files executed`);
  }
  if (minAvailableBytes < PGTAP_MEMORY_FLOOR) throw new Error(`pgTAP OOM risk: available memory fell to ${minAvailableBytes} bytes below the ${PGTAP_MEMORY_FLOOR}-byte floor`);
}
async function recordMigrationDeadlock(error, db, readLogs, diagnostic) {
  const output = error.failure?.output || '';
  if (!output.includes('(SQLSTATE 40P01)')) return;
  const pids = [...output.matchAll(/Process (\d+) waits for/g)].map(match => Number(match[1]));
  const attribution = diagnostic.migrationDeadlock = { pids };
  try {
    const activity = await db.query('SELECT pid, backend_type, application_name FROM pg_stat_activity WHERE pid = ANY($1::int[])', [pids]);
    attribution.activity = activity.rows;
    const cron = await db.query(`SELECT d.job_pid AS pid, j.jobname, d.status
      FROM cron.job_run_details d LEFT JOIN cron.job j USING (jobid)
      WHERE d.job_pid = ANY($1::int[]) ORDER BY d.runid`, [pids]);
    attribution.cron = cron.rows;
  } catch (readError) { attribution.activityError = sanitize(readError.message); }
  try {
    const logs = await readLogs();
    attribution.postgres = sanitize(logs.split(/\r?\n/).filter(line => pids.some(pid => line.includes(`Process ${pid}:`))).join('\n')).slice(0, 4000);
  } catch (readError) { attribution.logsError = sanitize(readError.message); }
  console.log(`Migration deadlock attribution: ${sanitize(JSON.stringify(attribution))}`);
}
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
function diskFloor(directory, cloneBytes = 0) {
  const stat = fs.statfsSync(directory);
  const free = Number(stat.bavail) * Number(stat.bsize);
  console.log(`Disk free GiB: ${(free / 2 ** 30).toFixed(2)}`);
  const required = 6 * 2 ** 30 + cloneBytes;
  if (free < required) {
    if (cloneBytes) throw new Error(`Insufficient disk for pgTAP clones: ${free} bytes free; ${cloneBytes} bytes for copies plus a 6 GiB reserve required`);
    throw new Error('Less than 6 GiB free; backend qualification blocked');
  }
}
const integrationImages = { postgrest: 'supabase/postgrest', 'edge-runtime': 'supabase/edge-runtime', mailpit: 'supabase/mailpit' };
function completePins(pins, integration = false) {
  const expected = { database: 'supabase/postgres', auth: 'supabase/gotrue', storage: 'supabase/storage-api', gateway: 'supabase/kong', realtime: 'supabase/realtime' };
  if (integration) Object.assign(expected, integrationImages);
  return Array.isArray(pins) && pins.length === Object.keys(expected).length && Object.entries(expected).every(([role, image]) =>
    pins.filter(pin => pin.role === role && pin.image === image && /^[a-zA-Z0-9_.-]+$/.test(pin.tag)
      && /^sha256:[a-f0-9]{64}$/.test(pin.digest) && /^sha256:[a-f0-9]{64}$/.test(pin.image_id)
      && pin.mirror === 'ghcr.io'
      && /^[a-zA-Z0-9_.-]+$/.test(pin.cli_tag)).length === 1);
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
async function imageGuard(pins, file, env, initContainer) {
  const policyFile = `${file}.policy.json`;
  const host = env.DOCKER_HOST || 'unix:///var/run/docker.sock';
  if (!host.startsWith('unix://')) throw new Error('Digest guard requires the hosted Unix Docker socket');
  fs.writeFileSync(file, JSON.stringify(pins), { mode: 0o600 });
  const args = [file, host.slice(7), policyFile];
  if (initContainer) args.push(initContainer);
  const child = fork(path.join(__dirname, 'docker-images.cjs'), args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
async function verifyHostedDatabaseInit(checked, env, container) {
  const pid1 = (await checked('docker', ['exec', container, 'cat', '/proc/1/comm'], env, 10000, { quiet: true })).trim();
  if (pid1 !== 'docker-init') throw new Error('Hosted database requires docker-init as PID 1');
  return pid1;
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
  const nightlyNetwork = process.env.NIGHTLY_DOCKER_NETWORK;
  const disposableShard = isHostedPgtap(process.env);
  if (disposableShard && pinState.qualificationOnly) throw new Error('Hosted pgTAP database init requires the digest-pinned Docker guard');
  const useDatabaseInit = !pinState.qualificationOnly && needsHostedDatabaseInit(process.env);
  if (disposableShard) {
    pins.push(...JSON.parse(fs.readFileSync('config/ci/hosted-integration-images.json', 'utf8')));
    if (!completePins(pins, true)) throw new Error('PIN_NEEDED: hosted integration requires every reviewed service image');
  }
  const workers = process.env.PGTAP_WORKERS || 'nproc';
  if (disposableShard) hostedWorkerLimit(workers, PGTAP_WORKER_CAP);
  const selected = shard ? shardFiles(fs.readdirSync('supabase/tests/pgtap'), shard, { hosted: disposableShard }) : undefined;
  if (shard && fs.existsSync('supabase/tests/pgtap/.pgtap-skip.json')) {
    const skip = JSON.parse(fs.readFileSync('supabase/tests/pgtap/.pgtap-skip.json', 'utf8'));
    if (!Array.isArray(skip) || skip.length) throw new Error('pgTAP shards cannot use a malformed/nonempty skip list');
  }
  const reportName = shard ? 'pgtap' : 'backend';
  diagnostic.stage = 'local-contracts';
  // Reuse the existing loopback, version, client-image and full-pgTAP contracts.
  const local = require('../ops/ci/cloud-pool-db-local.js');
  const { major } = local.readSupabaseConfig();
  const lane = local.loadLaneConfig();
  if (String(major) !== String(lane.psqlClientMajor)) throw new Error('Postgres/psql major mismatch');
  local.assertLoopbackOnly(process.env, 'hosted environment');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-supabase-'));
  fs.chmodSync(temp, 0o700);
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const project = `hosted-${crypto.randomBytes(8).toString('hex')}`;
  const databaseContainer = `supabase_db_${project}`;
  const env = { ...process.env, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0',
    QA_RUN_ID: '', NX_DAEMON: 'false', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const cli = path.join(bin, 'supabase');
  let started = false; let guard; let cliEnv = env; let dockerRoot;
  const summary = { stages: [], sha: process.env.GITHUB_SHA || 'unknown', migrations: 0, pgtap: 'NOT_RUN',
    ...(shard ? { shard, selected, files: [] } : {}),
    integration: disposableShard ? 'NOT_RUN' : 'DEFERRED_TO_HOSTED_SHARDS',
    serviceImagePins: pinState.qualificationOnly ? 'PIN_NEEDED' : 'resolved SHA-256 indices', imageQualificationOnly: pinState.qualificationOnly, ok: false };
  fs.mkdirSync('ci-reports', { recursive: true });
  const logFile = `ci-reports/${reportName}.log`;
  const checked = async (command, args, commandEnv, timeout, options = {}) => {
    const settings = { env: commandEnv, timeout, logFile, ...options };
    if (!nightlyNetwork || command !== cli || args[0] !== 'start') return run(command, args, settings);
    const { checkDockerBindings, checkFixtureNetwork } = require('../ci/nightly-local.cjs');
    checkFixtureNetwork(nightlyNetwork);
    const output = await run(command, ['--network-id', nightlyNetwork, ...args], settings);
    checkDockerBindings(project);
    return output;
  };
  const timed = (name, action) => { diagnostic.stage = name; return stage(summary, name, action); };
  try {
    diagnostic.stage = 'docker-preflight';
    await checked('docker', ['info', '--format', '{{.ServerVersion}}'], env);
    dockerRoot = (await checked('docker', ['info', '--format', '{{.DockerRootDir}}'], env, undefined, { quiet: true })).trim();
    diskFloor(dockerRoot);
    if (!pinState.qualificationOnly && env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) {
      throw new Error('Digest-pinned startup requires the hosted Unix Docker daemon');
    }
    diagnostic.stage = 'prepare-inputs';
    const [dependencies, images] = await Promise.allSettled([
      nightlyNetwork ? undefined : stage(summary, 'npm-install', () =>
        install((command, args) => checked(command, args, env, undefined, { logPrefix: '[npm] ' }))),
      pinState.qualificationOnly ? undefined : stage(summary, 'image-pulls', () => prepareImages(pins, {
        env, checked, timed: (name, action) => stage(summary, name, action), summary, dockerRoot, logFile, checkDisk: () => diskFloor(dockerRoot),
      })),
    ]);
    if (images.status === 'rejected') {
      diagnostic.stage = 'image-pull';
      throw images.reason;
    }
    if (dependencies.status === 'rejected') {
      diagnostic.stage = 'npm-install';
      throw dependencies.reason;
    }
    if (!pinState.qualificationOnly) {
      diskFloor(dockerRoot);
      diagnostic.stage = 'image-guard';
      guard = await imageGuard(pins, path.join(temp, 'runtime-image-pins.json'), env, useDatabaseInit ? databaseContainer : undefined);
      cliEnv = guard.env;
    }
    diagnostic.stage = 'cli-download';
    await installHostedCli(checked, env, temp, bin);
    env.SUPABASE_CLI_BIN = cli;
    // This workdir owns an empty DB. No remote profiles, seed files or cached schema are copied.
    const sb = path.join(temp, 'supabase');
    diagnostic.stage = 'stack-configuration';
    if (disposableShard) {
      await timed('edge-preparation', async () => {
        await checked('npm', ['run', 'edge:sync-shared'], env);
        await checked('npm', ['run', 'edge:prepare-resource-import-exceljs'], env);
        fs.cpSync('supabase/functions', path.join(sb, 'functions'), { recursive: true });
      });
    }
    summary.stackPorts = await hostedStackPorts(canBindPort, disposableShard);
    const { apiPort, dbPort, mailPort } = summary.stackPorts;
    const edge = disposableShard ? integrationEdgeEnvironment(apiPort) : undefined;
    if (edge) {
      Object.assign(env, edge.vars);
      // The Edge worker reaches Kong on the stack network.
      cliEnv = { ...cliEnv, ...edge.vars, EDGE_SUPABASE_URL: 'http://kong:8000',
        SUPABASE_AUTH_JWT_SECRET: edge.jwtSecret };
    }
    writeHostedStackConfig(temp, project, summary.stackPorts, major, [
      'site_url = "http://127.0.0.1:3001"',
      ...(edge ? ['jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"',
        '[edge_runtime]', 'enabled = true', 'policy = "per_worker"', 'deno_version = 2',
        '[edge_runtime.secrets]', ...Object.keys(edge.vars).map(name => `${name} = "env(${name})"`),
        ...integrationFunctionConfig(), '[local_smtp]', 'enabled = true', `port = ${mailPort}`] : []),
    ]);
    const startStack = (name, excludedServices) => {
      const exclude = excludedServices.join(',');
      console.log(`Stack service exclusions: ${exclude}`);
      return timed(name, () => checked(cli, ['start', '--debug', '--workdir', temp, '-x', exclude], cliEnv, 6 * 60000));
    };
    started = true; // A partial start must also be stopped.
    await startStack('stack-start', lane.exclude);
    if (useDatabaseInit) {
      summary.databasePid1 = await timed('database-init', () => verifyHostedDatabaseInit(checked, env, databaseContainer));
    }
    diagnostic.stage = 'stack-status';
    const status = JSON.parse(await checked(cli, ['status', '--workdir', temp, '-o', 'json'], cliEnv, undefined, { quiet: true }));
    if (!status.DB_URL?.trim()) throw new Error('Local stack did not provide DB_URL for DATABASE_URL');
    if (new URL(status.DB_URL).port !== String(dbPort)) throw new Error('Local stack reported an unexpected database port');
    Object.assign(env, { DATABASE_URL: status.DB_URL, DATABASE_URL_DIRECT: status.DB_URL,
      SUPABASE_URL: status.API_URL || '', SUPABASE_ANON_KEY: status.ANON_KEY || '',
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY || '', WORKSPACE_NAME: project });
    local.assertLoopbackOnly(env, 'local stack');
    if (edge) {
      const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
        .filter(name => !env[name].trim());
      if (missing.length) throw new Error(`Local integration stack did not provide ${missing.join(', ')}`);
      if (new URL(env.SUPABASE_URL).port !== String(apiPort)) {
        throw new Error('Local integration stack reported an unexpected SUPABASE_URL port');
      }
      if (!isJwtSignedWithSecret(env.SUPABASE_SERVICE_ROLE_KEY, edge.jwtSecret)) {
        throw new Error('Local integration stack reported a SUPABASE_SERVICE_ROLE_KEY with the wrong signing key');
      }
    }
    diagnostic.stage = 'database-connect';
    const { Client } = require('pg');
    const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 15000, query_timeout: 15000 });
    const stackAdminFor = (database, timeout, ...commands) => checked('docker', ['exec', databaseContainer, 'sh', '-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql "$@"', 'sh', '--host=127.0.0.1', '--username=supabase_admin',
      `--dbname=${database}`, '--no-psqlrc', '--no-password', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
      ...commands.flatMap(command => ['-c', command])], env, timeout, { quiet: true });
    const stackAdmin = (...commands) => stackAdminFor('postgres', 15000, ...commands);
    await db.connect();
    try {
      const history = await db.query("select to_regclass('supabase_migrations.schema_migrations') as history");
      if (history.rows[0].history) {
        const before = await db.query('select count(*)::int as n from supabase_migrations.schema_migrations');
        if (before.rows[0].n !== 0) throw new Error('Database is not empty of application migrations');
      }
      // Disable background ANALYZE before exposing the application migrations to this stack.
      summary.autovacuum = await timed('autovacuum-off', () => disableHostedAutovacuum(status.DB_URL, dbPort, stackAdmin, db));
      // The disposable fixture uses the registered schedules without launching background jobs.
      if (disposableShard) await disableHostedWalInitZero(stackAdmin);
      await timed('cron-pause', () => configureHostedDatabase(stackAdmin, db, disposableShard));
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
      } catch (error) {
        migrationError = error;
        await recordMigrationDeadlock(error, db, () => checked('docker', ['logs', '--tail', '300', databaseContainer], env, 10000,
          { quiet: true, includeStderr: true }), diagnostic);
        throw error;
      }
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
          const replayMs = summary.stages.find(s => s.name === 'migrations').durationMs;
          console.log(`Database setup timing: replay_ms=${replayMs} restore_ms=NOT_RUN`);
          summary.migrationsPerMinute = Number((summary.migrations / ((replayMs || 1) / 60000)).toFixed(2));
          summary.migrationFailed = migrationError && summary.currentMigration && summary.migrations < versions.length ? 1 : 0;
          summary.migrationNotRun = versions.length - summary.migrations - summary.migrationFailed;
          summary.firstFailingMigration = summary.migrationFailed ? files[summary.migrations] : null;
          if (summary.migrationFailed) console.error(`First failing migration: ${summary.firstFailingMigration}`);
          if (!migrationError && JSON.stringify(applied.rows.map(row => row.version)) !== JSON.stringify(versions)) throw new Error('Applied migration stamps do not match the complete source inventory');
        }
      }
      console.log(`Fresh migration replay: ${versions.length} files`);
      summary.currentMigration = null;
      diagnostic.stage = 'cron-pause-proof';
      summary.cron = JSON.parse(await stackAdmin(`SELECT json_build_object(
        'launch', current_setting('cron.launch_active_jobs'), 'logRun', current_setting('cron.log_run'),
        'active', (SELECT count(*) FROM cron.job WHERE active AND database = current_database()),
        'runs', (SELECT count(*) FROM cron.job_run_details WHERE database = current_database()))`));
      if (summary.cron.launch !== 'off' || summary.cron.logRun !== 'on' || summary.cron.runs !== 0) {
        throw new Error('pg_cron launch isolation failed during migration replay');
      }
      console.log(`Migration cron isolation: ${JSON.stringify(summary.cron)}`);
    } finally { await db.end(); }
    if (shard) {
      const templateAdmin = (...commands) => stackAdminFor('template1', CLONE_COMMAND_TIMEOUT, ...commands);
      const integrationOid = edge && await timed('integration-database-snapshot', () =>
        snapshotIntegrationDatabase({ checked, env, admin: templateAdmin, dockerRoot, project, summary }));
      if (edge) {
        // Keep the replayed volume and let the CLI start and health-check PostgREST against it.
        await timed('integration-stack-stop', () => checked(cli, ['stop', '--workdir', temp], cliEnv, 120000));
        const integrationExclude = lane.exclude.filter(service => !Object.hasOwn(integrationImages, service));
        await startStack('integration-stack-start', integrationExclude);
        await timed('integration-database-init', () => verifyHostedDatabaseInit(checked, env, databaseContainer));
      }
      if (selected.includes('0zz_label_renderer_url_policy_v1.sql')) {
        // Only the disposable stack administrator can persist custom database settings.
        await stackAdmin(`DO $fixture$
          BEGIN
            EXECUTE format('ALTER DATABASE %I SET app.local_label_renderer_url = %L', current_database(),
              concat('http', '://', concat_ws('.', 127, 0, 0, 1), ':${apiPort}/functions/v1/label-renderer'));
          END
        $fixture$`);
      }
      const databasePin = pins.find(pin => pin.role === 'database');
      local.writePsqlWrapper(bin, databasePin.runtimeId, { rootless: Boolean(nightlyNetwork) });
      const testEnv = shardEnvironment(env, local.loadBackendLocalPgtapEnv(), project, dbPort, selected);
      diskFloor(dockerRoot);
      summary.pgtap = 'running';
      await timed(`pgtap:${shard}`, () => {
        // Leave time to collect and upload the server log before the job times out.
        const deadline = pgtapDeadline(Date.now(), env.JOB_STARTED_AT);
        const remaining = () => {
          const milliseconds = deadline - Date.now();
          if (milliseconds < 1) throw new Error('pgTAP shard exceeded its execution deadline');
          return milliseconds;
        };
        return disposableShard && workers !== '1'
          ? runHostedShard({ selected, checked, testEnv: { ...testEnv, PGTAP_WORKERS: workers }, summary, dockerRoot, project, logFile,
            remaining, admin: (timeout, ...commands) => stackAdminFor('template1', timeout, ...commands) })
          : checked(process.execPath, ['scripts/ci-hosted/pgtap.cjs'], testEnv, remaining());
      });
      const rows = JSON.parse(fs.readFileSync('ci-reports/pgtap-files.json', 'utf8'));
      if (JSON.stringify(rows.map(row => row.file)) !== JSON.stringify(selected) || rows.some(row => row.status !== 'passed')) throw new Error('Incomplete pgTAP shard results');
      summary.pgtap = 'passed';
      summary.ok = true;
      if (edge) {
        diagnostic.stage = 'integration';
        summary.integration = 'running';
        const deadline = pgtapDeadline(Date.now(), env.JOB_STARTED_AT);
        const remaining = () => {
          const milliseconds = deadline - Date.now();
          if (milliseconds < 1) throw new Error('Integration shard exceeded the database job deadline');
          return milliseconds;
        };
        const integrationAdmin = (...commands) => stackAdminFor('postgres', Math.min(15000, remaining()), ...commands);
        summary.integrationDatabase = await timed('integration-database-restore', async () => {
          await activateIntegrationDatabase(templateAdmin, integrationOid);
          const settings = await restoreIntegrationDatabase(integrationAdmin);
          return { ...settings, origin: 'pristine-migrated-snapshot' };
        });
        await integrationAdmin("NOTIFY pgrst, 'reload schema'");
        await timed(`integration:${shard}`, async () => {
          const chosen = integrationShardFiles(shard);
          const files = await runIntegration(chosen, env, checked, remaining, path.join(temp, 'integration-jest.json'));
          summary.integrationFiles = files;
          const entries = JSON.parse(fs.readFileSync(exceptionFile, 'utf8')).filter(entry => chosen.includes(entry.file));
          const verdict = integrationCoverage([{ shard, integration: 'passed', integrationFiles: files }], chosen, entries);
          if (!verdict.ok) throw new Error(verdict.errors.join('\n'));
          summary.integrationKnownFailures = verdict.knownFailures;
        });
        summary.integration = 'passed';
      }
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
    summary.ok = false;
    if (summary.pgtap === 'running') summary.pgtap = 'failed';
    if (summary.integration === 'running') summary.integration = 'failed';
    if (guard && fs.existsSync(guard.policyFile)) diagnostic.imagePolicy = { ...diagnostic.imagePolicy, ...JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')) };
    saveFailure(diagnostic, error, environmentSecrets(env)); // Persist before stack teardown and temporary-file removal.
    if (started && ['stack-start', 'integration-stack-start'].includes(diagnostic.stage)) {
      diagnostic.startupDiagnostics = await stage(summary, 'stack-diagnostics', () => collectStackDiagnostics({
        project, env, dockerRoot, imagePolicy: diagnostic.imagePolicy, logFile,
      })).catch(diagnosticError => ({ error: sanitize(diagnosticError.message) }));
      saveFailure(diagnostic, error, environmentSecrets(env));
    }
    throw error;
  } finally {
    // The build reports lint failures to the aggregate job without throwing.
    if (started && (!summary.ok || diagnostic.failure)) {
      await captureDatabaseLog({ project, env, logFile: 'ci-reports/postgres-server.log' });
    }
    // Each pgTAP job on a GitHub-hosted runner owns a disposable VM.
    if (started && disposableShard) console.log('Stack stop delegated to GitHub-hosted VM teardown');
    if (started && !disposableShard) {
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
module.exports = { bucketSections, migrationInventory, imagePreflight, completePins, mainSwitch, imageGuard, verifyHostedDatabaseInit, migrationProgress, diskFloor, backendLint, waitForCronPause, disableHostedWalInitZero, configureHostedDatabase, hostedStackPorts, installHostedCli, writeHostedStackConfig, disableHostedAutovacuum, hostedWorkerCount, hostedWorkerLimit, cloneHostedDatabases, timeHostedCloneCommand, dropHostedDatabases, withHostedCloneIsolation, withHostedCloneServices, snapshotIntegrationDatabase, pgtapDeadline };
