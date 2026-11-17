#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../utils/resolve-db-url');

const LOCK_KEY = 'backfill_ingress_persisted_redaction_v1';
const DEFAULT_TIMEOUTS = Object.freeze({
  connectionTimeoutMs: 10000,
  statementTimeoutMs: 120000,
  lockTimeoutMs: 5000,
  queryGraceMs: 5000,
  cleanupReserveMs: 5000,
  rollbackTimeoutMs: 4000,
  proofFetchTimeoutMs: 120000,
  proofCommandTimeoutMs: 1800000,
});

function parseBoundedInt(value, fallback, minimum, maximum, name) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      values.json = true;
      continue;
    }
    if (arg === '--candidate-proof') {
      values.candidateProof = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values[name] = value;
    index += 1;
  }
  return {
    batchSize: parseBoundedInt(values['batch-size'], 500, 1, 2000, '--batch-size'),
    maxBatches: parseBoundedInt(values['max-batches'], 10000, 1, 100000, '--max-batches'),
    maxDurationMs: parseBoundedInt(
      values['max-duration-ms'],
      1800000,
      1000,
      86400000,
      '--max-duration-ms',
    ),
    connectionTimeoutMs: parseBoundedInt(
      values['connection-timeout-ms'],
      DEFAULT_TIMEOUTS.connectionTimeoutMs,
      100,
      60000,
      '--connection-timeout-ms',
    ),
    statementTimeoutMs: parseBoundedInt(
      values['statement-timeout-ms'],
      DEFAULT_TIMEOUTS.statementTimeoutMs,
      100,
      3600000,
      '--statement-timeout-ms',
    ),
    lockTimeoutMs: parseBoundedInt(
      values['lock-timeout-ms'],
      DEFAULT_TIMEOUTS.lockTimeoutMs,
      1,
      600000,
      '--lock-timeout-ms',
    ),
    queryGraceMs: parseBoundedInt(
      values['query-grace-ms'],
      DEFAULT_TIMEOUTS.queryGraceMs,
      1,
      60000,
      '--query-grace-ms',
    ),
    cleanupReserveMs: parseBoundedInt(
      values['cleanup-reserve-ms'],
      DEFAULT_TIMEOUTS.cleanupReserveMs,
      100,
      60000,
      '--cleanup-reserve-ms',
    ),
    rollbackTimeoutMs: parseBoundedInt(
      values['rollback-timeout-ms'],
      DEFAULT_TIMEOUTS.rollbackTimeoutMs,
      100,
      60000,
      '--rollback-timeout-ms',
    ),
    proofFetchTimeoutMs: parseBoundedInt(
      values['proof-fetch-timeout-ms'],
      DEFAULT_TIMEOUTS.proofFetchTimeoutMs,
      1000,
      600000,
      '--proof-fetch-timeout-ms',
    ),
    proofCommandTimeoutMs: parseBoundedInt(
      values['proof-command-timeout-ms'],
      DEFAULT_TIMEOUTS.proofCommandTimeoutMs,
      1000,
      86400000,
      '--proof-command-timeout-ms',
    ),
    candidateProof: Boolean(values.candidateProof),
    proofOut: values['proof-out'] || null,
    baseSha: values['base-sha'] || null,
    testCommand: values['test-command'] || null,
    testOutput: values['test-output'] || null,
    json: Boolean(values.json),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashNonSecretEnvironment(environment = process.env) {
  const entries = Object.entries(environment)
    .filter(([name]) => !/(?:secret|token|password|passwd|credential|cookie|authorization|api[_-]?key|private[_-]?key)/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, value]) => ({
      name,
      value_sha256: sha256(Buffer.from(String(value ?? ''), 'utf8')),
    }));
  return {
    entries,
    aggregate_sha256: sha256(Buffer.from(JSON.stringify(entries), 'utf8')),
  };
}

function runGitCommand(args, cwd, encoding = null, timeoutMs = 120000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return result;
}

function runGit(args, cwd, encoding = null, timeoutMs = 120000) {
  return runGitCommand(args, cwd, encoding, timeoutMs).stdout;
}

