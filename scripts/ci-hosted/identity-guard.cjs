'use strict';
const { readFileSync } = require('node:fs');
const { git } = require('./target-policy.cjs');

class GuardError extends Error {}

function readGit(reason, args, input) {
  try {
    return git(['--no-replace-objects', '--no-lazy-fetch', ...args], 'utf8', input);
  } catch {
    throw new GuardError(reason);
  }
}

function loadAllowlist() {
  let allowed;
  try {
    allowed = require('../../config/ci/commit-identities.json');
  } catch {
    throw new GuardError('unreadable allowlist');
  }
  const isText = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(allowed) || !allowed.length) throw new GuardError('invalid allowlist');
  return allowed.map(entry => {
    if (!isText(entry?.name) || !isText(entry.reason)) throw new GuardError('invalid allowlist row');
    const isBot = entry.login !== undefined;
    if (isBot ? !isText(entry.login) || !Number.isSafeInteger(entry.id) || entry.id < 1
      : !isText(entry.localPart) || !isText(entry.host)) {
      throw new GuardError('invalid allowlist address');
    }
    // Derive exact addresses from public GitHub metadata to keep source free of email literals.
    const localPart = isBot ? `${entry.id}+${entry.login}` : entry.localPart;
    const host = isBot ? 'users.noreply.github.com' : entry.host;
    return { ...entry, email: [localPart, host].join('@') };
  });
}

function unapprovedCommits(base, head, allowed) {
  const isSha = value => /^[a-f0-9]{40}$/.test(value || '');
  if (!isSha(base) || !isSha(head) || base === head) {
    throw new GuardError('invalid merge group range');
  }
  if (readGit('cannot read checkout head', ['rev-parse', 'HEAD']).trim() !== head) {
    throw new GuardError('merge group head mismatch');
  }

  // The squash queue is a linear chain. Raw parent headers survive a shallow checkout.
  const commits = [];
  for (let sha = head; sha !== base;) {
    const type = readGit('cannot find merge group commit',
      ['cat-file', '--batch-check=%(objecttype)'], `${sha}\n`).trim();
    if (type === `${sha} missing`) {
      readGit('cannot fetch merge group commit',
        ['fetch', '--no-tags', '--depth=1', '--filter=tree:0', 'origin', sha]);
    }
    const commit = readGit('cannot read merge group commit', ['cat-file', 'commit', sha]);
    const parent = /^tree [a-f0-9]{40}\nparent ([a-f0-9]{40})\n(?!parent )/.exec(commit)?.[1];
    if (!parent) throw new GuardError('merge group is not a squash chain to base');
    commits.push(sha);
    sha = parent;
  }

  const fields = readGit('cannot list merge group identities',
    ['log', '--no-walk=unsorted', '-z', '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', ...commits.reverse(), '--']).split('\0');
  if (fields.pop() !== '' || fields.length !== commits.length * 5) {
    throw new GuardError('invalid merge group identity records');
  }
  const unapproved = [];
  const permits = (name, email) => allowed.some(entry => entry.name === name && entry.email === email);
  for (let index = 0; index < fields.length; index += 5) {
    const [sha, author, authorEmail, committer, committerEmail] = fields.slice(index, index + 5);
    if (sha !== commits[index / 5]) throw new GuardError('merge group identity records mismatch');
    if (!permits(author, authorEmail) || !permits(committer, committerEmail)) {
      unapproved.push(sha.slice(0, 12));
    }
  }
  return unapproved;
}

function checkOpener(allowed) {
  let payload;
  try {
    payload = readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8');
  } catch {
    throw new GuardError('unreadable pull request event');
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new GuardError('invalid pull request event JSON');
  }
  const opener = event?.pull_request?.user;
  if (typeof opener?.type !== 'string' || typeof opener.login !== 'string' || !Number.isSafeInteger(opener.id)) {
    throw new GuardError('invalid pull request opener record');
  }
  return opener.type === 'Bot' && allowed.some(entry => entry.id === opener.id && entry.login === opener.login);
}

function failure(allowed) {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    return checkOpener(allowed) ? '' : 'opener fail';
  }
  if (process.env.GITHUB_EVENT_NAME !== 'merge_group') throw new GuardError('unsupported event');
  const rejected = unapprovedCommits(process.env.GROUP_BASE, process.env.GROUP_HEAD, allowed);
  return rejected.length ? `fail (${rejected.length} commits) ${rejected.join(' ')}` : '';
}

try {
  const reason = failure(loadAllowlist());
  if (reason) {
    console.error(`identity-guard: ${reason}`);
    process.exitCode = 1;
  } else console.log('identity-guard: pass');
} catch (error) {
  console.error(`identity-guard: error (${error instanceof GuardError ? error.message : 'unexpected guard failure'})`);
  process.exitCode = 1;
}
