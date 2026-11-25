'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
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

function gitAt(root, args, encoding) {
  return execFileSync('git', args, {
    cwd: root, encoding, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitObjects(root) {
  const git = (args, encoding) => gitAt(root, args, encoding);
  const entry = (commit, filename) => git(['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filename]);
  return {
    checkout: () => git(['rev-parse', 'HEAD'], 'utf8').trim(),
    files: () => git(['ls-tree', '-r', '-z', '--format=%(objectmode)%x09%(path)', 'HEAD'], 'utf8').split('\0')
      .filter(item => /^100(?:644|755)\t/.test(item))
      .map(item => item.slice(item.indexOf('\t') + 1)),
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

function matchesPattern(pattern, filename) {
  return pattern.endsWith('/**') ? filename.startsWith(pattern.slice(0, -2)) : filename === pattern;
}

function matchesCriticalPath(policy, filename) {
  return policy.patterns.some(pattern => matchesPattern(pattern, filename));
}

function isTestPath(filename) {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|__mocks__|__snapshots__)\//.test(filename) ||
    /\.(?:test|spec)\.[^/.]+$/.test(filename) || filename.endsWith('.snap');
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
  if (newest.updated_at !== newest.created_at) {
    throw new Error('Edited review verdict. Post a new verdict comment.');
  }
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
  const testChanges = new Set();
  for (const file of files) {
    if (!filePath(file?.filename) || typeof file.status !== 'string' ||
      (file.status === 'renamed' && !filePath(file.previous_filename))) {
      throw new Error('Invalid PR file inventory');
    }
    filenames.add(file.filename);
    if (file.status === 'renamed') filenames.add(file.previous_filename);
    const removed = file.status === 'renamed' ? file.previous_filename : file.filename;
    if (['removed', 'renamed'].includes(file.status) && isTestPath(removed)) {
      testChanges.add(removed);
      testChanges.add(file.filename);
    }
  }

  const critical = [...filenames].filter(filename => testChanges.has(filename) || matchesCriticalPath(policy, filename));
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

function checkDocumentedPaths(docs, policy) {
  const critical = docs.split(/^## /m).find(section => section.startsWith('Critical changes ('));
  assert.ok(critical, 'Missing AGENTS.md critical changes section');
  const [rules, exclusions] = critical.split(/^\*\*Not critical on their own\.\*\*/m);
  assert.ok(exclusions, 'Missing AGENTS.md critical changes exclusions');
  const documented = [...rules.matchAll(/`(\/?[\w.-]+(?:\/[\w.-]+)*\/?)`/g)]
    .map(([, filename]) => filename.replace(/^\//, ''));
  assert.ok(documented.length > 0, 'Missing AGENTS.md critical path references');
  const unmapped = documented.filter(filename =>
    !matchesCriticalPath(policy, filename) && !policy.packageScriptFiles.includes(filename));
  assert.deepEqual(unmapped, [], 'Unmapped critical path references in AGENTS.md: ' + unmapped.join(', '));
}

function checkPolicyPaths(policy, files) {
  const unmatched = [...policy.patterns, ...policy.packageScriptFiles].filter(pattern =>
    !files.some(filename => matchesPattern(pattern, filename)));
  assert.deepEqual(unmatched, [], 'Critical policy paths absent from the candidate tree: ' + unmatched.join(', '));
}

function fixtureInventory(git, base, head) {
  const fields = git(['diff', '--name-status', '-z', '-M', base, head, '--']).split('\0');
  const files = [];
  const statuses = { A: 'added', D: 'removed', M: 'modified' };
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    const filename = fields[i++];
    if (status === 'R100') {
      files.push({ filename: fields[i++], previous_filename: filename, status: 'renamed' });
    } else {
      assert.ok(statuses[status], 'Unexpected synthetic Git diff status: ' + status);
      files.push({ filename, status: statuses[status] });
    }
  }
  return files;
}

async function checkVerdicts(temp) {
  const source = path.join(temp, 'source');
  const checkout = path.join(temp, 'checkout');
  mkdirSync(source);
  const git = args => gitAt(source, args, 'utf8');
  git(['init', '--template=', '--object-format=sha1', '--initial-branch=base']);
  git(['config', 'user.name', 'Synthetic fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  const criticalFile = 'scripts/deploy/run.sh';
  const renameFile = 'scripts/deploy/rename.sh';
  const scopeFile = 'scripts/deploy/scope.sh';
  const testFile = 'tests/fixture.test.js';
  const mockFile = 'apps/example/src/__mocks__/fixture.js';
  const write = (filename, content) => writeFileSync(path.join(source, filename), content);
  const stage = (filename, content) => {
    write(filename, content);
    git(['add', '--', filename]);
  };
  const commit = message => {
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  mkdirSync(path.join(source, 'scripts/deploy'), { recursive: true });
  mkdirSync(path.join(source, 'tests'));
  stage(criticalFile, 'base\n');
  stage(renameFile, 'synthetic rename source\n');
  stage(scopeFile, 'scope\n');
  stage(testFile, 'synthetic test\n');
  mkdirSync(path.dirname(path.join(source, mockFile)), { recursive: true });
  stage(mockFile, 'synthetic test double\n');
  stage('package.json', '{}\n');
  const base = commit('Fixture base');
  git(['switch', '--detach', base]);
  stage(criticalFile, 'reviewed\n');
  const old = commit('Reviewed critical edit');
  git(['branch', 'reviewed', old]);

  function buildCase(name, edit, parent = old) {
    git(['switch', '--detach', parent]);
    edit();
    const head = commit(name);
    git(['branch', name, head]);
    return { head, files: fixtureInventory(git, base, head) };
  }
  const unchanged = buildCase('unchanged', () => stage('note.md', 'synthetic note\n'));
  const added = buildCase('added', () => stage('scripts/deploy/added.sh', 'synthetic addition\n'));
  const removed = buildCase('removed', () => git(['rm', '--', criticalFile]));
  const missingInBoth = buildCase('after-removal', () => stage('note.md', 'synthetic note\n'), removed.head);
  const modeChanged = buildCase('mode-change', () => {
    chmodSync(path.join(source, criticalFile), 0o755);
    git(['update-index', '--chmod=+x', '--', criticalFile]);
  });
  const renamed = buildCase('renamed', () => git(['mv', '--', renameFile, 'moved.sh']));
  const testRemoved = buildCase('test-removed', () => git(['rm', '--', testFile]), base);
  const testRenamed = buildCase('test-renamed', () => git(['mv', '--', testFile, 'moved-test.js']), base);
  const testEdited = buildCase('test-edited', () => stage(testFile, 'updated synthetic test\n'), base);
  const mockRemoved = buildCase('mock-removed', () => git(['rm', '--', mockFile]), base);
  const mockEdited = buildCase('mock-edited', () => stage(mockFile, 'updated test double\n'), base);
  const scopeChanged = buildCase('scope-change', () => stage(scopeFile, 'scope expanded\n'));
  const nonCritical = buildCase('non-critical', () => stage('note.md', 'synthetic note\n'), base);
  const manifestOnly = buildCase('manifest-metadata', () => stage('package.json', '{"private":true}\n'), base);
  const manifestScripts = buildCase('manifest-scripts', () => stage('package.json', '{"scripts":{"lint":"check"}}\n'), base);
  assert.ok(renamed.files.some(file => file.status === 'renamed' && file.previous_filename === renameFile),
    'Git fixture must report a rename out of the critical paths');
  assert.ok(!unchanged.files.some(file => file.filename === scopeFile) &&
    scopeChanged.files.some(file => file.filename === scopeFile), 'Git fixture must expand the reviewed scope');
  assert.equal(git(['rev-parse', old + ':' + criticalFile]), git(['rev-parse', modeChanged.head + ':' + criticalFile]),
    'Mode-only change must preserve the blob ID');

  gitAt(temp, ['clone', '--no-local', '--depth=1', '--single-branch', '--branch', 'base', source, checkout]);
  const objects = gitObjects(checkout);
  const head = unchanged.head;
  const event = readEvent('pull_request', { pull_request: { number: 17, base: { sha: base }, head: { sha: head } } });
  const groupEvent = readEvent('merge_group', { merge_group: {
    base_sha: base, head_ref: 'refs/heads/gh-readonly-queue/main/pr-17-' + old,
  } });
  assert.deepEqual(groupEvent, { number: event.number, base });
  assert.throws(() => readEvent('merge_group', { merge_group: { base_sha: base, head_ref: 'refs/heads/main' } }),
    /Cannot identify PR/);

  const policy = readPolicy({
    paths: { releaseGates: ['.github/workflows/**'], production: ['scripts/deploy/**'] },
    packageScriptFiles: ['package.json'],
    verdictAccountIds: [11],
  });
  const docs = '## Critical changes (fixture)\nRecognize `scripts/deploy/`.\n**Not critical on their own.**';
  checkDocumentedPaths(docs, policy);
  assert.throws(() => checkDocumentedPaths(docs, { ...policy, patterns: ['.github/workflows/**'] }),
    /Unmapped critical path references in AGENTS\.md: scripts\/deploy\//);
  checkPolicyPaths({ ...policy, patterns: ['scripts/deploy/**', criticalFile] }, objects.files());
  assert.throws(() => checkPolicyPaths({ ...policy, patterns: ['scripts/deploy/typo.sh'] }, objects.files()),
    /Critical policy paths absent from the candidate tree: scripts\/deploy\/typo\.sh/);
  assert.throws(() => checkPolicyPaths({ ...policy, patterns: ['scripts/empty/**'] }, objects.files()),
    /Critical policy paths absent from the candidate tree: scripts\/empty\/\*\*/);
  let nextId = 0;
  const earlier = '2026-01-01T00:00:00Z';
  const later = '2026-01-02T00:00:00Z';
  const comment = (body, author = 11, created = earlier, updated = created) => ({
    id: ++nextId, body, user: { id: author }, created_at: created, updated_at: updated,
  });
  async function check({ comments = [], candidate = unchanged, changedFiles = candidate.files.length,
    secondHead = candidate.head, state = 'open', request = { ...event, eventHead: candidate.head } } = {}) {
    const { number } = event;
    const endpoint = '/pulls/' + number;
    let reads = 0;
    const api = {
      get: async route => {
        if (route.startsWith('/compare/')) {
          assert.equal(route, '/compare/' + base + '...' + candidate.head + '?per_page=1');
          return { merge_base_commit: { sha: base } };
        }
        assert.equal(route, endpoint);
        const currentHead = reads++ ? secondHead : candidate.head;
        return { number, state, head: { sha: currentHead }, changed_files: changedFiles };
      },
      list: async route => {
        if (route === endpoint + '/files') return candidate.files;
        assert.equal(route, '/issues/' + number + '/comments');
        return comments;
      },
    };
    return enforce(request, policy, api, objects);
  }

  await assert.rejects(check(), /Missing review verdict/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head), comment('VERDICT: NO_GO ' + head)] }), /NO_GO/);
  const laterNoGo = comment('VERDICT: NO_GO ' + head, 11, later);
  const earlierGo = comment('VERDICT: GO ' + head);
  await assert.rejects(check({ comments: [earlierGo, laterNoGo] }), /NO_GO/);
  const editedGo = comment('VERDICT: GO ' + head, 11, earlier, later);
  await assert.rejects(check({ comments: [earlierGo, editedGo] }), /Post a new verdict comment/);
  assert.match(await check({ comments: [editedGo, comment('VERDICT: GO ' + head, 11, later)] }), /accepted/);
  const reviewed = [comment('VERDICT: GO ' + old)];
  assert.match(await check({ comments: reviewed }), /accepted/, 'unchanged critical entry');
  for (const [name, candidate] of Object.entries({ added, removed, modeChanged, renamed, scopeChanged })) {
    await assert.rejects(check({ candidate, comments: reviewed }), /stale/, name);
  }
  assert.match(await check({ candidate: missingInBoth, comments: [comment('VERDICT: GO ' + removed.head)] }),
    /accepted/, 'reviewed removal is still absent at the current head');
  await assert.rejects(check({ candidate: testRemoved }), /Missing review verdict/);
  await assert.rejects(check({ candidate: testRenamed }), /Missing review verdict/);
  await assert.rejects(check({ candidate: testRenamed, comments: [comment('VERDICT: GO ' + testRemoved.head)] }), /stale/);
  assert.match(await check({ candidate: testEdited }), /No critical/);
  await assert.rejects(check({ candidate: mockRemoved }), /Missing review verdict/);
  assert.match(await check({ candidate: mockEdited }), /No critical/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head), comment('VERDICT: GO abc')] }), /Malformed/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head + '\nVERDICT: NO_GO ' + head)] }), /Malformed/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head, 12)] }), /Missing/);
  const brokenApi = githubClient('example/repo', String(11), async () => ({ ok: false, status: 503 }));
  await assert.rejects(enforce(event, policy, brokenApi, objects), /HTTP 503/);
  const commentsEndpoint = '/issues/17/comments';
  const commentsUrl = 'https://api.github.com/repos/example/repo' + commentsEndpoint + '?per_page=100&page=';
  const pages = firstPage => githubClient('example/repo', String(11), async url => {
    if (url === commentsUrl + '1') {
      return new Response(JSON.stringify(firstPage), { headers: { link: '<' + commentsUrl + '2>; rel="next"' } });
    }
    assert.equal(url, commentsUrl + '2');
    return new Response(JSON.stringify([laterNoGo]));
  });
  const firstPage = [earlierGo, ...Array.from({ length: 99 }, () => comment('Note', 12))];
  await assert.rejects(check({ comments: await pages(firstPage).list(commentsEndpoint) }), /NO_GO/);
  await assert.rejects(pages([earlierGo]).list(commentsEndpoint), /Incomplete GitHub API page/);
  assert.match(await check({ comments: [comment('VERDICT: GO ' + head)] }), /accepted/);
  await assert.rejects(check({ request: groupEvent }), /Missing review verdict/);
  assert.match(await check({ request: groupEvent, comments: [comment('VERDICT: GO ' + head)] }), /accepted/);
  assert.match(await check({ candidate: nonCritical }), /No critical/);
  await assert.rejects(check({ request: { ...event, eventHead: old } }), /Cannot verify PR head/);
  await assert.rejects(check({ state: 'closed' }), /Cannot verify PR head/);
  await assert.rejects(check({ changedFiles: unchanged.files.length + 1 }), /Incomplete/);
  await assert.rejects(check({ comments: [comment('VERDICT: GO ' + head)], secondHead: old }), /PR changed/);
  assert.match(await check({ candidate: manifestOnly }), /No critical/);
  await assert.rejects(check({ candidate: manifestScripts }), /Missing/);
}

async function selfCheck(root, policy) {
  checkDocumentedPaths(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), policy);
  checkPolicyPaths(policy, gitObjects(root).files());
  const temp = mkdtempSync(path.join(tmpdir(), 'review-verdict-'));
  try {
    await checkVerdicts(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('Review verdict self-checks passed');
}

async function main(env) {
  const root = path.resolve(__dirname, '../..');
  const policy = readPolicy(JSON.parse(readFileSync(path.join(root, 'config/ci/critical-paths.json'), 'utf8')));
  if (process.argv[2] === '--self-check') return selfCheck(root, policy);
  const event = readEvent(env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
  console.log(await enforce(event, policy, githubClient(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN), gitObjects(root)));
}

main(process.env).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
