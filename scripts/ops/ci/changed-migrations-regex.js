#!/usr/bin/env node
/**
 * changed-migrations-regex.js
 *
 * Produces a regex suitable for OBJECTIVES_LINT_INCLUDE that matches the set of
 * changed SQL migration files under supabase/migrations/.
 *
 * Primary use: GitHub Actions `objectives_lint_changed / run` inside PR Governance Gate.
 *
 * Behavior:
 * - Prefer an exact local-gate base SHA when one is provided.
 * - Diff proven GitHub synthetic PR/merge-group refs via HEAD^1..HEAD.
 * - Otherwise compare against origin/$GITHUB_BASE_REF.
 *
 * Output:
 * - Default: prints the regex to stdout (empty when no changed migrations).
 * - --format github-output: also writes `pattern=<regex>` to $GITHUB_OUTPUT.
 *
 * Notes:
 * - Intentionally requires no npm dependencies.
 */
/* eslint-disable no-console */
const fs = require('fs');
const { spawnSync } = require('child_process');

function die(msg) {
  console.error(`[changed-migrations-regex] ${msg}`);
  process.exit(1);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegexPattern(files) {
  const seen = new Set();
  const unique = [];
  for (const file of Array.isArray(files) ? files : []) {
    const v = String(file || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    unique.push(v);
  }
  if (!unique.length) return '';
  const escaped = unique.map(escapeRegex);
  return `^(?:${escaped.join('|')})$`;
}

function isMigrationPath(file) {
  const value = String(file || '').trim().replace(/\\/g, '/');
  return value.startsWith('supabase/migrations/') && value.toLowerCase().endsWith('.sql');
}

function parseNameStatusZ(output) {
  const tokens = String(output || '').split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = String(tokens[index++] || '').trim();
    if (!status) throw new Error('git diff returned an empty change status');
    const kind = status.charAt(0);
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        throw new Error(`git diff returned an incomplete ${status} record`);
      }
      changes.push({ status, oldPath, newPath });
      continue;
    }
    const file = tokens[index++];
    if (!file) throw new Error(`git diff returned an incomplete ${status} record`);
    changes.push({ status, oldPath: kind === 'D' ? file : '', newPath: kind === 'D' ? '' : file });
  }
  return changes;
}

function parseArgs(argvIn) {
  const out = { format: '', base: '', head: 'HEAD', files: [] };
  const argv = Array.isArray(argvIn) ? argvIn : process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '').trim();
    if (!a) continue;
    if (a === '--format') out.format = String(argv[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
    else if (a === '--base') out.base = String(argv[++i] || '').trim();
    else if (a.startsWith('--base=')) out.base = a.split('=').slice(1).join('=').trim();
    else if (a === '--head') out.head = String(argv[++i] || '').trim();
    else if (a.startsWith('--head=')) out.head = a.split('=').slice(1).join('=').trim();
    else if (a === '--files') out.files.push(String(argv[++i] || '').trim());
    else if (a.startsWith('--files=')) out.files.push(a.split('=').slice(1).join('=').trim());
    else if (a === '--file') out.files.push(String(argv[++i] || '').trim());
    else if (a.startsWith('--file=')) out.files.push(a.split('=').slice(1).join('=').trim());
  }
  return out;
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  const code = typeof res.status === 'number' ? res.status : 1;
  return { ok: code === 0, code, out: String(res.stdout || ''), err: String(res.stderr || '') };
}

function hasRef(ref) {
  const res = git(['rev-parse', '--verify', ref], { stdio: ['ignore', 'ignore', 'ignore'] });
  return res.ok;
}

function ensureOriginRef(branch) {
  const b = String(branch || '').trim();
  if (!b) return;
  git(['fetch', 'origin', b, '--no-tags'], { stdio: 'inherit' });
}

function isGitHubSyntheticMergeRef(env = process.env) {
  if (String(env.GITHUB_ACTIONS || '').trim().toLowerCase() !== 'true') return false;
  const eventName = String(env.GITHUB_EVENT_NAME || '').trim();
  const ref = String(env.GITHUB_REF || '').trim();
  if (eventName === 'pull_request') {
    return /^refs\/pull\/[1-9]\d*\/merge$/.test(ref);
  }
  if (eventName === 'merge_group') {
    return /^refs\/heads\/gh-readonly-queue\/(?:dev|main)\/.+$/i.test(ref);
  }
  return false;
}

function resolveBaseRef({ baseArg }) {
  const explicit = String(baseArg || '').trim();
  if (explicit) return explicit;

  const localGateBaseSha = String(process.env.LOCAL_GATE_BASE_SHA || '').trim();
  if (localGateBaseSha) {
    return /^[0-9a-f]{40}$/i.test(localGateBaseSha) && hasRef(localGateBaseSha)
      ? localGateBaseSha
      : '';
  }

  if (isGitHubSyntheticMergeRef() && hasRef('HEAD^2')) return 'HEAD^1';

  const baseBranch = String(process.env.GITHUB_BASE_REF || '').trim();
  if (!baseBranch) return '';
  const originRef = `origin/${baseBranch}`;
  if (!hasRef(originRef)) ensureOriginRef(baseBranch);
  if (hasRef(originRef)) return originRef;

  return '';
}

function listChangedMigrationChanges({ baseRef, headRef }) {
  const base = String(baseRef || '').trim();
  const head = String(headRef || '').trim() || 'HEAD';
  const res = git(
    ['diff', '--name-status', '-z', '--find-renames', base, head, '--', 'supabase/migrations'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (!res.ok) {
    throw new Error((res.err || '').trim() || `git diff failed (${res.code})`);
  }
  return parseNameStatusZ(res.out)
    .filter((change) => isMigrationPath(change.oldPath) || isMigrationPath(change.newPath))
    .map((change) => ({
      ...change,
      scanPath: isMigrationPath(change.newPath) ? change.newPath.replace(/\\/g, '/') : '',
    }));
}

function listChangedMigrations({ baseRef, headRef }) {
  return listChangedMigrationChanges({ baseRef, headRef })
    .map((change) => change.scanPath)
    .filter(Boolean);
}

function parseFilesArgs(filesArgs) {
  const out = [];
  for (const raw of Array.isArray(filesArgs) ? filesArgs : []) {
    const v = String(raw || '').trim();
    if (!v) continue;
    for (const token of v.split(',')) {
      const t = String(token || '').trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v == null ? '' : v)}`);
  }
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function main() {
  const args = parseArgs();
  const format = String(args.format || '').trim().toLowerCase();

  let files = parseFilesArgs(args.files);
  if (!files.length) {
    const baseRef = resolveBaseRef({ baseArg: args.base });
    if (!baseRef) die('Unable to resolve base ref (expected merge commit with HEAD^1 or origin/$GITHUB_BASE_REF).');
    try {
      files = listChangedMigrations({ baseRef, headRef: args.head });
    } catch (e) {
      die(`Unable to list changed migrations: ${e.message}`);
    }
  }

  const filtered = files
    .map((f) => String(f || '').trim())
    .filter((f) => f && f.startsWith('supabase/migrations/') && f.toLowerCase().endsWith('.sql'));

  const pattern = buildRegexPattern(filtered);
  if (format === 'github-output') {
    writeGithubOutput({ pattern });
  }
  if (pattern) process.stdout.write(`${pattern}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRegexPattern,
  escapeRegex,
  isGitHubSyntheticMergeRef,
  isMigrationPath,
  listChangedMigrationChanges,
  listChangedMigrations,
  parseFilesArgs,
  parseNameStatusZ,
  resolveBaseRef,
};

