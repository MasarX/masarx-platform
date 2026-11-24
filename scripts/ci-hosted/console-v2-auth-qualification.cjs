'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = process.cwd();
const candidate = createRequire(path.join(root, 'package.json'));
const {
  bucketSections, completePins, configureHostedDatabase, disableHostedAutovacuum,
  hostedStackPorts, imageGuard, migrationInventory, verifyHostedDatabaseInit,
} = candidate('./scripts/ci-hosted/backend.cjs');
const { run } = candidate('./scripts/ci-hosted/process.cjs');
const { assertLoopbackOnly, loadLaneConfig, readSupabaseConfig } = candidate('./scripts/ops/ci/cloud-pool-db-local.js');
const { buildSupabaseCliAsset } = candidate('./scripts/ops/ci/supabase-cli-asset.js');
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
  NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_FETCH_RETRIES: '0',
  NEXT_TELEMETRY_DISABLED: '1', NX_NO_CLOUD: 'true', DO_NOT_TRACK: '1',
  SUPABASE_TELEMETRY_DISABLED: '1', OTEL_SDK_DISABLED: 'true',
};
const quiet = (command, args, env = baseEnv, timeout) =>
  run(command, args, { env, timeout, quiet: true, printQuietFailure: false });
const npm = (args, env) => quiet('npm', args, env);
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

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

