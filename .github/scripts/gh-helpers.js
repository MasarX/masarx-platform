/**
 * Shared helpers for `actions/github-script` steps.
 *
 * Notes:
 * - Keep this file dependency-free (no node_modules) so it can be required from workflows.
 * - All functions accept `{ github, owner, repo, ... }` to stay reusable across workflows.
 */

function norm(value) {
  return String(value || '').trim();
}

function commentRecencyKey(comment) {
  const parsed = Date.parse(String(comment?.updated_at || comment?.created_at || ''));
  if (Number.isFinite(parsed)) return parsed;
  const fallbackId = Number.parseInt(String(comment?.id || '0').trim(), 10);
  return Number.isFinite(fallbackId) ? fallbackId : 0;
}

const ASSIGNMENT_KIND_LABEL = 'kind:worker-plan';
const EXECUTION_CARD_KIND_LABEL = 'kind:execution-card';
const PROJECT_EXECUTION_RECORD_LABEL = 'planning:execution-record';
const PROJECT_EXECUTION_RECORD_MARKER = '<!-- 523315b5-3114-406b-9448-1f88b7544f4b-execution-record';
const DISPATCH_LABELS = [
  'dispatch:ready',
  'dispatch:in_progress',
  'dispatch:review',
  'dispatch:blocked',
  'dispatch:done',
  'dispatch:sync-needed',
];
const PRIORITY_LABELS = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'];

const ACTIVE_DEPLOYMENT_STATES = new Set(['queued', 'in_progress', 'pending', 'waiting']);
const SUCCESS_DEPLOYMENT_STATES = new Set(['success']);
const ACTIVE_WORKFLOW_RUN_STATES = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);
const SUCCESS_WORKFLOW_RUN_CONCLUSIONS = new Set(['success']);

function getIssueLabelNames(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const names = [];
  for (const label of labels) {
    if (typeof label === 'string') {
      const v = norm(label);
      if (v) names.push(v);
      continue;
    }
    const name = norm(label?.name);
    if (name) names.push(name);
  }
  return names;
}

function hasProjectExecutionRecordMarker(body) {
  return String(body || '').toLowerCase().includes(PROJECT_EXECUTION_RECORD_MARKER);
}

function isProjectExecutionRecordIssue(issue) {
  const labels = getIssueLabelNames(issue).map((name) => name.toLowerCase());
  return labels.includes(PROJECT_EXECUTION_RECORD_LABEL)
    || hasProjectExecutionRecordMarker(issue?.body);
}

function isExecutionRecordIssue(issue) {
  const labels = getIssueLabelNames(issue).map((name) => name.toLowerCase());
  return labels.includes(EXECUTION_CARD_KIND_LABEL)
    || isProjectExecutionRecordIssue(issue);
}

function executionRecordKindLabel(issue) {
  const labels = getIssueLabelNames(issue).map((name) => name.toLowerCase());
  if (labels.includes(EXECUTION_CARD_KIND_LABEL)) return EXECUTION_CARD_KIND_LABEL;
  if (labels.includes(PROJECT_EXECUTION_RECORD_LABEL) || hasProjectExecutionRecordMarker(issue?.body)) {
    return PROJECT_EXECUTION_RECORD_LABEL;
  }
  return '';
}

function priorityRank(labelName) {
  const key = norm(labelName).toLowerCase();
  switch (key) {
    case 'priority:p0':
      return 0;
    case 'priority:p1':
      return 1;
    case 'priority:p2':
      return 2;
    case 'priority:p3':
      return 3;
    default:
      return 2;
  }
}

function resolvePriorityLabelFromNames(names, fallback = 'priority:p2') {
  const list = Array.isArray(names) ? names.map((n) => norm(n).toLowerCase()).filter(Boolean) : [];
  const matches = list.filter((n) => PRIORITY_LABELS.includes(n));
  if (!matches.length) return fallback;
  matches.sort((a, b) => priorityRank(a) - priorityRank(b));
  return matches[0];
}

