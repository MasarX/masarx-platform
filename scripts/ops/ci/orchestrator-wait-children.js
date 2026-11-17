#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { requestGithubJson } = require('./github-api-retry');

function die(msg) {
  console.error(`[orchestrator-wait-children] ${msg}`);
  process.exit(1);
}

function toIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(String(value || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseBool01(value, fallback = true) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (raw === '1') return true;
  if (raw === '0') return false;
  die(`Expected boolean 0/1 value, got: ${raw}`);
}

function parseArgs(argv) {
  const out = {
    stage: '',
    sha: '',
    targetsJson: '',
    startedAt: '',
    timeoutMinutes: '',
    pollSeconds: '',
    summaryPath: '',
    format: '',
    waitForChildren: '',
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    if (!token) continue;
    if (token === '--stage') out.stage = String(args[++i] || '').trim();
    else if (token.startsWith('--stage=')) out.stage = token.split('=').slice(1).join('=').trim();
    else if (token === '--sha') out.sha = String(args[++i] || '').trim();
    else if (token.startsWith('--sha=')) out.sha = token.split('=').slice(1).join('=').trim();
    else if (token === '--targets-json') out.targetsJson = String(args[++i] || '').trim();
    else if (token.startsWith('--targets-json=')) out.targetsJson = token.split('=').slice(1).join('=').trim();
    else if (token === '--started-at') out.startedAt = String(args[++i] || '').trim();
    else if (token.startsWith('--started-at=')) out.startedAt = token.split('=').slice(1).join('=').trim();
    else if (token === '--timeout-minutes') out.timeoutMinutes = String(args[++i] || '').trim();
    else if (token.startsWith('--timeout-minutes=')) out.timeoutMinutes = token.split('=').slice(1).join('=').trim();
    else if (token === '--poll-seconds') out.pollSeconds = String(args[++i] || '').trim();
    else if (token.startsWith('--poll-seconds=')) out.pollSeconds = token.split('=').slice(1).join('=').trim();
    else if (token === '--summary-path') out.summaryPath = String(args[++i] || '').trim();
    else if (token.startsWith('--summary-path=')) out.summaryPath = token.split('=').slice(1).join('=').trim();
    else if (token === '--format') out.format = String(args[++i] || '').trim();
    else if (token.startsWith('--format=')) out.format = token.split('=').slice(1).join('=').trim();
    else if (token === '--wait-for-children') out.waitForChildren = String(args[++i] || '').trim();
    else if (token.startsWith('--wait-for-children=')) {
      out.waitForChildren = token.split('=').slice(1).join('=').trim();
    }
  }
  return out;
}

function parseTargets(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    die(`Invalid targets JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) die('targets JSON must be an array');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      die(`targets[${index}] must be an object`);
    }
    const surfaceId = String(item.surface_id || '').trim();
    const workflowId = String(item.workflow_id || '').trim();
    if (!surfaceId) die(`targets[${index}] missing surface_id`);
    if (!workflowId) die(`targets[${index}] missing workflow_id`);
    return {
      surface_id: surfaceId,
      workflow_id: workflowId,
    };
  });
}

function writeGithubOutput(values) {
  const outPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outPath) return;
  const lines = [];
  for (const [key, value] of Object.entries(values || {})) {
    lines.push(`${key}=${String(value == null ? '' : value)}`);
  }
  fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

async function listWorkflowRuns({ owner, repo, workflowId, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?per_page=100`;
  const payload = await requestGithubJson({
    token,
    url,
    userAgent: 'masarx-orchestrator-wait-children',
    maxAttempts: process.env.ORCHESTRATOR_GITHUB_API_MAX_ATTEMPTS || '',
    retryDelayMs: process.env.ORCHESTRATOR_GITHUB_API_RETRY_DELAY_MS || '',
  });
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  return runs;
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function selectWorkflowRunCandidate({ runs, sha, startedAtMs, pinnedRunId }) {
  const list = Array.isArray(runs) ? runs : [];
  if (pinnedRunId) {
    return list.find((row) => Number(row?.id) === Number(pinnedRunId)) || null;
  }
  const minCreatedAtMs = Math.max(0, Number(startedAtMs || 0) - (5 * 60 * 1000));
  const sameShaCandidates = list
    .filter((row) => String(row?.head_sha || '').trim() === sha)
    .sort((a, b) => parseTimeMs(b?.created_at) - parseTimeMs(a?.created_at));
  const scopedCandidates = sameShaCandidates
    .filter((row) => parseTimeMs(row?.created_at) >= minCreatedAtMs);
  const candidates = scopedCandidates.length > 0 ? scopedCandidates : sameShaCandidates;
  // Failed-job reruns reuse child workflow runs dispatched by the original attempt.
  // If the rerun start window excludes them, fall back to the newest same-SHA run.
  const activeCandidate = candidates.find((row) => String(row?.status || '').trim().toLowerCase() !== 'completed');
  if (activeCandidate) {
    return activeCandidate;
  }
  const successfulCandidate = candidates.find((row) => String(row?.conclusion || '').trim().toLowerCase() === 'success');
  if (successfulCandidate) {
    return successfulCandidate;
  }
  return candidates[0] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function computeAggregateConclusion(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return 'skipped';
  const failed = list.filter((row) => String(row?.conclusion || '') !== 'success');
  return failed.length ? 'failure' : 'success';
}

async function waitForChildrenRuns({
  stage,
  sha,
  targets,
  startedAt,
  timeoutMinutes,
  pollSeconds,
  token,
  owner,
  repo,
  listWorkflowRunsImpl = listWorkflowRuns,
  sleepImpl = sleep,
  nowImpl = Date.now,
}) {
  const startedAtIso = toIso(startedAt) || new Date().toISOString();
  const startedAtMs = parseTimeMs(startedAtIso);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const pollMs = pollSeconds * 1000;
  const deadline = nowImpl() + timeoutMs;

  const states = targets.map((target) => ({
    surface_id: target.surface_id,
    workflow_id: target.workflow_id,
    run_id: '',
    run_url: '',
    run_status: 'pending',
    conclusion: '',
    observed_at: '',
    fetch_error_count: 0,
    last_error: '',
  }));

  while (nowImpl() < deadline) {
    let allCompleted = true;
    for (const state of states) {
      if (state.run_status === 'completed' || state.run_status === 'timed_out' || state.run_status === 'missing') {
        continue;
      }
      allCompleted = false;
      let runs;
      try {
        runs = await listWorkflowRunsImpl({
          owner,
          repo,
          workflowId: state.workflow_id,
          token,
        });
      } catch (error) {
        state.fetch_error_count += 1;
        state.last_error = String(error?.message || error || '').trim();
        state.observed_at = new Date().toISOString();
        console.warn(
          `[orchestrator-wait-children] transient GitHub API failure for workflow=${state.workflow_id} surface=${state.surface_id}: ${state.last_error || 'unknown error'}`,
        );
        continue;
      }
      const candidate = selectWorkflowRunCandidate({
        runs,
        sha,
        startedAtMs,
        pinnedRunId: state.run_id || '',
      });
      if (!candidate) {
        state.run_status = 'waiting_for_run';
        state.observed_at = new Date().toISOString();
        continue;
      }
      state.run_id = String(candidate.id || '');
      state.run_url = String(candidate.html_url || '');
      state.run_status = String(candidate.status || 'unknown').trim().toLowerCase();
      state.conclusion = String(candidate.conclusion || '').trim().toLowerCase();
      state.observed_at = new Date().toISOString();
      if (state.run_status === 'completed' && !state.conclusion) {
        state.conclusion = 'unknown';
      }
    }
    if (allCompleted) break;
    await sleepImpl(pollMs);
  }

  for (const state of states) {
    if (state.run_status === 'completed') {
      if (!state.conclusion) state.conclusion = 'unknown';
      continue;
    }
    if (state.fetch_error_count > 0) {
      state.run_status = 'timed_out';
      state.conclusion = 'timed_out';
      state.observed_at = new Date().toISOString();
      continue;
    }
    if (state.run_status === 'waiting_for_run' || state.run_status === 'pending') {
      state.run_status = 'missing';
      state.conclusion = 'missing';
      state.observed_at = new Date().toISOString();
      continue;
    }
    state.run_status = 'timed_out';
    state.conclusion = 'timed_out';
    state.observed_at = new Date().toISOString();
  }

  const aggregate_conclusion = computeAggregateConclusion(states);
  return {
    stage,
    sha,
    started_at: startedAtIso,
    completed_at: new Date().toISOString(),
    timeout_minutes: timeoutMinutes,
    poll_seconds: pollSeconds,
    aggregate_conclusion,
    targets: states,
  };
}

function printSummary(summary) {
  const rows = Array.isArray(summary?.targets) ? summary.targets : [];
  console.log(`[orchestrator-wait-children] stage=${summary.stage} sha=${summary.sha}`);
  console.log(`[orchestrator-wait-children] aggregate_conclusion=${summary.aggregate_conclusion}`);
  for (const row of rows) {
    console.log(
      `[orchestrator-wait-children] surface=${row.surface_id} workflow=${row.workflow_id} run_id=${row.run_id || '<none>'} status=${row.run_status} conclusion=${row.conclusion}`,
    );
    if (row.run_url) {
      console.log(`[orchestrator-wait-children] surface=${row.surface_id} run_url=${row.run_url}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = String(args.stage || process.env.ORCHESTRATOR_STAGE || '').trim();
  const sha = String(args.sha || process.env.DEPLOY_SHA || '').trim();
  const targetsJson = String(args.targetsJson || process.env.TARGETS_JSON || '').trim();
  const startedAt = String(args.startedAt || process.env.ORCHESTRATOR_STARTED_AT || '').trim();
  const timeoutMinutes = parsePositiveInt(
    args.timeoutMinutes || process.env.ORCHESTRATOR_WAIT_TIMEOUT_MINUTES || '90',
    90,
  );
  const pollSeconds = parsePositiveInt(
    args.pollSeconds || process.env.ORCHESTRATOR_WAIT_POLL_SECONDS || '15',
    15,
  );
  const summaryPath = String(
    args.summaryPath || process.env.ORCHESTRATOR_CHILDREN_SUMMARY_PATH || '.tmp/orchestrator-children-summary.json',
  ).trim();
  const format = String(args.format || '').trim().toLowerCase();
  const shouldWaitForChildren = parseBool01(
    args.waitForChildren || process.env.ORCHESTRATOR_WAIT_FOR_CHILDREN || '1',
    true,
  );
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  const [owner, repo] = repository.split('/');

  if (!stage) die('Missing stage (--stage or ORCHESTRATOR_STAGE).');
  if (!sha) die('Missing deploy SHA (--sha or DEPLOY_SHA).');
  if (!repository || !owner || !repo) die('Missing GITHUB_REPOSITORY (owner/repo).');
  if (!token) die('Missing GITHUB_TOKEN.');

  const targets = parseTargets(targetsJson);

  if (!shouldWaitForChildren) {
    const skipped = {
      stage,
      sha,
      started_at: toIso(startedAt) || new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_minutes: timeoutMinutes,
      poll_seconds: pollSeconds,
      aggregate_conclusion: 'skipped',
      targets: targets.map((target) => ({
        surface_id: target.surface_id,
        workflow_id: target.workflow_id,
        run_id: '',
        run_url: '',
        run_status: 'skipped',
        conclusion: 'skipped',
        observed_at: new Date().toISOString(),
      })),
      reason: 'ORCHESTRATOR_WAIT_FOR_CHILDREN=0',
    };
    ensureDir(summaryPath);
    fs.writeFileSync(summaryPath, `${JSON.stringify(skipped, null, 2)}\n`, 'utf8');
    printSummary(skipped);
    if (format === 'github-output') {
      writeGithubOutput({
        children_summary_path: summaryPath,
        children_aggregate_conclusion: skipped.aggregate_conclusion,
        children_failed_surfaces: '',
        children_run_count: String(skipped.targets.length),
      });
    }
    return;
  }

  const summary = await waitForChildrenRuns({
    stage,
    sha,
    targets,
    startedAt,
    timeoutMinutes,
    pollSeconds,
    token,
    owner,
    repo,
  });

  ensureDir(summaryPath);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  printSummary(summary);

  const failedSurfaces = summary.targets
    .filter((row) => String(row.conclusion || '') !== 'success')
    .map((row) => row.surface_id)
    .join(',');

  if (format === 'github-output') {
    writeGithubOutput({
      children_summary_path: summaryPath,
      children_aggregate_conclusion: summary.aggregate_conclusion,
      children_failed_surfaces: failedSurfaces,
      children_run_count: String(summary.targets.length),
    });
  }

  if (summary.aggregate_conclusion !== 'success') {
    die(`One or more child workflows did not succeed (failed surfaces: ${failedSurfaces || 'unknown'}).`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    die(err && err.message ? err.message : String(err));
  });
}

module.exports = {
  parseArgs,
  parseTargets,
  selectWorkflowRunCandidate,
  computeAggregateConclusion,
  waitForChildrenRuns,
};
