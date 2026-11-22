const { appendFileSync, readFileSync } = require('node:fs');

const workflow = '/actions/workflows/deploy.yml/runs';
const attemptMarker = 'Record database push attempt';
const legacyDeploy = 'Apply migrations and deploy registered edge functions';

async function* pages(get, path, field) {
  for (let page = 1; ; page++) {
    const rows = (await get(`${path}&per_page=100&page=${page}`))[field];
    yield* rows;
    if (rows.length < 100) return;
  }
}

async function evaluate(get, env, record) {
  const tip = (await get('/git/ref/heads/main')).object.sha;
  if (!/^[0-9a-f]{40}$/.test(tip)) throw new Error('Invalid main tip');

  if (env.GITHUB_EVENT_NAME === 'push') {
    if (env.GITHUB_SHA !== tip) {
      for await (const run of pages(get, `${workflow}?branch=main&event=push&head_sha=${tip}`, 'workflow_runs')) {
        if (run.run_number > Number(env.RUN_NUMBER)) {
          if (run.status === 'completed' && !['success', 'failure'].includes(run.conclusion)) {
            record(`G1: superseding run ${run.id} for ${tip} was ${run.conclusion}; dispatch expected_sha=${tip}`);
            return 'refused';
          }
          record(`G1: superseded by ${tip}`);
          return 'superseded';
        }
      }
    }
    record('G1: no superseding push');
    record('G3: not applicable to push');
  } else {
    record('G1: not applicable to dispatch');
    if (env.EXPECTED_SHA !== tip || env.GITHUB_SHA !== tip) {
      record('G3: expected_sha must equal both the main tip and github.sha');
      return 'refused';
    }
    record('G3: dispatch SHA matched');
  }

  for await (const run of pages(get, `${workflow}?branch=main`, 'workflow_runs')) {
    for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
      if (String(run.id) === env.GITHUB_RUN_ID && attempt >= Number(env.GITHUB_RUN_ATTEMPT)) continue;
      const path = `/actions/runs/${run.id}/attempts/${attempt}/jobs?`;
      for await (const job of pages(get, path, 'jobs')) {
        if (job.name !== 'database' || job.status !== 'completed') continue;
        const marker = job.steps.find(step => step.name === attemptMarker);
        const legacy = job.steps.find(step => step.name === legacyDeploy);
        // Cancellation can prevent the marker from running after the combined step starts.
        const attempted = ['success', 'cancelled', 'timed_out'].includes(legacy?.conclusion)
          || marker?.conclusion === 'success' || (!marker && legacy?.conclusion === 'failure');
        if (!attempted) continue;

        if (job.conclusion !== 'success') {
          const rearmed = env.DEV_DB_REARMED_AT;
          const rearmedAt = Date.parse(rearmed);
          if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rearmed ?? '') ||
              !(rearmedAt > Date.parse(job.completed_at) && rearmedAt <= Date.now())) {
            record(`G2: previous apply failed at run ${run.id}; re-arm required`);
            return 'refused';
          }
          record(`G2: re-armed after run ${run.id}`);
        } else {
          record(`G2: previous apply at run ${run.id} concluded ${job.conclusion}`);
        }
        return 'allow';
      }
    }
  }
  record('G2: no previous apply found');
  return 'allow';
}

function summarize(log, status, elapsed, env) {
  const applied = new Set();
  let pending;
  let failed = false;
  let retries = 0;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('::warning::Supabase db push failed with SQLSTATE ')) {
      if (line.startsWith('::warning::Supabase db push failed with SQLSTATE 40P01 ')) retries++;
      pending = undefined;
      failed = false;
      continue;
    }
    if (failed) continue;
    if (line.startsWith('ERROR: ')) {
      pending = undefined;
      failed = true;
      continue;
    }
    const match = /^Applying migration (\d+_[a-z0-9_.-]+\.sql)\.\.\.$/i.exec(line);
    if (match) {
      if (pending) applied.add(pending);
      pending = match[1];
    }
  }
  if (status === '0' && pending) applied.add(pending);
  const names = [...applied];
  const redact = name => {
    if (!name) return 'None';
    const privateValues = [env.SUPABASE_PROJECT_REF, env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_PASSWORD, env.SUPABASE_JWT_SECRET];
    return privateValues.some(value => value && name.includes(value)) ? 'Redacted' : `\`${name}\``;
  };
  return [
    '## DEV database apply', '',
    `- SHA: ${env.GITHUB_SHA}`,
    `- Migration push duration: ${elapsed}s`,
    `- Migrations applied: ${names.length}${status === '0' ? '' : ' (confirmed from CLI progress; push failed)'}`,
    `- First migration: ${redact(names[0])}`,
    `- Last migration: ${redact(names.at(-1))}`,
    `- 40P01 retries: ${retries}`,
    '',
  ].join('\n');
}

async function guard(env, fetchRequest = fetch) {
  const get = async path => {
    const response = await fetchRequest(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`, {
      headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    return response.json();
  };
  const record = decision => {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${decision}\n`);
    console.log(decision);
  };
  appendFileSync(env.GITHUB_STEP_SUMMARY, '## DEV database guard\n\n');
  try {
    const result = await evaluate(get, env, record);
    appendFileSync(env.GITHUB_OUTPUT, `superseded=${result === 'superseded'}\n`);
    return result === 'refused' ? 1 : 0;
  } catch {
    const message = 'Guard could not verify GitHub deployment state';
    appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
    console.error(`::error::${message}`);
    return 1;
  }
}

if (require.main === module) {
  const [mode, log, status, elapsed] = process.argv.slice(2);
  if (mode === 'summarize') {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summarize(readFileSync(log, 'utf8'), status, elapsed, process.env));
  } else {
    guard(process.env).then(status => { process.exitCode = status; });
  }
}

module.exports = { evaluate, guard, summarize };