async function setAssignmentLabels({
  github,
  owner,
  repo,
  issueNumber,
  dispatchLabel,
  priorityLabel = '',
  ensureKind = true,
  kindLabel = ASSIGNMENT_KIND_LABEL,
}) {
  const num = parseInt(String(issueNumber || '').trim(), 10);
  if (!num) throw new Error(`setAssignmentLabels: invalid issueNumber: ${issueNumber || '<empty>'}`);
  const targetDispatch = norm(dispatchLabel).toLowerCase();
  if (targetDispatch && !DISPATCH_LABELS.includes(targetDispatch)) {
    throw new Error(`setAssignmentLabels: invalid dispatch label: ${dispatchLabel}`);
  }

  const { data: issue } = await github.rest.issues.get({
    owner,
    repo,
    issue_number: num,
  });

  const issueState = norm(issue?.state).toLowerCase();
  const current = getIssueLabelNames(issue).map((n) => n.toLowerCase());
  if (issueState !== 'open' && targetDispatch && targetDispatch !== 'dispatch:done') {
    throw new Error(
      `setAssignmentLabels: refusing to set non-terminal dispatch '${targetDispatch}' on closed issue #${num}`,
    );
  }
  const next = current.filter((n) => !DISPATCH_LABELS.includes(n) && !PRIORITY_LABELS.includes(n));
  const normalizedKindLabel = norm(kindLabel).toLowerCase() || ASSIGNMENT_KIND_LABEL;
  if (ensureKind && !next.includes(normalizedKindLabel)) next.push(normalizedKindLabel);

  const priority = norm(priorityLabel).toLowerCase() || resolvePriorityLabelFromNames(current, 'priority:p2');
  if (priority && PRIORITY_LABELS.includes(priority) && !next.includes(priority)) next.push(priority);
  if (targetDispatch && !next.includes(targetDispatch)) next.push(targetDispatch);

  await github.rest.issues.setLabels({
    owner,
    repo,
    issue_number: num,
    labels: Array.from(new Set(next)),
  });
  return Array.from(new Set(next));
}

async function normalizeAssignmentToDone({
  github,
  owner,
  repo,
  issueNumber,
  priorityLabel = 'priority:p2',
  ensureKind = true,
  closeIfOpen = true,
  kindLabel = ASSIGNMENT_KIND_LABEL,
}) {
  const num = parseInt(String(issueNumber || '').trim(), 10);
  if (!num) {
    throw new Error(
      `normalizeAssignmentToDone: invalid issueNumber: ${issueNumber || '<empty>'}`,
    );
  }

  const { data: issue } = await github.rest.issues.get({
    owner,
    repo,
    issue_number: num,
  });
  const assignees = Array.isArray(issue?.assignees)
    ? issue.assignees.map((item) => norm(item?.login)).filter(Boolean)
    : [];
  const issueState = norm(issue?.state).toLowerCase();
  const warnings = [];

  const labels = await setAssignmentLabels({
    github,
    owner,
    repo,
    issueNumber: num,
    dispatchLabel: 'dispatch:done',
    priorityLabel,
    ensureKind,
    kindLabel,
  });

  if (assignees.length) {
    try {
      await github.rest.issues.removeAssignees({
        owner,
        repo,
        issue_number: num,
        assignees,
      });
    } catch (err) {
      warnings.push(
        `Unable to clear assignees from assignment issue #${num}: ${String(err?.message || err)}`,
      );
    }
  }

  let closed = false;
  if (closeIfOpen && issueState === 'open') {
    try {
      await github.rest.issues.update({
        owner,
        repo,
        issue_number: num,
        state: 'closed',
      });
      closed = true;
    } catch (err) {
      warnings.push(
        `Unable to close assignment issue #${num}: ${String(err?.message || err)}`,
      );
    }
  }

  return {
    issueState,
    closed,
    labels,
    assigneesCleared: assignees.length,
    warnings,
  };
}

async function findCommentByMarker({
  github,
  owner,
  repo,
  issueNumber,
  marker,
  expectedAuthorLogin = '',
  expectedAuthorType = 'User',
}) {
  const num = parseInt(String(issueNumber || '').trim(), 10);
  if (!num) throw new Error(`findCommentByMarker: invalid issueNumber: ${issueNumber || '<empty>'}`);
  const m = norm(marker);
  if (!m) throw new Error('findCommentByMarker: missing marker');
  const expectedLogin = norm(expectedAuthorLogin).toLowerCase();
  const expectedType = norm(expectedAuthorType || 'User').toLowerCase();

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: num,
    per_page: 100,
  });
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => {
      if (!expectedLogin) return String(comment?.body || '').includes(m);
      const hasExactMarkerLine = String(comment?.body || '')
        .split(/\r?\n/)
        .some((line) => line.trim() === m);
      const authorLogin = norm(comment?.user?.login).toLowerCase();
      const authorType = norm(comment?.user?.type).toLowerCase();
      return hasExactMarkerLine && authorLogin === expectedLogin && authorType === expectedType;
    })
    .sort((left, right) => commentRecencyKey(right) - commentRecencyKey(left))[0] || null;
}

