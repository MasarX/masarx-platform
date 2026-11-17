const PR_CONTEXT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      title
      body
      baseRefName
      headRefName
      headRefOid
      isDraft
      isCrossRepository
      author { login }
      headRepository { nameWithOwner }
      labels(first: 100) { nodes { name } }
    }
  }
}`;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeRefName(value) {
  return normalizeString(value).replace(/^refs\/heads\//, '');
}

function normalizeLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => normalizeString(label?.name || label))
    .filter(Boolean);
}

function isTooManyFilesChangedError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = normalizeString(error?.message || error?.response?.data?.message || '').toLowerCase();
  return status === 422 && message.includes('too many files changed');
}

function isSameRepository(headRepositoryName, repositoryFullName, isCrossRepository = null) {
  const repoFullName = normalizeString(repositoryFullName).toLowerCase();
  const headRepo = normalizeString(headRepositoryName).toLowerCase();
  if (headRepo && repoFullName) return headRepo === repoFullName;
  if (typeof isCrossRepository === 'boolean') return !isCrossRepository;
  return false;
}

function buildContextPayload({
  number,
  title,
  body,
  labels,
  baseRef,
  headRef,
  headSha,
  sameRepo,
  authorLogin,
  isDraft = false,
  state,
  source,
}) {
  return {
    number: Number(number || 0),
    title: normalizeString(title),
    body: String(body || ''),
    labels: normalizeLabels(labels),
    baseRef: normalizeString(baseRef),
    headRef: normalizeString(headRef),
    headSha: normalizeString(headSha),
    sameRepo: sameRepo ? '1' : '0',
    authorLogin: normalizeString(authorLogin).toLowerCase(),
    isDraft: Boolean(isDraft),
    state: normalizeString(state).toLowerCase(),
    source: normalizeString(source),
  };
}

function fromGraphql(node, repositoryFullName) {
  return buildContextPayload({
    number: node?.number,
    title: node?.title,
    body: node?.body,
    labels: node?.labels?.nodes,
    baseRef: node?.baseRefName,
    headRef: node?.headRefName,
    headSha: node?.headRefOid,
    sameRepo: isSameRepository(
      node?.headRepository?.nameWithOwner,
      repositoryFullName,
      node?.isCrossRepository,
    ),
    authorLogin: node?.author?.login,
    isDraft: node?.isDraft,
    state: node?.state,
    source: 'graphql',
  });
}

function fromRest(pr, repositoryFullName) {
  return buildContextPayload({
    number: pr?.number,
    title: pr?.title,
    body: pr?.body,
    labels: pr?.labels,
    baseRef: pr?.base?.ref,
    headRef: pr?.head?.ref,
    headSha: pr?.head?.sha,
    sameRepo: isSameRepository(pr?.head?.repo?.full_name, repositoryFullName),
    authorLogin: pr?.user?.login,
    isDraft: pr?.draft,
    state: pr?.merged || pr?.merged_at ? 'closed' : pr?.state,
    source: 'rest',
  });
}

function normalizeAssociatedPullRequest(item) {
  return {
    number: Number(item?.number || 0),
    baseRef: normalizeRefName(item?.baseRef || item?.base?.ref),
    headRef: normalizeRefName(item?.headRef || item?.head?.ref),
    headSha: normalizeString(item?.headSha || item?.head?.sha),
  };
}

async function listAssociatedPrsByCommit({ github, owner, repo, commitSha }) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    if (page > 100) throw new Error('Incomplete associated PR inventory.');
    const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner, repo, commit_sha: exactSha(commitSha), per_page: 100, page,
      mediaType: { previews: ['groot'] },
    });
    if (!Array.isArray(response?.data)) throw new Error('Invalid associated PR inventory.');
    rows.push(...response.data);
    if (response.data.length < 100) break;
  }
  const normalized = rows.map(normalizeAssociatedPullRequest);
  if (normalized.some((item) => !Number.isSafeInteger(item.number) || item.number < 1)) {
    throw new Error('Invalid associated PR identity inventory.');
  }
  return normalized;
}

function exactSha(value) {
  const sha = normalizeString(value);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing or invalid full candidate SHA.');
  return sha;
}

function requireCurrentPullRequest(pr, { number, baseRef, sourceHeadSha, repositoryFullName }) {
  if (pr.number !== number || pr.state !== 'open' || pr.source === 'issue_event_fallback' ||
      pr.sameRepo !== '1' || pr.baseRef !== baseRef || pr.headSha !== exactSha(sourceHeadSha)) {
    throw new Error(`Unverified or obsolete PR #${number} in ${repositoryFullName}.`);
  }
}

async function getMergeParents({ github, owner, repo, sha }) {
  const response = await github.rest.repos.getCommit({ owner, repo, ref: exactSha(sha) });
  const commit = response?.data;
  if (commit?.sha !== sha || !Array.isArray(commit.parents) || commit.parents.length !== 2) {
    throw new Error('Unverified tested merge commit topology.');
  }
  return commit.parents.map((parent) => exactSha(parent?.sha));
}

async function resolvePullRequestTestedContext({ github, owner, repo, mergeSha, eventPullRequest, repositoryFullName }) {
  const testedSha = exactSha(mergeSha);
  const baseSha = exactSha(eventPullRequest?.base?.sha);
  const sourceHeadSha = exactSha(eventPullRequest?.head?.sha);
  const prNumber = Number(eventPullRequest?.number);
  const baseRef = normalizeRefName(eventPullRequest?.base?.ref);
  if (!prNumber || baseRef !== 'dev') throw new Error('Invalid native PR candidate context.');
  const pr = await resolvePullRequestContext({ github, owner, repo, prNumber, repositoryFullName, eventPullRequest });
  requireCurrentPullRequest(pr, { number: prNumber, baseRef, sourceHeadSha, repositoryFullName });
  const parents = await getMergeParents({ github, owner, repo, sha: testedSha });
  if (parents[0] !== baseSha || parents[1] !== sourceHeadSha) {
    throw new Error('Tested PR merge does not contain the exact event base and source head.');
  }
  return { ...pr, mergeSha: testedSha, baseSha, sourceHeadSha, candidates: [{ number: prNumber, headSha: sourceHeadSha }] };
}

