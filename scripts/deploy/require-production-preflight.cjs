'use strict';

const { execFileSync } = require('node:child_process');

function requireProductionPreflight({ appRun, repo, tag, sha }, exec = execFileSync) {
  if (!appRun || !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repo) ||
      !/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('invalid production preflight configuration');
  }

  const [org, name] = repo.split('/');
  // https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
  const endpoint = `repos/${repo}/actions/workflows/production-preflight.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`;
  let pages;
  try {
    pages = JSON.parse(exec('python', [
      '-I', appRun, '--org', org, '--repo', name, 'gh', 'api', '--paginate', '--slurp', endpoint,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true }));
  } catch {
    throw new Error('could not read production preflight runs');
  }
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.workflow_runs))) {
    throw new Error('invalid production preflight run inventory');
  }

  let latest;
  for (const { workflow_runs: runs } of pages) {
    for (const run of runs) {
      if (run?.head_branch !== tag || run.head_sha !== sha || run.event !== 'workflow_dispatch') continue;
      if (!Number.isSafeInteger(run.id) || run.id <= 0) throw new Error('invalid production preflight run ID');
      if (!latest || run.id > latest.id) latest = run;
    }
  }
  if (latest?.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('latest production preflight for the release tag and SHA must complete successfully');
  }
  return latest.id;
}

if (require.main === module) {
  const [appRun, repo, tag, sha] = process.argv.slice(2);
  try {
    const id = requireProductionPreflight({ appRun, repo, tag, sha });
    console.log(`production_preflight_run=${id}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { requireProductionPreflight };
