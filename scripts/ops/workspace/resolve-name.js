#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const { spawnSync } = require('child_process');

function parseArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${flag}`) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return '';
    }
    if (a.startsWith(`--${flag}=`)) {
      return a.split('=').slice(1).join('=');
    }
  }
  return '';
}

function resolveWorkspaceName(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const cwd = options.cwd || process.cwd();

  const explicit = parseArg(argv, 'name');
  if (explicit !== '') {
    const trimmed = String(explicit).trim();
    if (!trimmed) {
      throw new Error('`--name` was provided but is empty; supply a non-empty name or run inside a git worktree.');
    }
    return trimmed;
  }

  // npm@11+ may strip `--name` tokens (even after `--`), leaving only the
  // positional value. Accept a single positional arg as the workspace name.
  if (argv.length) {
    const positional = argv.find((a) => {
      const v = String(a || '').trim();
      if (!v) return false;
      if (v === '--') return false;
      if (v.startsWith('-')) return false;
      return true;
    });
    if (positional) return String(positional).trim();
  }

  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd });
  if (res.status !== 0) {
    throw new Error('Missing `--name` and not inside a git worktree; rerun with `--name "<desired-name>"`.');
  }
  const root = String(res.stdout || '').trim();
  if (!root) {
    throw new Error('Unable to resolve git worktree root; rerun with `--name "<desired-name>"`.');
  }
  // Git can return paths using either separator depending on platform and caller.
  // Normalize to POSIX separators so workspace naming remains deterministic in CI.
  const name = path.posix.basename(root.replace(/\\/g, '/'));
  if (!name) {
    throw new Error('Resolved git worktree name is empty; rerun with `--name "<desired-name>"`.');
  }
  return name;
}

module.exports = { resolveWorkspaceName };
