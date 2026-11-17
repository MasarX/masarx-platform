const PR_CONTEXT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
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

function parsePrNumberFromHeadRef(ref) {
  const raw = normalizeString(ref);
  if (!raw) return 0;
  const match = raw.match(/pr-(\d+)-/i) || raw.match(/pr-(\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
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
  if (!commitSha) return [];
  const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: commitSha,
    per_page: 20,
    mediaType: { previews: ['groot'] },
  });
  const rows = Array.isArray(response?.data) ? response.data : [];
  return rows
    .map(normalizeAssociatedPullRequest)
    .filter((item) => Number.isFinite(item.number) && item.number > 0);
}

function selectMergeGroupPullRequest({
  associated,
  baseRef,
  headRef,
  explicitPrNumber = 0,
}) {
  const candidates = (Array.isArray(associated) ? associated : [])
    .map(normalizeAssociatedPullRequest)
    .filter((item) => Number.isFinite(item.number) && item.number > 0);
  const normalizedBaseRef = normalizeRefName(baseRef);
  const normalizedHeadRef = normalizeRefName(headRef);

  if (explicitPrNumber) {
    const exact = candidates.find((item) => item.number === explicitPrNumber);
    return {
      candidates: exact ? [exact] : [{ number: explicitPrNumber, baseRef: normalizedBaseRef, headRef: '', headSha: '' }],
      source: 'head_ref',
    };
  }

  const baseScoped = normalizedBaseRef
    ? candidates.filter((item) => item.baseRef === normalizedBaseRef)
    : candidates;
  const scoped = baseScoped.length ? baseScoped : candidates;
  const branchScoped = normalizedHeadRef && !normalizedHeadRef.startsWith('gh-readonly-queue/')
    ? scoped.filter((item) => item.headRef === normalizedHeadRef)
    : scoped;

  if (branchScoped.length) {
    return { candidates: branchScoped, source: 'associated_commit_branch' };
  }
  return { candidates: scoped, source: 'associated_commit' };
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
  const normalizedMergeSha = normalizeString(mergeSha);
  if (!normalizedMergeSha) {
    throw new Error('Missing merge group SHA while resolving PR context.');
  }

  const normalizedBaseRef = normalizeRefName(baseRef);
  const normalizedBaseSha = normalizeString(baseSha);
  const normalizedHeadRef = normalizeString(headRef);
  const testedHeadSha = normalizeString(headSha) || normalizedMergeSha;
  const explicitPrNumber = parsePrNumberFromHeadRef(normalizedHeadRef);

  let associated = [];
  try {
    associated = await listAssociatedPrsByCommit({
      github,
      owner,
      repo,
      commitSha: normalizedMergeSha,
    });
  } catch (error) {
    associated = [];
  }

  const selection = selectMergeGroupPullRequest({
    associated,
    baseRef: normalizedBaseRef,
    headRef: normalizedHeadRef,
    explicitPrNumber,
  });
  const candidates = selection.candidates || [];

  if (!candidates.length) {
    throw new Error(
      `Unable to resolve PR number for merge_group commit '${normalizedMergeSha}'. ` +
      `head_ref='${normalizedHeadRef || '<missing-head_ref>'}' base_ref='${normalizedBaseRef || '<missing-base_ref>'}'.`,
    );
  }

  if (candidates.length > 1) {
    return {
      multiPrGroup: true,
      mergeSha: normalizedMergeSha,
      headSha: '',
      baseRef: normalizedBaseRef,
      baseSha: normalizedBaseSha,
      candidates,
    };
  }

  const prNumber = candidates[0].number;
  const pr = await resolvePullRequestContext({
    github,
    owner,
    repo,
    prNumber,
    repositoryFullName,
  });

  return {
    ...pr,
    number: prNumber,
    // Merge-group validation must publish artifacts for the exact tree GitHub tests.
    headSha: testedHeadSha,
    sourceHeadSha: pr?.headSha || candidates[0]?.headSha || '',
    mergeSha: normalizedMergeSha,
    baseRef: pr?.baseRef || normalizedBaseRef,
    baseSha: normalizedBaseSha,
    multiPrGroup: false,
    source: selection.source,
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
  isSameRepository,
  isTooManyFilesChangedError,
  listAssociatedPrsByCommit,
  normalizeLabels,
  normalizeAssociatedPullRequest,
  normalizeRefName,
  normalizeString,
  parsePrNumberFromHeadRef,
  resolveMergeGroupPullRequestContext,
  resolvePullRequestContext,
  selectMergeGroupPullRequest,
};
