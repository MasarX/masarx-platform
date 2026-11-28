'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { run } = require('./process.cjs');
const { sanitize, environmentSecrets, outputTail } = require('./diagnostics.cjs');

const imagePrefix = image => String(image || '').replace(/(sha256:[a-f0-9]{12})[a-f0-9]+/g, '$1');
const belongsToStack = (row, project) => String(row.Names || '').split(',').some(name => name.endsWith(`_${project}`))
  || String(row.Labels || '').split(',').includes(`com.supabase.cli.project=${project}`);
const isGitHubHosted = env => env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
const isHostedPgtap = env => isGitHubHosted(env) && Boolean(env.PGTAP_SHARD);
const needsHostedDatabaseInit = env => isGitHubHosted(env) && (Boolean(env.PGTAP_SHARD) || env.GITHUB_JOB === 'database-build');

async function captureDatabaseLog({ project, env, logFile, execute = run }) {
  const secrets = environmentSecrets(env);
  const container = `supabase_db_${project}`;
  const fullLog = isHostedPgtap(env);
  const options = { env, timeout: 10000, quiet: true, includeStderr: true, printQuietFailure: false };
  try {
    const tailLimit = fullLog ? [] : ['--tail', '20000'];
    const logs = await execute('docker', ['logs', ...tailLimit, '--timestamps', container], options);
    fs.writeFileSync(logFile, sanitize(logs, secrets));
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'postgres_log=true\n');
    const tail = outputTail(logs, secrets).trimEnd().replace(/\r/g, '');
    // Prefix each line so runner commands in server output are inert.
    if (tail) console.log(`Postgres server log tail:\n${tail.split('\n').map(line => `| ${line}`).join('\n')}`);
  } catch (error) {
    console.warn(`Could not capture Postgres server log: ${sanitize(error.message, secrets)}`);
  }
  if (fullLog) {
    try {
      // Record only timestamps and exit codes. Probe output may contain connection data.
      const health = await execute('docker', ['inspect', '--format',
        '{{with .State.Health}}{{range .Log}}{{.Start.UnixNano}} {{.End.UnixNano}} {{.ExitCode}}{{println}}{{end}}{{end}}',
        container], options);
      for (const row of health.trim().split('\n').filter(line => /^\d+ \d+ -?\d+$/.test(line))) {
        console.log(`Postgres health probe (start ns, end ns, exit code) ${row}`);
      }
    } catch (error) {
      console.warn(`Could not capture Postgres probe exit timing: ${sanitize(error.message, secrets)}`);
    }
  }
}

const integrationServices = project => ({ edge: `supabase_edge_runtime_${project}`, gateway: `supabase_kong_${project}` });
const eventFilters = ['--filter', 'type=container', '--filter', 'type=network', '--format', '{{json .}}'];
const eventLimit = 60;

function integrationLifecycleEvent(project, ids = new Map()) {
  const names = new Map(Object.entries(integrationServices(project)).map(([service, name]) => [name, service]));
  const actions = /^(?:create|start|restart|die|oom|kill|stop|destroy|connect|disconnect|health_status: (?:starting|healthy|unhealthy))$/;
  return ({ Type, Actor, Action, time }) => {
    const service = Type === 'network' ? ids.get(Actor?.Attributes?.container) : names.get(Actor?.Attributes?.name);
    if (!service || !actions.test(Action) || !Number.isInteger(time)) return [];
    if (Type === 'container' && Actor.ID) ids.set(Actor.ID, service);
    const exitCode = Actor.Attributes?.exitCode;
    return [{ service, action: Action, time, ...(Action === 'die' && /^\d{1,3}$/.test(exitCode) ? { exitCode: Number(exitCode) } : {}) }];
  };
}

function observeIntegrationEdgeLifecycle({ project, env, since, launch = spawn }) {
  // Docker retains only 256 historical events across the daemon, including the pgTAP clients.
  const child = launch('docker', ['events', '--since', since, ...eventFilters], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const classify = integrationLifecycleEvent(project);
  const lifecycle = [];
  let partial = false;
  let stopping = false;
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    try {
      lifecycle.push(...classify(JSON.parse(line)));
      if (lifecycle.length > eventLimit) lifecycle.shift();
    } catch { partial = true; }
  });
  const result = new Promise(resolve => {
    child.once('error', () => { partial = true; });
    child.once('close', () => resolve({ lifecycle, lifecycleCapture: stopping && !partial ? 'live' : 'partial' }));
  });
  return () => {
    if (!stopping && child.exitCode === null && child.signalCode === null) stopping = child.kill();
    return result;
  };
}