function fetchAuthoritativeBase(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const remote = String(options.remote || 'origin').trim();
  const branch = String(options.branch || 'dev').trim();
  const timeoutMs = parseBoundedInt(
    options.timeoutMs,
    DEFAULT_TIMEOUTS.proofFetchTimeoutMs,
    1000,
    600000,
    'proof fetch timeout',
  );
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('authoritative remote and branch names must be bounded Git ref components');
  }
  const gitRunner = options.gitRunner || runGit;
  const remoteUrl = String(gitRunner(['remote', 'get-url', remote], cwd, 'utf8', timeoutMs)).trim();
  if (!remoteUrl) throw new Error(`authoritative remote ${remote} has no URL`);
  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  const startedAt = new Date().toISOString();
  const fetchResult = options.gitRunner
    ? { status: 0, signal: null, error: null, stdout: gitRunner(['fetch', '--no-tags', '--prune', remote, refspec], cwd, null, timeoutMs), stderr: Buffer.alloc(0) }
    : runGitCommand(['fetch', '--no-tags', '--prune', remote, refspec], cwd, null, timeoutMs);
  const finishedAt = new Date().toISOString();
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const sha = String(gitRunner(['rev-parse', `${remoteRef}^{commit}`], cwd, 'utf8', timeoutMs)).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`authoritative ${remoteRef} did not resolve to an exact SHA`);
  return {
    remote,
    branch,
    remote_url: remoteUrl,
    remote_url_sha256: sha256(Buffer.from(remoteUrl, 'utf8')),
    remote_ref: remoteRef,
    sha: sha.toLowerCase(),
    refspec,
    fetch_started_at: startedAt,
    fetch_finished_at: finishedAt,
    fetch_exit_code: fetchResult.status,
    fetch_signal: fetchResult.signal || null,
    fetch_spawn_error: fetchResult.error ? String(fetchResult.error.message || fetchResult.error) : null,
    fetch_stdout_sha256: sha256(Buffer.isBuffer(fetchResult.stdout) ? fetchResult.stdout : Buffer.from(fetchResult.stdout || '')),
    fetch_stderr_sha256: sha256(Buffer.isBuffer(fetchResult.stderr) ? fetchResult.stderr : Buffer.from(fetchResult.stderr || '')),
    fetch_timeout_ms: timeoutMs,
  };
}

function splitNull(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function assertNonCandidateArtifactPath(absolutePath, worktree, label) {
  const relativePath = path.relative(worktree, absolutePath);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    return;
  }
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', relativePath], {
    cwd: worktree,
    windowsHide: true,
  });
  if (ignored.status !== 0) {
    throw new Error(`${label} must be outside the worktree or ignored so it cannot invalidate candidate identity`);
  }
}

function parseGitTreeEntry(rawEntry, label) {
  const tab = rawEntry.indexOf('\t');
  if (tab < 0) throw new Error(`Malformed ${label} entry`);
  const metadata = rawEntry.slice(0, tab).trim().split(/\s+/);
  if (metadata.length < 2) throw new Error(`Malformed ${label} metadata`);
  const objectSha = metadata.find((value) => /^[0-9a-f]{40,64}$/i.test(value));
  if (!objectSha) throw new Error(`Malformed ${label} object identity`);
  return {
    path: rawEntry.slice(tab + 1),
    mode: metadata[0],
    object_sha: objectSha,
  };
}

function readIndexEntry(relativePath, cwd) {
  const entries = splitNull(runGit(['ls-files', '--stage', '-z', '--', relativePath], cwd));
  if (entries.length !== 1) throw new Error(`Expected one Git index entry for ${relativePath}`);
  const parsed = parseGitTreeEntry(entries[0], 'Git index');
  if (parsed.path !== relativePath) throw new Error(`Git index path mismatch for ${relativePath}`);
  return parsed;
}

function readTreeEntry(relativePath, cwd, revision) {
  const entries = splitNull(runGit(['ls-tree', '-z', revision, '--', relativePath], cwd));
  if (entries.length !== 1) throw new Error(`Expected one ${revision} tree entry for deleted path ${relativePath}`);
  const parsed = parseGitTreeEntry(entries[0], `${revision} tree`);
  if (parsed.path !== relativePath) throw new Error(`${revision} tree path mismatch for ${relativePath}`);
  return parsed;
}

