'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const sha = /^[a-f0-9]{40}$/;
const numericId = value => Number.isSafeInteger(value) && value > 0;
const filePath = value => typeof value === 'string' && value.split('/').every(
  part => part && part !== '.' && part !== '..' && !part.includes('\0'),
);

function readPolicy({ paths, packageScriptFiles, verdictAccountIds }) {
  if (!paths || typeof paths !== 'object' || !Object.values(paths).every(Array.isArray)) {
    throw new Error('Invalid critical-path categories');
  }
  const patterns = Object.values(paths).flat();
  if (!patterns.length || !patterns.every(pattern => typeof pattern === 'string' &&
    filePath(pattern.replace(/\/\*\*$/, '')) && !pattern.replace(/\/\*\*$/, '').includes('*')) ||
    !Array.isArray(packageScriptFiles) || !packageScriptFiles.every(filePath) ||
    !Array.isArray(verdictAccountIds) || !verdictAccountIds.length || !verdictAccountIds.every(numericId)) {
    throw new Error('Invalid critical-path policy');
  }
  return { patterns, packageScriptFiles, verdictAccountIds: new Set(verdictAccountIds) };
}

function readEvent(eventName, event) {
  if (eventName === 'pull_request') {
    const pr = event.pull_request;
    if (!numericId(pr?.number) || !sha.test(pr?.base?.sha) || !sha.test(pr?.head?.sha)) {
      throw new Error('Cannot identify PR from event');
    }
    return { number: pr.number, base: pr.base.sha, eventHead: pr.head.sha };
  }

  const group = event.merge_group;
  const match = /^refs\/heads\/gh-readonly-queue\/.+\/pr-([1-9]\d*)-[a-f0-9]{40}$/.exec(group?.head_ref);
  const number = Number(match?.[1]);
  if (eventName !== 'merge_group' || !numericId(number) || !sha.test(group?.base_sha)) {
    throw new Error('Cannot identify PR from merge group');
  }
  return { number, base: group.base_sha };
}