async function qualify() {
  const report = {
    workflow: process.env.GITHUB_WORKFLOW_REF, workflowCommit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    candidateCommit: process.env.CANDIDATE_SHA, candidateTree: process.env.CANDIDATE_TREE,
    stages: {}, builds: {}, qa: Object.fromEntries(checks.map(name => [name, 'NOT_RUN'])),
  };
  const stage = async (name, work) => {
    try {
      const result = await work();
      report.stages[name] = 'PASS';
      return result;
    } catch {
      report.stages[name] = 'FAIL';
      throw new Error(name);
    }
  };
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'console-auth-'));
  const evidence = path.join(process.env.RUNNER_TEMP, 'console-auth-evidence/test-results/console-v2-auth');
  const speed = path.join(temp, 'speed-evidence');
  const cli = path.join(temp, 'supabase-cli');
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
    await stage('lockedDependencies', async () => {
      report.lockfileSha256 = fileHash('package-lock.json');
      const { packageManager } = candidate('./package.json');
      assert.match(packageManager, /^npm@\d+\.\d+\.\d+$/);
      await npm(['install', '--global', packageManager, '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal((await npm(['--version'])).trim(), packageManager.slice(4));
      await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal(fileHash('package-lock.json'), report.lockfileSha256);
    });
    const { status, apiUrl } = await stage('isolatedSupabase', async () => {
      const pins = candidate('./config/ci/hosted-supabase-images.json');
      assert(completePins(pins));
      const services = candidate('./tests/fixtures/ci/supabase-services-2.116.0.json').services;
      const rest = services.find(service => service.name === 'postgrest/postgrest');
      assert.equal(rest?.local, 'v16.1');
      pins.push({
        image: 'supabase/postgrest', cli_tag: rest.local, mirror: 'ghcr.io',
        digest: 'sha256:5922bde07147b82b1c9d8f749e48c1e5b99ebb233f3888bb7ab65f07cf4ac82d',
        image_id: 'sha256:eb4951a2f9ac02288100937995af3cb7fb64c296b1228405de5d77ca4dd3410d',
      });
      const { exclude, psqlClientMajor } = loadLaneConfig();
      assert(exclude.includes('postgrest'));
      const requiredPins = pins.filter(pin => pin.role !== 'realtime');
      const { major } = readSupabaseConfig();
      assert.equal(String(major), String(psqlClientMajor));
      const asset = buildSupabaseCliAsset({ version: '2.116.0', platform: 'linux', arch: 'amd64' });
      const response = await fetch(asset.download_url, { signal: AbortSignal.timeout(120_000) });
      assert(response.ok);
      const archive = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(archive), asset.sha256);
      const archivePath = path.join(temp, 'supabase.tar.gz');
      fs.writeFileSync(archivePath, archive);
      await quiet('tar', ['-xzf', archivePath, '-C', temp, 'supabase']);
      fs.renameSync(path.join(temp, 'supabase'), cli);
      for (const pin of requiredPins) {
        const ref = `${pin.mirror}/${pin.image}@${pin.digest}`;
        await quiet('docker', ['pull', '--platform=linux/amd64', ref]);
        pin.runtimeId = (await quiet('docker', ['image', 'inspect', '--format', '{{.Id}}', ref])).trim();
        assert.equal(pin.runtimeId, pin.image_id);
        await quiet('docker', ['tag', pin.runtimeId, `public.ecr.aws/${pin.image}:${pin.cli_tag}`]);
      }
      report.supabaseCliSha256 = asset.sha256;
      report.imageDigests = Object.fromEntries(requiredPins.map(pin => [pin.image, pin.digest]));
      const { apiPort, dbPort, shadowPort } = await hostedStackPorts();
      const apiUrl = origin(apiPort);
      const supabaseDir = path.join(stack, 'supabase');
      fs.mkdirSync(path.join(supabaseDir, 'migrations'), { recursive: true });
      const config = [
        `project_id = "${project}"`, '[api]', 'enabled = true', `port = ${apiPort}`, 'schemas = ["api"]',
        'extra_search_path = ["public", "extensions"]', '[db]', `port = ${dbPort}`,
        `shadow_port = ${shadowPort}`, `major_version = ${major}`, '[db.seed]', 'enabled = false',
        '[studio]', 'enabled = false', '[analytics]', 'enabled = false', '[auth]', 'enabled = true',
        `jwt_expiry = ${jwtExpirySeconds}`,
        `site_url = "${liveUrl}"`, `additional_redirect_urls = ["${liveUrl}/auth/callback"]`,
        '[storage]', 'enabled = true', '', bucketSections(fs.readFileSync('supabase/config.toml', 'utf8')),
      ].join('\n');
      fs.writeFileSync(path.join(supabaseDir, 'config.toml'), config);
      report.stackConfigSha256 = sha256(config);
      report.jwtExpirySeconds = jwtExpirySeconds;
      await quiet('docker', ['network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', project]);
      networkCreated = true;
      guard = await imageGuard(requiredPins, path.join(temp, 'image-pins.json'),
        { ...baseEnv, SUPABASE_HOME: path.join(temp, 'supabase-home') }, database);
      started = true;
      await quiet(cli, ['start', '--workdir', stack, '--network-id', project, '-x',
        exclude.filter(service => service !== 'postgrest').join(',')], guard.env, 360_000);
      await verifyHostedDatabaseInit(quiet, baseEnv, database);
      const ports = [];
      const containers = (await quiet('docker', ['ps', '-q', '--filter', `network=${project}`])).trim().split(/\s+/);
      for (const id of containers) {
        const mappings = JSON.parse(await quiet('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]));
        for (const binding of Object.values(mappings ?? {}).flat().filter(Boolean)) {
          assert.equal(binding.HostIp, loopback);
          ports.push(binding.HostPort);
        }
      }
      assert.deepEqual(ports.sort(), [String(apiPort), String(dbPort)].sort());
      const status = JSON.parse(await quiet(cli, ['status', '--workdir', stack, '-o', 'json'], guard.env));
      assert.equal(new URL(status.API_URL).port, String(apiPort));
      assert.equal(new URL(status.DB_URL).port, String(dbPort));
      assertLoopbackOnly({ SUPABASE_URL: status.API_URL, DATABASE_URL: status.DB_URL }, 'auth qualification');
      assert(status.ANON_KEY && status.SERVICE_ROLE_KEY && status.ANON_KEY !== status.SERVICE_ROLE_KEY);
      const { Client } = candidate('pg');
      const db = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
      const admin = (...sql) => quiet('docker', ['exec', database, 'sh', '-ec',
        'PGPASSWORD="$POSTGRES_PASSWORD" exec psql "$@"', 'sh', '--host=127.0.0.1', '--username=supabase_admin',
        '--dbname=postgres', '--no-psqlrc', '--no-password', '--quiet', '--tuples-only', '--no-align',
        '--set=ON_ERROR_STOP=1', ...sql.flatMap(command => ['-c', command])]);
      await db.connect();
      try {
        const history = await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') AS history");
        if (history.rows[0].history) {
          const initial = await db.query('SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations');
          assert.equal(initial.rows[0].n, 0);
        }
        await disableHostedAutovacuum(status.DB_URL, dbPort, admin, db);
        await configureHostedDatabase(admin, db, false);
        fs.rmdirSync(path.join(supabaseDir, 'migrations'));
        fs.symlinkSync(path.join(root, 'supabase/migrations'), path.join(supabaseDir, 'migrations'), 'dir');
        await quiet(cli, ['migration', 'up', '--local', '--workdir', stack], guard.env);
        const applied = await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version');
        assert.deepEqual(applied.rows.map(row => row.version), migrationInventory(fs.readdirSync('supabase/migrations')));
        assert.equal((await db.query('SHOW cron.launch_active_jobs')).rows[0]['cron.launch_active_jobs'], 'off');
      } finally {
        await db.end();
      }
      const health = await fetch(`${apiUrl}/auth/v1/health`, {
        headers: { apikey: status.ANON_KEY }, redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      assert(health.ok);
      assert.equal(JSON.parse(fs.readFileSync(guard.policyFile, 'utf8')).denied, 0);
      return { status, apiUrl };
    });

    const appRequire = createRequire(path.join(app, 'package.json'));
    const { preview } = await import(pathToFileURL(appRequire.resolve('vite')));
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
          await stage('liveBundleBudget', () => npm(['run', 'check:bundle-size', '--workspace', workspace], env));
        } catch {
          bundleFailed = true; // Preserve the budget failure while collecting independent browser evidence.
        }
      }
      const dist = path.join(temp, mode);
      fs.renameSync(path.join(app, 'dist'), dist);
      const files = fs.readdirSync(dist, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.relative(dist, path.join(entry.parentPath, entry.name))).sort();
      assert(files.includes('index.html') && files.some(file => file.endsWith('.js')));
      report.builds[mode] = {
        inputsSha256: sha256(JSON.stringify(buildInputs)),
        directorySha256: sha256(JSON.stringify(files.map(file => [file, fileHash(path.join(dist, file))]))),
      };
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
      const { email, password } = JSON.parse(await qa('fixture', {
        ...qaEnv, SUPABASE_URL: apiUrl, SUPABASE_ANON_KEY: status.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, DATABASE_URL: status.DB_URL,
        QA_JWT_EXPIRY_SECONDS: String(jwtExpirySeconds),
      }, 60_000));
      assert(typeof email === 'string' && email && typeof password === 'string' && password);
      return { email, password };
    });
    await stage('qaBrowser', async () => {
      const output = await qa('browser', {
        ...qaEnv, E2E_CONSOLE_LIVE: '1', VERIFY_BASE: liveUrl, SPEED_EVIDENCE_DIR: speed,
        E2E_CONSOLE_AUTH_EMAIL: account.email, E2E_CONSOLE_AUTH_PASSWORD: account.password,
        VITE_SUPABASE_URL: apiUrl, VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
      }, 480_000);
      const results = JSON.parse(output);
      assert.deepEqual(Object.keys(results).sort(), [...checks].sort());
      for (const name of checks) {
        const allowed = ['PASS', 'FAIL', 'NOT_RUN', ...(name === 'mfa' ? ['UNSUPPORTED'] : [])];
        assert(allowed.includes(results[name]));
      }
      report.qa = results;
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
      assert(Object.values(results).every(result => result === 'PASS' || result === 'UNSUPPORTED'));
    });
    if (bundleFailed) throw new Error('bundle budget');
  } catch {
    process.exitCode = 1;
  } finally {
    const cleanup = [
      ...previews.map(server => server.close()),
      ...(started ? [quiet(cli, ['stop', '--workdir', stack, '--no-backup'], guard.env, 90_000)] : []),
    ];
    let clean = (await Promise.allSettled(cleanup)).every(result => result.status === 'fulfilled');
    guard?.child.kill();
    // The CLI may remove the network itself.
    try {
      const remaining = networkCreated ? await quiet('docker', ['network', 'ls', '--format', '{{.Name}}']) : '';
      if (remaining.split('\n').includes(project)) await quiet('docker', ['network', 'rm', project]);
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      clean = false;
    }
    if (!clean) process.exitCode = 1;
    report.stages.teardown = clean ? 'PASS' : 'FAIL';
    writeJson(path.join(evidence, 'auth-qualification.json'), report);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  }
}

qualify().catch(() => {
  console.error('Qualification could not complete its provenance report.');
  process.exitCode = 1;
});