function buildCandidateProof(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const baseSha = String(options.baseSha || '').trim();
  const baseRef = String(options.baseRef || 'refs/remotes/origin/dev').trim();
  const testCommand = String(options.testCommand || '').trim();
  const testOutput = path.resolve(cwd, String(options.testOutput || ''));
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('--base-sha must be an exact 40-character SHA');
  if (!testCommand) throw new Error('--test-command is required for candidate proof');
  if (!options.testOutput || !fs.existsSync(testOutput)) throw new Error('--test-output must identify an existing artifact');

  runGit(['cat-file', '-e', `${baseSha}^{commit}`], cwd);
  const baseRefSha = runGit(['rev-parse', `${baseRef}^{commit}`], cwd, 'utf8').trim();
  if (baseRefSha.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error(`--base-sha does not match authoritative ${baseRef} (${baseRefSha})`);
  }
  const commonDirRaw = runGit(['rev-parse', '--git-common-dir'], cwd, 'utf8').trim();
  const worktree = path.resolve(runGit(['rev-parse', '--show-toplevel'], cwd, 'utf8').trim());
  const commonDir = path.resolve(worktree, commonDirRaw);
  assertNonCandidateArtifactPath(testOutput, worktree, '--test-output');
  const head = runGit(['rev-parse', 'HEAD'], cwd, 'utf8').trim();
  runGit(['merge-base', '--is-ancestor', baseSha, head], cwd);
  const branch = runGit(['branch', '--show-current'], cwd, 'utf8').trim();
  const statusV2Z = runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd);
  const worktreeDiffBinary = runGit(['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'], cwd);
  const baseToHeadDiffBinary = runGit(['diff', '--binary', '--full-index', '--no-ext-diff', `${baseSha}..HEAD`, '--'], cwd);
  const worktreeDeleted = splitNull(runGit(['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--'], cwd));
  const baseDeleted = splitNull(runGit(['diff', '--name-only', '--diff-filter=D', '-z', `${baseSha}..HEAD`, '--'], cwd));
  const deletedPaths = [...new Set([...baseDeleted, ...worktreeDeleted])].sort();
  const trackedChanged = [
    ...splitNull(runGit(['diff', '--name-only', '-z', `${baseSha}..HEAD`, '--'], cwd)),
    ...splitNull(runGit(['diff', '--name-only', '-z', 'HEAD', '--'], cwd)),
  ];
  const untracked = splitNull(runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd));
  const deletedSet = new Set(deletedPaths);
  const changedPaths = [...new Set([...trackedChanged.filter((item) => !deletedSet.has(item)), ...untracked])].sort();
  const files = changedPaths.map((relativePath) => {
    const absolutePath = path.resolve(worktree, relativePath);
    if (!absolutePath.startsWith(`${worktree}${path.sep}`) || !fs.existsSync(absolutePath)) {
      throw new Error(`candidate path is missing or outside worktree: ${relativePath}`);
    }
    const content = fs.readFileSync(absolutePath);
    const stat = fs.lstatSync(absolutePath);
    const tracked = !untracked.includes(relativePath);
    const indexEntry = tracked ? readIndexEntry(relativePath, cwd) : null;
    return {
      path: relativePath.replace(/\\/g, '/'),
      tracked,
      filesystem_mode: `0${(stat.mode & 0o777).toString(8)}`,
      index_mode: indexEntry?.mode || null,
      index_object_sha: indexEntry?.object_sha || null,
      size: stat.size,
      sha256: sha256(content),
    };
  });
  const deleted = deletedPaths.map((relativePath) => {
    const revision = baseDeleted.includes(relativePath) ? baseSha : 'HEAD';
    const treeEntry = readTreeEntry(relativePath, cwd, revision);
    return {
      path: relativePath.replace(/\\/g, '/'),
      source_revision: revision,
      source_mode: treeEntry.mode,
      source_object_sha: treeEntry.object_sha,
    };
  });
  const output = fs.readFileSync(testOutput);
  let testCounts = null;
  try {
    const outputEnvelope = JSON.parse(output.toString('utf8'));
    const parsed = outputEnvelope.stdout_base64
      ? JSON.parse(Buffer.from(outputEnvelope.stdout_base64, 'base64').toString('utf8').trim())
      : outputEnvelope;
    testCounts = {
      suites_total: parsed.numTotalTestSuites,
      suites_passed: parsed.numPassedTestSuites,
      suites_failed: parsed.numFailedTestSuites,
      tests_total: parsed.numTotalTests,
      tests_passed: parsed.numPassedTests,
      tests_failed: parsed.numFailedTests,
      tests_pending: parsed.numPendingTests,
      tests_todo: parsed.numTodoTests,
      success: parsed.success,
    };
  } catch {
    testCounts = { parseable_json: false };
  }

  const postHead = runGit(['rev-parse', 'HEAD'], cwd, 'utf8').trim();
  const postStatusV2Z = runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd);
  const postWorktreeDiffBinary = runGit(['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'], cwd);
  const postBaseToHeadDiffBinary = runGit(['diff', '--binary', '--full-index', '--no-ext-diff', `${baseSha}..HEAD`, '--'], cwd);
  if (postHead !== head
    || !postStatusV2Z.equals(statusV2Z)
    || !postWorktreeDiffBinary.equals(worktreeDiffBinary)
    || !postBaseToHeadDiffBinary.equals(baseToHeadDiffBinary)) {
    throw new Error('Candidate changed while proof identity was being collected');
  }
  for (const file of files) {
    const absolutePath = path.resolve(worktree, file.path);
    const content = fs.readFileSync(absolutePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.size !== file.size
      || `0${(stat.mode & 0o777).toString(8)}` !== file.filesystem_mode
      || sha256(content) !== file.sha256) {
      throw new Error(`Candidate file changed while proof identity was being collected: ${file.path}`);
    }
  }
  const postOutput = fs.readFileSync(testOutput);
  if (!postOutput.equals(output)) throw new Error('Test output changed while proof identity was being collected');

  const proof = {
    version: 1,
    git: {
      common_dir: commonDir,
      worktree,
      branch,
      base_ref: baseRef,
      base_ref_sha: baseRefSha,
      base_sha: baseSha.toLowerCase(),
      head_sha: head,
      status_v2_z_base64: statusV2Z.toString('base64'),
      status_v2_z_sha256: sha256(statusV2Z),
      base_to_head_diff_binary_sha256: sha256(baseToHeadDiffBinary),
      base_to_head_diff_binary_bytes: baseToHeadDiffBinary.length,
      worktree_diff_binary_sha256: sha256(worktreeDiffBinary),
      worktree_diff_binary_bytes: worktreeDiffBinary.length,
      deleted,
      untracked: untracked.sort(),
      files,
    },
    proof: {
      command: testCommand,
      command_sha256: sha256(Buffer.from(testCommand, 'utf8')),
      tool: {
        node: process.version,
        git: runGit(['--version'], cwd, 'utf8').trim(),
        platform: process.platform,
        architecture: process.arch,
      },
      environment: {
        CI: process.env.CI || null,
        NODE_ENV: process.env.NODE_ENV || null,
      },
      environment_hashes: hashNonSecretEnvironment(),
      working_directory: worktree,
      output_absolute_path: testOutput,
      output_path: path.relative(worktree, testOutput).replace(/\\/g, '/'),
      output_sha256: sha256(output),
      output_bytes: output.length,
      counts: testCounts,
    },
  };
  proof.candidate_identity_sha256 = sha256(Buffer.from(JSON.stringify(proof), 'utf8'));
  return proof;
}