function githubClient(repository, token, send = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Missing GitHub API identity');

  async function request(endpoint) {
    const response = await send('https://api.github.com/repos/' + repository + endpoint, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('GitHub API returned HTTP ' + response.status);
    return { data: await response.json(), next: /rel="next"/.test(response.headers.get('link') || '') };
  }

  return {
    async get(endpoint) {
      return (await request(endpoint)).data;
    },
    async list(endpoint) {
      const rows = [];
      for (let page = 1; ; page++) {
        const { data, next } = await request(endpoint + '?per_page=100&page=' + page);
        if (!Array.isArray(data) || (next && data.length !== 100)) throw new Error('Incomplete GitHub API page');
        rows.push(...data);
        if (!next) return rows;
      }
    },
  };
}

function gitObjects(root) {
  const git = (args, encoding) => execFileSync('git', args, {
    cwd: root, encoding, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = (commit, filename) => git(['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filename]);
  return {
    checkout: () => git(['rev-parse', 'HEAD'], 'utf8').trim(),
    fetch: (...commits) => git(['fetch', '--no-tags', '--depth=1', 'origin', ...new Set(commits)]),
    same: (left, right, filename) => entry(left, filename).equals(entry(right, filename)),
    scripts(commit, filename) {
      const item = entry(commit, filename);
      if (!item.length) return {};
      if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(item.toString('utf8'))) {
        throw new Error('Package manifest is not a regular file');
      }
      const manifest = JSON.parse(git(['show', commit + ':' + filename], 'utf8'));
      const scripts = manifest.scripts ?? {};
      if (typeof scripts !== 'object' || Array.isArray(scripts) ||
        !Object.values(scripts).every(command => typeof command === 'string')) {
        throw new Error('Invalid package scripts');
      }
      return scripts;
    },
  };
}

function newestVerdict(comments, identities) {
  const verdicts = [];
  for (const comment of comments) {
    if (!comment || !numericId(comment.id) || typeof comment.body !== 'string' ||
      !Number.isFinite(Date.parse(comment.created_at))) throw new Error('Invalid PR comment');
    if (!identities.has(comment.user?.id)) continue;
    const lines = comment.body.split(/\r?\n/).filter(line => /^\s*VERDICT\s*:/i.test(line));
    if (lines.length) verdicts.push({ ...comment, lines });
  }

  const newest = verdicts.sort((left, right) =>
    Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id)[0];
  if (!newest) throw new Error('Missing review verdict');
  const verdict = newest.lines.length === 1 && /^VERDICT: (GO|NO_GO) ([a-f0-9]{40})$/.exec(newest.lines[0]);
  if (!verdict) throw new Error('Malformed review verdict');
  if (verdict[1] !== 'GO') throw new Error('Review verdict is NO_GO');
  return verdict[2];
}

async function enforce(event, policy, api, objects) {
  if (objects.checkout() !== event.base) throw new Error('Verdict policy checkout does not match event base');
  const endpoint = '/pulls/' + event.number;
  const pr = await api.get(endpoint);
  const head = pr.head?.sha;
  if (pr.number !== event.number || pr.state !== 'open' || !sha.test(head) ||
    (event.eventHead && event.eventHead !== head) || !Number.isInteger(pr.changed_files) ||
    pr.changed_files < 0 || pr.changed_files > 3000) throw new Error('Cannot verify PR head or changed-file count');

  const files = await api.list(endpoint + '/files');
  if (files.length !== pr.changed_files || new Set(files.map(file => file?.filename)).size !== files.length) {
    throw new Error('Incomplete PR file inventory');
  }
  const filenames = new Set();
  for (const file of files) {
    if (!filePath(file?.filename) || typeof file.status !== 'string' ||
      (file.status === 'renamed' && !filePath(file.previous_filename))) {
      throw new Error('Invalid PR file inventory');
    }
    filenames.add(file.filename);
    if (file.status === 'renamed') filenames.add(file.previous_filename);
  }

  const critical = [...filenames].filter(filename => policy.patterns.some(pattern =>
    pattern.endsWith('/**') ? filename.startsWith(pattern.slice(0, -2)) : filename === pattern));
  const manifests = policy.packageScriptFiles.filter(filename => filenames.has(filename));
  if (manifests.length) {
    // The PR diff is relative to its merge base, even when the target branch advanced.
    const comparison = await api.get('/compare/' + event.base + '...' + head + '?per_page=1');
    const mergeBase = comparison.merge_base_commit?.sha;
    if (!sha.test(mergeBase)) throw new Error('Cannot verify PR merge base for package scripts');
    objects.fetch(mergeBase, head);
    for (const filename of manifests) {
      const before = objects.scripts(mergeBase, filename);
      const after = objects.scripts(head, filename);
      if (Object.keys({ ...before, ...after }).some(script => before[script] !== after[script])) {
        critical.push(filename);
      }
    }
  }

  if (critical.length) {
    const comments = await api.list('/issues/' + event.number + '/comments');
    const reviewed = newestVerdict(comments, policy.verdictAccountIds);
    if (reviewed !== head) {
      objects.fetch(reviewed, head);
      // Compare literal tree entries, including adds, deletions and mode changes.
      if (critical.some(filename => !objects.same(reviewed, head, filename))) {
        throw new Error('Review verdict is stale for the critical files');
      }
    }
  }

  const current = await api.get(endpoint);
  if (current.head?.sha !== head || current.state !== 'open' || current.changed_files !== pr.changed_files) {
    throw new Error('PR changed while reading verdict evidence');
  }
  return critical.length ? 'Critical-file review verdict accepted' : 'No critical files changed';
}

async function selfCheck() {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const old = 'c'.repeat(40);
  const event = readEvent('pull_request', { pull_request: { number: 17, base: { sha: base }, head: { sha: head } } });
  assert.deepEqual(readEvent('merge_group', { merge_group: {
    base_sha: base, head_ref: 'refs/heads/gh-readonly-queue/main/pr-17-' + old,
  } }), { number: event.number, base });
  assert.throws(() => readEvent('merge_group', { merge_group: { base_sha: base, head_ref: 'refs/heads/main' } }),
    /Cannot identify PR/);

  const policy = readPolicy({
    paths: { releaseGates: ['.github/workflows/**'], production: ['scripts/deploy/**'] },
    packageScriptFiles: ['package.json'],
    verdictAccountIds: [11],
  });
  let nextId = 0;
  const comment = (body, author = 11) => ({
    id: ++nextId, body, user: { id: author }, created_at: '2026-01-01T00:00:00Z',
  });
  async function check({ number = 17, comments = [], files = [{ filename: 'scripts/deploy/run.sh', status: 'modified' }],
    contentsMatch = false, changedFiles = files.length, scriptsBefore = {}, scriptsAfter = {},
    secondHead = head } = {}) {
    const endpoint = '/pulls/' + number;
    let reads = 0;
    const api = {
      get: async route => {
        if (route.startsWith('/compare/')) return { merge_base_commit: { sha: base } };
        assert.equal(route, endpoint);
        const currentHead = reads++ ? secondHead : head;
        return { number, state: 'open', head: { sha: currentHead }, changed_files: changedFiles };
      },
      list: async route => {
        if (route === endpoint + '/files') return files;
        assert.equal(route, '/issues/' + number + '/comments');
        return comments;
      },
    };
    return enforce({ number, base }, policy, api, {
      checkout: () => base, fetch: () => {},
      same: () => contentsMatch,
      scripts: commit => commit === base ? scriptsBefore : scriptsAfter,
    });
  }

  await assert.rejects(check(), /Missing review verdict/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head), comment('VERDICT: NO_GO ' + head)] }), /NO_GO/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + old)] }), /stale/);
  assert.match(await check({ comments: [comment('VERDICT: GO ' + old)], contentsMatch: true }), /accepted/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head), comment('VERDICT: GO abc')] }), /Malformed/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head, 12)] }), /Missing/);
  const brokenApi = githubClient('example/repo', String(11), async () => ({ ok: false, status: 503 }));
  await assert.rejects(enforce(event, policy, brokenApi, { checkout: () => base }), /HTTP 503/);
  assert.match(await check({ comments: [comment('VERDICT: GO ' + head)] }), /accepted/);
  assert.match(await check({ files: [{ filename: 'docs/note.md', status: 'modified' }] }), /No critical/);
  await assert.rejects(check({ files: [{
    filename: 'other/new-name', previous_filename: 'scripts/deploy/run.sh', status: 'renamed',
  }] }), /Missing/);
  await assert.rejects(check({ changedFiles: 2 }), /Incomplete/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head)], secondHead: old }), /PR changed/);
  assert.match(await check({ files: [{ filename: 'package.json', status: 'modified' }] }), /No critical/);
  await assert.rejects(check({
    files: [{ filename: 'package.json', status: 'modified' }],
    scriptsBefore: { lint: 'check' }, scriptsAfter: { lint: 'check --changed' },
  }), /Missing/);
  console.log('Review verdict self-checks passed');
}

async function main(env) {
  const root = path.resolve(__dirname, '../..');
  const policy = readPolicy(JSON.parse(readFileSync(path.join(root, 'config/ci/critical-paths.json'), 'utf8')));
  if (process.argv[2] === '--self-check') return selfCheck();
  const event = readEvent(env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
  console.log(await enforce(event, policy, githubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN), gitObjects(root)));
}

main(process.env).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
