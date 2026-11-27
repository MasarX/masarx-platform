'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { expiryUnboundExitCode } = require('./console-v2-auth-qa-fixture.cjs');

const root = process.cwd();
const candidate = createRequire(path.join(root, 'package.json'));
const {
  completePins, configureHostedDatabase, disableHostedAutovacuum, hostedStackPorts,
  imageGuard, installHostedCli, migrationInventory, verifyHostedDatabaseInit, writeHostedStackConfig,
} = require('./backend.cjs');
const { prepareImages } = require('./images.cjs');
const { run } = require('./process.cjs');
const { assertLoopbackOnly, loadLaneConfig, readSupabaseConfig } = candidate('./scripts/ops/ci/cloud-pool-db-local.js');
const { readSpeedBudgets } = candidate('./scripts/frontend/design-speed-budgets.cjs');
const checks = ['liveStartup', 'demoStartup', 'signIn', 'restore', 'refresh', 'signOut', 'mfa', 'startupP75'];
const loopback = '127.0.0.1';
const jwtExpirySeconds = 180;
const origin = port => `http://${loopback}:${port}`;
const sha256 = input => createHash('sha256').update(input).digest('hex');
const fileHash = file => sha256(fs.readFileSync(file));
const baseEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', CI: 'true',
  ENV_FILE: '/dev/null', ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0',
  NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_FETCH_RETRIES: '0',
  NEXT_TELEMETRY_DISABLED: '1', NX_NO_CLOUD: 'true', DO_NOT_TRACK: '1',
  SUPABASE_TELEMETRY_DISABLED: '1', OTEL_SDK_DISABLED: 'true',
};
const quiet = (command, args, env = baseEnv, timeout, options) =>
  run(command, args, { ...options, env, timeout, quiet: true, printQuietFailure: false });
const npm = (args, env) => quiet('npm', args, env);
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const imagePolicyDenied = 'DOCKER_IMAGE_POLICY_DENIED';

