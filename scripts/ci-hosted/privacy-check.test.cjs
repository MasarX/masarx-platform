'use strict';
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'privacy-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const email = ['fixture[bot]', 'users.noreply.github.com'].join('@');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
  };
  const git = (args, overrides = {}) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const write = (file, data) => writeFileSync(join(cwd, file), data);
  git(['init', '-q']);
  return { email, git, write, scan(base, event = 'pull_request') {
    const head = git(['rev-parse', 'HEAD']);
    return spawnSync(process.execPath, [join(__dirname, 'privacy-check.cjs'), base, head], {
      cwd, env: { ...env, GITHUB_EVENT_NAME: event }, encoding: 'utf8',
    });
  } };
}

test('privacy check rejects each seeded rule, including findings removed by a later commit', t => {
  const { git, scan, write } = fixture(t);
  const token = ['gh', 'p_', randomBytes(18).toString('hex')].join('');
  const workstationPath = ['Q:', 'Users', 'fixture', 'work'].join('/');
  const privateIpv4 = [192, 168, 71, 72].join('.');
  const authorEmail = ['fixture-author', 'example.invalid'].join('@');
  const committerEmail = ['fixture-committer', 'example.invalid'].join('@');
  write('sample.txt', 'Original line\n');
  git(['add', '.']);
  git(['commit', '-qm', 'Base']);
  const base = git(['rev-parse', 'HEAD']);

  write(`binary-${privateIpv4}-file.bin`, Buffer.from([0, 1, 2]));
  write('sample.txt', `Original line\n${token}\n${workstationPath}\n`);
  git(['add', '.']);
  git(['commit', '-qm', `Seed findings\n\n${privateIpv4}\nCo-authored-by: Fixture\nGenerated with Fixture`], {
    GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_EMAIL: committerEmail,
  });
  const seeded = git(['rev-parse', 'HEAD']);
  git(['revert', '--no-edit', seeded]);

  const result = scan(base);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.stderr.trim().split('\n').sort(), [
    `absolute-workstation-path sample.txt:3`,
    `author-email commit/${seeded}:1`,
    `co-author-trailer commit/${seeded}:6`,
    `committer-email commit/${seeded}:2`,
    `credential-shape sample.txt:2`,
    `private-ipv4 commit/${seeded}:5`,
    `private-ipv4 commit/${seeded}/path/1:1`,
    `tool-attribution-trailer commit/${seeded}:7`,
  ].sort());
});

test('privacy check scans only additions and accepts GitHub squash attribution only in the merge group', t => {
  const { email, git, scan, write } = fixture(t);
  const inherited = [10, 9, 8, 7].join('.');
  write('sample.txt', `${inherited}\n`);
  git(['add', '.']);
  git(['commit', '-qm', 'Base']);
  const base = git(['rev-parse', 'HEAD']);
  write('sample.txt', `${inherited}\n203.0.113.10\n`);
  git(['add', '.']);
  git(['commit', '-qm', `Public example\n\nCo-authored-by: Fixture <${email}>`], {
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: ['noreply', 'github.com'].join('@'),
  });

  const group = scan(base, 'merge_group');
  assert.equal(group.status, 0, group.stderr);
  assert.equal(group.stderr, '');
  assert.equal(group.stdout, '');
  const pr = scan(base);
  assert.equal(pr.status, 1);
  assert.equal(pr.stderr, `co-author-trailer commit/${git(['rev-parse', 'HEAD'])}:5\n`);
});
