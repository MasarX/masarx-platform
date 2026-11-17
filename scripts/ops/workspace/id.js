#!/usr/bin/env node
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

function shell(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function computeWorkspaceId() {
  const explicit = String(process.env.WORKSPACE_NAME || '').trim();
  if (explicit) return explicit;
  const user = process.env.CI
    ? (process.env.GITHUB_ACTOR || 'ci')
    : (shell('git', ['config', 'user.name']) || process.env.USER || 'local');
  const owner = slugify(user) || 'user';
  const root = shell('git', ['rev-parse', '--show-toplevel']) || process.cwd();
  const cwd = path.resolve(root);
  const suffix = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return `wk-${owner}-${suffix}`;
}

if (require.main === module) {
  console.log(computeWorkspaceId());
}

module.exports = { computeWorkspaceId };