function failureCode(error, exitCode) {
  if (error.code === imagePolicyDenied) return imagePolicyDenied;
  if (error.failure?.timeout || error.name === 'TimeoutError' || ['ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code)) return 'TIMEOUT_OR_LIMIT';
  if (error.code === 'ERR_ASSERTION') return 'CHECK_FAILED';
  if (error instanceof SyntaxError) return 'INVALID_OUTPUT';
  if (error.failure?.signal || error.signal) return 'COMMAND_SIGNAL';
  if (exitCode !== undefined) return 'COMMAND_EXIT';
  return 'OPERATION_FAILED';
}

function speedEvidence(file, limit) {
  const { viewport, runs } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(viewport, '1440x900');
  assert.equal(runs.length, 5);
  const samples = runs.map(({ lcpMs, inpMs }) => {
    assert(Number.isSafeInteger(lcpMs) && lcpMs > 0 && lcpMs <= 480_000);
    assert(Number.isSafeInteger(inpMs) && inpMs >= 16 && inpMs <= 480_000);
    return { lcpMs, inpMs };
  });
  const p75 = key => samples.map(sample => sample[key]).sort((a, b) => a - b)[3];
  const result = { lcpMs: p75('lcpMs'), inpMs: p75('inpMs') };
  return { route: '/', viewport, runs: samples, p75: result, limit,
    result: result.lcpMs <= limit.lcpMs && result.inpMs <= limit.inpMs ? 'PASS' : 'FAIL' };
}

async function qualify(stackOnly) {
  const report = {
    workflow: process.env.GITHUB_WORKFLOW_REF, workflowCommit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    candidateCommit: process.env.CANDIDATE_SHA, candidateTree: process.env.CANDIDATE_TREE,
    stages: {}, failureReasons: {}, builds: {}, qa: Object.fromEntries(checks.map(name => [name, 'NOT_RUN'])),
  };
  const fail = (name, step, error) => {
    const status = error.failure?.exitCode ?? error.status;
    const exitCode = Number.isInteger(status) ? status : undefined;
    const code = failureCode(error, exitCode);
    report.stages[name] = 'FAIL';
    report.failureReasons[name] = { step, code, exitCode };
    console.error(`${name}: FAIL ${step} ${code}${exitCode === undefined ? '' : ` exit=${exitCode}`}`);
  };
  const stage = async (name, work) => {
    let step = name;
    try {
      const result = await work(value => { step = value; });
      report.stages[name] = 'PASS';
      console.log(`${name}: PASS`);
      return result;
    } catch (error) {
      fail(name, step, error);
      throw error;
    }
  };
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'console-auth-'));
  const evidence = path.join(process.env.RUNNER_TEMP, 'console-auth-evidence/test-results/console-v2-auth');
  const speed = path.join(temp, 'speed-evidence');
  const cli = path.join(temp, 'bin', 'supabase');
  const stack = path.join(temp, 'stack');
  const project = `console-auth-${report.run}`;
  const database = `supabase_db_${project}`;
  const workspace = '@masarx/console-v2';
  const app = path.join(root, 'apps/console-v2');
  const liveUrl = origin(5175);
  const demoUrl = origin(5176);
  const previews = [];
  let guard;
  let started = false;
  let networkCreated = false;
  fs.mkdirSync(path.join(evidence, 'speed-evidence'), { recursive: true });
  fs.mkdirSync(speed);

  try {
    await stage('lockedDependencies', async mark => {
      mark('lockfile');
      report.lockfileSha256 = fileHash('package-lock.json');
      const { packageManager } = candidate('./package.json');
      assert.match(packageManager, /^npm@\d+\.\d+\.\d+$/);
      mark('npmVersion');
      await npm(['install', '--global', packageManager, '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal((await npm(['--version'])).trim(), packageManager.slice(4));
      mark('npmCi');
      await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      mark('lockfile');
      assert.equal(fileHash('package-lock.json'), report.lockfileSha256);
    });
    const { status, apiUrl } = await stage('isolatedSupabase', async mark => {
      mark('pinsAndVersions');
      const pins = candidate('./config/ci/hosted-supabase-images.json');
      assert(completePins(pins));
      const services = candidate('./tests/fixtures/ci/supabase-services-2.116.0.json').services;
      const rest = services.find(service => service.name === 'postgrest/postgrest');
      assert.equal(rest?.local, 'v16.1');
      pins.push({
        role: 'rest', image: 'supabase/postgrest', cli_tag: rest.local, mirror: 'ghcr.io',
        digest: 'sha256:5922bde07147b82b1c9d8f749e48c1e5b99ebb233f3888bb7ab65f07cf4ac82d',
        image_id: 'sha256:eb4951a2f9ac02288100937995af3cb7fb64c296b1228405de5d77ca4dd3410d',
      });
      const { exclude, psqlClientMajor } = loadLaneConfig();
      assert(exclude.includes('postgrest'));
      const { major } = readSupabaseConfig();
      assert.equal(String(major), String(psqlClientMajor));
      mark('cliInstall');
      fs.mkdirSync(path.dirname(cli));
      report.supabaseCliSha256 = await installHostedCli(quiet, baseEnv, temp, path.dirname(cli));
      mark('dockerPreflight');
      const dockerRoot = (await quiet('docker', ['info', '--format', '{{.DockerRootDir}}'], baseEnv, 30_000)).trim();
      mark('imagePullOrVerification');
      // Fresh database setup uses the Realtime image even when the service is excluded.
      await prepareImages(pins, { env: baseEnv, checked: quiet, timed: (_, action) => action(), summary: {}, dockerRoot, quiet: true });
      report.imageDigests = Object.fromEntries(pins.map(pin => [pin.image, pin.digest]));
      mark('stackConfiguration');
      const ports = await hostedStackPorts();
      const { apiPort, dbPort } = ports;
      const apiUrl = origin(apiPort);
      const supabaseDir = path.join(stack, 'supabase');
      const config = writeHostedStackConfig(stack, project, ports, major, [
        `jwt_expiry = ${jwtExpirySeconds}`,
        `site_url = "${liveUrl}"`, `additional_redirect_urls = ["${liveUrl}/auth/callback"]`,
      ], true);
      // PostgREST builds its cache before the CLI returns. Candidate migrations will populate this empty schema.
      const bootstrap = 'CREATE SCHEMA api AUTHORIZATION postgres;\n';
      fs.writeFileSync(path.join(supabaseDir, 'seed.sql'), bootstrap, { mode: 0o600 });
      report.stackConfigSha256 = sha256(config);
      report.stackBootstrapSha256 = sha256(bootstrap);
      report.jwtExpirySeconds = jwtExpirySeconds;
      mark('loopbackNetwork');
      await quiet('docker', ['network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', project]);
      networkCreated = true;
      mark('imageGuard');
      guard = await imageGuard(pins, path.join(temp, 'image-pins.json'),
        { ...baseEnv, SUPABASE_HOME: path.join(temp, 'supabase-home') }, database);
      started = true;
      mark('stackStart');
      await quiet(cli, ['start', '--workdir', stack, '--network-id', project, '-x',
        exclude.filter(service => service !== 'postgrest').join(',')], guard.env, 360_000).catch(error => {
        if (JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')).denied > 0) {
          mark('imagePolicy');
          error.code = imagePolicyDenied;
        }
        throw error;
      });
      mark('databaseInit');
      await verifyHostedDatabaseInit(quiet, baseEnv, database);
      mark('publishedPorts');
      const published = [];
      const containers = (await quiet('docker', ['ps', '-q', '--filter', `network=${project}`])).trim().split(/\s+/);
      for (const id of containers) {
        const mappings = JSON.parse(await quiet('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]));
        for (const binding of Object.values(mappings ?? {}).flat().filter(Boolean)) {
          assert.equal(binding.HostIp, loopback);
          published.push(binding.HostPort);
        }
      }
      assert.deepEqual(published.sort(), [String(apiPort), String(dbPort)].sort());
      mark('stackStatus');
      const status = JSON.parse(await quiet(cli, ['status', '--workdir', stack, '-o', 'json'], guard.env));
      assert.equal(new URL(status.API_URL).port, String(apiPort));
      assert.equal(new URL(status.DB_URL).port, String(dbPort));
      assertLoopbackOnly({ SUPABASE_URL: status.API_URL, DATABASE_URL: status.DB_URL }, 'auth qualification');
      assert(status.ANON_KEY && status.SERVICE_ROLE_KEY && status.ANON_KEY !== status.SERVICE_ROLE_KEY);
      mark('databaseConnect');
      const { Client } = candidate('pg');
      const db = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
      const admin = (...sql) => quiet('docker', ['exec', database, 'sh', '-ec',
        'PGPASSWORD="$POSTGRES_PASSWORD" exec psql "$@"', 'sh', '--host=127.0.0.1', '--username=supabase_admin',
        '--dbname=postgres', '--no-psqlrc', '--no-password', '--quiet', '--tuples-only', '--no-align',
        '--set=ON_ERROR_STOP=1', ...sql.flatMap(command => ['-c', command])]);
      await db.connect();
      try {
        mark('emptyMigrationHistory');
        const history = await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') AS history");
        if (history.rows[0].history) {
          const initial = await db.query('SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations');
          assert.equal(initial.rows[0].n, 0);
        }
        mark('databaseSettings');
        await disableHostedAutovacuum(status.DB_URL, dbPort, admin, db);
        await configureHostedDatabase(admin, db, false);
        mark('migrationReplay');
        fs.rmdirSync(path.join(supabaseDir, 'migrations'));
        fs.symlinkSync(path.join(root, 'supabase/migrations'), path.join(supabaseDir, 'migrations'), 'dir');
        await quiet(cli, ['migration', 'up', '--local', '--workdir', stack], guard.env);
        mark('migrationInventory');
        const applied = await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version');
        assert.deepEqual(applied.rows.map(row => row.version), migrationInventory(fs.readdirSync('supabase/migrations')));
        assert.equal((await db.query('SHOW cron.launch_active_jobs')).rows[0]['cron.launch_active_jobs'], 'off');
      } finally {
        await db.end();
      }
      mark('authHealth');
      const health = await fetch(`${apiUrl}/auth/v1/health`, {
        headers: { apikey: status.ANON_KEY }, redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      assert(health.ok);
      mark('imagePolicy');
      assert.equal(JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')).denied, 0);
      return { status, apiUrl };
    });
    if (stackOnly) return;

    const appRequire = createRequire(path.join(app, 'package.json'));
    const { preview } = await stage('previewPrerequisites', () => import(pathToFileURL(appRequire.resolve('vite'))));
    let bundleFailed = false;
    for (const [mode, url] of [['live', liveUrl], ['demo', demoUrl]]) {
      const live = mode === 'live';
      const buildInputs = {
        NODE_ENV: 'production', VITE_USE_SEED: String(!live), VITE_SENTRY_DSN: '',
        ...(live ? { VITE_SUPABASE_URL: apiUrl, VITE_SUPABASE_ANON_KEY: status.ANON_KEY } : {}),
      };
      const env = { ...baseEnv, ...buildInputs };
      await stage(`${mode}Build`, () => npm(['run', 'build', '--workspace', workspace], env));
      if (live) {
        try {
          // Apply the reviewed ceiling from the workflow checkout to the untouched candidate build.
          const checker = path.resolve(__dirname, '../../apps/console-v2/scripts/check-bundle-size.mjs');
          await stage('liveBundleBudget', () => execFileSync(process.execPath, [checker], {
            cwd: app, env, stdio: 'pipe', timeout: 30_000,
          }));
        } catch {
          bundleFailed = true; // Preserve the budget failure while collecting independent browser evidence.
        }
      }
      const dist = path.join(temp, mode);
      await stage(`${mode}BuildEvidence`, () => {
        fs.renameSync(path.join(app, 'dist'), dist);
        const files = fs.readdirSync(dist, { recursive: true, withFileTypes: true })
          .filter(entry => entry.isFile())
          .map(entry => path.relative(dist, path.join(entry.parentPath, entry.name))).sort();
        assert(files.includes('index.html') && files.some(file => file.endsWith('.js')));
        report.builds[mode] = {
          inputsSha256: sha256(JSON.stringify(buildInputs)),
          directorySha256: sha256(JSON.stringify(files.map(file => [file, fileHash(path.join(dist, file))]))),
        };
      });
      await stage(`${mode}Preview`, async () => {
        const server = await preview({
          configFile: false, root: app, mode: 'production', logLevel: 'silent', build: { outDir: dist },
          preview: {
            host: loopback, port: Number(new URL(url).port), strictPort: true,
            headers: { 'Content-Security-Policy': `default-src 'self'; connect-src 'self'${live ? ` ${apiUrl}` : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:` },
          },
        });
        previews.push(server);
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
        assert(response.ok);
        assert.equal(await response.text(), fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
      });
    }
    await stage('browserPrerequisites', () =>
      quiet(process.execPath, [candidate.resolve('@playwright/test/cli'), 'install', 'chromium']));
    const qaEnv = {
      ...baseEnv, QA_TEMP_DIR: temp, QA_CANDIDATE_DIR: root,
      QA_CANDIDATE: JSON.stringify({
        workflowSha: report.workflowCommit, sourceSha: report.candidateCommit, sourceTree: report.candidateTree,
        lockfileDigest: report.lockfileSha256, runId: Number(report.run), attempt: Number(report.attempt),
      }),
      QA_LIVE: JSON.stringify({ origin: liveUrl, buildDigest: report.builds.live.directorySha256 }),
      QA_DEMO: JSON.stringify({ origin: demoUrl, buildDigest: report.builds.demo.directorySha256 }),
    };
    const qa = (name, env, timeout) =>
      quiet(process.execPath, [path.join(__dirname, `console-v2-auth-qa-${name}.cjs`)], env, timeout);
    const account = await stage('qaFixture', async () => {
      const output = await qa('fixture', {
        ...qaEnv, SUPABASE_URL: apiUrl, SUPABASE_ANON_KEY: status.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, DATABASE_URL: status.DB_URL,
        QA_JWT_EXPIRY_SECONDS: String(jwtExpirySeconds),
      }, 60_000).catch(error => {
        if (error.failure?.exitCode === expiryUnboundExitCode) report.qaRefreshReason = 'REFRESH_EXPIRY_UNBOUND';
        throw error;
      });
      const { email, password } = JSON.parse(output);
      assert(typeof email === 'string' && email && typeof password === 'string' && password);
      return { email, password };
    });
    await stage('qaBrowser', async () => {
      const output = await qa('browser', {
        ...qaEnv, E2E_CONSOLE_LIVE: '1', VERIFY_BASE: liveUrl, SPEED_EVIDENCE_DIR: speed,
        E2E_CONSOLE_AUTH_EMAIL: account.email, E2E_CONSOLE_AUTH_PASSWORD: account.password,
        VITE_SUPABASE_URL: apiUrl, VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
      }, 480_000);
      const { refreshReason, ...results } = JSON.parse(output);
      assert.deepEqual(Object.keys(results).sort(), [...checks].sort());
      assert(refreshReason === null || (refreshReason === 'REFRESH_NOT_OBSERVED' && results.refresh === 'NOT_RUN'));
      for (const name of checks) {
        const allowed = ['PASS', 'FAIL', 'NOT_RUN', ...(name === 'mfa' ? ['UNSUPPORTED'] : [])];
        assert(allowed.includes(results[name]));
      }
      report.qa = { ...results, startupP75: 'NOT_RUN' };
      if (refreshReason) report.qaRefreshReason = refreshReason;
      const budget = readSpeedBudgets().find(row => row.screen === 'Console V2 Dashboard `/`');
      assert(budget);
      const limit = {
        lcpMs: Math.round(budget.lcpMs * (1 + budget.toleranceRatio)),
        inpMs: Math.round(budget.inpMs * (1 + budget.toleranceRatio)),
      };
      const measured = ['live', 'demo'].map(mode => {
        const file = `speed--dashboard-${mode}.json`;
        const source = path.join(speed, file);
        if (!fs.existsSync(source)) return 'NOT_RUN';
        const record = speedEvidence(source, limit);
        writeJson(path.join(evidence, 'speed-evidence', file), record);
        return record.result;
      });
      const speedStatus = measured.includes('FAIL') ? 'FAIL' : measured.includes('NOT_RUN') ? 'NOT_RUN' : 'PASS';
      assert.equal(results.startupP75, speedStatus);
      report.qa.startupP75 = speedStatus;
      assert(Object.values(report.qa).every(result => result === 'PASS' || result === 'UNSUPPORTED'));
    });
    if (bundleFailed) throw new Error('bundle budget');
  } catch {
    process.exitCode = 1;
  } finally {
    const cleanup = [
      ...previews.map(server => server.close()),
      ...(started ? [quiet(cli, ['stop', '--workdir', stack, '--no-backup'], guard.env, 90_000)] : []),
    ];
    const outcomes = await Promise.allSettled(cleanup);
    const failedCleanup = outcomes.find(result => result.status === 'rejected');
    if (failedCleanup) fail('teardown', 'stopServices', failedCleanup.reason);
    guard?.child.kill();
    // The CLI may remove the network itself.
    try {
      const remaining = networkCreated ? await quiet('docker', ['network', 'ls', '--format', '{{.Name}}']) : '';
      if (remaining.split('\n').includes(project)) await quiet('docker', ['network', 'rm', project]);
    } catch (error) {
      fail('teardown', 'removeNetwork', error);
    }
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch (error) {
      fail('teardown', 'removePrivateFiles', error);
    }
    if (report.stages.teardown === 'FAIL') process.exitCode = 1;
    else {
      report.stages.teardown = 'PASS';
      console.log('teardown: PASS');
    }
    writeJson(path.join(evidence, 'auth-qualification.json'), report);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  }
}

qualify(process.argv[2] === '--stack-only').catch(() => {
  console.error('provenance: FAIL report OPERATION_FAILED');
  process.exitCode = 1;
});