function executeExactCommand(command, cwd, options = {}) {
  const timeoutMs = parseBoundedInt(
    options.timeoutMs,
    DEFAULT_TIMEOUTS.proofCommandTimeoutMs,
    1000,
    86400000,
    'proof command timeout',
  );
  return spawnSync(command, {
    cwd,
    shell: true,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
  });
}

function runCandidateProof(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const testCommand = String(options.testCommand || '').trim();
  const testOutput = path.resolve(cwd, String(options.testOutput || ''));
  if (!testCommand) throw new Error('--test-command is required for candidate proof');
  if (!options.testOutput) throw new Error('--test-output is required for candidate proof');
  const worktree = path.resolve(runGit(['rev-parse', '--show-toplevel'], cwd, 'utf8').trim());
  assertNonCandidateArtifactPath(testOutput, worktree, '--test-output');
  fs.mkdirSync(path.dirname(testOutput), { recursive: true });
  fs.writeFileSync(testOutput, '{"state":"pending"}\n', { flag: 'w' });

  const remoteVerifier = options.remoteVerifier || fetchAuthoritativeBase;
  const authorityOptions = {
    cwd,
    remote: options.remote || 'origin',
    branch: options.remoteBranch || 'dev',
    timeoutMs: options.proofFetchTimeoutMs,
  };
  const authorityBefore = remoteVerifier(authorityOptions);
  if (String(authorityBefore.sha || '').toLowerCase() !== String(options.baseSha || '').toLowerCase()) {
    throw new Error(`--base-sha does not match freshly fetched ${authorityBefore.remote_ref} (${authorityBefore.sha})`);
  }

  const proofOptions = {
    cwd,
    baseSha: options.baseSha,
    baseRef: options.baseRef || 'refs/remotes/origin/dev',
    testCommand,
    testOutput,
  };
  const before = buildCandidateProof(proofOptions);
  const beforeGitSha256 = sha256(Buffer.from(JSON.stringify(before.git), 'utf8'));
  const startedAt = new Date().toISOString();
  const startedMonotonic = monotonicNowMs();
  const commandRunner = options.commandRunner || executeExactCommand;
  const commandTimeoutMs = parseBoundedInt(
    options.proofCommandTimeoutMs,
    DEFAULT_TIMEOUTS.proofCommandTimeoutMs,
    1000,
    86400000,
    'proof command timeout',
  );
  const result = commandRunner(testCommand, cwd, { timeoutMs: commandTimeoutMs });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  const finishedAt = new Date().toISOString();
  const execution = {
    command: testCommand,
    command_sha256: sha256(Buffer.from(testCommand, 'utf8')),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, monotonicNowMs() - startedMonotonic),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    spawn_error: result.error ? String(result.error.message || result.error) : null,
    timed_out: result.error?.code === 'ETIMEDOUT',
    timeout_ms: commandTimeoutMs,
    stdout_base64: stdout.toString('base64'),
    stdout_sha256: sha256(stdout),
    stdout_bytes: stdout.length,
    stderr_base64: stderr.toString('base64'),
    stderr_sha256: sha256(stderr),
    stderr_bytes: stderr.length,
  };
  fs.writeFileSync(testOutput, `${JSON.stringify(execution)}\n`, { flag: 'w' });

  const authorityAfter = remoteVerifier(authorityOptions);
  if (authorityAfter.sha !== authorityBefore.sha
    || authorityAfter.remote_url !== authorityBefore.remote_url
    || authorityAfter.remote_ref !== authorityBefore.remote_ref) {
    throw new Error('Authoritative remote dev moved or changed while the exact test command was running');
  }

  const after = buildCandidateProof(proofOptions);
  const afterGitSha256 = sha256(Buffer.from(JSON.stringify(after.git), 'utf8'));
  if (afterGitSha256 !== beforeGitSha256) {
    throw new Error('Candidate changed while the exact test command was running');
  }
  after.proof.execution = {
    ...execution,
    stdout_base64: undefined,
    stderr_base64: undefined,
  };
  after.proof.authority = {
    remote: authorityBefore.remote,
    branch: authorityBefore.branch,
    remote_url: authorityBefore.remote_url,
    remote_url_sha256: authorityBefore.remote_url_sha256,
    remote_ref: authorityBefore.remote_ref,
    sha: authorityBefore.sha,
    pre_fetch: authorityBefore,
    post_fetch: authorityAfter,
  };
  after.proof.causality = {
    pre_candidate_git_sha256: beforeGitSha256,
    post_candidate_git_sha256: afterGitSha256,
      test_output_sha256: after.proof.output_sha256,
      authoritative_remote_sha: authorityAfter.sha,
      authoritative_remote_url_sha256: authorityAfter.remote_url_sha256,
  };
  after.proof.causality.receipt_sha256 = sha256(Buffer.from(JSON.stringify({
    command_sha256: execution.command_sha256,
    pre_candidate_git_sha256: beforeGitSha256,
    post_candidate_git_sha256: afterGitSha256,
    test_output_sha256: after.proof.output_sha256,
    exit_code: execution.exit_code,
    signal: execution.signal,
    started_at: execution.started_at,
    finished_at: execution.finished_at,
  }), 'utf8'));
  after.candidate_identity_sha256 = sha256(Buffer.from(JSON.stringify({
    git: after.git,
    proof: after.proof,
  }), 'utf8'));
  return after;
}