async function ensureLabel({ github, owner, repo, name, color, description }) {
  const labelName = norm(name);
  if (!labelName) throw new Error('ensureLabel: missing label name');
  try {
    await github.rest.issues.getLabel({ owner, repo, name: labelName });
  } catch (_) {
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: labelName,
      color: norm(color) || 'ededed',
      description: norm(description),
    });
  }
}

async function upsertComment({
  github,
  owner,
  repo,
  issueNumber,
  marker,
  body,
  expectedAuthorLogin = '',
  expectedAuthorType = 'User',
}) {
  const num = parseInt(String(issueNumber || '').trim(), 10);
  if (!num) throw new Error(`upsertComment: invalid issueNumber: ${issueNumber || '<empty>'}`);

  const m = norm(marker);
  if (!m) throw new Error('upsertComment: missing marker');

  const text = norm(body);
  if (!text) throw new Error('upsertComment: missing body');

  const existing = await findCommentByMarker({
    github,
    owner,
    repo,
    issueNumber: num,
    marker: m,
    expectedAuthorLogin,
    expectedAuthorType,
  });
  if (existing?.id) {
    if (norm(existing.body) === text) {
      return;
    }
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: text,
    });
    return;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: num,
    body: text,
  });
}

async function requireMaintainer({ github, owner, repo, username, purpose }) {
  const user = norm(username);
  if (!user) throw new Error('requireMaintainer: missing username');
  const why = norm(purpose);

  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: user,
  });

  const permission = String(data?.permission || '').toLowerCase();
  if (permission !== 'admin' && permission !== 'maintain') {
    const label = why ? ` to ${why}` : '';
    throw new Error(`User @${user} is not authorized${label} (permission=${permission || '<unknown>'}).`);
  }
}

async function getDeploymentStateSummary({ github, owner, repo, environment, sha }) {
  const envName = norm(environment);
  const commitSha = norm(sha).toLowerCase();
  if (!envName) throw new Error('getDeploymentStateSummary: missing environment');
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error(`getDeploymentStateSummary: invalid sha: ${sha || '<empty>'}`);
  }

  const { data: deployments } = await github.rest.repos.listDeployments({
    owner,
    repo,
    environment: envName,
    sha: commitSha,
    per_page: 50,
  });

  const deploymentList = Array.isArray(deployments) ? deployments : [];
  const latestStates = [];
  let hasSuccess = false;
  let hasActive = false;

  for (const deployment of deploymentList) {
    const deploymentId = deployment?.id;
    if (!deploymentId) continue;
    const { data: statuses } = await github.rest.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: deploymentId,
      per_page: 50,
    });
    const statusList = Array.isArray(statuses) ? statuses : [];
    if (statusList.length === 0) {
      latestStates.push('created');
      hasActive = true;
      continue;
    }
    const latestState = norm(statusList[0]?.state).toLowerCase() || 'unknown';
    latestStates.push(latestState);
    if (SUCCESS_DEPLOYMENT_STATES.has(latestState)) hasSuccess = true;
    if (ACTIVE_DEPLOYMENT_STATES.has(latestState)) hasActive = true;
  }

  return {
    deploymentCount: deploymentList.length,
    latestStates,
    hasSuccess,
    hasActive,
  };
}

async function getWorkflowRunStateSummary({ github, owner, repo, workflowId, sha, excludeRunId = '' }) {
  const workflow = norm(workflowId);
  const commitSha = norm(sha).toLowerCase();
  const skipRunId = norm(excludeRunId);

  if (!workflow) throw new Error('getWorkflowRunStateSummary: missing workflowId');
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error(`getWorkflowRunStateSummary: invalid sha: ${sha || '<empty>'}`);
  }

  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflow,
    per_page: 50,
  });

  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  const relevant = runs.filter((run) => {
    const runSha = norm(run?.head_sha).toLowerCase();
    if (runSha !== commitSha) return false;
    const runId = String(run?.id || '');
    if (skipRunId && runId === skipRunId) return false;
    return true;
  });

  let hasActive = false;
  let hasSuccess = false;
  const activeRunIds = [];
  const successRunIds = [];

  for (const run of relevant) {
    const status = norm(run?.status).toLowerCase();
    const conclusion = norm(run?.conclusion).toLowerCase();
    const runId = String(run?.id || '');

    if (ACTIVE_WORKFLOW_RUN_STATES.has(status)) {
      hasActive = true;
      if (runId) activeRunIds.push(runId);
    } else if (status === 'completed' && SUCCESS_WORKFLOW_RUN_CONCLUSIONS.has(conclusion)) {
      hasSuccess = true;
      if (runId) successRunIds.push(runId);
    }
  }

  return {
    runCount: relevant.length,
    hasActive,
    hasSuccess,
    activeRunIds,
    successRunIds,
  };
}

