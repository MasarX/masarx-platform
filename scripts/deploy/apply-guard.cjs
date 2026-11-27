const { appendFileSync, readFileSync } = require('node:fs');
const { RETRYABLE_NETWORK_ERROR_CODES } = require('../ops/ci/github-api-retry');

const attemptMarker = 'Record database push attempt';
const legacyDeploy = 'Apply migrations and deploy registered edge functions';
const defaultHistoryDays = '30';
const deploymentBranches = ['main', 'dev'];
class HistoryLimitError extends Error {}

async function* pages(get, path, field) {
  for (let page = 1; page <= 10; page++) {
    const result = await get(`${path}&per_page=100&page=${page}`);
    if (result.total_count >= 1000) throw new HistoryLimitError();
    const rows = result[field];
    yield* rows;
    if (rows.length < 100) return;
  }
  throw new HistoryLimitError();
}

async function evaluate(get, env, record) {
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  const workflowFile = workflowRef
    ? /^[^/]+\/[^/]+\/\.github\/workflows\/([^/@]+\.ya?ml)@refs\/.+$/.exec(workflowRef)?.[1]
    : 'deploy.yml';
  if (!workflowFile) throw new Error('Invalid GITHUB_WORKFLOW_REF');
  const workflow = '/actions/workflows/' + encodeURIComponent(workflowFile) + '/runs';
  const isTag = env.GITHUB_REF?.startsWith('refs/tags/');

  const shaPattern = /^[0-9a-f]{40}$/;
  const tip = (await get('/git/ref/heads/main'))?.object?.sha;
  if (typeof tip !== 'string' || !shaPattern.test(tip)) throw new Error('Invalid main tip');

  if (env.GITHUB_EVENT_NAME === 'push') {
    let replacement;
    if (env.GITHUB_SHA !== tip) {
      for await (const run of pages(get, `${workflow}?branch=main&event=push&head_sha=${tip}`, 'workflow_runs')) {
        if (run.run_number > Number(env.RUN_NUMBER) && (!replacement || run.run_number > replacement.run_number)) {
          replacement = run;
        }
      }
    }
    if (replacement) {
      const { id, status, conclusion } = replacement;
      if (status === 'completed' && !['success', 'failure'].includes(conclusion)) {
        record(`G1: superseding run ${id} for ${tip} was ${conclusion}; dispatch expected_sha=${tip}`);
        return 'refused';
      }
      record(`G1: superseded by ${tip}`);
      return 'superseded';
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

  const now = Date.now();
  const maxHistoryDays = 400;
  const historyDays = (isTag && env.DB_APPLY_HISTORY_DAYS) || defaultHistoryDays;
  const historyStart = new Date(now - Number(historyDays) * 24 * 60 * 60 * 1000);
  // GitHub returns no runs for a created= range starting before 1970, which would read as "no previous apply".
  if (!/^[1-9]\d*$/.test(historyDays) || Number(historyDays) > maxHistoryDays) {
    throw new Error(`DB_APPLY_HISTORY_DAYS must be a positive whole number of days, at most ${maxHistoryDays}`);
  }
  const isoSecond = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const created = encodeURIComponent(`${isoSecond(historyStart)}..${isoSecond(new Date(now))}`);
  let latest;
  for (const branch of isTag ? [''] : deploymentBranches) {
    const branchFilter = branch ? 'branch=' + branch + '&' : '';
    for await (const run of pages(get, `${workflow}?${branchFilter}created=${created}`, 'workflow_runs')) {
      for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
        if (String(run.id) === env.GITHUB_RUN_ID && attempt >= Number(env.GITHUB_RUN_ATTEMPT)) continue;
        const path = `/actions/runs/${run.id}/attempts/${attempt}/jobs?`;
        for await (const job of pages(get, path, 'jobs')) {
          const isDatabase = job.name === 'database'
            || (isTag && typeof job.name === 'string' && job.name.endsWith(' / database'));
          if (!isDatabase || job.status !== 'completed') continue;
          // Missing step data cannot rule out an apply attempt.
          const steps = Array.isArray(job.steps) ? job.steps : undefined;
          const marker = steps?.find(step => step.name === attemptMarker);
          const legacy = steps?.find(step => step.name === legacyDeploy);
          // Cancellation can prevent the marker from running after the combined step starts.
          const attempted = !steps || ['success', 'cancelled', 'timed_out'].includes(legacy?.conclusion)
            || marker?.conclusion === 'success' || (!marker && legacy?.conclusion === 'failure');
          if (!attempted) continue;

          const completedAt = Date.parse(job.completed_at);
          if (!Number.isFinite(completedAt)) throw new Error('Invalid database completion time');
          if (!latest || completedAt > latest.completedAt ||
              (completedAt === latest.completedAt && job.conclusion !== 'success')) {
            latest = { id: run.id, conclusion: job.conclusion, completedAt };
          }
        }
      }
    }
  }
  if (!latest) {
    record('G2: no previous apply found');
  } else if (latest.conclusion === 'success') {
    record(`G2: previous apply at run ${latest.id} concluded success`);
  } else {
    const rearmed = isTag ? env.DB_REARMED_AT : env.DEV_DB_REARMED_AT;
    const rearmedAt = Date.parse(rearmed);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rearmed ?? '') ||
        !(rearmedAt > latest.completedAt && rearmedAt <= now)) {
      record(`G2: previous apply failed at run ${latest.id}; re-arm required`);
      return 'refused';
    }
    record(`G2: re-armed after run ${latest.id}`);
  }
  return 'allow';
}