async function resolveMergeGroupPullRequestContext({
  github,
  owner,
  repo,
  mergeSha,
  baseRef,
  baseSha,
  headRef,
  headSha,
  repositoryFullName,
}) {
  const normalizedMergeSha = exactSha(mergeSha);
  const normalizedBaseRef = normalizeRefName(baseRef);
  const normalizedBaseSha = exactSha(baseSha);
  const queueRef = normalizeRefName(headRef);
  const queueMatch = queueRef.match(/^gh-readonly-queue\/dev\/pr-([1-9]\d*)-([a-f0-9]{40})$/);
  if (normalizedBaseRef !== 'dev' || !queueMatch || exactSha(headSha) !== normalizedMergeSha) {
    throw new Error('Invalid native merge-group candidate context.');
  }
  const candidates = [];
  const seen = new Set();
  let current = normalizedMergeSha;
  // Bound malformed/unavailable graphs; never turn incomplete proof into an empty group.
  while (current !== normalizedBaseSha) {
    if (seen.has(current) || seen.size >= 100) throw new Error('Incomplete merge-group topology.');
    seen.add(current);
    const [parent, sourceHeadSha] = await getMergeParents({ github, owner, repo, sha: current });
    const associated = await listAssociatedPrsByCommit({ github, owner, repo, commitSha: sourceHeadSha });
    const matches = [];
    for (const item of associated.filter((item) => item.baseRef === normalizedBaseRef && item.headSha === sourceHeadSha)) {
      const pr = await resolvePullRequestContext({ github, owner, repo, prNumber: item.number, repositoryFullName });
      if (pr.state !== 'open') continue;
      requireCurrentPullRequest(pr, { number: item.number, baseRef: normalizedBaseRef, sourceHeadSha, repositoryFullName });
      if (pr.isDraft) throw new Error('Merge-group member is now a draft.');
      matches.push(pr);
    }
    if (matches.length !== 1 || candidates.some((item) => item.number === matches[0].number)) {
      throw new Error('Unverified or ambiguous merge-group PR membership.');
    }
    candidates.unshift(matches[0]);
    current = parent;
  }
  if (!candidates.length || !candidates.some((item) => item.number === Number(queueMatch[1]))) {
    throw new Error('Queue ref does not identify a tested merge-group member.');
  }
  const pr = candidates.length === 1 ? candidates[0] : {};
  return {
    ...pr,
    number: pr.number || 0,
    headSha: normalizedMergeSha,
    sourceHeadSha: pr.headSha || '',
    mergeSha: normalizedMergeSha,
    baseRef: normalizedBaseRef,
    baseSha: normalizedBaseSha,
    sameRepo: '1',
    isDraft: candidates.some((item) => item.isDraft),
    multiPrGroup: candidates.length > 1,
    candidates: candidates.map((item) => ({ number: item.number, headSha: item.headSha })),
    source: 'verified_merge_graph',
  };
}

function fromIssueFallback(issue, eventPullRequest, repositoryFullName) {
  return buildContextPayload({
    number: issue?.number || eventPullRequest?.number,
    title: issue?.title,
    body: issue?.body,
    labels: issue?.labels,
    baseRef: eventPullRequest?.base?.ref,
    headRef: eventPullRequest?.head?.ref,
    headSha: eventPullRequest?.head?.sha,
    sameRepo: isSameRepository(eventPullRequest?.head?.repo?.full_name, repositoryFullName),
    authorLogin: issue?.user?.login,
    state: issue?.state,
    source: 'issue_event_fallback',
  });
}

async function resolvePullRequestContext({
  github,
  owner,
  repo,
  prNumber,
  repositoryFullName,
  eventPullRequest = null,
}) {
  const normalizedNumber = Number(prNumber || 0);
  if (!normalizedNumber) {
    throw new Error('Missing pull request number while resolving PR context.');
  }

  try {
    const data = await github.graphql(PR_CONTEXT_QUERY, {
      owner,
      repo,
      number: normalizedNumber,
    });
    const node = data?.repository?.pullRequest || null;
    if (node) return fromGraphql(node, repositoryFullName);
  } catch (error) {
    // Fall back to REST/issue lookup below.
  }

  try {
    const response = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: normalizedNumber,
    });
    return fromRest(response?.data || null, repositoryFullName);
  } catch (error) {
    if (!isTooManyFilesChangedError(error)) {
      throw error;
    }
  }

  const issueResponse = await github.rest.issues.get({
    owner,
    repo,
    issue_number: normalizedNumber,
  });
  return fromIssueFallback(issueResponse?.data || null, eventPullRequest, repositoryFullName);
}

module.exports = {
  PR_CONTEXT_QUERY,
  buildContextPayload,
  exactSha,
  isSameRepository,
  isTooManyFilesChangedError,
  listAssociatedPrsByCommit,
  normalizeLabels,
  normalizeAssociatedPullRequest,
  normalizeRefName,
  normalizeString,
  resolveMergeGroupPullRequestContext,
  resolvePullRequestContext,
  resolvePullRequestTestedContext,
};
