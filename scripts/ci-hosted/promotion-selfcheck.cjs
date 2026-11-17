'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { devPromotion, evaluatePolicy, policySource } = require('./policy.cjs');
const repository = 'synthetic/project';
const tip = 'a'.repeat(40); const base = 'b'.repeat(40);
const candidate = 'c'.repeat(40);
const repo = { id: 1, full_name: repository, fork: false };
const fork = { id: 2, full_name: 'synthetic/fork', fork: true };
const event = (target = 'main', branch = 'dev', headRepo = repo) => ({ pull_request: {
  number: 7,
  base: { ref: target, sha: base, repo: { ...repo } },
  head: { ref: branch, sha: tip, repo: { ...headRepo } },
} });
const calls = [];
const read = args => {
  calls.push(args);
  if (args[1] === '--is-shallow-repository') return 'true\n';
  return args[0] === 'rev-parse' ? `${tip}\n` : '';
};
const prEvent = 'pull_request';
assert.equal(devPromotion(event(), prEvent, repository, read), true);
assert.deepEqual(calls, [
  ['rev-parse', '--is-shallow-repository'],
  ['fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin', '+refs/heads/dev:refs/policy/dev'],
  ['rev-parse', 'refs/policy/dev'],
  ['merge-base', '--is-ancestor', base, tip],
]);
assert.throws(() => devPromotion(event(), prEvent, repository, args => {
  if (args[0] === 'merge-base') throw new Error('main has commits absent from dev');
  return read(args);
}), /main-to-dev back-merge/);
const stale = event(); stale.pull_request.head.sha = candidate;
assert.throws(() => devPromotion(stale, prEvent, repository, read), /stale/);
for (const mutate of [
  pr => { delete pr.head; },
  pr => { delete pr.head.ref; },
  pr => { pr.head.repo.fork = true; },
  pr => { delete pr.head.repo; },
  pr => { delete pr.head.repo.id; },
  pr => { delete pr.head.repo.full_name; },
  pr => { delete pr.head.repo.fork; },
  pr => { delete pr.head.sha; },
  pr => { pr.head.sha = 'invalid'; },
  pr => { delete pr.base.repo; },
  pr => { delete pr.base.repo.id; },
  pr => { delete pr.base.repo.full_name; },
]) {
  const bad = event(); mutate(bad.pull_request);
  calls.length = 0;
  assert.throws(() => devPromotion(bad, prEvent, repository, read));
  assert.equal(calls.length, 0);
}
assert.throws(() => devPromotion(event(), prEvent, '', read));
assert.throws(() => devPromotion(event(), prEvent, repository, () => { throw new Error('unreadable dev tip'); }), /unreadable/);
assert.throws(() => devPromotion(event(), prEvent, repository, () => 'invalid'), /SHA/);
for (const branch of ['feature', 'main', 'preview', 'hotfix', 'hotfix/']) {
  assert.throws(() => devPromotion(event('main', branch), prEvent, repository, read), /Main accepts/);
}
for (const branch of ['dev', 'hotfix/urgent']) {
  assert.throws(() => devPromotion(event('main', branch, fork), prEvent, repository, read), /Main accepts/);
}
assert.equal(devPromotion(event('dev', 'dev'), prEvent, repository, read), false);
assert.equal(calls.length, 0);
for (const field of ['title', 'body']) {
  const edited = { ...event(), action: 'edited', changes: { [field]: { from: 'synthetic previous text' } } };
  assert.equal(policySource(edited, prEvent), base);
  assert.equal(devPromotion(edited, prEvent, repository, read), true);
}

