'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = process.env;
const state = path.join(env.RUNNER_TEMP, 'ci-job-timing.json');
const now = Date.now();
const seconds = ms => Math.max(0, ms) / 1000;

function publish(timing) {
  const backend = ['database-build', 'database-pgtap'].includes(env.GITHUB_JOB);
  const report = env.GITHUB_JOB === 'database-build' ? 'backend.json' : 'pgtap.json';
  const file = path.join(env.GITHUB_WORKSPACE, 'ci-reports', report);
  let stages = [];
  if (backend && fs.existsSync(file)) {
    try {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(report.stages)) stages = report.stages;
    } catch {
      console.log('CI database phase timings unavailable');
    }
  }
  const duration = name => {
    const stage = stages.find(row => name.test(row.name));
    return stage ? seconds(stage.durationMs) : null;
  };
  const summary = {
    job: env.GITHUB_JOB,
    setup_seconds: Object.fromEntries(Object.entries(timing.phases).filter(([name]) => name !== 'workload' && name !== 'reporting')),
    npm_cache: timing.cache,
    image_pull_seconds: duration(/^image-pulls$/),
    replay_seconds: duration(/^migrations$/),
    test_seconds: backend ? duration(/^pgtap:/)
      : ['unit', 'ui', 'e2e', 'visual-baselines'].includes(env.GITHUB_JOB) ? timing.phases.workload ?? null : null,
    workload_seconds: timing.phases.workload ?? null,
  };
  for (const stage of stages) {
    if (['npm-install', 'stack-start', 'autovacuum-off', 'database-settings'].includes(stage.name)) {
      summary.setup_seconds[stage.name] = seconds(stage.durationMs);
    }
  }
  const payload = JSON.stringify(summary);
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### CI timing\n\n\`\`\`json\n${payload}\n\`\`\`\n`);
  console.log(`CI timing: ${payload}`);
}

try {
  if (env.STATE_timing === 'publish') {
    const timing = JSON.parse(fs.readFileSync(state, 'utf8'));
    timing.phases[timing.phase] = seconds(now - timing.started);
    publish(timing);
  } else if (!env.STATE_timing) {
    const phase = env.INPUT_PHASE;
    const timing = phase === 'prepare' ? { phases: {}, cache: 'NOT_RUN' } : JSON.parse(fs.readFileSync(state, 'utf8'));
    if (timing.phase) timing.phases[timing.phase] = seconds(now - timing.started);
    if (['hit', 'miss'].includes(env['INPUT_NPM-CACHE'])) timing.cache = env['INPUT_NPM-CACHE'];
    fs.writeFileSync(state, JSON.stringify({ ...timing, phase, started: now }));
    fs.appendFileSync(env.GITHUB_STATE, `timing=${phase === 'prepare' ? 'publish' : 'ignore'}\n`);
  }
} catch {
  console.log('CI timing summary unavailable');
}
