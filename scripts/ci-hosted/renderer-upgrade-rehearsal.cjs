'use strict';

const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const {
  configureHostedDatabase, disableHostedAutovacuum, hostedStackPorts, imageGuard,
  installHostedCli, migrationInventory, verifyHostedDatabaseInit, writeHostedStackConfig,
} = require('./backend.cjs');
const { prepareImages } = require('./images.cjs');
const { integrationEdgeEnvironment } = require('./integration.cjs');
const { run } = require('./process.cjs');
const { assertLoopbackOnly, loadLaneConfig, readSupabaseConfig } = require('../ops/ci/cloud-pool-db-local.js');

const tagged = 'ed381a7ceb304152abe16a6e438e5cf861b08045';
const holdCommit = '7f62c1d05179bd127148f1a319f21a1a5a7a0069';
const holdPath = 'scripts/deploy/hold-renderer-upgrade-jobs.sql';
const beforeTransportGate = '20261124055620';
const workers = ['api-caller', 'outbound-wake', 'label-renderer'];
const phases = ['tagged_stack', 'original_receipts', 'migration_hold_and_upgrade', 'mixed_versions', 'rollback_and_reapply'];
const bridgeUrl = 'http://rehearsal-edge:9000';
const invokeUrl = bridgeUrl + '/functions/v1/label-renderer';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const runQuiet = (command, args, env, timeout) => run(command, args, { env, timeout, quiet: true, printQuietFailure: false });

// This gateway selects immutable ESZIP files. The digest header is made from the exact bytes passed to the worker.
const gateway = String.raw`
const versions = new Map();
const vars = Deno.env.toObject();
Deno.serve(async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/rest/v1/')) {
    return fetch(new Request(new URL(url.pathname + url.search, 'http://kong:8000'), request));
  }
  const name = /^\/functions\/v1\/([a-z-]+)$/.exec(url.pathname)?.[1];
  const sha = JSON.parse(await Deno.readTextFile('/rehearsal/active.json'))[name];
  if (!sha) return new Response(null, { status: 404 });
  const authorization = request.headers.get('authorization');
  const allowed = name === 'api-caller' ? [vars.API_CALLER_DB_JWT] :
    [vars.LABEL_RENDERER_DB_JWT, vars.LABEL_RENDERER_GATEWAY_JWT];
  if (name !== 'outbound-wake' && request.method !== 'OPTIONS' &&
      !allowed.some(token => token && authorization === 'Bearer ' + token)) {
    return new Response(null, { status: 401 });
  }
  const servicePath = '/rehearsal/bundles/' + sha + '/' + name;
  try {
    if (!versions.has(servicePath)) {
      versions.set(servicePath, (async () => {
        const bytes = await Deno.readFile(servicePath + '/bundle.eszip');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return { bytes, digest: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
      })());
    }
    const { bytes, digest } = await versions.get(servicePath);
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath, maybeEszip: bytes, allowRemoteModules: false,
      memoryLimitMb: 256, workerTimeoutMs: 60_000, cpuTimeSoftLimitMs: 10_000, cpuTimeHardLimitMs: 20_000,
      envVars: Object.entries({ ...vars, EDGE_SUPABASE_URL: name === 'outbound-wake' ?
        'http://rehearsal-edge:9000' : 'http://kong:8000' }),
    });
    const result = await worker.fetch(request);
    const headers = new Headers(result.headers);
    headers.set('x-rehearsal-bundle-sha256', digest);
    return new Response(result.body, { status: result.status, headers });
  } catch {
    return Response.json({ code: 'rehearsal_worker_error' }, { status: 500 });
  }
});
`;