async function enableAutoMerge({ github, pullRequestId, mergeMethod = 'MERGE' }) {
  const prId = norm(pullRequestId);
  if (!prId) throw new Error('enableAutoMerge: missing pullRequestId');

  const resolvedMergeMethod = norm(mergeMethod) || 'MERGE';

  try {
    await github.graphql(
      `mutation($prId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $mergeMethod }) {
          pullRequest { number }
        }
      }`,
      { prId, mergeMethod: resolvedMergeMethod }
    );
    return { ok: true, message: 'enabled' };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

async function enqueuePullRequest({ github, pullRequestId, expectedHeadOid = '' }) {
  const prId = norm(pullRequestId);
  if (!prId) throw new Error('enqueuePullRequest: missing pullRequestId');

  const oid = norm(expectedHeadOid).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error('enqueuePullRequest: expectedHeadOid must be an exact 40-hex commit SHA');
  }

  try {
    const result = await github.graphql(
      `mutation($prId: ID!, $expectedHeadOid: GitObjectID!) {
        enqueuePullRequest(input: { pullRequestId: $prId, expectedHeadOid: $expectedHeadOid }) {
          mergeQueueEntry {
            id
            position
            state
          }
        }
      }`,
      {
        prId,
        expectedHeadOid: oid,
      }
    );
    return {
      ok: true,
      message: 'enqueued',
      mergeQueueEntry: result?.enqueuePullRequest?.mergeQueueEntry || null,
    };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

async function dequeuePullRequest({ github, pullRequestId }) {
  const id = norm(pullRequestId);
  if (!id) throw new Error('dequeuePullRequest: missing pullRequestId');

  try {
    const result = await github.graphql(
      `mutation($id: ID!) {
        dequeuePullRequest(input: { id: $id }) {
          mergeQueueEntry {
            id
            state
          }
        }
      }`,
      { id }
    );
    return {
      ok: true,
      message: 'dequeued',
      mergeQueueEntry: result?.dequeuePullRequest?.mergeQueueEntry || null,
    };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

async function disableAutoMerge({ github, pullRequestId }) {
  const prId = norm(pullRequestId);
  if (!prId) throw new Error('disableAutoMerge: missing pullRequestId');

  try {
    await github.graphql(
      `mutation($prId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $prId }) {
          pullRequest { number }
        }
      }`,
      { prId }
    );
    return { ok: true, message: 'disabled' };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

async function removeLabel({ github, owner, repo, issueNumber, name }) {
  const num = parseInt(String(issueNumber || '').trim(), 10);
  if (!num) throw new Error(`removeLabel: invalid issueNumber: ${issueNumber || '<empty>'}`);
  const labelName = norm(name);
  if (!labelName) throw new Error('removeLabel: missing label name');

  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: num,
      name: labelName,
    });
    return { ok: true, removed: true };
  } catch (e) {
    const status = Number(e?.status || 0);
    if (status === 404) {
      return { ok: true, removed: false };
    }
    throw e;
  }
}

async function updatePullRequestBranch({ github, pullRequestId, expectedHeadOid }) {
  const prId = norm(pullRequestId);
  if (!prId) throw new Error('updatePullRequestBranch: missing pullRequestId');

  const oid = norm(expectedHeadOid);
  if (!oid) throw new Error('updatePullRequestBranch: missing expectedHeadOid');

  try {
    await github.graphql(
      `mutation($prId: ID!, $oid: GitObjectID!) {
        updatePullRequestBranch(input: { pullRequestId: $prId, expectedHeadOid: $oid }) {
          pullRequest { number }
        }
      }`,
      { prId, oid }
    );
    return { ok: true, message: 'updated' };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

module.exports = {
  ASSIGNMENT_KIND_LABEL,
  EXECUTION_CARD_KIND_LABEL,
  PROJECT_EXECUTION_RECORD_LABEL,
  PROJECT_EXECUTION_RECORD_MARKER,
  DISPATCH_LABELS,
  PRIORITY_LABELS,
  disableAutoMerge,
  dequeuePullRequest,
  ensureLabel,
  enqueuePullRequest,
  enableAutoMerge,
  findCommentByMarker,
  getIssueLabelNames,
  hasProjectExecutionRecordMarker,
  isProjectExecutionRecordIssue,
  isExecutionRecordIssue,
  executionRecordKindLabel,
  normalizeAssignmentToDone,
  getDeploymentStateSummary,
  getWorkflowRunStateSummary,
  norm,
  requireMaintainer,
  removeLabel,
  resolvePriorityLabelFromNames,
  setAssignmentLabels,
  updatePullRequestBranch,
  upsertComment,
};