function writeCandidateProof(proof, outputPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, outputPath);
  const worktree = path.resolve(runGit(['rev-parse', '--show-toplevel'], cwd, 'utf8').trim());
  assertNonCandidateArtifactPath(resolved, worktree, '--proof-out');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'w' });
  return resolved;
}

function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resolveBatchTimeouts(remainingMs, options = {}) {
  const cleanupReserveMs = options.cleanupReserveMs ?? DEFAULT_TIMEOUTS.cleanupReserveMs;
  const queryGraceMs = options.queryGraceMs ?? DEFAULT_TIMEOUTS.queryGraceMs;
  const availableMs = Math.floor(remainingMs - cleanupReserveMs);
  if (availableMs <= queryGraceMs + 2) {
    throw new Error(`Backfill deadline has no safe batch window (${Math.floor(remainingMs)}ms remaining)`);
  }
  const statementTimeoutMs = Math.max(
    2,
    Math.min(options.statementTimeoutMs ?? DEFAULT_TIMEOUTS.statementTimeoutMs, availableMs - queryGraceMs),
  );
  const lockTimeoutMs = Math.max(
    1,
    Math.min(options.lockTimeoutMs ?? DEFAULT_TIMEOUTS.lockTimeoutMs, statementTimeoutMs - 1),
  );
  const queryTimeoutMs = Math.min(availableMs, statementTimeoutMs + queryGraceMs);
  if (!(lockTimeoutMs < statementTimeoutMs && statementTimeoutMs < queryTimeoutMs)) {
    throw new Error('Backfill timeout layers must satisfy lock < statement < query');
  }
  return { cleanupReserveMs, lockTimeoutMs, statementTimeoutMs, queryTimeoutMs };
}

