#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

function normalizeFiles(stdout) {
  const seen = new Set();
  const files = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const file = String(raw || '').trim().replace(/\\/g, '/');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

function runGit(args, { cwd = process.cwd(), spawnSyncImpl = spawnSync } = {}) {
  return spawnSyncImpl('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function resolveChangedFiles({
  cwd = process.cwd(),
  baseSha = '',
  headSha = '',
  spawnSyncImpl = spawnSync,
} = {}) {
  const attempts = [
    { strategy: 'merge_parent_diff', args: ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD^1', 'HEAD'] },
  ];

  if (baseSha && headSha) {
    attempts.push({
      strategy: 'base_head_diff',
      args: ['diff', '--name-only', '--diff-filter=ACDMRTUXB', baseSha, headSha],
    });
  }

  attempts.push(
    { strategy: 'merge_tree_diff', args: ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'] },
    { strategy: 'show_head', args: ['show', '--pretty=', '--name-only', 'HEAD'] },
  );

  const errors = [];
  for (const attempt of attempts) {
    const res = runGit(attempt.args, { cwd, spawnSyncImpl });
    if (res.status === 0) {
      return {
        strategy: attempt.strategy,
        files: normalizeFiles(res.stdout),
        errors,
      };
    }
    const stderr = String(res.stderr || res.error?.message || `git exited ${res.status}`);
    errors.push(`${attempt.strategy}: ${stderr.trim()}`);
  }

  const err = new Error(`Unable to resolve changed files via git. ${errors.join(' | ')}`);
  err.attemptErrors = errors;
  throw err;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = '1';
    }
  }
  return out;
}

function writeGithubOutput(payload) {
  const entries = Object.entries(payload);
  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const format = String(args.format || 'json').trim().toLowerCase();
  const result = resolveChangedFiles({
    baseSha: String(args['base-sha'] || process.env.PR_BASE_SHA || '').trim(),
    headSha: String(args['head-sha'] || process.env.PR_HEAD_SHA || '').trim(),
  });

  if (format === 'github-output') {
    writeGithubOutput({
      changed_files_json: JSON.stringify(result.files),
      changed_files_strategy: result.strategy,
      changed_files_count: String(result.files.length),
    });
    return;
  }

  process.stdout.write(
    JSON.stringify(
      {
        files: result.files,
        strategy: result.strategy,
        errors: result.errors,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const message = String(err?.message || err || 'unknown_error');
    console.error(`[pr-changed-files] ${message}`);
    process.exit(1);
  }
}

module.exports = {
  normalizeFiles,
  resolveChangedFiles,
};
