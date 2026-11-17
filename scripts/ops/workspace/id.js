#!/usr/bin/env node
const crypto = require('crypto');
const path = require('path');
const {
  assertCommandDidNotTimeOut,
  runBoundedSyncCommand,
} = require('./bounded-sync-command');

function shell(cmd, args, options = {}) {
  const result = runBoundedSyncCommand(cmd, args, options);
  assertCommandDidNotTimeOut(result, `[workspace/id] ${cmd} identity probe`);
  return result.ok ? result.stdout.trim() : '';
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function computeWorkspaceId(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.WORKSPACE_NAME || '').trim();
  if (explicit) return explicit;
  const user = env.CI
    ? (env.GITHUB_ACTOR || 'ci')
    : (shell('git', ['config', 'user.name'], { ...options, env }) || env.USER || 'local');
  const owner = slugify(user) || 'user';
  const root = shell('git', ['rev-parse', '--show-toplevel'], { ...options, env }) || options.cwd || process.cwd();
  const cwd = path.resolve(root);
  const suffix = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return `wk-${owner}-${suffix}`;
}

if (require.main === module) {
  console.log(computeWorkspaceId());
}

module.exports = { computeWorkspaceId, shell };