function destroyClient(client, reason, logger = console) {
  const stream = client?.connection?.stream;
  if (!stream || typeof stream.destroy !== 'function') {
    throw new Error(`Cannot prove backend termination after cleanup failure: ${reason.message}`);
  }
  stream.destroy(reason);
  logger.error('[ingress-redaction-backfill] backend_termination=socket_destroyed');
  return 'socket_destroyed';
}

function validateBatchResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backfill returned a non-object result');
  }
  if (typeof value.has_more !== 'boolean') {
    throw new Error('Backfill result is missing boolean has_more');
  }
  if (!value.updated || typeof value.updated !== 'object' || Array.isArray(value.updated)) {
    throw new Error('Backfill result is missing updated counts');
  }
  const updated = {};
  for (const [name, count] of Object.entries(value.updated)) {
    if (!Number.isInteger(Number(count)) || Number(count) < 0) {
      throw new Error(`Backfill returned invalid updated count for ${name}`);
    }
    updated[name] = Number(count);
  }
  return { hasMore: value.has_more, updated };
}

async function drainIngressRedaction(options = {}) {
  const {
    connectionString,
    batchSize = 500,
    maxBatches = 10000,
    maxDurationMs = 1800000,
    connectionTimeoutMs = DEFAULT_TIMEOUTS.connectionTimeoutMs,
    statementTimeoutMs = DEFAULT_TIMEOUTS.statementTimeoutMs,
    lockTimeoutMs = DEFAULT_TIMEOUTS.lockTimeoutMs,
    queryGraceMs = DEFAULT_TIMEOUTS.queryGraceMs,
    cleanupReserveMs = DEFAULT_TIMEOUTS.cleanupReserveMs,
    rollbackTimeoutMs = DEFAULT_TIMEOUTS.rollbackTimeoutMs,
    clientFactory = (config) => new Client(config),
    now = monotonicNowMs,
    logger = console,
  } = options;
  if (!String(connectionString || '').trim()) throw new Error('Missing database connection string');

  const startedAt = now();
  const deadlineAt = startedAt + maxDurationMs;
  const initialConnectionBudgetMs = Math.floor(maxDurationMs - cleanupReserveMs);
  if (initialConnectionBudgetMs <= 0) {
    throw new Error('Backfill max duration must exceed the cleanup reserve before connecting');
  }
  const boundedConnectionTimeoutMs = Math.min(connectionTimeoutMs, initialConnectionBudgetMs);
  const client = clientFactory({
    connectionString,
    connectionTimeoutMillis: boundedConnectionTimeoutMs,
  });
  const totals = {};
  let batches = 0;
  let lockOwned = false;
  let transactionOpen = false;
  let clientDestroyed = false;
  let connected = false;
  try {
    try {
      const remainingConnectionBudgetMs = Math.floor(deadlineAt - now() - cleanupReserveMs);
      if (remainingConnectionBudgetMs <= 0) {
        throw new Error('Backfill deadline has no safe connection window');
      }
      const connectTimeoutMs = Math.min(boundedConnectionTimeoutMs, remainingConnectionBudgetMs);
      await withTimeout(client.connect(), connectTimeoutMs, 'database connection');
    } catch (error) {
      if (client?.connection?.stream && typeof client.connection.stream.destroy === 'function') {
        const termination = destroyClient(client, error, logger);
        clientDestroyed = true;
        error.backendTermination = termination;
      }
      throw error;
    }
    connected = true;
    const lockBudget = resolveBatchTimeouts(deadlineAt - now(), {
      statementTimeoutMs,
      lockTimeoutMs,
      queryGraceMs,
      cleanupReserveMs,
    });
    const lock = await client.query({
      text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      values: [LOCK_KEY],
      query_timeout: lockBudget.queryTimeoutMs,
    });
    lockOwned = lock.rows?.[0]?.acquired === true;
    if (!lockOwned) throw new Error('Another ingress redaction drain owns the advisory lock');

    while (true) {
      if (batches >= maxBatches) throw new Error(`Backfill exceeded max batches (${maxBatches})`);
      const budget = resolveBatchTimeouts(deadlineAt - now(), {
        statementTimeoutMs,
        lockTimeoutMs,
        queryGraceMs,
        cleanupReserveMs,
      });

      let batch;
      try {
        await client.query({ text: 'BEGIN', query_timeout: budget.queryTimeoutMs });
        transactionOpen = true;
        await client.query({
          text: `SET LOCAL lock_timeout = '${budget.lockTimeoutMs}ms'`,
          query_timeout: budget.queryTimeoutMs,
        });
        await client.query({
          text: `SET LOCAL statement_timeout = '${budget.statementTimeoutMs}ms'`,
          query_timeout: budget.queryTimeoutMs,
        });
        const response = await client.query({
          text: 'SELECT public.backfill_ingress_persisted_redaction_v1($1::int) AS result',
          values: [batchSize],
          query_timeout: budget.queryTimeoutMs,
        });
        batch = validateBatchResult(response.rows?.[0]?.result);
        await client.query({ text: 'COMMIT', query_timeout: budget.queryTimeoutMs });
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) {
          try {
            const rollbackBudgetMs = Math.max(1, Math.min(
              rollbackTimeoutMs,
              cleanupReserveMs,
              Math.max(1, deadlineAt - now()),
            ));
            await withTimeout(client.query({
              text: 'ROLLBACK',
              query_timeout: rollbackBudgetMs,
            }), rollbackBudgetMs, 'backfill rollback');
            transactionOpen = false;
          } catch (rollbackError) {
            const termination = destroyClient(client, rollbackError, logger);
            clientDestroyed = true;
            const cleanupError = new Error(`${error.message}; rollback failed: ${rollbackError.message}; backend ${termination}`);
            cleanupError.cause = error;
            cleanupError.backendTermination = termination;
            throw cleanupError;
          }
        }
        throw error;
      }

      // The durable cursor is the committed database state. Counts advance only
      // after COMMIT succeeds, never after a timed-out or rolled-back query.
      batches += 1;
      for (const [name, count] of Object.entries(batch.updated)) {
        totals[name] = (totals[name] || 0) + count;
      }
      logger.error(`[ingress-redaction-backfill] batch=${batches} has_more=${batch.hasMore}`);
      if (!batch.hasMore) break;
    }

    return {
      status: 'complete',
      batches,
      batch_size: batchSize,
      duration_ms: Math.max(0, now() - startedAt),
      updated: totals,
    };
  } finally {
    if (lockOwned && connected && !clientDestroyed) {
      try {
        const unlockTimeoutMs = Math.max(1, Math.min(
          rollbackTimeoutMs,
          cleanupReserveMs,
          Math.max(1, deadlineAt - now()),
        ));
        await withTimeout(client.query({
          text: 'SELECT pg_advisory_unlock(hashtext($1))',
          values: [LOCK_KEY],
          query_timeout: unlockTimeoutMs,
        }), unlockTimeoutMs, 'advisory unlock');
      } catch (error) {
        const termination = destroyClient(client, error, logger);
        clientDestroyed = true;
        const cleanupError = new Error(`Advisory unlock failed: ${error.message}; backend ${termination}`);
        cleanupError.cause = error;
        cleanupError.backendTermination = termination;
        throw cleanupError;
      }
    }
    if (connected && !clientDestroyed) {
      const endTimeoutMs = Math.max(1, Math.min(rollbackTimeoutMs, cleanupReserveMs));
      try {
        await withTimeout(client.end(), endTimeoutMs, 'database connection close');
      } catch (error) {
        const termination = destroyClient(client, error, logger);
        const cleanupError = new Error(`Connection close failed: ${error.message}; backend ${termination}`);
        cleanupError.cause = error;
        cleanupError.backendTermination = termination;
        throw cleanupError;
      }
    }
  }
}

