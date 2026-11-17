'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { devPromotion, policySource, classify, enforceScope } = require('./policy.cjs');
const repository = 'synthetic/project';
const tip = 'a'.repeat(40); const base = 'b'.repeat(40);
const repo = { id: 1, full_name: repository, fork: false };
const event = (target = 'main', branch = 'dev') => ({ pull_request: {
  base: { ref: target, sha: base, repo: { ...repo } },
  head: { ref: branch, sha: tip, repo: { ...repo } },
} });
const calls = [];
const read = args => { calls.push(args); return args[0] === 'rev-parse' ? `${tip}\n` : ''; };
for (const target of ['main', 'preview']) {
  calls.length = 0;
  assert.equal(devPromotion(event(target), 'pull_request_target', repository, read), true);
  assert.deepEqual(calls, [
    ['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/dev:refs/policy/dev'],
    ['rev-parse', 'refs/policy/dev'],
  ]);
  assert.equal(policySource(event(target), 'pull_request_target'), base);
  const stale = event(target); stale.pull_request.head.sha = 'c'.repeat(40);
  assert.throws(() => devPromotion(stale, 'pull_request_target', repository, read), /stale/);
  for (const mutate of [
    e => { e.pull_request.head.repo = { id: 2, full_name: 'synthetic/fork', fork: true }; },
    e => { e.pull_request.head.repo.fork = true; },
    e => { delete e.pull_request.head.repo; },
    e => { delete e.pull_request.head.repo.id; },
    e => { delete e.pull_request.head.repo.full_name; },
    e => { delete e.pull_request.head.repo.fork; },
    e => { delete e.pull_request.head.sha; },
    e => { e.pull_request.head.sha = 'invalid'; },
    e => { delete e.pull_request.base.repo; },
    e => { delete e.pull_request.base.repo.id; },
    e => { delete e.pull_request.base.repo.full_name; },
  ]) {
    const bad = event(target); mutate(bad);
    calls.length = 0;
    assert.throws(() => devPromotion(bad, 'pull_request_target', repository, read));
    assert.equal(calls.length, 0);
  }
  assert.throws(() => devPromotion(event(target), 'pull_request_target', '', read));
  assert.throws(() => devPromotion(event(target), 'pull_request_target', repository, () => { throw new Error('unreadable dev tip'); }), /unreadable/);
  assert.throws(() => devPromotion(event(target), 'pull_request_target', repository, () => 'invalid'), /SHA/);
}
for (const branch of ['feature', 'main', 'preview']) {
  assert.throws(() => devPromotion(event('main', branch), 'pull_request_target', repository, read), /Main accepts/);
}
const missingHead = event(); delete missingHead.pull_request.head;
assert.throws(() => devPromotion(missingHead, 'pull_request_target', repository, read), /Main accepts/);
const missingBranch = event(); delete missingBranch.pull_request.head.ref;
assert.throws(() => devPromotion(missingBranch, 'pull_request_target', repository, read), /Main accepts/);
for (const [target, branch] of [['dev', 'dev'], ['dev', 'feature'], ['preview', 'feature']]) {
  calls.length = 0;
  assert.equal(devPromotion(event(target, branch), 'pull_request_target', repository, read), false);
  assert.equal(calls.length, 0);
}
assert.equal(devPromotion(event(), 'merge_group', repository, read), false);
for (const field of ['title', 'body']) {
  const edited = { ...event(), action: 'edited', changes: { [field]: { from: 'synthetic previous text' } } };
  assert.equal(policySource(edited, 'pull_request_target'), base);
  assert.equal(devPromotion(edited, 'pull_request_target', repository, read), true);
}
const retargeted = { ...event('main', 'feature'), action: 'edited', changes: { base: { ref: { from: 'dev' } } } };
assert.equal(policySource(retargeted, 'pull_request_target'), base);
assert.throws(() => devPromotion(retargeted, 'pull_request_target', repository, read), /Main accepts/);
// Ordinary mixed protected changes still require the existing scope rule.
assert.throws(() => enforceScope(classify([['M', '.github/workflows/public-ci.yml'], ['M', 'synthetic.txt']]), 'pull_request_target'));
const workflow = fs.readFileSync('.github/workflows/policy.yml', 'utf8');
assert.equal(workflow.includes('ref: ${{ steps.source.outputs.base }}'), true);
assert.equal(workflow.includes('persist-credentials: false'), true);
assert.equal(/secrets\.|pull_request\.head|head\.sha/.test(workflow), false);
assert.equal(workflow.includes('types: [opened, synchronize, reopened, edited]'), true);
assert.equal(workflow.includes('run: node scripts/ci-hosted/promotion-selfcheck.cjs'), false);
console.log('PASS: live dev promotions, main-only promotion flow, stale/missing identities, forks and base-owned execution');
