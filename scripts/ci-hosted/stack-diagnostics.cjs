'use strict';
const fs = require('node:fs');
const { run } = require('./process.cjs');
const { sanitize, environmentSecrets } = require('./diagnostics.cjs');

const imagePrefix = image => String(image || '').replace(/(sha256:[a-f0-9]{12})[a-f0-9]+/g, '$1');
const belongsToStack = (row, project) => String(row.Names || '').split(',').some(name => name.endsWith(`_${project}`))
  || String(row.Labels || '').split(',').includes(`com.supabase.cli.project=${project}`);

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
      const container = { name: sanitize(row.Names, secrets), image: sanitize(imagePrefix(row.Image), secrets), imageId: imagePrefix(inspected?.imageId),
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

module.exports = { collectStackDiagnostics, imagePrefix, belongsToStack };