async function captureIntegrationEdge({ project, env, since, stopEvents, execute = run }) {
  const services = integrationServices(project);
  const options = { env, timeout: 5000, quiet: true, printQuietFailure: false };
  const capture = async (args, parse) => {
    try { return parse(await execute('docker', args, { ...options, includeStderr: args[0] === 'logs' })); }
    catch { return null; }
  };
  const timestamp = value => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? value : null;
  const stateFormat = '{"id":{{json .Id}},"state":{{json .State}},"restarts":{{json .RestartCount}},"networks":{{json .NetworkSettings.Networks}}}';
  const state = service => capture(['inspect', '--format', stateFormat, services[service]], JSON.parse);
  const rules = {
    edge: [
      ['worker_boot', /worker.{0,40}(?:boot|creation).{0,40}(?:error|fail)|failed to (?:boot|create) worker/i],
      ['memory_limit', /out of memory|memory limit|allocation failed|WORKER_RESOURCE_LIMIT/i],
      ['panic', /panicked at|fatal runtime error/i],
      ['worker_shutdown', /worker.{0,40}(?:shutdown|terminated|evicted)/i],
      ['cache_open_failed', /Could not initialize cache database .*(?:CannotOpen|unable to open (?:the )?database file)/i],
      ['cache_contention', /Could not initialize cache database .*(?:DatabaseBusy|DatabaseLocked|database is locked)/i],
      ['cache_replacement', /Could not initialize cache database .*deleting and retrying/i],
      ['bus_error', /\bSIGBUS\b|\bbus error\b/i],
    ],
    gateway: [
      ['dns_failure', /name resolution failed|dns server error|could not resolve/i],
      ['upstream_closed', /upstream prematurely closed|connection reset by peer/i],
      ['upstream_connect', /connect\(\) failed|connection refused/i],
      ['upstream_timeout', /upstream timed out/i],
      ['http_502', /HTTP\/\d(?:\.\d)?" 502\b/],
      ['http_503', /HTTP\/\d(?:\.\d)?" 503\b/],
    ],
  };
  // Keep timestamps and fixed classifications. Request bodies, URLs and daemon metadata stay out of the report.
  const logs = service => capture(['logs', '--tail', '200', '--timestamps', services[service]], raw => raw.trim().split(/\r?\n/)
    .filter(line => service === 'edge' || /\/functions\/v1\/(?:label-renderer|webhook-receiver)\b/.test(line))
    .flatMap(line => rules[service].filter(([, pattern]) => pattern.test(line))
      .map(([kind]) => ({ at: timestamp(line.split(' ', 1)[0]), kind }))).slice(-30));
  const until = new Date().toISOString();
  const [edge, gateway, edgeLogs, gatewayLogs, events] = await Promise.all([
    state('edge'), state('gateway'), logs('edge'), logs('gateway'),
    stopEvents ? undefined : capture(['events', '--since', since, '--until', until, ...eventFilters],
      raw => raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))),
  ]);
  const networkIds = row => Object.values(row?.networks ?? {}).filter(network => network.EndpointID).map(network => network.NetworkID);
  const describe = row => row && ({ status: row.state.Status, running: row.state.Running, restarting: row.state.Restarting, oomKilled: row.state.OOMKilled,
    exitCode: row.state.ExitCode, restarts: row.restarts, health: row.state.Health?.Status ?? 'none',
    startedAt: timestamp(row.state.StartedAt), finishedAt: timestamp(row.state.FinishedAt), networkCount: networkIds(row).length });
  const ids = new Map([[edge?.id, 'edge'], [gateway?.id, 'gateway']].filter(([id]) => id));
  const history = stopEvents ? await stopEvents() : {
    lifecycle: events?.flatMap(integrationLifecycleEvent(project, ids)).slice(-eventLimit) ?? null,
    lifecycleCapture: events ? 'history' : 'unavailable',
  };
  return { since, until, edge: describe(edge), gateway: describe(gateway),
    sharedNetwork: edge && gateway ? networkIds(edge).some(id => networkIds(gateway).includes(id)) : null,
    ...history, edgeLogs, gatewayLogs };
}