const workflowFiles = ['.github/workflows/policy.yml', '.github/workflows/public-ci.yml'];
const gitFixture = (files, gitCalls = []) => args => {
  gitCalls.push(args);
  if (args[0] === 'fetch') return '';
  if (args[0] === 'rev-parse') return ({
    '--is-shallow-repository': 'false\n',
    'refs/policy/dev': tip, 'refs/policy/candidate': candidate,
    [`${candidate}^1`]: base, [`${candidate}^2`]: tip,
  })[args[1]];
  if (args[0] === 'diff') {
    assert.deepEqual(args, ['diff', '--no-renames', '--name-status', '-z', base, candidate]);
    return files.map(file => `M\0${file}\0`).join('');
  }
  if (args[0] === 'ls-tree') return args.includes('.github/workflows') ? workflowFiles.join('\0') : '';
  if (args[0] === 'show') return "env:\n  NPM_CONFIG_IGNORE_SCRIPTS: 'true'\n";
  if (args[0] === 'merge-base') {
    assert.deepEqual(args, ['merge-base', '--is-ancestor', base, tip]);
    return '';
  }
  throw new Error(`Unexpected fixture Git operation: ${args[0]}`);
};
const featurePr = { ...event('dev', 'feature'), action: 'opened' };
assert.doesNotThrow(() => evaluatePolicy(featurePr, prEvent, repository, gitFixture(['docs/example.md'])));
const mainBase = { ...featurePr.pull_request.base, ref: 'main', sha: 'd'.repeat(40) };
const retargeted = {
  action: 'edited',
  changes: { base: { ref: { from: 'dev' } } },
  pull_request: { ...featurePr.pull_request, base: mainBase },
};
assert.equal(policySource(retargeted, prEvent), mainBase.sha);
assert.throws(() => evaluatePolicy(retargeted, prEvent, repository, () => {
  assert.fail('Retargeted feature PR must be refused before reading candidate Git objects');
}), /Main accepts/);
const hotfix = event('main', 'hotfix/urgent');
assert.doesNotThrow(() => evaluatePolicy(hotfix, prEvent, repository, gitFixture(['docs/example.md'])));
assert.throws(() => evaluatePolicy(hotfix, prEvent, repository, gitFixture([workflowFiles[1]])), /target marker is closed/);
assert.doesNotThrow(() => evaluatePolicy(event(), prEvent, repository, gitFixture([workflowFiles[1], 'docs/example.md'])));
const forkCalls = [];
const forkPr = event('dev', 'feature', fork);
assert.doesNotThrow(() => evaluatePolicy(forkPr, prEvent, repository, gitFixture(['docs/example.md'], forkCalls)));
assert.deepEqual(forkCalls.filter(([op]) => op === 'fetch'), [
  ['fetch', '--no-tags', '--depth=2', 'origin', '+refs/pull/7/merge:refs/policy/candidate'],
]);
assert.throws(() => evaluatePolicy(forkPr, prEvent, repository, gitFixture([workflowFiles[1], 'docs/example.md'])), /touch nothing outside/);
for (const baseRef of ['dev', 'refs/heads/dev']) {
  const group = { merge_group: { base_ref: baseRef, base_sha: base, head_sha: candidate } };
  const groupCalls = [];
  assert.doesNotThrow(() => evaluatePolicy(group, 'merge_group', repository, gitFixture(['docs/example.md'], groupCalls)));
  assert.deepEqual(groupCalls.slice(0, 3), [
    ['fetch', '--no-tags', '--depth=64', 'origin', base],
    ['fetch', '--no-tags', '--depth=64', 'origin', candidate],
    ['diff', '--no-renames', '--name-status', '-z', base, candidate],
  ]);
  delete group.merge_group.head_sha;
  assert.throws(() => evaluatePolicy(group, 'merge_group', repository, gitFixture([])), /SHA/);
}
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'scripts/ci-hosted/render-policy.py', '--check']);
const workflow = fs.readFileSync('.github/workflows/policy.yml', 'utf8');
assert.equal(workflow.includes('ref: ${{ steps.source.outputs.base }}'), true);
assert.equal(workflow.includes('persist-credentials: false'), true);
assert.equal(/secrets\.|pull_request\.head|head\.sha/.test(workflow), false);
assert.match(workflow, /^  pull_request:\n    types: \[opened, synchronize, reopened, edited\]$/m);
assert.doesNotMatch(workflow, /^  pull_request_target:/m);
assert.equal(workflow.includes('run: node scripts/ci-hosted/promotion-selfcheck.cjs'), false);
console.log('PASS: dev promotions and ancestry, retarget refusal, guarded hotfixes, fork PR data, queue range and generated workflow');