async function main() {
  loadEnv();
  const args = parseArgs();
  if (args.candidateProof) {
    if (!args.proofOut) throw new Error('--proof-out is required for candidate proof');
    const proof = runCandidateProof({
      cwd: process.cwd(),
      baseSha: args.baseSha,
      testCommand: args.testCommand,
      testOutput: args.testOutput,
      proofFetchTimeoutMs: args.proofFetchTimeoutMs,
      proofCommandTimeoutMs: args.proofCommandTimeoutMs,
    });
    const outputPath = writeCandidateProof(proof, args.proofOut);
    console.log(JSON.stringify({
      status: 'complete',
      output: outputPath,
      candidate_identity_sha256: proof.candidate_identity_sha256,
    }));
    if (proof.proof.execution.exit_code !== 0 || proof.proof.execution.spawn_error) {
      throw new Error(`Exact test command failed with exit code ${proof.proof.execution.exit_code}`);
    }
    return;
  }
  const resolved = await resolveDatabaseUrlWithFallback({ env: process.env, logger: console });
  const result = await drainIngressRedaction({
    connectionString: resolved.dsn,
    batchSize: args.batchSize,
    maxBatches: args.maxBatches,
    maxDurationMs: args.maxDurationMs,
    connectionTimeoutMs: args.connectionTimeoutMs,
    statementTimeoutMs: args.statementTimeoutMs,
    lockTimeoutMs: args.lockTimeoutMs,
    queryGraceMs: args.queryGraceMs,
    cleanupReserveMs: args.cleanupReserveMs,
    rollbackTimeoutMs: args.rollbackTimeoutMs,
  });
  if (args.json) console.log(JSON.stringify(result));
  else console.log(`[ingress-redaction-backfill] complete batches=${result.batches}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ingress-redaction-backfill] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertNonCandidateArtifactPath,
  drainIngressRedaction,
  destroyClient,
  executeExactCommand,
  fetchAuthoritativeBase,
  monotonicNowMs,
  hashNonSecretEnvironment,
  parseArgs,
  runCandidateProof,
  resolveBatchTimeouts,
  runGit,
  validateBatchResult,
  withTimeout,
  writeCandidateProof,
};