function databaseHeader(env, section) {
  return '## ' + (env.DEPLOY_ENV || 'dev').toUpperCase() + ' database ' + section;
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
    databaseHeader(env, 'apply'), '',
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
    const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`;
    const endpoint = path.split('?')[0];
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      let response;
      let reason;
      try {
        response = await fetchRequest(url, {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return await response.json();
      } catch (error) {
        if (response?.ok && error?.name === 'SyntaxError') throw new Error(`invalid JSON from ${endpoint}`);
        if (attempt === maxAttempts) throw error;
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          reason = 'timeout';
        } else if (RETRYABLE_NETWORK_ERROR_CODES.has(error?.cause?.code ?? error?.code) ||
          error?.message === 'terminated' || error?.message === 'socket hang up' ||
          (error?.message === 'fetch failed' && !error.cause)) {
          reason = 'network';
        } else {
          throw error;
        }
      }
      if (!reason) {
        const { status } = response;
        if (attempt === maxAttempts || ![429, 502, 503, 504].includes(status)) {
          throw new Error(`GitHub API returned HTTP ${status} for ${endpoint}`);
        }
        reason = `http-${status}`;
        void response.body?.cancel().catch(() => {});
      }
      console.log(`guard_api_retry attempt=${attempt + 1} reason=${reason}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  };
  const record = decision => {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${decision}\n`);
    console.log(decision);
  };
  appendFileSync(env.GITHUB_STEP_SUMMARY, databaseHeader(env, 'guard') + '\n\n');
  try {
    const result = await evaluate(get, env, record);
    if (result === 'refused') return 1;
    appendFileSync(env.GITHUB_OUTPUT, `superseded=${result === 'superseded'}\n`);
    return 0;
  } catch (error) {
    const detail = error instanceof HistoryLimitError ? 'history scan limit reached' : error?.message || 'unknown error';
    const redacted = env.GH_TOKEN ? detail.replaceAll(env.GH_TOKEN, '[redacted]') : detail;
    const message = `Guard could not verify GitHub deployment state: ${redacted.replace(/[\r\n]+/g, ' ')}`;
    appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
    console.error(`::error::${message.replaceAll('%', '%25')}`);
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