async function waitFor(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function seedLabels(db, kind) {
  const [org, client, address, shipment] = Array.from({ length: 4 }, randomUUID);
  const tracking = org.slice(0, 12);
  await db.query("INSERT INTO public.organizations(id,name,slug) VALUES ($1::uuid,'Synthetic labels',$1::uuid::text)", [org]);
  await db.query("INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status) VALUES ($1::uuid,$2,'Synthetic client',$1::uuid::text,'standard','active')", [client, org]);
  await db.query("INSERT INTO public.addresses(id,organization_id,client_id,raw_input,city,province,country,validation_status) VALUES ($1,$2,$3,'Synthetic address','Riyadh','Riyadh','SA','pending')", [address, org, client]);
  const count = kind === 'render' ? 1 : 2;
  await db.query(`INSERT INTO public.shipments(id,organization_id,client_id,service_type,tracking_number,status,box_count,origin_address_id,destination_address_id)
    VALUES ($1,$2,$3,'delivery',$4,'pending',$5,$6,$6)`, [shipment, org, client, tracking, count, address]);
  const { rows: boxes } = await db.query(`INSERT INTO public.shipment_boxes(id,shipment_id,organization_id,client_id,box_number,barcode)
    SELECT gen_random_uuid(),$1,$2,$3,n,$4 || ':' || n FROM generate_series(1,$5) n RETURNING id`, [shipment, org, client, tracking, count]);

  const { createWorkflowContext, clearWorkflowEngineContext } = require('../../tests/integration/helpers/tenant-utils.js');
  const context = { organization_id: org, client_id: client };
  const { runId, stepId } = await createWorkflowContext(db, { templateName: 'sys_label_generation_v1', context, local: false });
  let labelJob;
  let receipt;
  try {
    if (kind === 'render') {
      labelJob = (await db.query("SELECT public.request_label_generation($1,'shipping',NULL,'renderer_rehearsal',$2,'primary') AS id",
        [shipment, boxes[0].id])).rows[0].id;
      receipt = (await db.query('SELECT public.invoke_label_renderer(1,$1::jsonb) AS receipt',
        [{ organization_id: org, job_id: labelJob }])).rows[0].receipt;
    } else {
      receipt = (await db.query('SELECT public.invoke_label_renderer_print_sync_v1($1,$2,$3::jsonb) AS receipt',
        [runId, stepId, { organization_id: org, client_id: client, job_purpose: 'manual',
          execute_dispatch_mode: 'async', workflow_progress_enabled: false, expires_seconds: 600,
          shipments: [{ shipment_id: shipment, box_ids: boxes.map(box => box.id) }] }])).rows[0].receipt;
    }
  } finally {
    await clearWorkflowEngineContext(db);
  }
  assert(receipt.status === 202 && !receipt.completed && Number.isSafeInteger(receipt.request_id), kind + ' receipt not pending at enqueue');
  return { kind, org, labelJob, requestId: receipt.request_id, edgeJobId: receipt.edge_job_id ?? null };
}

async function observe(db, work) {
  const [[effect], [receipt], [queue]] = await Promise.all([
    db.query(`SELECT count(*)::int AS count, coalesce(array_agg(name ORDER BY at), '{}') AS paths,
      coalesce(array_agg(at ORDER BY at), '{}') AS times FROM rehearsal.storage_writes
      WHERE ($1 = 'render' AND name = $2 || '/labels/' || $3 || '.pdf')
         OR ($1 = 'print' AND starts_with(name, $2 || '/bundles/'))`,
    [work.kind, work.org, work.labelJob ?? null]).then(result => result.rows),
    db.query(`SELECT result->>'completed' = 'true' AS completed, (result->>'status')::int AS status,
      result#>>'{body,status}' AS outcome FROM public.check_async_response($1) AS result`, [work.requestId]).then(result => result.rows),
    work.edgeJobId
      ? db.query(`SELECT status, retry_count AS retries, scheduled_at::text AS scheduled, scheduled_at <= now() AS due,
          edge_lease_token IS NOT NULL AS leased FROM public.outbound_calls WHERE id = $1 AND renderer_request_id = $2`,
      [work.edgeJobId, work.requestId]).then(result => result.rows)
      : db.query('SELECT EXISTS (SELECT FROM net.http_request_queue WHERE id = $1) AS queued', [work.requestId]).then(result => result.rows),
  ]);
  assert(queue, 'Original leased receipt disappeared');
  return { ...work, receipt, queue, effects: effect.count, paths: effect.paths, effectTimes: effect.times };
}

async function rehearse(report, persist, scratch) {
  const git = args => runQuiet('git', args);
  const candidate = (await git(['rev-parse', 'HEAD'])).trim();
  const main = (await git(['rev-parse', '--verify', (process.env.REHEARSAL_MAIN_SHA || 'origin/main') + '^{commit}'])).trim();
  assert.equal((await git(['rev-parse', 'v0.1.0^{commit}'])).trim(), tagged);
  assert.equal((await git(['diff', '--name-only', '--diff-filter=DMRT', tagged, main, '--', 'supabase/migrations'])).trim(), '', 'Tagged migrations changed');
  report.commits = { candidate, main, tagged, hold: holdCommit };
  const hold = await git(['show', main + ':' + holdPath]);
  assert.equal(hold, await git(['show', holdCommit + ':' + holdPath]), '#919 hold differs on main');
  report.holdSha256 = sha256(hold);
  persist();

  const runtimeDir = path.join(scratch, 'runtime');
  const stack = path.join(scratch, 'stack');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(runtimeDir, 'index.ts'), gateway);
  const activePath = path.join(runtimeDir, 'active.json');
  const cli = path.join(bin, 'supabase');
  const project = 'renderer-' + process.env.GITHUB_RUN_ID;
  const database = 'supabase_db_' + project;
  const docker = args => runQuiet('docker', args);
  const ports = await hostedStackPorts(undefined, true);
  const { apiPort, dbPort, mailPort: runtimePort } = ports;
  const edge = integrationEdgeEnvironment(apiPort);
  const vars = { ...process.env, SUPABASE_HOME: path.join(scratch, 'supabase-home'),
    SUPABASE_AUTH_JWT_SECRET: edge.jwtSecret };
  const pins = [...require('../../config/ci/hosted-supabase-images.json'),
    ...require('../../config/ci/hosted-integration-images.json').filter(pin => pin.role !== 'mailpit')];
  const runtimePin = pins.find(pin => pin.role === 'edge-runtime');

  let guard;
  let db;
  let admin;
  let status;
  let active;
  let watermark;
  let inProgress;
  const receipts = [];
  const artifactDigests = new Map();
  const prepared = {};
  const chosen = {};
  const api = 'http://127.0.0.1:' + runtimePort;
  const auth = { authorization: 'Bearer ' + edge.vars.API_CALLER_DB_JWT, 'content-type': 'application/json' };
  const phase = async (name, task) => {
    inProgress = report.phases[name];
    Object.assign(inProgress, { startedAt: new Date().toISOString(), status: 'FAILED' });
    console.log('START ' + name);
    persist();
    await task();
    await checkpoint(name, receipts.filter(work => work.phase === 'complete').map(work => work.requestId));
    Object.assign(inProgress, { endedAt: new Date().toISOString(), status: 'PASS' });
    persist();
    console.log('PASS ' + name);
  };
  const apiCall = async (name, method, body) => {
    const result = await fetch(api + '/functions/v1/' + name, { method, headers: auth,
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(result.headers.get('x-rehearsal-bundle-sha256'), active[name].sha256,
      'Live bundle digest missing or different for ' + name + ' (HTTP ' + result.status + ')');
    return result;
  };
  const use = async (revisions) => {
    active = Object.fromEntries(workers.map((name, index) => [name, { sha: revisions[index], sha256: prepared[revisions[index]][name] }]));
    fs.writeFileSync(activePath + '.next', JSON.stringify(Object.fromEntries(workers.map(name => [name, active[name].sha]))));
    fs.renameSync(activePath + '.next', activePath);
    await waitFor(async () => {
      try { return Boolean(await fetch(api + '/ready', { signal: AbortSignal.timeout(1000) })); }
      catch { return false; }
    }, 'Edge Runtime did not listen');
    for (const [name, method, expected] of [['api-caller', 'GET', 405], ['outbound-wake', 'GET', 202], ['label-renderer', 'OPTIONS', 204]]) {
      const response = await apiCall(name, method);
      assert.equal(response.status, expected, name + ' live probe failed');
      await response.body?.cancel();
    }
  };
  const migrate = async (source, last) => {
    const sourceDir = path.join(source, 'supabase/migrations');
    const target = path.join(stack, 'supabase/migrations');
    const files = fs.readdirSync(sourceDir).filter(file => file.endsWith('.sql') && (!last || file.split('_')[0] <= last));
    const expected = migrationInventory(files);
    for (const file of files) {
      if (!fs.existsSync(path.join(target, file))) fs.linkSync(path.join(sourceDir, file), path.join(target, file));
    }
    await runQuiet(cli, ['migration', 'up', '--local', '--workdir', stack], guard.env);
    const { rows } = await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version');
    assert(rows.length === expected.length && rows.every((row, index) => row.version === expected[index]), 'Migration history differs from source');
    watermark = { version: expected.at(-1), count: expected.length };
    await db.query("NOTIFY pgrst, 'reload schema'");
  };
  const checkpoint = async (name, completed = []) => {
    const evidence = { name, time: new Date().toISOString(), bundles: active, migrations: watermark,
      receipts: await Promise.all(receipts.map(work => observe(db, work))) };
    (inProgress.timeline ??= []).push(evidence);
    persist();
    for (const work of evidence.receipts) {
      const done = completed.includes(work.requestId);
      assert.equal(work.effects, Number(done), work.kind + ' effect count differs for original receipt ' + work.requestId);
      assert.equal(work.receipt.completed, done, work.kind + ' receipt completion differs');
      if (!done && !work.edgeJobId) assert(work.queue.queued, work.kind + ' tagged receipt left the net queue');
      if (done) {
        assert.equal(work.receipt.status, 200, work.kind + ' original receipt did not succeed');
        assert.equal(work.receipt.outcome, 'ok', work.kind + ' renderer did not report success');
        if (!artifactDigests.has(work.requestId)) {
          const object = await fetch(status.API_URL + '/storage/v1/object/authenticated/labels/' + work.paths[0], {
            headers: { authorization: 'Bearer ' + status.SERVICE_ROLE_KEY, apikey: status.SERVICE_ROLE_KEY },
            redirect: 'error', signal: AbortSignal.timeout(15_000),
          });
          assert(object.ok, 'Could not read the original PDF output');
          const bytes = Buffer.from(await object.arrayBuffer());
          assert.equal(bytes.toString('ascii', 0, 5), '%PDF-', 'Original output is not a PDF');
          artifactDigests.set(work.requestId, sha256(bytes));
        }
        work.pdfSha256 = artifactDigests.get(work.requestId);
      }
    }
    persist();
    return evidence.receipts;
  };
  const seed = async cohort => {
    const pair = [];
    for (const kind of ['render', 'print']) {
      const work = await seedLabels(db, kind);
      assert.equal(Boolean(work.edgeJobId), cohort !== 'legacy', 'Unexpected receipt transport');
      Object.assign(work, { cohort, phase: 'pending' });
      receipts.push(work);
      pair.push(work);
    }
    return pair;
  };
  const dispatch = async (pair, expectedError) => {
    for (const work of pair) {
      const response = await apiCall('api-caller', 'POST', { job_id: work.edgeJobId });
      const result = (await response.json()).result;
      (inProgress.dispatch ??= []).push({ requestId: work.requestId, status: response.status,
        resultStatus: result?.status, success: response.ok, expectedDisposition: expectedError ?? 'success',
        at: new Date().toISOString() });
      persist();
      if (expectedError) assert(response.status === 502 && result?.error === expectedError, 'Unexpected caller disposition: ' + expectedError);
      else assert(response.ok && result?.status === 200, 'Leased caller did not complete the original receipt');
    }
  };
  const due = async pair => {
    for (const work of pair) {
      const { rowCount } = await db.query(`UPDATE public.outbound_calls SET scheduled_at = now()
        WHERE id=$1 AND status='pending_edge' AND retry_count=0 AND edge_lease_token IS NULL AND scheduled_at > now()`,
      [work.edgeJobId]);
      assert.equal(rowCount, 1, 'Expected the deferral schedule and released lease');
    }
    inProgress.advancedFixtureSchedule = true;
  };

  try {
    let legacy, leased, rollback;
    await phase('tagged_stack', async () => {
      inProgress.operation = 'source_checkout';
      for (const sha of [tagged, main]) {
        const source = path.join(scratch, sha);
        chosen[sha] = source;
        await git(['worktree', 'add', '--detach', source, sha]);
        await runQuiet(process.execPath, [path.join(source, 'scripts/edge/sync-shared.js')]);
      }
      inProgress.operation = 'pinned_tools_and_images';
      report.cliSha256 = await installHostedCli(runQuiet, vars, scratch, bin);
      const checked = (command, args, env, timeout) => runQuiet(command, args, env, timeout);
      await prepareImages(pins, { env: vars, checked, timed: (_, action) => action(), summary: {}, quiet: true });
      report.runtimeImage = runtimePin.digest;
      const denoCache = path.join(scratch, 'deno');
      fs.mkdirSync(denoCache);
      for (const sha of [tagged, main]) {
        prepared[sha] = {};
        for (const name of workers) {
          inProgress.operation = 'bundle_' + name + '_' + (sha === tagged ? 'tagged' : 'main');
          const out = path.join(runtimeDir, 'bundles', sha, name);
          fs.mkdirSync(out, { recursive: true });
          await docker(['run', '--rm', '--pull', 'never', '--user', process.getuid() + ':' + process.getgid(),
            '-e', 'DENO_DIR=/cache', '-v', chosen[sha] + ':/source:ro', '-v', denoCache + ':/cache',
            '-v', out + ':/output', '-w', '/source', runtimePin.runtimeId,
            'bundle', '--entrypoint', '/source/supabase/functions/' + name + '/index.ts', '--output', '/output/bundle.eszip', '--timeout', '60']);
          prepared[sha][name] = sha256(fs.readFileSync(path.join(out, 'bundle.eszip')));
        }
      }

      inProgress.operation = 'start_database_services';
      writeHostedStackConfig(stack, project, ports, readSupabaseConfig().major, [
        'site_url = "http://127.0.0.1:3001"', 'jwt_secret = "env(SUPABASE_AUTH_JWT_SECRET)"',
      ], true);
      fs.writeFileSync(path.join(stack, 'supabase/seed.sql'), 'CREATE SCHEMA api AUTHORIZATION postgres;\n');
      await docker(['network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', project]);
      guard = await imageGuard(pins, path.join(scratch, 'pins.json'), vars, database);
      await runQuiet(cli, ['start', '--workdir', stack, '--network-id', project, '-x',
        loadLaneConfig().exclude.filter(service => service !== 'postgrest').join(',')], guard.env, 360_000);
      await verifyHostedDatabaseInit(checked, vars, database);
      status = JSON.parse(await runQuiet(cli, ['status', '--workdir', stack, '-o', 'json'], guard.env));
      assertLoopbackOnly({ SUPABASE_URL: status.API_URL, DATABASE_URL: status.DB_URL }, 'renderer rehearsal');
      assert.equal(new URL(status.DB_URL).port, String(dbPort));
      assert.equal(new URL(status.API_URL).port, String(apiPort));
      db = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
      admin = (...sql) => docker(['exec', database, 'sh', '-ec', 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql "$@"', 'sh',
        '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1',
        ...sql.flatMap(command => ['-c', command])]);
      await db.connect();
      await disableHostedAutovacuum(status.DB_URL, dbPort, admin, db);
      await configureHostedDatabase(admin, db, false);
      inProgress.operation = 'replay_tagged_schema';
      await migrate(chosen[tagged]);
      inProgress.operation = 'serve_tagged_bundles';
      const runtimeEnv = { ...edge.vars, EDGE_ENVIRONMENT: 'local', LABEL_RENDERER_INVOKE_URL: invokeUrl,
        EDGE_SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY };
      await runQuiet('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', project,
        '--name', project + '-edge', '--network-alias', 'rehearsal-edge', '-p', '127.0.0.1:' + runtimePort + ':9000',
        '-v', runtimeDir + ':/rehearsal:ro', ...Object.keys(runtimeEnv).flatMap(name => ['-e', name]),
        runtimePin.runtimeId, 'start', '--main-service', '/rehearsal'], { ...vars, ...runtimeEnv });
      await use(workers.map(() => tagged));
      delete inProgress.operation;
    });

    await phase('original_receipts', async () => {
      await admin("ALTER SYSTEM SET pg_net.batch_size = '0'", 'SELECT pg_reload_conf()', 'SELECT net.worker_restart()');
      await waitFor(async () => (await db.query('SHOW pg_net.batch_size')).rows[0]['pg_net.batch_size'] === '0',
        'Could not pause the local pg_net queue');
      await admin(`CREATE SCHEMA rehearsal;
        CREATE TABLE rehearsal.storage_writes(name text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE FUNCTION rehearsal.record_storage_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp AS $storage$
        BEGIN
          INSERT INTO rehearsal.storage_writes(name) VALUES (NEW.name);
          RETURN NEW;
        END; $storage$;
        REVOKE ALL ON FUNCTION rehearsal.record_storage_write() FROM PUBLIC;
        CREATE TRIGGER rehearsal_storage_write AFTER INSERT OR UPDATE OF version ON storage.objects
        FOR EACH ROW WHEN (NEW.bucket_id = 'labels') EXECUTE FUNCTION rehearsal.record_storage_write();
        GRANT USAGE ON SCHEMA rehearsal TO postgres;
        GRANT SELECT ON rehearsal.storage_writes TO postgres`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false),
        set_config('request.jwt.claim.role','service_role',false)`);
      await db.query(`SELECT public.upsert_label_provider_settings_v1('global',NULL,
        jsonb_build_object('version',1,'providers',jsonb_build_array(jsonb_build_object(
          'name','renderer-rehearsal','invoke_url',$1::text,'invoke_secret',$2::text))), 'Synthetic renderer rehearsal')`,
      [invokeUrl, edge.vars.LABEL_RENDERER_DB_JWT]);
      legacy = await seed('legacy');
    });

    await phase('migration_hold_and_upgrade', async () => {
      inProgress.operation = 'install_exact_hold';
      await db.query(hold);
      inProgress.operation = 'authorize_local_renderer_url';
      await admin("ALTER DATABASE postgres SET app.local_label_renderer_url = '" + invokeUrl + "'");
      inProgress.operation = 'replay_to_hold_window';
      await migrate(chosen[main], beforeTransportGate);
      inProgress.operation = 'prove_held_leased_receipts';
      leased = await seed('leased');
      const held = await checkpoint('after_exact_hold_before_transport_gate');
      assert(held.filter(work => work.edgeJobId).every(work => work.queue.scheduled === 'infinity' && !work.queue.leased && work.queue.retries === 0),
        '#919 did not hold the original leased receipts');
      await dispatch(leased, 'job_not_claimable');

      inProgress.operation = 'replay_remaining_migrations';
      await migrate(chosen[main]);
      assert((await db.query("SELECT to_regprocedure('public.hold_renderer_upgrade_job_v1()') IS NULL AS released")).rows[0].released,
        'The release migration did not remove the hold');
      await dispatch(leased, 'job_spec_invalid');
      await checkpoint('tagged_caller_deferred_after_hold_release');
      delete inProgress.operation;
    });

    await phase('mixed_versions', async () => {
      await use([main, main, tagged]);
      await due(leased);
      await dispatch(leased, 'renderer_transport_deferred');
      await checkpoint('signed_caller_tagged_renderer');
      // Leave the legacy renderer active while the tagged pg_net envelopes drain.
      await admin('ALTER SYSTEM RESET pg_net.batch_size', 'SELECT pg_reload_conf()', 'SELECT net.worker_restart()');
      await waitFor(async () => (await Promise.all(legacy.map(work => observe(db, work)))).every(work => work.receipt.completed),
        'Original tagged pg_net receipts did not settle');
      legacy.forEach(work => { work.phase = 'complete'; });
      await checkpoint('tagged_pg_net_receipts_settled', legacy.map(work => work.requestId));
      await use(workers.map(() => main));
      await due(leased);
      await dispatch(leased);
      leased.forEach(work => { work.phase = 'complete'; });
    });

    await phase('rollback_and_reapply', async () => {
      await use(workers.map(() => tagged));
      rollback = await seed('rollback');
      await dispatch(rollback, 'job_spec_invalid');
      await dispatch(leased, 'job_not_claimable');
      const completed = [...legacy, ...leased].map(work => work.requestId);
      await checkpoint('tagged_bundles_restored', completed);
      await use(workers.map(() => main));
      await due(rollback);
      // The migrated schema defaults dispatch to disabled until the local relay is configured.
      await db.query(`SELECT public.upsert_settings_value_v1('edge_dispatch_policy', 'global', NULL,
        jsonb_build_object('endpoint_url', $1::text, 'enabled', true), 1, 'Synthetic renderer rehearsal')`,
      [bridgeUrl + '/functions/v1/api-caller']);
      const { rows: [relay] } = await db.query('SELECT endpoint_matches, dispatch_enabled FROM public.outbound_wake_relay_state_v1()');
      assert(relay.endpoint_matches && relay.dispatch_enabled, 'Local rollback recovery relay is disabled');
      inProgress.relay = relay;
      const wake = await apiCall('outbound-wake', 'POST', {});
      assert.equal(wake.status, 202, 'Rollback recovery wake was not accepted');
      await wake.body?.cancel();
      await waitFor(async () => (await Promise.all(rollback.map(work => observe(db, work)))).every(work => work.receipt.completed),
        'Reapplied wake and caller did not settle the rollback receipts');
      rollback.forEach(work => { work.phase = 'complete'; });
      await dispatch([...leased, ...rollback], 'job_not_claimable');
    });
  } catch (error) {
    if (inProgress) {
      inProgress.endedAt = new Date().toISOString();
      inProgress.failure = error.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] :
        /^[a-zA-Z_0-9 ,()-]+$/.test(error.message) ? error.message : (error.code || error.name);
      persist();
    }
    throw error;
  } finally {
    await db?.end();
    guard?.child.kill();
    // Stack, build cache and synthetic credentials disappear with the disposable runner.
  }
}

async function main() {
  assert(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted' && /^\d+$/.test(process.env.GITHUB_RUN_ID),
  'Rehearsal requires its own GitHub-hosted Linux runner');
  const temp = process.env.RUNNER_TEMP;
  const report = {
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    runUrl: process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID,
    status: 'FAILED',
    phases: Object.fromEntries(phases.map(name => [name, { status: 'NOT_RUN' }])),
    managed: Object.fromEntries(['function_upload', 'interruption', 'resume', 'rollback_republish', 'pooler_pre_apply']
      .map(name => [name, { status: 'NOT_RUN', reason: 'Requires an isolated managed Supabase project. This stack runs on the CI runner.' }])),
    substitute: 'The runner compiles and serves v0.1.0 and main ESZIPs for api-caller, outbound-wake and label-renderer.',
  };
  const persist = () => fs.writeFileSync(path.join(temp, 'renderer-upgrade.json'), JSON.stringify(report, null, 2) + '\n');
  persist();
  try {
    await rehearse(report, persist, fs.mkdtempSync(path.join(temp, 'renderer-upgrade-')));
    report.status = 'PASS';
  } catch (error) {
    const failed = Object.entries(report.phases).find(([, phase]) => phase.status === 'FAILED');
    console.error(failed ? [failed[0], failed[1].operation, failed[1].failure || 'failed'].filter(Boolean).join(': ')
      : 'Rehearsal source preflight failed');
    process.exitCode = 1;
  } finally {
    persist();
  }
}

main().catch(() => { console.error('Rehearsal could not initialize evidence on a disposable runner'); process.exitCode = 1; });
