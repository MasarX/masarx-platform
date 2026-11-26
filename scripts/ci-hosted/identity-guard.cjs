'use strict';
const { readFileSync } = require('node:fs');
const { git } = require('./target-policy.cjs');

function readGit(...args) {
  return git(['--no-replace-objects', ...args]);
}

function loadAllowlist() {
  const allowed = require('../../config/ci/commit-identities.json');
  const isText = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(allowed) || !allowed.length) throw new Error('Empty identity allowlist');
  return allowed.map(entry => {
    if (!isText(entry?.name) || !isText(entry.reason)) throw new Error('Invalid identity allowlist entry');
    const isBot = entry.login !== undefined;
    if (isBot ? !isText(entry.login) || !Number.isSafeInteger(entry.id) || entry.id < 1
      : !isText(entry.localPart) || !isText(entry.host)) {
      throw new Error('Invalid identity address components');
    }
    // Derive exact addresses from public GitHub metadata to keep source free of email literals.
    const localPart = isBot ? `${entry.id}+${entry.login}` : entry.localPart;
    const host = isBot ? 'users.noreply.github.com' : entry.host;
    return { ...entry, email: [localPart, host].join('@') };
  });
}

function unapprovedCommits(base, head, allowed) {
  const isSha = value => /^[a-f0-9]{40}$/.test(value || '');
  if (!isSha(base) || !isSha(head) || readGit('rev-parse', 'HEAD').trim() !== head) {
    throw new Error('Invalid merge group range');
  }

  // The existing checkout is shallow. Fetch the commit graph without trees or blobs.
  if (readGit('rev-parse', '--is-shallow-repository').trim() === 'true') {
    readGit('fetch', '--no-tags', '--unshallow', '--filter=tree:0', 'origin', head);
  }
  if (readGit('rev-parse', '--is-shallow-repository').trim() !== 'false') {
    throw new Error('Incomplete merge group history');
  }
  readGit('merge-base', '--is-ancestor', base, head);

  const fields = readGit('log', '-z', '--reverse', '--no-show-signature',
    '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', `${base}..${head}`, '--').split('\0');
  if (fields.pop() !== '' || !fields.length || fields.length % 5 !== 0) {
    throw new Error('Invalid merge group commit records');
  }
  let unapproved = 0;
  const permits = (name, email) => allowed.some(entry => entry.name === name && entry.email === email);
  for (let index = 0; index < fields.length; index += 5) {
    const [sha, author, authorEmail, committer, committerEmail] = fields.slice(index, index + 5);
    if (!isSha(sha)) throw new Error('Invalid merge group commit SHA');
    if (!permits(author, authorEmail) || !permits(committer, committerEmail)) {
      unapproved += 1;
    }
  }
  return unapproved;
}

function checkOpener(allowed) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const opener = event?.pull_request?.user;
  if (opener?.type !== 'Bot' || typeof opener.login !== 'string' ||
      !allowed.some(entry => entry.id === opener.id && entry.login === opener.login)) {
    throw new Error('Invalid pull request opener');
  }
}

const isPullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';
let rejected = 0;
try {
  const allowed = loadAllowlist();
  if (isPullRequest) checkOpener(allowed);
  else if (process.env.GITHUB_EVENT_NAME === 'merge_group') {
    rejected = unapprovedCommits(process.env.GROUP_BASE, process.env.GROUP_HEAD, allowed);
    if (rejected) throw new Error('Unapproved commit identities');
  } else throw new Error('Invalid identity guard event');
  console.log('identity-guard: pass');
} catch {
  console.error(isPullRequest ? 'identity-guard: opener fail' : `identity-guard: fail (${rejected} commits)`);
  process.exitCode = 1;
}