async function collectStackDiagnostics({ project, env, dockerRoot, imagePolicy = {}, logFile, execute = run }) {
  const report = { containers: [], logs: [], unhealthy: [], errors: [], imagePolicy };
  const secrets = environmentSecrets(env);
  const deadline = Date.now() + 60000;
  const emit = value => {
    const clean = sanitize(value, secrets);
    console.log(clean);
    if (logFile) fs.appendFileSync(logFile, `${clean}\n`);
    return clean;
  };
  const capture = async (command, args) => {
    const remaining = deadline - Date.now();
    try {
      if (remaining <= 0) throw new Error('Startup diagnostics deadline exhausted');
      return await execute(command, args, { env, quiet: true, includeStderr: command === 'docker' && args[0] === 'logs', timeout: Math.min(10000, remaining) });
    } catch (error) {
      report.errors.push(emit(`${command} ${args[0]} diagnostic failed: ${error.message}\n${error.failure?.output || ''}`));
      return '';
    }
  };
  emit('Startup diagnostics (60-second command budget)');
  emit(`Digest guard: ${JSON.stringify({ decision: imagePolicy.decision, allowed: imagePolicy.allowed, denied: imagePolicy.denied, denials: imagePolicy.denials })}`);
  report.unreviewedImages = (imagePolicy.imageRequests || []).filter(request => !request.reviewed);
  emit(`CLI image requests: ${JSON.stringify(imagePolicy.imageRequests || [])}`);
  emit(`CLI images outside reviewed pins: ${JSON.stringify(report.unreviewedImages)}`);
  emit(`Last guarded Docker request: ${JSON.stringify(imagePolicy.lastRequest || null)}`);
  report.containerRequests = (imagePolicy.requests || []).filter(request => /\/(?:containers|exec)\//.test(request.path));
  for (const request of report.containerRequests) emit(`Guarded container request (admission order): ${JSON.stringify(request)}`);
  report.disk = emit(await capture('df', ['-h', '/', dockerRoot]));
  report.memory = emit(await capture('free', ['-m']));
  try {
    const rows = (await capture('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const format = '{"id":{{json .Id}},"imageId":{{json .Image}},"state":{{json .State}}}';
    const states = rows.length ? (await capture('docker', ['inspect', '--format', format, ...rows.map(row => row.ID)]))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    for (const row of rows) {
      const inspected = states.find(state => state.id === row.ID);
      const state = inspected?.state || {};
      const container = { id: row.ID.slice(0, 12), name: sanitize(row.Names, secrets), image: sanitize(imagePrefix(row.Image), secrets), imageId: imagePrefix(inspected?.imageId),
        status: sanitize(row.Status, secrets), health: state.Health?.Status || 'none' };
      report.containers.push(container);
      emit(`docker ps -a: ${JSON.stringify(container)}`);
      if (!belongsToStack(row, project)) continue;
      if (state.Restarting || state.Status === 'restarting' || state.Health?.Status === 'unhealthy') {
        report.unhealthy.push({ name: row.Names, state: emit(`docker inspect health ${row.Names}: ${JSON.stringify(state)}`) });
      }
      emit(`Container ${row.Names}: last 60 log lines`);
      report.logs.push({ name: row.Names, output: emit(await capture('docker', ['logs', '--tail', '60', '--timestamps', row.ID])) });
    }
    if (!rows.some(row => belongsToStack(row, project))) emit('No stack containers remain for log collection');
  } catch (error) { report.errors.push(emit(`Container diagnostic parsing failed: ${error.message}`)); }
  return report;
}

module.exports = { captureDatabaseLog, captureIntegrationEdge, observeIntegrationEdgeLifecycle, collectStackDiagnostics,
  imagePrefix, belongsToStack, isHostedPgtap, needsHostedDatabaseInit };
