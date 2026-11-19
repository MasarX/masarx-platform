#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const focused = require('./pr-validation-focused-collection');
const focusedNative = require('./pr-validation-focused-native');

const VALIDATION_RESOURCE = 'pr-deploy-validation-supabase';
const VALIDATION_OWNER = 'pr-deploy-validation-supabase';
const VALIDATION_REUSE_STATES = new Set(['active', 'terminal_stop_required']);
const VALIDATION_BLOCKING_STATES = new Set(['starting']);
const DEFAULT_VALIDATION_LOCAL_START_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_VALIDATION_LOCAL_START_HARD_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_VALIDATION_HEALTH_CHECK_TIMEOUT_MS = 45000;

function die(message) {
  console.error(`[pr-validation-session] ${message}`);
  process.exit(1);
}

function runtimeLeasesScript() {
  return path.join('scripts', 'ops', 'runtime-leases.js');
}

function workspaceScript(name) {
  return path.join('scripts', 'ops', 'workspace', name);
}

function pgtapScript() {
  return path.join('scripts', 'tests', 'run-pgtap-cloud.js');
}

function sanitizeFileToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'session';
}

function heartbeatStopFilePath(outDir, options, headSha, leaseId = '') {
  const token = [
    `pr${sanitizeFileToken(options.prNumber)}`,
    sanitizeFileToken(options.worktreeId),
    sanitizeFileToken(String(headSha || '').slice(0, 12)),
    sanitizeFileToken(options.projectId),
    leaseId ? sanitizeFileToken(String(leaseId).slice(0, 12)) : '',
  ].filter(Boolean).join('-');
  return path.join(outDir, `heartbeat-${token}.stop`);
}

function parseArgs(argvIn) {
  const args = Array.isArray(argvIn) ? argvIn : process.argv.slice(2);
  const out = {
    files: '',
    prNumber: '',
    specIssue: '',
    ownerThreadId: '',
    worktreeId: '',
    worktreePath: process.cwd(),
    projectId: '',
    ports: '',
    purpose: 'focused-local-admission',
    outDir: path.join('.tmp', 'pr-validation-sessions'),
    keepWarm: false,
    keepWarmOnFailure: false,
    reuseActive: false,
    requireClean: false,
    allowedDirty: '',
    allowGeneratedDirty: false,
    enforceDirtyGuard: false,
    coldStartReason: '',
    collectFocusedFailures: false,
    jobs: undefined,
    repairFocusedFailures: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (!token) continue;
    const readValue = () => String(args[++index] || '').trim();
    if (token === '--files') out.files = readValue();
    else if (token.startsWith('--files=')) out.files = token.split('=').slice(1).join('=').trim();
    else if (token === '--pr-number') out.prNumber = readValue();
    else if (token.startsWith('--pr-number=')) out.prNumber = token.split('=').slice(1).join('=').trim();
    else if (token === '--spec-issue') out.specIssue = readValue();
    else if (token.startsWith('--spec-issue=')) out.specIssue = token.split('=').slice(1).join('=').trim();
    else if (token === '--owner-thread-id') out.ownerThreadId = readValue();
    else if (token.startsWith('--owner-thread-id=')) out.ownerThreadId = token.split('=').slice(1).join('=').trim();
    else if (token === '--worktree-id') out.worktreeId = readValue();
    else if (token.startsWith('--worktree-id=')) out.worktreeId = token.split('=').slice(1).join('=').trim();
    else if (token === '--worktree-path') out.worktreePath = readValue();
    else if (token.startsWith('--worktree-path=')) out.worktreePath = token.split('=').slice(1).join('=').trim();
    else if (token === '--project-id') out.projectId = readValue();
    else if (token.startsWith('--project-id=')) out.projectId = token.split('=').slice(1).join('=').trim();
    else if (token === '--ports') out.ports = readValue();
    else if (token.startsWith('--ports=')) out.ports = token.split('=').slice(1).join('=').trim();
    else if (token === '--purpose') out.purpose = readValue();
    else if (token.startsWith('--purpose=')) out.purpose = token.split('=').slice(1).join('=').trim();
    else if (token === '--out-dir') out.outDir = readValue();
    else if (token.startsWith('--out-dir=')) out.outDir = token.split('=').slice(1).join('=').trim();
    else if (token === '--keep-warm') out.keepWarm = true;
    else if (token === '--keep-warm-on-failure') out.keepWarmOnFailure = true;
    else if (token === '--reuse-active') out.reuseActive = true;
    else if (token === '--require-clean') out.requireClean = true;
    else if (token === '--allowed-dirty') out.allowedDirty = readValue();
    else if (token.startsWith('--allowed-dirty=')) out.allowedDirty = token.split('=').slice(1).join('=').trim();
    else if (token === '--allow-generated-dirty') out.allowGeneratedDirty = true;
    else if (token === '--enforce-dirty-guard') out.enforceDirtyGuard = true;
    else if (token === '--collect-focused-failures') out.collectFocusedFailures = true;
    else if (token === '--jobs') out.jobs = readValue();
    else if (token.startsWith('--jobs=')) out.jobs = token.split('=').slice(1).join('=').trim();
    else if (token === '--repair-focused-failures') out.repairFocusedFailures = true;
    else if (token === '--cold-start-reason') out.coldStartReason = normalizeExplicitColdStartReason(readValue());
    else if (token.startsWith('--cold-start-reason=')) {
      out.coldStartReason = normalizeExplicitColdStartReason(token.split('=').slice(1).join('='));
    }
    else die(`Unknown argument: ${token}`);
  }
  return out;
}

function parseFocusedFiles(raw) {
  return String(raw || '')
    .split(/[\n,;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePorts(raw) {
  const ports = {};
  for (const entry of String(raw || '').split(',')) {
    const [name, value] = entry.split(/[=:]/u).map((item) => String(item || '').trim());
    if (!name || !value) continue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid port '${entry}'`);
    }
    ports[name.replace(/-/g, '_')] = parsed;
  }
  return ports;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeExplicitColdStartReason(value) {
  const reason = String(value || '').trim();
  if (!reason) throw new Error('--cold-start-reason requires a non-empty value');
  if (reason.length > 160 || !/^[a-z0-9][a-z0-9._-]*$/u.test(reason)) {
    throw new Error('--cold-start-reason must be a safe lowercase identifier');
  }
  return reason;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(rootDir, relDir);
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile()) out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function computeDirectoryFingerprint(cwd, relativeDir) {
  const rootDir = path.join(cwd, relativeDir);
  const files = listFilesRecursive(rootDir).filter((file) => file.endsWith('.sql'));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const abs = path.join(rootDir, file);
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return {
    algorithm: 'sha256',
    path: relativeDir.replace(/\\/g, '/'),
    file_count: files.length,
    digest: hash.digest('hex'),
  };
}

function normalizeMigrationFingerprint(fingerprint = {}) {
  const algorithm = String(fingerprint?.algorithm || '').trim().toLowerCase();
  const digest = String(fingerprint?.digest || '').trim().toLowerCase();
  const fingerprintPath = normalizeRepoPath(fingerprint?.path || '');
  const fileCount = Number(fingerprint?.file_count);
  if (!algorithm || !digest || !fingerprintPath || !Number.isInteger(fileCount) || fileCount < 0) return null;
  return {
    algorithm,
    path: fingerprintPath,
    file_count: fileCount,
    digest,
  };
}

function compareMigrationFingerprints(currentFingerprint, baselineFingerprint) {
  const current = normalizeMigrationFingerprint(currentFingerprint);
  const baseline = normalizeMigrationFingerprint(baselineFingerprint);
  if (!current) return { matches: false, reason: 'current_migration_fingerprint_incomplete' };
  if (!baseline) return { matches: false, reason: 'baseline_migration_fingerprint_missing_or_incomplete' };
  for (const key of ['algorithm', 'path', 'file_count', 'digest']) {
    if (current[key] !== baseline[key]) {
      return {
        matches: false,
        reason: `migration_fingerprint_${key}_mismatch`,
        current,
        baseline,
      };
    }
  }
  return {
    matches: true,
    reason: 'migration_fingerprint_exact_match',
    current,
    baseline,
  };
}

function normalizePathIdentity(value) {
  const resolved = path.resolve(String(value || '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validationArtifactMatchesBinding(artifact = {}, binding = {}, options = {}) {
  const requireLease = options.requireLease !== false;
  const artifactLeaseId = String(artifact.marker_lease_id || artifact.lease_id || '').trim();
  if (requireLease && artifactLeaseId !== String(binding.leaseId || '').trim()) return false;
  if (String(artifact.pr_number || artifact.current_pr || '') !== String(binding.prNumber || '')) return false;
  if (String(artifact.owner_thread_id || '') !== String(binding.ownerThreadId || '')) return false;
  if (String(artifact.worktree_id || '') !== String(binding.worktreeId || '')) return false;
  if (normalizePathIdentity(artifact.worktree_path) !== normalizePathIdentity(binding.worktreePath)) return false;
  if (String(artifact.branch || '') !== String(binding.branch || '')) return false;
  if (String(artifact.head_sha || '').toLowerCase() !== String(binding.headSha || '').toLowerCase()) return false;
  if (String(artifact.project_id || '') !== String(binding.projectId || '')) return false;
  const artifactPorts = artifact.ports || {};
  const bindingPorts = binding.ports || {};
  return Object.entries(bindingPorts).every(([key, value]) => Number(artifactPorts[key]) === Number(value));
}

function tokenizeProcessCommandLine(commandLine = '') {
  return (String(commandLine || '').match(/(?:[^\s"]+|"[^"]*")+/gu) || [])
    .map((token) => token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token);
}

function commandOptionValues(tokens = [], flag = '') {
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === flag && index + 1 < tokens.length) values.push(tokens[index + 1]);
    else if (tokens[index].startsWith(`${flag}=`)) values.push(tokens[index].slice(flag.length + 1));
  }
  return values;
}

function isDirectValidationScriptInvocation(tokens = [], scriptIndex = -1) {
  if (scriptIndex !== 1 || tokens.length < 2) return false;
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  return executable === 'node' || executable === 'node.exe';
}

function recordedProcessEvidence(record = {}, processInfo = {}, commandLine = '', details = {}) {
  const tokens = Array.isArray(details.tokens) ? details.tokens : [];
  return {
    inspection_source: String(processInfo.inspection_source || 'process_inspector'),
    parent_pid: Number(processInfo.parent_pid || 0),
    creation_time: String(processInfo.creation_time || ''),
    command_line_available: Boolean(commandLine),
    command_line_sha256: commandLine
      ? crypto.createHash('sha256').update(commandLine).digest('hex')
      : '',
    executable: path.basename(String(tokens[0] || '')).toLowerCase(),
    token_count: tokens.length,
    script_index: Number.isInteger(details.scriptIndex) ? details.scriptIndex : -1,
    direct_script_invocation: details.directScriptInvocation === true,
    heartbeat_flag_present: details.heartbeatFlagPresent === true,
    record_kind: String(record.kind || ''),
    record_lease_id: String(record.lease_id || ''),
    record_artifact_path: String(record.artifact_path || ''),
    record_started_at: String(record.artifact?.started_at || ''),
    record_finished_at: String(record.artifact?.finished_at || ''),
    recorded_parent_pid: Number(record.loop?.parent_pid || 0),
    recorded_stop_file: String(record.loop?.stop_file || ''),
    recorded_session_file: String(record.loop?.session_file || record.artifact_path || ''),
  };
}

function inspectLiveProcessIdentities(pids = [], options = {}) {
  const uniquePids = [...new Set(pids.map((pid) => Number(pid || 0)).filter((pid) => pid > 0))];
  if (!uniquePids.length) return new Map();
  if (typeof options.inspectProcesses === 'function') {
    const supplied = options.inspectProcesses(uniquePids);
    const rows = supplied instanceof Map ? [...supplied.values()] : (Array.isArray(supplied) ? supplied : []);
    return new Map(rows.map((row) => [Number(row.pid || 0), row]));
  }
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const platform = options.platform || process.platform;
  let outcome;
  if (platform === 'win32') {
    const ids = uniquePids.join(',');
    const script = [
      `$ids=@(${ids})`,
      'Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object {',
      '[pscustomobject]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;command_line=[string]$_.CommandLine;creation_time=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString(\'o\')}else{\'\'}}',
      '} | ConvertTo-Json -Compress',
    ].join('; ');
    outcome = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } else {
    outcome = spawnSyncImpl('ps', ['-p', uniquePids.join(','), '-o', 'pid=', '-o', 'lstart=', '-o', 'args='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  if (outcome?.error || outcome?.status !== 0) {
    const message = outcome?.error?.message || String(outcome?.stderr || '').trim() || `process inspection exit ${outcome?.status}`;
    return new Map(uniquePids.map((pid) => [pid, { pid, inspection_error: message }]));
  }
  try {
    let rows = [];
    if (platform === 'win32') {
      const raw = String(outcome.stdout || '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      }
    } else {
      rows = String(outcome.stdout || '').split(/\r?\n/u).map((line) => {
        const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u);
        return match ? { pid: Number(match[1]), creation_time: new Date(match[2]).toISOString(), command_line: match[3] } : null;
      }).filter(Boolean);
    }
    return new Map(rows.map((row) => [Number(row.pid || 0), row]));
  } catch (error) {
    return new Map(uniquePids.map((pid) => [pid, { pid, inspection_error: error?.message || String(error) }]));
  }
}

function processCreationMatchesArtifact(processInfo = {}, artifact = {}, kind = '') {
  const createdAt = Date.parse(processInfo.creation_time || '');
  const startedAt = Date.parse(artifact.started_at || '');
  if (!Number.isFinite(createdAt) || !Number.isFinite(startedAt)) return false;
  const lowerBound = startedAt - 5 * 60 * 1000;
  const finishedAt = Date.parse(artifact.finished_at || '');
  const upperBound = kind === 'heartbeat'
    ? (Number.isFinite(finishedAt) ? finishedAt + 60 * 1000 : Date.now() + 60 * 1000)
    : startedAt + 5 * 60 * 1000;
  return createdAt >= lowerBound && createdAt <= upperBound;
}

function recordedProcessIdentity(record = {}, processInfo = {}) {
  if (!processInfo || processInfo.not_found) {
    return {
      status: 'stale',
      reason: 'process_not_found',
      evidence: recordedProcessEvidence(record, processInfo),
    };
  }
  if (processInfo.inspection_error) {
    return {
      status: 'ambiguous',
      reason: `process_inspection_failed:${processInfo.inspection_error}`,
      evidence: recordedProcessEvidence(record, processInfo),
    };
  }
  const commandLine = String(processInfo.command_line || '').trim();
  if (!commandLine) {
    return {
      status: 'ambiguous',
      reason: 'process_command_line_unavailable',
      evidence: recordedProcessEvidence(record, processInfo),
    };
  }
  const tokens = tokenizeProcessCommandLine(commandLine);
  const scriptPath = normalizePathIdentity(__filename);
  const worktreePath = String(record.artifact?.worktree_path || '');
  const scriptIndex = tokens.findIndex((token) => {
    const candidate = path.isAbsolute(token) ? token : path.resolve(worktreePath, token);
    return normalizePathIdentity(candidate) === scriptPath;
  });
  const directScriptInvocation = isDirectValidationScriptInvocation(tokens, scriptIndex);
  const heartbeatFlagPresent = tokens.includes('--heartbeat-child');
  const validationLooking = scriptIndex >= 0 || /(?:pr-validation-session|--heartbeat-child)/iu.test(commandLine);
  const evidence = recordedProcessEvidence(record, processInfo, commandLine, {
    tokens,
    scriptIndex,
    directScriptInvocation,
    heartbeatFlagPresent,
  });
  if (!validationLooking) return { status: 'stale', reason: 'live_pid_reused_by_unrelated_process', evidence };
  if (!directScriptInvocation) {
    if (scriptIndex >= 0 && !heartbeatFlagPresent) {
      return { status: 'stale', reason: 'live_pid_reused_by_non_validation_script_reference', evidence };
    }
    return { status: 'ambiguous', reason: 'validation_process_script_identity_partial', evidence };
  }
  const args = tokens.slice(scriptIndex + 1);
  const exactOption = (flag, expected, pathValue = false) => {
    const values = commandOptionValues(args, flag);
    if (values.length !== 1) return false;
    return pathValue
      ? normalizePathIdentity(values[0]) === normalizePathIdentity(expected)
      : String(values[0]) === String(expected);
  };
  let exact = false;
  if (record.kind === 'heartbeat') {
    exact = args[0] === '--heartbeat-child' &&
      exactOption('--cwd', record.artifact.worktree_path, true) &&
      exactOption('--lease-id', record.lease_id) &&
      exactOption('--stop-file', record.loop.stop_file, true) &&
      exactOption('--session-file', record.artifact_path, true);
    if (exact && Number(record.loop.parent_pid || 0) > 0) {
      exact = exactOption('--parent-pid', Number(record.loop.parent_pid));
    }
  } else {
    const commandPorts = commandOptionValues(args, '--ports');
    let portsMatch = commandPorts.length === 1;
    if (portsMatch) {
      try {
        const parsedPorts = parsePorts(commandPorts[0]);
        portsMatch = Object.entries(record.artifact.ports || {})
          .every(([key, value]) => Number(parsedPorts[key]) === Number(value));
      } catch (_) {
        portsMatch = false;
      }
    }
    exact = !args.includes('--heartbeat-child') &&
      exactOption('--pr-number', record.artifact.pr_number || record.artifact.current_pr) &&
      exactOption('--owner-thread-id', record.artifact.owner_thread_id) &&
      exactOption('--worktree-id', record.artifact.worktree_id) &&
      exactOption('--worktree-path', record.artifact.worktree_path, true) &&
      exactOption('--project-id', record.artifact.project_id) &&
      portsMatch;
  }
  if (!exact) return { status: 'ambiguous', reason: `${record.kind}_command_identity_mismatch`, evidence };
  if (!processCreationMatchesArtifact(processInfo, record.artifact, record.kind)) {
    return { status: 'ambiguous', reason: `${record.kind}_creation_time_outside_session`, evidence };
  }
  return { status: 'exact', reason: `${record.kind}_identity_exact`, evidence };
}
function findLeaseSessionBaselineFingerprint(outDir, binding = {}) {
  let names = [];
  try {
    names = fs.readdirSync(outDir)
      .filter((name) => /^pr-validation-session-.*\.json$/u.test(name));
  } catch (_) {
    return { fingerprint: null, artifact_path: '', reason: 'session_artifact_directory_unreadable' };
  }
  const candidates = names
    .map((name) => {
      const artifactPath = path.join(outDir, name);
      const artifact = readJson(artifactPath);
      if (!artifact || !validationArtifactMatchesBinding(artifact, binding)) return null;
      const fingerprint = normalizeMigrationFingerprint(artifact.migration_fingerprint);
      if (!fingerprint) return null;
      const timestamp = Date.parse(artifact.finished_at || artifact.started_at || '') || 0;
      return { artifactPath, artifact, fingerprint, timestamp };
    })
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp);
  if (!candidates.length) {
    return { fingerprint: null, artifact_path: '', reason: 'matching_lease_session_baseline_not_found' };
  }
  return {
    fingerprint: candidates[0].fingerprint,
    artifact_path: candidates[0].artifactPath,
    reason: 'matching_lease_session_baseline_found',
  };
}

function inspectRecordedValidationProcesses(outDir, binding = {}, options = {}) {
  const isAlive = options.isAlive || isProcessAlive;
  const currentPid = Number(options.currentPid || process.pid);
  let names = [];
  try {
    names = fs.readdirSync(outDir).filter((name) => /^pr-validation-session-.*\.json$/u.test(name));
  } catch (error) {
    return {
      scan_ok: false,
      scan_error: error?.message || String(error),
      exact_heartbeat_count: 0,
      unbound_heartbeat_count: 0,
      runner_count: 0,
    };
  }
  const heartbeatCandidates = [];
  const runnerCandidates = [];
  const currentRunnerCandidates = [];
  for (const name of names) {
    const artifactPath = path.join(outDir, name);
    const artifact = readJson(artifactPath);
    if (!artifact || !validationArtifactMatchesBinding(artifact, binding, { requireLease: false })) continue;
    const artifactLeaseId = String(artifact.marker_lease_id || artifact.lease_id || '').trim();
    const loop = artifact.heartbeat_loop || artifact.heartbeat_sync?.heartbeatLoop || null;
    const heartbeatPid = Number(loop?.pid || 0);
    if (heartbeatPid > 0 && isAlive(heartbeatPid)) {
      heartbeatCandidates.push({
        kind: 'heartbeat', pid: heartbeatPid, lease_id: artifactLeaseId, artifact_path: artifactPath, artifact, loop,
      });
    }
    const runnerPid = Number(artifact.session_pid || 0);
    const terminal = Boolean(artifact.finished_at || artifact.status === 'passed' || artifact.status === 'failed');
    if (!terminal && runnerPid > 0 && isAlive(runnerPid)) {
      const runnerCandidate = {
        kind: 'runner', pid: runnerPid, lease_id: artifactLeaseId, artifact_path: artifactPath, artifact,
      };
      if (runnerPid === currentPid) currentRunnerCandidates.push(runnerCandidate);
      else runnerCandidates.push(runnerCandidate);
    }
  }
  const candidates = [...heartbeatCandidates, ...runnerCandidates];
  const processInfoByPid = inspectLiveProcessIdentities(candidates.map((row) => row.pid), options);
  const exactRows = [];
  const ambiguousRows = [];
  const staleRows = [];
  const candidatesByPid = new Map();
  for (const candidate of candidates) {
    if (!candidatesByPid.has(candidate.pid)) candidatesByPid.set(candidate.pid, []);
    candidatesByPid.get(candidate.pid).push(candidate);
  }
  for (const [pid, rows] of candidatesByPid.entries()) {
    const processInfo = processInfoByPid.get(pid) || (isAlive(pid)
      ? { pid, inspection_error: 'live_process_identity_missing_from_inspection' }
      : { pid, not_found: true });
    if (pid === currentPid && currentRunnerCandidates.length) {
      const currentClassified = currentRunnerCandidates
        .map((row) => ({ row, identity: recordedProcessIdentity(row, processInfo) }));
      const exactCurrent = currentClassified.filter((item) => item.identity.status === 'exact');
      if (exactCurrent.length === 1) {
        staleRows.push({
          pid,
          reason: 'historical_pid_reused_by_exact_current_session_runner',
          evidence: exactCurrent[0].identity.evidence,
        });
        continue;
      }
      if (exactCurrent.length > 1) {
        ambiguousRows.push({
          pid,
          reason: 'multiple_current_session_runner_identities_match',
          evidence: exactCurrent.map((item) => item.identity.evidence),
        });
        continue;
      }
      const ambiguousCurrent = currentClassified.find((item) => item.identity.status === 'ambiguous');
      ambiguousRows.push({
        pid,
        reason: ambiguousCurrent
          ? 'current_session_' + ambiguousCurrent.identity.reason
          : 'current_session_runner_identity_not_exact',
        evidence: ambiguousCurrent?.identity.evidence || null,
      });
      continue;
    }
    const classified = rows.map((row) => ({ row, identity: recordedProcessIdentity(row, processInfo) }));
    const exact = classified.filter((item) => item.identity.status === 'exact');
    if (exact.length === 1) exactRows.push(exact[0].row);
    else if (exact.length > 1) {
      ambiguousRows.push({
        pid,
        reason: 'multiple_recorded_process_identities_match',
        evidence: exact.map((item) => item.identity.evidence),
      });
    } else {
      const ambiguous = classified.find((item) => item.identity.status === 'ambiguous');
      if (ambiguous) {
        ambiguousRows.push({ pid, reason: ambiguous.identity.reason, evidence: ambiguous.identity.evidence });
      } else {
        staleRows.push({
          pid,
          reason: classified[0]?.identity.reason || 'process_not_found',
          evidence: classified[0]?.identity.evidence || null,
        });
      }
    }
  }
  const heartbeats = new Map(exactRows.filter((row) => row.kind === 'heartbeat').map((row) => [row.pid, row]));
  const runners = new Map(exactRows.filter((row) => row.kind === 'runner').map((row) => [row.pid, row]));
  const heartbeatRows = [...heartbeats.values()];
  const exactHeartbeatRows = heartbeatRows.filter((row) => row.lease_id === String(binding.leaseId || '').trim());
  const unboundHeartbeatRows = heartbeatRows.filter((row) => row.lease_id !== String(binding.leaseId || '').trim());
  return {
    scan_ok: ambiguousRows.length === 0,
    scan_error: ambiguousRows.length
      ? ambiguousRows.map((row) => `${row.pid}:${row.reason}`).join(',')
      : '',
    exact_heartbeat_count: exactHeartbeatRows.length,
    exact_heartbeat_pids: exactHeartbeatRows.map((row) => row.pid),
    unbound_heartbeat_count: unboundHeartbeatRows.length,
    unbound_heartbeat_pids: unboundHeartbeatRows.map((row) => row.pid),
    runner_count: runners.size,
    runner_pids: [...runners.keys()],
    ambiguous_process_count: ambiguousRows.length,
    ambiguous_process_pids: ambiguousRows.map((row) => row.pid),
    ambiguous_processes: ambiguousRows,
    ignored_stale_pid_count: staleRows.length,
    ignored_stale_pids: staleRows.map((row) => row.pid),
    ignored_stale_processes: staleRows,
  };
}
function validationSessionLockPath(outDir, binding = {}) {
  const token = [
    `pr${sanitizeFileToken(binding.prNumber)}`,
    sanitizeFileToken(binding.worktreeId),
    sanitizeFileToken(String(binding.headSha || '').slice(0, 12)),
    sanitizeFileToken(binding.projectId),
  ].join('-');
  return path.join(outDir, `runner-${token}.lock`);
}

function acquireValidationSessionLock(outDir, binding = {}, options = {}) {
  const lockPath = validationSessionLockPath(outDir, binding);
  const isAlive = options.isAlive || isProcessAlive;
  const pid = Number(options.pid || process.pid);
  const payload = { pid, acquired_at: new Date().toISOString(), ...binding };
  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    tryCreate();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJson(lockPath) || {};
    const existingPid = Number(existing.pid || 0);
    if (existingPid > 0 && isAlive(existingPid)) {
      throw new Error(`matching validation session runner already active at pid ${existingPid}`);
    }
    fs.rmSync(lockPath, { force: true });
    tryCreate();
  }
  return {
    path: lockPath,
    pid,
    release() {
      const current = readJson(lockPath) || {};
      if (Number(current.pid || 0) === pid) fs.rmSync(lockPath, { force: true });
    },
  };
}

function findNextSortedPgtapFile(cwd, fileName) {
  if (!fileName) return '';
  const dir = path.join(cwd, 'supabase', 'tests', 'pgtap');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return '';
  }
  const index = files.indexOf(path.basename(fileName));
  return index >= 0 && index + 1 < files.length ? files[index + 1] : '';
}

function branchManifestState(cwd) {
  const scriptPath = path.join(cwd, 'scripts', 'ops', 'pr-branch.js');
  const pkg = readJson(path.join(cwd, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  const hasScripts = Boolean(
    scripts['ops:pr-branch:inventory'] &&
    scripts['ops:pr-branch:validate-manifest'] &&
    scripts['ops:pr-branch:snapshot'],
  );
  if (!fs.existsSync(scriptPath) || !hasScripts) return 'missing_in_active_pr_checkout';
  return 'available_unvalidated';
}

function normalizeRepoPath(filePath) {
  return String(filePath || '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function parseGitStatusPorcelain(raw) {
  return String(raw || '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const status = line.slice(0, 2).trim();
      const rawPath = (line.length > 2 && line[2] === ' ' ? line.slice(3) : line.slice(2)).trim();
      const file = normalizeRepoPath(rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath);
      return { status, file };
    })
    .filter((entry) => entry.file);
}

function isGeneratedDirtyPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return normalized === 'supabase/config.toml' ||
    normalized.startsWith('.tmp/') ||
    normalized.startsWith('supabase/.temp/') ||
    normalized.startsWith('test-results/') ||
    normalized.startsWith('playwright-report/') ||
    normalized.startsWith('docs/ops/evidence/');
}

function hasAutoOverlayMarkers(toml) {
  return /^# AUTO-OVERLAY-BEGIN/m.test(String(toml || '')) &&
    /^# AUTO-OVERLAY-END /m.test(String(toml || ''));
}

function parseAutoOverlayPorts(toml) {
  const match = String(toml || '').match(/^# AUTO-OVERLAY-END\b.*\bports=([^\r\n]+)/m);
  if (!match) return {};
  const ports = {};
  const rawPorts = match[1] || '';
  const re = /([a-zA-Z][a-zA-Z0-9_-]*):(\d+)/gu;
  let portMatch = re.exec(rawPorts);
  while (portMatch) {
    ports[portMatch[1].replace(/-/g, '_')] = Number.parseInt(portMatch[2], 10);
    portMatch = re.exec(rawPorts);
  }
  return ports;
}

function assessValidationConfigOverlay(configText, baselineText, options = {}, reusableLease = null) {
  if (!reusableLease) return { allowed: false, reason: 'missing_reusable_validation_lease' };
  const details = reusableLease.details || {};
  const state = String(reusableLease.validation_stack_state || details.state || '').trim();
  if (reusableLease.resource_class !== VALIDATION_RESOURCE || reusableLease.owner !== VALIDATION_OWNER || !VALIDATION_REUSE_STATES.has(state)) {
    return { allowed: false, reason: 'lease_not_reusable_first_class_validation_stack' };
  }
  if (String(details.project_id || '') !== String(options.projectId || '')) {
    return { allowed: false, reason: 'lease_project_mismatch' };
  }
  if (String(details.pr_number || '') !== String(options.prNumber || '')) {
    return { allowed: false, reason: 'lease_pr_mismatch' };
  }
  if (String(details.worktree_id || '') !== String(options.worktreeId || '')) {
    return { allowed: false, reason: 'lease_worktree_mismatch' };
  }
  if (!hasAutoOverlayMarkers(configText)) {
    return { allowed: false, reason: 'config_missing_auto_overlay_markers' };
  }
  if (!String(baselineText || '').trim()) {
    return { allowed: false, reason: 'missing_clean_config_baseline' };
  }
  if (hasAutoOverlayMarkers(baselineText)) {
    return { allowed: false, reason: 'baseline_is_also_overlaid' };
  }
  const overlayPorts = parseAutoOverlayPorts(configText);
  let optionPorts = {};
  try {
    optionPorts = parsePorts(options.ports);
  } catch (_) {
    optionPorts = {};
  }
  const leasePorts = reusableLease?.details?.ports || {};
  for (const key of ['api', 'db', 'studio']) {
    if (!Number.isFinite(Number(overlayPorts[key]))) {
      return { allowed: false, reason: `overlay_${key}_port_missing` };
    }
    if (Number.isFinite(Number(optionPorts[key])) && Number(overlayPorts[key]) !== Number(optionPorts[key])) {
      return { allowed: false, reason: `overlay_${key}_port_mismatch` };
    }
    if (Number.isFinite(Number(leasePorts[key])) && Number(overlayPorts[key]) !== Number(leasePorts[key])) {
      return { allowed: false, reason: `overlay_${key}_port_mismatch` };
    }
  }
  return {
    allowed: true,
    reason: 'validation_overlay_matches_reusable_first_class_lease',
    overlay_ports: overlayPorts,
  };
}

function assessWorkspaceValidationOverlay(cwd, options = {}, reusableLease = null) {
  const configPath = path.join(cwd, 'supabase', 'config.toml');
  const baselinePath = path.join(cwd, 'supabase', '.temp', 'config.baseline.toml');
  let configText = '';
  let baselineText = '';
  try {
    configText = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    configText = '';
  }
  try {
    baselineText = fs.readFileSync(baselinePath, 'utf8');
  } catch (_) {
    baselineText = '';
  }
  return {
    path: 'supabase/config.toml',
    ...assessValidationConfigOverlay(configText, baselineText, options, reusableLease),
  };
}

function buildDirtyGuard(rawStatus, options = {}) {
  const allowed = new Set(parseFocusedFiles(options.allowedDirty).map(normalizeRepoPath));
  const activeValidationOverlay = new Set((options.activeValidationOverlayDirty || []).map(normalizeRepoPath));
  const items = parseGitStatusPorcelain(rawStatus).map((entry) => {
    let classification = 'unexpected';
    if (allowed.has(entry.file)) classification = 'allowed_intentional';
    else if (activeValidationOverlay.has(entry.file)) classification = 'allowed_validation_overlay';
    else if (options.allowGeneratedDirty && isGeneratedDirtyPath(entry.file)) classification = 'allowed_generated';
    return { ...entry, classification };
  });
  return {
    clean: items.length === 0,
    enforce_dirty_guard: Boolean(options.enforceDirtyGuard),
    require_clean: Boolean(options.requireClean),
    allow_generated_dirty: Boolean(options.allowGeneratedDirty),
    allowed_dirty: Array.from(allowed),
    active_validation_overlay_dirty: Array.from(activeValidationOverlay),
    items,
    unexpected_dirty: items.filter((entry) => entry.classification === 'unexpected').map((entry) => entry.file),
    generated_dirty: items.filter((entry) => entry.classification === 'allowed_generated').map((entry) => entry.file),
    intentional_dirty: items.filter((entry) => entry.classification === 'allowed_intentional').map((entry) => entry.file),
    validation_overlay_dirty: items.filter((entry) => entry.classification === 'allowed_validation_overlay').map((entry) => entry.file),
  };
}

function dirtyGuardHasSchemaFiles(dirtyGuard = {}) {
  return (dirtyGuard.items || []).some((entry) => (
    entry.file.startsWith('supabase/migrations/') ||
    entry.file.startsWith('supabase/schemas/') ||
    entry.file.startsWith('supabase/schema')
  ));
}

function dirtyGuardIsFixtureOnly(dirtyGuard = {}) {
  const intentional = dirtyGuard.intentional_dirty || [];
  if (!intentional.length) return false;
  return intentional.every((file) => file.startsWith('supabase/tests/pgtap/'));
}

function buildColdStartReason({ plan = {}, options = {}, reusableLease = null } = {}) {
  if (!plan.local_start) return '';
  if (String(options.coldStartReason || '').trim()) {
    return normalizeExplicitColdStartReason(options.coldStartReason);
  }
  if (options.reuseActive && !reusableLease) return 'reuse_active_requested_but_no_matching_lease';
  return 'no_valid_warm_validation_stack';
}

function extractFailureText(step = {}) {
  const text = sanitizeText(`${step.stderr || ''}\n${step.stdout || ''}`)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-40)
    .join('\n');
  return text.slice(-4000);
}

function classifyFocusedPgtapFailure(failureText = '') {
  const text = String(failureText || '');
  if (/integration_plugin_activate_core_v1 requires active sender\/client source binding/iu.test(text)) {
    return {
      failureClass: 'sender_client_source_binding_fixture_setup_order',
      exactCosDecisionNeeded: 'none_for_low_risk_local_loop',
      nextAction: 'repair_failed_focused_fixture_then_rerun_only_failed_file',
      localAdmissionState: 'focused_test_failed_known_fixture_class',
    };
  }
  return {
    failureClass: 'focused_pgtap_failed',
    exactCosDecisionNeeded: 'focused_failure_triage',
    nextAction: 'hold_at_failed_focused_test',
    localAdmissionState: 'focused_test_failed',
  };
}

function focusedPrePgtapScope(focusedTest = '') {
  const tokens = path.basename(String(focusedTest || ''), '.sql').split('_').filter(Boolean);
  if (/^0[a-z0-9]+$/iu.test(tokens[0] || '')) tokens.shift();
  if (/^b\d+$/iu.test(tokens[0] || '')) tokens.shift();
  return tokens.slice(0, 2).join('_') || 'current_focused_test';
}

function classifyValidationActiveTransitionFailure(message = '', context = {}) {
  const normalized = String(message || '');
  const activeLeaseAcquireStep = [...(context.steps || [])]
    .reverse()
    .find((step) => step?.label === 'validation lease acquire active');
  const activeTransitionHostPressureBlocked =
    normalized === 'validation lease active transition host pressure guard failed' ||
    (
      normalized === 'validation lease acquire active failed' &&
      Number(activeLeaseAcquireStep?.exit ?? 0) !== 0 &&
      /Host pressure blocks lease acquisition:/u.test(extractFailureText(activeLeaseAcquireStep))
    );
  if (activeTransitionHostPressureBlocked) {
    return {
      failureClass: 'validation_active_transition_host_pressure_blocked',
      exactCosDecisionNeeded: 'await_delayed_host_green_and_approve_same_file_retry',
      nextAction: 'hold_at_' + focusedPrePgtapScope(context.focusedTest) + '_before_pgtap',
      localAdmissionState: 'failed_before_pgtap',
    };
  }
  if (normalized === 'active warm validation lifecycle process guard failed') {
    const processState = context.processState || {};
    const historicalPidAmbiguity = Number(processState.ambiguous_process_count || 0) > 0 &&
      /(?:heartbeat_command_identity_mismatch|validation_process_script_identity_partial)/iu
        .test(String(processState.scan_error || ''));
    return {
      failureClass: historicalPidAmbiguity
        ? 'validation_process_guard_ambiguous_historical_pid'
        : 'validation_active_warm_process_guard_failed',
      exactCosDecisionNeeded: 'approve_lifecycle_fix_and_same_file_retry',
      nextAction: `hold_at_${focusedPrePgtapScope(context.focusedTest)}_before_pgtap`,
      localAdmissionState: 'failed_before_pgtap',
    };
  }
  if (normalized !== 'validation active transition heartbeat or runner guard failed') return null;
  return {
    failureClass: 'validation_active_transition_guard_failed',
    exactCosDecisionNeeded: 'approve_lifecycle_fix_and_same_file_retry',
    nextAction: 'hold_at_pod_before_pgtap',
    localAdmissionState: 'failed_before_pgtap',
  };
}

function refreshMeasurableFields(result, context = {}) {
  const options = context.options || {};
  const files = Array.isArray(result.focused_files) ? result.focused_files : [];
  const passedFiles = Array.isArray(result.passed_files) ? result.passed_files : [];
  const failedFile = String(result.failed_file || '');
  const currentTest = context.currentTest || failedFile || files.find((file) => !passedFiles.includes(file)) || files[files.length - 1] || '';
  const lastPassedTest = passedFiles.length ? passedFiles[passedFiles.length - 1] : '';
  const nextBatchTest = files.find((file) => !passedFiles.includes(file) && file !== failedFile) || '';
  const terminalReference = failedFile || lastPassedTest || files[files.length - 1] || '';
  const nextSortedTest = context.nextSortedTest !== undefined
    ? context.nextSortedTest
    : findNextSortedPgtapFile(context.cwd || result.worktree_path || process.cwd(), terminalReference);
  const dirtyGuard = result.dirty_guard || {};
  const plan = result.session_plan || context.plan || {};
  const leaseId = String(context.leaseId || result.marker_lease_id || result.lease_id || '').trim();
  const failureClass = context.failureClass ||
    result.local_start_failure_class ||
    (failedFile ? 'focused_pgtap_failed' : '');
  const localStart = typeof context.localStart === 'boolean'
    ? context.localStart
    : (typeof plan.local_start === 'boolean' ? plan.local_start : null);
  const migrationFingerprint = context.migrationFingerprint || result.migration_fingerprint || null;
  const previousMigrationFingerprint = context.previousMigrationFingerprint ||
    result.warm_baseline_migration_fingerprint?.digest || '';
  const migrationFingerprintChanged = Boolean(
    previousMigrationFingerprint &&
    migrationFingerprint?.digest &&
    previousMigrationFingerprint !== migrationFingerprint.digest,
  );
  const pendingTestsCount = failedFile
    ? files.filter((file) => !passedFiles.includes(file) && file !== failedFile).length
    : files.filter((file) => !passedFiles.includes(file)).length;

  result.current_pr = result.pr_number;
  result.focused_test = files[0] || '';
  result.current_test = currentTest;
  result.last_passed_test = lastPassedTest;
  result.next_test = failedFile ? failedFile : (nextBatchTest || nextSortedTest || '');
  result.next_sorted_focused_file = nextSortedTest || '';
  result.passed_tests_count = passedFiles.length;
  result.pending_tests_count = pendingTestsCount;
  result.failed_test = failedFile;
  result.failed_files = failedFile ? [failedFile] : [];
  result.focused = files.join(',');
  result.failure_class = failureClass;
  result.failure_text = context.failureText || result.failure_text || '';
  result.local_admission_state = context.localAdmissionState || result.local_admission_state || 'starting';
  result.local_start = localStart;
  result.db_reused = Boolean(result.reused_warm_stack);
  result.migrations_replayed = localStart === null ? null : Boolean(localStart);
  result.migration_fingerprint = migrationFingerprint;
  result.migration_fingerprint_changed = migrationFingerprintChanged;
  result.schema_files_changed = dirtyGuardHasSchemaFiles(dirtyGuard);
  result.fixture_only_change = dirtyGuardIsFixtureOnly(dirtyGuard);
  result.cold_start_reason = context.coldStartReason || result.cold_start_reason || '';
  result.keep_warm_requested = Boolean(options.keepWarm);
  result.keep_warm_on_failure = Boolean(options.keepWarmOnFailure);
  result.lease_id = leaseId;
  result.heartbeat_owner = leaseId ? `${VALIDATION_OWNER}:${leaseId}` : VALIDATION_OWNER;
  result.dirty_guard_status = dirtyGuard.unexpected_dirty?.length ? 'failed' : 'passed';
  result.github_quiet = true;
  result.branch_manifest_state = context.branchManifestState || result.branch_manifest_state || 'missing_in_active_pr_checkout';
  result.governance_gate_state = context.governanceGateState || result.governance_gate_state || 'local_focused_only_github_quiet';
  result.exact_cos_decision_needed = context.exactCosDecisionNeeded ||
    (failedFile ? 'focused_failure_triage' : 'none_for_low_risk_local_loop');
  result.next_action = context.nextAction ||
    (failedFile
      ? 'hold_at_failed_focused_test'
      : (result.next_test ? 'continue_next_focused_test_when_guards_green' : 'run_final_local_candidate_gate_after_closure_gates'));
  return result;
}

function gitValue(args, cwd = process.cwd(), options = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) return '';
  const value = String(res.stdout || '');
  return options.trim === false ? value : value.trim();
}

function terminateProcessTree(child, options = {}) {
  if (!child?.pid) return { attempted: false, succeeded: false, method: 'none' };
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const outcome = spawnSyncImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return {
      attempted: true,
      succeeded: outcome?.status === 0 && !outcome?.error,
      method: 'taskkill',
      pid: child.pid,
      status: outcome?.status == null ? null : outcome.status,
      error: outcome?.error ? String(outcome.error.message || outcome.error) : '',
    };
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
    return { attempted: true, succeeded: true, method: 'process_group_sigterm', pid: child.pid };
  } catch (_) {
    try {
      child.kill('SIGTERM');
      return { attempted: true, succeeded: true, method: 'child_sigterm', pid: child.pid };
    } catch {
      return { attempted: true, succeeded: false, method: 'failed', pid: child.pid };
    }
  }
}

function resolveLocalStartTimeouts(options = {}, env = process.env) {
  const stepTimeoutMs = parsePositiveInt(
    options.localStartStepTimeoutMs ?? env.PR_VALIDATION_LOCAL_START_STEP_TIMEOUT_MS,
    DEFAULT_VALIDATION_LOCAL_START_STEP_TIMEOUT_MS,
  );
  const configuredHard = parsePositiveInt(
    options.localStartHardTimeoutMs ??
      env.PR_VALIDATION_LOCAL_START_HARD_TIMEOUT_MS ??
      env.WORKSPACE_LOCAL_START_SUPABASE_START_HARD_TIMEOUT_MS,
    DEFAULT_VALIDATION_LOCAL_START_HARD_TIMEOUT_MS,
  );
  const hardTimeoutMs = Math.max(1000, Math.min(configuredHard, Math.max(1000, stepTimeoutMs - 60000)));
  return { stepTimeoutMs, hardTimeoutMs };
}

function buildLocalStartEnv(options = {}, env = process.env) {
  const timeouts = resolveLocalStartTimeouts(options, env);
  return {
    WORKSPACE_LOCAL_START_SUPABASE_START_HARD_TIMEOUT_MS: String(timeouts.hardTimeoutMs),
  };
}

function runCommand(label, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = parsePositiveInt(options.timeoutMs, 0);
  const terminationGraceMs = parsePositiveInt(options.terminationGraceMs, 5000);
  const spawnImpl = options.spawnImpl || spawn;
  const chunks = { stdout: '', stderr: '' };
  let child = null;
  let timedOut = false;
  let timeoutTimer = null;
  let terminationGraceTimer = null;
  let termination = null;
  let closeObserved = false;
  let terminationGraceExpired = false;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (payload = {}) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationGraceTimer) clearTimeout(terminationGraceTimer);
      const finishedAt = new Date().toISOString();
      const stdout = sanitizeText(chunks.stdout);
      const spawnError = payload.error ? String(payload.error.message || payload.error) : '';
      const stderr = sanitizeText([chunks.stderr, spawnError].filter(Boolean).join('\n'));
      const exit = timedOut ? 124 : (payload.code == null ? 1 : payload.code);
      const writerMayBeActive = Boolean(timedOut && termination && !termination.succeeded);
      const record = {
        label,
        command,
        args,
        exit,
        signal: payload.signal || '',
        started_at: startedAt,
        finished_at: finishedAt,
        stdout,
        stderr,
        timed_out: timedOut,
        timeout_ms: timedOut ? timeoutMs : null,
        termination,
        close_observed: closeObserved,
        termination_grace_expired: terminationGraceExpired,
        writer_may_be_active: writerMayBeActive,
      };
      if (options.logPath) {
        fs.appendFileSync(
          options.logPath,
          [
            `[${startedAt}] BEGIN ${label}: ${command} ${args.join(' ')}`,
            stdout,
            stderr,
            timedOut ? `[${finishedAt}] TIMEOUT ${label} after ${timeoutMs}ms` : '',
            `[${finishedAt}] END ${label} exit=${record.exit}`,
            '',
          ].filter((line) => line !== '').join('\n'),
        );
      }
      resolve(record);
    };

    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env || {}) },
        shell: false,
        windowsHide: true,
        detached: (options.platform || process.platform) !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (options.activeCommandRef) options.activeCommandRef.child = child;
      child.stdout?.on('data', (chunk) => { chunks.stdout += String(chunk || ''); });
      child.stderr?.on('data', (chunk) => { chunks.stderr += String(chunk || ''); });
      child.once('error', (error) => finish({ error }));
      child.once('close', (code, signal) => {
        closeObserved = true;
        if (options.activeCommandRef?.child === child) options.activeCommandRef.child = null;
        finish({ code, signal });
      });
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          chunks.stderr += `${label} timed out after ${timeoutMs}ms\n`;
          termination = terminateProcessTree(child, options);
          if (!termination.succeeded) {
            chunks.stderr += `${label} process-tree termination was not confirmed\n`;
            finish({ code: 124, signal: 'TIMEOUT' });
            return;
          }
          terminationGraceTimer = setTimeout(() => {
            terminationGraceExpired = true;
            if (options.activeCommandRef?.child === child) options.activeCommandRef.child = null;
            finish({ code: 124, signal: 'TIMEOUT' });
          }, terminationGraceMs);
        }, timeoutMs);
      }
    } catch (error) {
      finish({ error });
    }
  });
}

async function runSessionCommand(result, resultPath, label, command, args, options = {}) {
  result.active_step = {
    label,
    command,
    args,
    started_at: new Date().toISOString(),
    timeout_ms: parsePositiveInt(options.timeoutMs, 0) || null,
  };
  writeJson(resultPath, result);
  const record = await runCommand(label, command, args, options);
  delete result.active_step;
  result.steps.push(record);
  writeJson(resultPath, result);
  return record;
}

function parseHeartbeatChildArgs(argv = []) {
  const out = {
    cwd: process.cwd(),
    leaseId: '',
    stopFile: '',
    logPath: '',
    intervalMs: 60000,
    maxMs: 8 * 60 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    const readValue = () => String(argv[++index] || '').trim();
    if (token === '--cwd') out.cwd = readValue();
    else if (token === '--lease-id') out.leaseId = readValue();
    else if (token === '--stop-file') out.stopFile = readValue();
    else if (token === '--log-path') out.logPath = readValue();
    else if (token === '--interval-ms') out.intervalMs = Number.parseInt(readValue(), 10) || out.intervalMs;
    else if (token === '--max-ms') out.maxMs = Number.parseInt(readValue(), 10) || out.maxMs;
    else if (token === '--parent-pid') out.parentPid = Number.parseInt(readValue(), 10) || 0;
    else if (token === '--session-file') out.sessionFile = readValue();
  }
  return out;
}

function appendHeartbeatLog(logPath, message) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function heartbeatExitReason(options = {}) {
  if (options.stopFile && fs.existsSync(options.stopFile)) return 'stop_file_seen';
  let session = {};
  let sessionTerminal = false;
  let preserveTerminalWarmHeartbeat = false;
  if (options.sessionFile) {
    session = readJson(options.sessionFile) || {};
    sessionTerminal = Boolean(
      session.finished_at ||
      session.status === 'failed' ||
      session.status === 'passed' ||
      session.interrupted,
    );
    preserveTerminalWarmHeartbeat = Boolean(
      sessionTerminal &&
      session.validation_stack_state === 'active' &&
      (session.keep_warm_requested === true || session.keep_warm_on_failure === true),
    );
  }
  if (sessionTerminal && !preserveTerminalWarmHeartbeat) return 'session_terminal';
  if (options.parentPid && !isProcessAlive(options.parentPid) && !preserveTerminalWarmHeartbeat) return 'parent_not_alive';
  if (options.startedAt && options.maxMs && Date.now() - options.startedAt > options.maxMs) return 'max_ms_elapsed';
  return '';
}

function heartbeatChildMain(argv = []) {
  const options = parseHeartbeatChildArgs(argv);
  if (!options.leaseId || !options.stopFile) process.exit(1);
  const startedAt = Date.now();
  const heartbeatIntervalMs = Math.max(15000, options.intervalMs);
  let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
  const beat = () => {
    const res = spawnSync(process.execPath, [
      runtimeLeasesScript(),
      'heartbeat',
      '--owner',
      VALIDATION_OWNER,
      '--lease-id',
      options.leaseId,
      '--json',
    ], {
      cwd: options.cwd,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    });
    const errorText = res.error ? ` error=${res.error.message || res.error}` : '';
    appendHeartbeatLog(options.logPath, `heartbeat lease=${options.leaseId} exit=${res.status == null ? 1 : res.status}${errorText}`);
  };
  beat();
  const timer = setInterval(() => {
    const exitReason = heartbeatExitReason({ ...options, startedAt });
    if (exitReason) {
      appendHeartbeatLog(options.logPath, `heartbeat ${exitReason} lease=${options.leaseId}`);
      clearInterval(timer);
      process.exit(0);
    }
    if (Date.now() >= nextHeartbeatAt) {
      beat();
      nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
    }
  }, 1000);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000, intervalMs = 100) {
  const startedAt = Date.now();
  while (isProcessAlive(pid) && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isProcessAlive(pid);
}

function startHeartbeatLoop({ cwd, leaseId, stopFile, logPath, sessionFile }) {
  if (!leaseId || !stopFile) return null;
  try {
    fs.rmSync(stopFile, { force: true });
  } catch (_) {
    // Best effort; a stale stop file should not block the owner heartbeat loop.
  }
  const child = spawn(process.execPath, [
    __filename,
    '--heartbeat-child',
    '--cwd',
    cwd,
    '--lease-id',
    leaseId,
    '--stop-file',
    stopFile,
    '--log-path',
    logPath,
    '--parent-pid',
    String(process.pid),
    '--session-file',
    sessionFile || '',
  ], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return {
    pid: child.pid,
    stop_file: stopFile,
    interval_ms: 60000,
    parent_pid: process.pid,
    session_file: sessionFile || '',
  };
}

function stopHeartbeatLoop(loop) {
  if (!loop?.stop_file) return;
  fs.mkdirSync(path.dirname(loop.stop_file), { recursive: true });
  fs.writeFileSync(loop.stop_file, `${new Date().toISOString()}\n`);
}

async function stopHeartbeatLoopAndWait(loop, options = {}) {
  const pid = Number(loop?.pid || 0);
  const isAlive = options.isAlive || isProcessAlive;
  if (!loop?.stop_file) {
    const exitConfirmed = pid <= 0 || !isAlive(pid);
    return {
      requested: false,
      pid,
      exit_confirmed: exitConfirmed,
      reason: exitConfirmed ? 'no_live_heartbeat_to_stop' : 'heartbeat_stop_file_missing',
    };
  }
  const stopLoop = options.stopLoop || stopHeartbeatLoop;
  const waitForExit = options.waitForExit || waitForProcessExit;
  stopLoop(loop);
  const exitConfirmed = pid <= 0
    ? true
    : await waitForExit(pid, Number(options.timeoutMs || 5000));
  return {
    requested: true,
    pid,
    stop_file: loop.stop_file,
    exit_confirmed: exitConfirmed,
    reason: exitConfirmed ? 'heartbeat_stop_confirmed' : 'heartbeat_stop_timeout',
  };
}

function attachExistingHeartbeatLoop({ leaseId, stopFile, pid = null }) {
  if (!leaseId || !stopFile) return null;
  return {
    pid,
    stop_file: stopFile,
    interval_ms: 60000,
    attached_existing: true,
  };
}

function attachExactHeartbeatLoopForCleanup({ leaseId = '', processState = {}, stopFile = '' } = {}) {
  const exactPids = Array.isArray(processState.exact_heartbeat_pids)
    ? processState.exact_heartbeat_pids.map((pid) => Number(pid || 0)).filter((pid) => pid > 0)
    : [];
  if (Number(processState.exact_heartbeat_count || 0) !== 1 || exactPids.length !== 1) return null;
  return attachExistingHeartbeatLoop({ leaseId, stopFile, pid: exactPids[0] });
}

function syncHeartbeatLoopForLease({
  cwd,
  currentLeaseId = '',
  nextLeaseId = '',
  heartbeatLoop = null,
  stopFileForLease,
  logPath = '',
  sessionFile = '',
  startLoop = startHeartbeatLoop,
  stopLoop = stopHeartbeatLoop,
} = {}) {
  const normalizedNext = String(nextLeaseId || '').trim();
  const normalizedCurrent = String(currentLeaseId || '').trim();
  if (!normalizedNext) {
    return {
      leaseId: normalizedCurrent,
      heartbeatLoop,
      restarted: false,
      reason: 'missing_next_lease_id',
    };
  }
  if (normalizedNext === normalizedCurrent && heartbeatLoop) {
    return {
      leaseId: normalizedNext,
      heartbeatLoop,
      restarted: false,
      reason: 'heartbeat_already_matches_lease',
    };
  }
  if (heartbeatLoop) stopLoop(heartbeatLoop);
  const nextLoop = startLoop({
    cwd,
    leaseId: normalizedNext,
    stopFile: stopFileForLease(normalizedNext),
    logPath,
    sessionFile,
  });
  return {
    leaseId: normalizedNext,
    heartbeatLoop: nextLoop,
    restarted: true,
    reason: normalizedCurrent ? 'heartbeat_rebound_to_current_marker_lease' : 'heartbeat_started_for_current_marker_lease',
  };
}

function sanitizeText(text) {
  return String(text || '').replace(
    /("(?:ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY|JWT_SECRET|PUBLISHABLE_KEY|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET)"\s*:\s*")[^"]+(")/gu,
    '$1[REDACTED]$2',
  );
}

function parseJsonFromText(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

function buildValidationCommand(files, options = {}) {
  const start = options.reuseActive ? 'reused-stack-health-check' : 'npm run local:start';
  const stop = options.keepWarm || options.keepWarmOnFailure
    ? 'keep validation stack warm for same-session focused checks'
    : 'npm run local:stop';
  return `${start}; PGTAP_ONLY_FILES=${files.join(',')} npm run test:pgtap; ${stop}`;
}

function probeTcpPort(name, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const parsedPort = Number(port);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
      resolve({ name, port, ok: false, reason: 'invalid_port' });
      return;
    }
    const socket = net.createConnection({ host: '127.0.0.1', port: parsedPort });
    const finish = (payload) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(payload);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ name, port: parsedPort, ok: true }));
    socket.once('timeout', () => finish({ name, port: parsedPort, ok: false, reason: 'timeout' }));
    socket.once('error', (error) => finish({ name, port: parsedPort, ok: false, reason: error?.code || error?.message || 'connect_error' }));
  });
}

function probeHttpPath(name, port, requestPath, okStatusCodes = [], timeoutMs = 5000) {
  return new Promise((resolve) => {
    const parsedPort = Number(port);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
      resolve({ name, port, path: requestPath, ok: false, reason: 'invalid_port' });
      return;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: parsedPort,
      path: requestPath,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const status = Number(res.statusCode);
        const ok = okStatusCodes.length
          ? okStatusCodes.includes(status)
          : status >= 200 && status <= 499;
        resolve({ name, port: parsedPort, path: requestPath, status, ok });
      });
    });
    req.once('timeout', () => {
      req.destroy();
      resolve({ name, port: parsedPort, path: requestPath, ok: false, reason: 'timeout' });
    });
    req.once('error', (error) => {
      resolve({ name, port: parsedPort, path: requestPath, ok: false, reason: error?.code || error?.message || 'http_error' });
    });
    req.end();
  });
}

async function healthCheckChildMain(argv = []) {
  let ports = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--ports-json') {
      try {
        ports = JSON.parse(String(argv[++index] || '{}'));
      } catch {
        ports = {};
      }
    }
  }
  const probes = [];
  if (ports.db) probes.push(await probeTcpPort('db', ports.db));
  if (ports.api) {
    probes.push(await probeHttpPath('api-rest-gateway', ports.api, '/rest/v1/', [200, 401, 403, 404]));
    probes.push(await probeHttpPath('auth-health', ports.api, '/auth/v1/health', [200, 404]));
  }
  if (ports.studio) probes.push(await probeHttpPath('studio-shell', ports.studio, '/'));
  const failed = probes.filter((probe) => !probe.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    mode: 'reused_validation_stack_health_only',
    probes,
  }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

async function runReusedStackHealthCheck(result, resultPath, cwd, ports, logPath, options = {}) {
  return runSessionCommand(
    result,
    resultPath,
    'reused validation stack health check',
    process.execPath,
    [__filename, '--health-check-child', '--ports-json', JSON.stringify(ports)],
    {
      cwd,
      logPath,
      timeoutMs: parsePositiveInt(
        options.healthCheckTimeoutMs ?? process.env.PR_VALIDATION_HEALTH_CHECK_TIMEOUT_MS,
        DEFAULT_VALIDATION_HEALTH_CHECK_TIMEOUT_MS,
      ),
      activeCommandRef: options.activeCommandRef,
    },
  );
}

function classifyLocalStartFailure(step = {}) {
  const text = `${step.stdout || ''}\n${step.stderr || ''}`;
  if (step.timed_out || /local:start timed out after \d+ms/i.test(text)) return 'local_start_supervised_timeout';
  if (/supabase start exceeded hard runtime timeout \d+ms/i.test(text)) return 'local_start_hard_timeout';
  if (/runtime_lease_port_bind_conflict/i.test(text)) return 'runtime_lease_port_bind_conflict';
  if (/supabase_postgres_startup_recovery_timeout/i.test(text)) {
    return 'supabase_postgres_startup_recovery_timeout';
  }
  if (
    /docker rm -f supabase_\S+ timed out after \d+ms/i.test(text) ||
    /Timed out waiting for stale Supabase containers to stop/i.test(text)
  ) {
    return 'supabase_owner_cleanup_timeout';
  }
  if (
    /failed to bind host port 0\.0\.0\.0:\d+\/tcp:\s*address already in use/i.test(text) ||
    /Bind for 0\.0\.0\.0:\d+ failed: port is already allocated/i.test(text)
  ) {
    return 'runtime_lease_port_bind_conflict';
  }
  if (
    /local_start_migration_deadlock:\s*bounded retry exhausted/i.test(text) &&
    /deadlock detected\s*\(SQLSTATE\s+40P01\)/i.test(text)
  ) {
    return 'local_start_migration_deadlock';
  }
  if (/supabase_cli_stopped_services_db_only/i.test(text)) return 'supabase_cli_stopped_services_db_only';
  if (/Supabase CLI reports .*DB-only project with stopped services/i.test(text)) {
    return 'supabase_cli_stopped_services_db_only';
  }
  if (/supabase_db_only_migrations_complete_no_services/i.test(text)) {
    return 'supabase_db_only_migrations_complete_no_services';
  }
  if (/DB-only Supabase startup|stayed DB-only/i.test(text)) return 'supabase_db_only_startup';
  return 'local_start_failed';
}

function buildLeaseArgs(options, state, files, branch, headSha) {
  return [
    runtimeLeasesScript(),
    'acquire',
    '--resource',
    VALIDATION_RESOURCE,
    '--owner',
    VALIDATION_OWNER,
    '--owner-thread-id',
    options.ownerThreadId,
    '--worktree-id',
    options.worktreeId,
    '--worktree-path',
    options.worktreePath,
    '--branch',
    branch,
    '--head-sha',
    headSha,
    '--pr-number',
    options.prNumber,
    '--project-id',
    options.projectId,
    '--ports',
    options.ports,
    '--validation-command',
    buildValidationCommand(files, options),
    '--purpose',
    options.purpose,
    '--state',
    state,
    '--json',
  ];
}

function extractLeaseId(commandResult) {
  const text = `${commandResult.stdout}\n${commandResult.stderr}`;
  const parsed = parseJsonFromText(text);
  return String(parsed?.lease?.id || parsed?.id || '').trim();
}

function findReusableValidationLease(statusPayload, options, branch, headSha) {
  return findMatchingValidationLease(statusPayload, options, branch, headSha, VALIDATION_REUSE_STATES);
}

function findBlockingStartingValidationLease(statusPayload, options, branch, headSha) {
  return findMatchingValidationLease(statusPayload, options, branch, headSha, VALIDATION_BLOCKING_STATES);
}

function buildFocusedCheckpointTransitionLifecycleEvidence(context = {}) {
  const leases = Array.isArray(context.statusPayload?.leases)
    ? context.statusPayload.leases
      .filter((lease) => lease?.resource_class === VALIDATION_RESOURCE && lease?.owner === VALIDATION_OWNER)
      .map((lease) => ({
        id: String(lease?.id || ''),
        resource_class: lease?.resource_class,
        owner: lease?.owner,
        validation_stack_state: String(lease?.validation_stack_state || lease?.details?.state || ''),
        stale: lease?.stale === true,
        expired: lease?.expired === true,
        details: {
          state: String(lease?.details?.state || lease?.validation_stack_state || ''),
          project_id: String(lease?.details?.project_id || ''),
          pr_number: String(lease?.details?.pr_number || ''),
          owner_thread_id: String(lease?.details?.owner_thread_id || ''),
          worktree_id: String(lease?.details?.worktree_id || ''),
          worktree_path: String(lease?.details?.worktree_path || ''),
          branch: String(lease?.details?.branch || ''),
          head_sha: String(lease?.details?.head_sha || ''),
          ports: { ...(lease?.details?.ports || {}) },
        },
      }))
    : null;
  return {
    schema: 'pr-validation-session.focused-checkpoint-transition.v1',
    fullPorts: { ...(context.ports || {}) },
    validationLeases: leases,
    processGuard: context.processGuard || null,
    overlayAllowed: context.overlayAllowed === true,
    migrationMatches: context.migrationMatches === true,
  };
}
function findMatchingValidationLease(statusPayload, options, branch, headSha, states) {
  const leases = Array.isArray(statusPayload?.leases) ? statusPayload.leases : [];
  let optionPorts = {};
  try {
    optionPorts = parsePorts(options.ports);
  } catch (_) {
    optionPorts = {};
  }
  return leases.find((lease) => {
    const details = lease?.details || {};
    const state = String(lease?.validation_stack_state || details.state || '').trim();
    const leasePorts = details.ports || {};
    const portsMatch = Object.keys(optionPorts).length > 0 && Object.entries(optionPorts).every(([key, value]) => (
      Number.isFinite(Number(optionPorts[key])) &&
      Number.isFinite(Number(leasePorts[key])) &&
      Number(value) === Number(leasePorts[key])
    ));
    return (
      lease?.resource_class === VALIDATION_RESOURCE &&
      lease?.owner === VALIDATION_OWNER &&
      lease?.expired !== true &&
      lease?.stale !== true &&
      states.has(state) &&
      String(details.project_id || '') === String(options.projectId || '') &&
      String(details.pr_number || '') === String(options.prNumber || '') &&
      String(details.owner_thread_id || '') === String(options.ownerThreadId || '') &&
      String(details.worktree_id || '') === String(options.worktreeId || '') &&
      normalizePathIdentity(details.worktree_path) === normalizePathIdentity(options.worktreePath) &&
      String(details.branch || '') === String(branch || '') &&
      String(details.head_sha || '').toLowerCase() === String(headSha || '').toLowerCase() &&
      portsMatch
    );
  }) || null;
}

function buildSessionPlan({ reuseActive = false, reusableLease = null, blockingStartingLease = null } = {}) {
  if (blockingStartingLease && !reusableLease) {
    return {
      blocked: true,
      block_reason: 'matching_validation_stack_starting',
      owner_action: 'wait_for_existing_starting_validation_session_or_request_owner_release',
      acquire_starting: false,
      local_start: false,
      reused_stack_health_check: false,
      local_verify_before_focused_files: false,
      acquire_active: false,
      stop_at_terminal: false,
    };
  }
  return {
    acquire_starting: !reusableLease,
    local_start: !reusableLease,
    reused_stack_health_check: Boolean(reuseActive && reusableLease),
    local_verify_before_focused_files: false,
    acquire_active: true,
    stop_at_terminal: true,
  };
}

function classifyWarmFailurePreservation({
  focusedFailure = {},
  options = {},
  result = {},
  leaseId = '',
  heartbeatLoop = null,
} = {}) {
  if (!options.keepWarmOnFailure) {
    return { preserveActive: false, reason: 'keep_warm_on_failure_not_requested' };
  }
  if (focusedFailure.failureClass !== 'sender_client_source_binding_fixture_setup_order') {
    return { preserveActive: false, reason: 'unknown_or_semantic_failure_class' };
  }
  if (!leaseId) return { preserveActive: false, reason: 'missing_current_lease_id' };
  if (!heartbeatLoop) return { preserveActive: false, reason: 'missing_current_heartbeat' };
  const dirtyGuard = result.dirty_guard || {};
  if (dirtyGuard.unexpected_dirty?.length) return { preserveActive: false, reason: 'unexpected_dirty_present' };
  if (result.active_validation_overlay_guard?.allowed === false) {
    return { preserveActive: false, reason: 'validation_overlay_not_exact' };
  }
  if (dirtyGuardHasSchemaFiles(dirtyGuard)) {
    const comparison = compareMigrationFingerprints(
      result.migration_fingerprint,
      result.warm_baseline_migration_fingerprint,
    );
    if (!comparison.matches) {
      return {
        preserveActive: false,
        reason: 'schema_dirty_' + comparison.reason,
        migration_fingerprint_comparison: comparison,
      };
    }
    return {
      preserveActive: true,
      reason: 'known_fixture_failure_schema_dirty_matches_warm_baseline',
      migration_fingerprint_comparison: comparison,
    };
  }
  return {
    preserveActive: true,
    reason: 'known_fixture_failure_owner_bound_warm_stack_safe',
  };
}

function assessTerminalWarmReconciliation({
  lease = null,
  identityMatched = false,
  overlayGuard = {},
  processState = {},
  currentFingerprint = null,
  baselineFingerprint = null,
  runtimeHealthy = false,
} = {}) {
  const state = String(lease?.validation_stack_state || lease?.details?.state || '').trim();
  if (!identityMatched || !lease) return { eligible: false, reason: 'lease_identity_mismatch' };
  if (state !== 'terminal_stop_required') return { eligible: false, reason: 'lease_not_terminal_stop_required' };
  if (lease.expired === true || lease.stale === true) return { eligible: false, reason: 'lease_stale_or_expired' };
  if (!overlayGuard?.allowed) return { eligible: false, reason: 'validation_overlay_not_exact' };
  if (!runtimeHealthy) return { eligible: false, reason: 'validation_runtime_unhealthy' };
  if (processState?.scan_ok !== true) return { eligible: false, reason: 'validation_process_guard_unavailable' };
  if (Number(processState.runner_count || 0) !== 0) return { eligible: false, reason: 'competing_validation_runner_present' };
  if (Number(processState.unbound_heartbeat_count || 0) !== 0) return { eligible: false, reason: 'unbound_validation_heartbeat_present' };
  if (Number(processState.exact_heartbeat_count || 0) !== 0) return { eligible: false, reason: 'terminal_lease_heartbeat_not_zero' };
  const fingerprintComparison = compareMigrationFingerprints(currentFingerprint, baselineFingerprint);
  if (!fingerprintComparison.matches) {
    return {
      eligible: false,
      reason: fingerprintComparison.reason,
      migration_fingerprint_comparison: fingerprintComparison,
    };
  }
  return {
    eligible: true,
    reason: 'exact_terminal_warm_zero_heartbeat_reconciliation_allowed',
    replace_heartbeat: true,
    migration_fingerprint_comparison: fingerprintComparison,
  };
}

function installTerminationHandlers(control) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = [];
  for (const signal of signals) {
    const handler = () => {
      control.terminationRequested = true;
      control.signal = signal;
      if (control.result && control.resultPath) {
        control.result.interrupted = signal;
        control.result.validation_stack_state = 'terminal_stop_required';
        control.result.local_admission_state = 'interrupted_terminalizing';
        try {
          writeJson(control.resultPath, control.result);
        } catch (_) {
          // Final cleanup will attempt to write the terminal artifact again.
        }
      }
      if (control.heartbeatLoop) stopHeartbeatLoop(control.heartbeatLoop);
      if (control.activeCommandRef?.child) {
        terminateProcessTree(control.activeCommandRef.child, { platform: process.platform });
      }
    };
    process.once(signal, handler);
    handlers.push([signal, handler]);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

function assertNotTerminated(control) {
  if (control?.terminationRequested) {
    const error = new Error(`validation session interrupted by ${control.signal || 'signal'}`);
    error.interrupted = true;
    throw error;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function assertRequired(options, files, ports) {
  const missing = [];
  if (!files.length) missing.push('files');
  if (!options.prNumber) missing.push('pr-number');
  if (!options.ownerThreadId) missing.push('owner-thread-id');
  if (!options.worktreeId) missing.push('worktree-id');
  if (!options.projectId) missing.push('project-id');
  if (!Object.keys(ports).length) missing.push('ports');
  if (missing.length) die(`Missing required fields: ${missing.join(', ')}`);
}

function buildFocusedNativeSessionIdentity(context = {}) {
  const options = context.options || {};
  return focusedNative.buildFocusedNativeIdentity({
    cwd: context.cwd,
    targetKind: 'pr',
    targetId: String(options.prNumber),
    prNumber: options.prNumber,
    repoPath: context.cwd,
    repoId: path.basename(context.cwd),
    ownerThreadId: options.ownerThreadId,
    worktreeId: options.worktreeId,
    branch: context.branch,
    headSha: context.headSha,
    projectId: options.projectId,
    validationResource: VALIDATION_RESOURCE,
    validationOwner: VALIDATION_OWNER,
    leaseId: context.leaseId,
    ports: context.ports,
    policy: context.policy,
    migrationFingerprint: context.migrationFingerprint,
    warmBaselineFingerprint: context.warmBaselineFingerprint,
  });
}

async function captureFocusedNativeGuard(context = {}) {
  const leaseStatus = await runSessionCommand(
    context.result,
    context.resultPath,
    `focused parallel-wave guard ${context.file}`,
    process.execPath,
    [runtimeLeasesScript(), 'status', '--json'],
    {
      cwd: context.cwd,
      logPath: context.logPath,
      timeoutMs: 30000,
      activeCommandRef: context.activeCommandRef,
    },
  );
  const payload = parseJsonFromText(`${leaseStatus.stdout}\n${leaseStatus.stderr}`);
  const activeLease = findMatchingValidationLease(
    payload,
    context.options,
    context.branch,
    context.headSha,
    new Set(['active']),
  );
  const binding = {
    leaseId: context.leaseId,
    ownerThreadId: context.options.ownerThreadId,
    worktreeId: context.options.worktreeId,
    worktreePath: context.cwd,
    branch: context.branch,
    headSha: context.headSha,
    prNumber: context.options.prNumber,
    projectId: context.options.projectId,
    ports: context.ports,
  };
  const processes = inspectRecordedValidationProcesses(context.outDir, binding);
  const dirty = buildDirtyGuard(gitValue(['status', '--porcelain'], context.cwd, { trim: false }), {
    ...context.options,
    activeValidationOverlayDirty: ['supabase/config.toml'],
  });
  const migration = computeDirectoryFingerprint(context.cwd, path.join('supabase', 'migrations'));
  const overlay = assessWorkspaceValidationOverlay(context.cwd, context.options, activeLease);
  const currentAdmission = focusedNative.resolveFocusedNativeAdmission({
    ...context.options,
    cwd: context.cwd,
  });
  const freshIdentity = buildFocusedNativeSessionIdentity({
    cwd: context.cwd,
    options: context.options,
    branch: context.branch,
    headSha: context.headSha,
    leaseId: context.leaseId,
    ports: context.ports,
    policy: currentAdmission.policy,
    migrationFingerprint: migration,
    warmBaselineFingerprint: context.identity.warmBaselineFingerprint,
  });
  const testPath = path.resolve(context.cwd, context.file.replace(/\//gu, path.sep));
  const testFileDigest = crypto.createHash('sha256').update(fs.readFileSync(testPath)).digest('hex');
  const migrationStable = migration.digest === context.identity.migrationFingerprint.digest
    && migration.file_count === context.identity.migrationFingerprint.file_count;
  const policyStable = freshIdentity.policyFileFingerprint === context.identity.policyFileFingerprint
    && freshIdentity.focusedPolicyFingerprint === context.identity.focusedPolicyFingerprint;
  const runnerStable = freshIdentity.runnerFingerprint === context.identity.runnerFingerprint;
  const harnessStable = freshIdentity.pgtapHarnessFingerprint === context.identity.pgtapHarnessFingerprint;
  const fixtureStable = freshIdentity.fixtureBootstrapFingerprint === context.identity.fixtureBootstrapFingerprint;
  const leaseGuardGreen = leaseStatus.exit === 0 && String(activeLease?.id || '') === context.leaseId;
  const processGuardGreen = processes.scan_ok === true
    && Number(processes.runner_count || 0) === 0
    && Number(processes.ambiguous_process_count || 0) === 0
    && Number(processes.unbound_heartbeat_count || 0) === 0;
  const heartbeatGuardGreen = Number(processes.exact_heartbeat_count || 0) === 1;
  const values = {
    timestamp: new Date().toISOString(),
    hostGreen: leaseGuardGreen && context.result.validation_stack_state === 'active',
    dirtyGuardGreen: dirty.unexpected_dirty.length === 0,
    migrationFingerprintDigest: migration.digest,
    migrationFingerprintStable: migrationStable,
    policyFileFingerprint: freshIdentity.policyFileFingerprint,
    focusedPolicyFingerprint: freshIdentity.focusedPolicyFingerprint,
    runnerFingerprint: freshIdentity.runnerFingerprint,
    pgtapHarnessFingerprint: freshIdentity.pgtapHarnessFingerprint,
    policyFingerprintStable: policyStable,
    runnerFingerprintStable: runnerStable,
    harnessFingerprintStable: harnessStable,
    fixtureBootstrapFingerprint: freshIdentity.fixtureBootstrapFingerprint,
    fixtureBootstrapFingerprintStable: fixtureStable,
    testFileDigest,
    testFileDigestStable: testFileDigest === context.digest,
    leaseId: context.leaseId,
    warmBaselineFingerprint: context.identity.warmBaselineFingerprint,
    validationStackGeneration: context.identity.validationStackGeneration,
    writerLockFingerprint: context.writerLockFingerprint,
    leaseGuardGreen,
    processGuardGreen,
    heartbeatGuardGreen,
    overlayGuardGreen: overlay.allowed === true,
    heartbeatCount: Number(processes.exact_heartbeat_count || 0),
    runnerCount: Number(processes.runner_count || 0),
  };
  values.allGreen = Object.entries(values)
    .filter(([key]) => key.endsWith('Green') || key.endsWith('Stable'))
    .every(([, value]) => value === true)
    && values.heartbeatCount === 1
    && values.runnerCount === 0;
  context.result.focused_parallel_wave_last_guard = values;
  context.result.validation_process_guard = processes;
  context.result.dirty_guard = dirty;
  context.result.migration_fingerprint = migration;
  return values;
}

function applyFocusedNativeOutcome(result, outcome) {
  const artifactStatus = String(outcome.artifact?.status || '');
  result.focused_terminal_state = artifactStatus;
  if (outcome.exitCode === 0) {
    result.failed_file = '';
    result.failed_test = '';
    result.failed_files = [];
    result.failure_class = '';
    result.failure_text = '';
    result.current_test = outcome.artifact.nextSortedFile || '';
    result.next_test = outcome.artifact.nextSortedFile || '';
    result.next_sorted_focused_file = outcome.artifact.nextSortedFile || '';
    result.local_admission_state = new Set(['focused_subset_terminal_passed', 'final_serial_passed']).has(artifactStatus)
      ? artifactStatus
      : 'focused_terminal_passed';
    result.exact_cos_decision_needed = 'none_for_successful_focused_terminal';
    result.next_action = outcome.artifact.status === 'focused_subset_terminal_passed'
      ? 'continue_from_preserved_next_sorted_focused_file_without_final_gates'
      : 'final_serial_gates_passed';
    return result;
  }
  const hardStop = outcome.schedulerArtifact?.hardStop || outcome.artifact.hardStop;
  const failedRecord = outcome.artifact.perFile.find((entry) => entry.status === 'hard_stop')
    || outcome.artifact.perFile.find((entry) => outcome.failedFiles.includes(entry.path));
  if (hardStop?.failureClass === 'focused_contamination_baseline_deadline_exceeded') {
    const current = hardStop.file || outcome.artifact.nextSortedFile || '';
    result.failed_file = '';
    result.failed_test = '';
    result.failed_files = [];
    result.failure_class = hardStop.failureClass;
    result.failure_text = '';
    result.current_test = current;
    result.next_test = current;
    result.next_sorted_focused_file = current;
    result.local_admission_state = 'failed_before_pgtap';
    result.exact_cos_decision_needed = 'repair_focused_contamination_baseline_before_retry';
    result.next_action = 'hold_before_contamination_baseline_or_pgtap_and_return_to_pr_chief';
    return result;
  }
  result.failed_file = hardStop?.file || failedRecord?.path || outcome.artifact.nextSortedFile || '';
  result.failure_class = hardStop?.failureClass
    || failedRecord?.finalSerializedResult?.failureClass
    || 'focused_parallel_wave_has_unresolved_failures';
  result.failure_text = failedRecord?.finalSerializedResult?.excerpt
    || failedRecord?.parallelResult?.excerpt
    || '';
  result.failed_test = result.failed_file;
  result.failed_files = result.failed_file ? [result.failed_file] : [];
  result.current_test = result.failed_file;
  result.next_sorted_focused_file = outcome.artifact.nextSortedFile || result.failed_file;
  result.local_admission_state = 'focused_parallel_terminal_failed';
  result.exact_cos_decision_needed = 'repair_or_classify_focused_parallel_failure_before_retry';
  result.next_action = 'hold_focused_parallel_execution_and_return_to_pr_chief';
  return result;
}

function applyFocusedPreAdmissionFailure(result, error, files = []) {
  const text = String(error?.message || error || '');
  const identityFailure = /focused collection identity/iu.test(text);
  const transitionFailure = error?.failureClass === 'focused_checkpoint_transition_lifecycle_failed'
    || /focused checkpoint transition lifecycle failed/iu.test(text);
  const failureClass = transitionFailure
    ? 'focused_checkpoint_transition_lifecycle_failed'
    : (identityFailure
      ? 'focused_parallel_identity_invalid'
      : (/manifest|queue/iu.test(text)
        ? 'focused_parallel_queue_manifest_invalid'
        : (/guard/iu.test(text) ? 'focused_parallel_guard_red' : 'focused_parallel_capacity_evidence_missing_or_red')));
  const current = String(files[0] || '');
  result.failure_class = failureClass;
  result.failure_text = text;
  result.failed_file = '';
  result.failed_test = '';
  result.failed_files = [];
  result.current_test = current;
  result.next_test = current;
  result.next_sorted_focused_file = current;
  result.local_admission_state = 'failed_before_pgtap';
  result.exact_cos_decision_needed = transitionFailure
    ? 'repair_focused_checkpoint_transition_before_retry'
    : (identityFailure
      ? 'repair_focused_parallel_identity_before_retry'
      : 'repair_focused_parallel_admission_evidence_before_retry');
  result.next_action = transitionFailure
    ? 'hold_before_checkpoint_transition_or_pgtap_and_return_to_pr_chief'
    : (identityFailure
      ? 'hold_before_focused_identity_checkpoint_or_pgtap_and_return_to_pr_chief'
      : 'hold_before_checkpoint_wrapper_or_pgtap_and_return_to_pr_chief');
  return result;
}

function focusedNativeSuccessTerminalState(result = {}) {
  const state = String(result.focused_terminal_state || result.local_admission_state || '');
  return new Set(['focused_subset_terminal_passed', 'final_serial_passed']).has(state) ? state : '';
}

function refreshKeepWarmSuccessResult(result, context = {}) {
  const nativeTerminalState = focusedNativeSuccessTerminalState(result);
  return refreshMeasurableFields(result, {
    ...context,
    currentTest: nativeTerminalState ? result.current_test : context.currentTest,
    nextSortedTest: nativeTerminalState ? result.next_sorted_focused_file : context.nextSortedTest,
    localAdmissionState: nativeTerminalState || 'focused_files_passed',
    exactCosDecisionNeeded: nativeTerminalState ? result.exact_cos_decision_needed : undefined,
    nextAction: nativeTerminalState
      ? result.next_action
      : 'continue_next_focused_test_when_guards_green',
  });
}

function hasExactSerialPilotSessionEvidence(result = {}) {
  const focusedFiles = Array.isArray(result.focused_files) ? result.focused_files : [];
  const passedFiles = Array.isArray(result.passed_files) ? result.passed_files : [];
  const failedFiles = Array.isArray(result.failed_files) ? result.failed_files : [];
  const wave = result.focused_parallel_wave || {};
  const perFile = Array.isArray(wave.perFile) ? wave.perFile : [];
  const record = perFile[0];
  const finalResult = record?.finalSerializedResult;
  const counts = wave.counts || {};
  const selected = focusedFiles[0];
  return result.focused_terminal_state === 'focused_subset_terminal_passed'
    && focusedFiles.length === 1
    && typeof selected === 'string' && selected.length > 0
    && passedFiles.length === 1 && passedFiles[0] === selected
    && failedFiles.length === 0
    && String(result.failed_file || '') === ''
    && String(result.failed_test || '') === ''
    && wave.serialPilotAccepted === true
    && wave.queueScope === 'pilot_subset'
    && perFile.length === 1
    && record?.path === selected
    && record.status === 'serial_passed'
    && finalResult?.disposition === 'passed'
    && finalResult.failureClass === ''
    && Array.isArray(finalResult.hardStops) && finalResult.hardStops.length === 0
    && counts.selected === 1
    && counts.serialPassed === 1
    && counts.unresolvedFailures === 0
    && counts.completeFailures === 0;
}

function finalizeSessionResult(result, context = {}) {
  const exitCode = Number(context.exitCode || 0);
  const nativeTerminalState = focusedNativeSuccessTerminalState(result);
  const prePgtapFailure = result.local_admission_state === 'failed_before_pgtap';
  result.finished_at = context.finishedAt || new Date().toISOString();
  result.status = exitCode === 0 && !result.failed_file && !result.error ? 'passed' : 'failed';
  result.log_path = context.logPath;
  result.checkpoint_path = context.checkpointPath;
  refreshMeasurableFields(result, {
    cwd: context.cwd,
    options: context.options,
    plan: result.session_plan,
    leaseId: context.leaseId,
    migrationFingerprint: context.migrationFingerprint,
    branchManifestState: context.branchManifestState,
    currentTest: nativeTerminalState || prePgtapFailure ? result.current_test : undefined,
    nextSortedTest: nativeTerminalState || prePgtapFailure ? result.next_sorted_focused_file : undefined,
    failureClass: result.local_start_failure_class || result.failure_class,
    localAdmissionState: result.status === 'passed'
      ? (nativeTerminalState || 'focused_terminal_passed')
      : (prePgtapFailure || result.failure_class === 'validation_active_transition_guard_failed'
        ? 'failed_before_pgtap'
        : 'focused_terminal_failed'),
    exactCosDecisionNeeded: result.status === 'passed'
      ? (nativeTerminalState ? result.exact_cos_decision_needed : 'none_for_low_risk_local_loop')
      : result.exact_cos_decision_needed,
    nextAction: result.status === 'passed'
      ? (nativeTerminalState ? result.next_action : 'continue_next_focused_test_when_guards_green')
      : result.next_action,
    coldStartReason: result.cold_start_reason,
  });
  if (prePgtapFailure) {
    result.failed_file = '';
    result.failed_test = '';
    result.failed_files = [];
  }
  const processGuard = result.validation_process_guard || {};
  const finalGuard = result.focused_parallel_wave_last_guard || {};
  const activeLifecycleSafe = result.validation_stack_state === 'active'
    && processGuard.exact_heartbeat_count === 1;
  const releasedLifecycleSafe = result.validation_stack_state === 'released'
    && result.steps?.some((step) => step.label === 'local:stop' && step.exit === 0)
    && result.steps?.some((step) => step.label === 'validation lease release' && step.exit === 0);
  result.serial_pilot_accepted = Boolean(result.status === 'passed'
    && hasExactSerialPilotSessionEvidence(result)
    && finalGuard.allGreen === true
    && Number(finalGuard.runnerCount) === 0
    && processGuard.scan_ok === true
    && Number(processGuard.runner_count) === 0
    && Number(processGuard.unbound_heartbeat_count) === 0
    && Number(processGuard.ambiguous_process_count) === 0
    && (activeLifecycleSafe || releasedLifecycleSafe));
  return result;
}

function buildFocusedNativeCapacityEvidence(options = {}) {
  const hostParallelism = Number(options.hostParallelism);
  const databaseCap = Number(options.databaseCapacity?.databaseConnectionCap);
  const rawCpuAverage = options.hostMetrics?.cpu_pressure?.average_percent;
  const rawMemoryUsed = options.hostMetrics?.memory_pressure?.used_percent;
  const rawMemoryFree = options.hostMetrics?.memory_pressure?.free_memory_mb;
  const cpuAverage = Number(rawCpuAverage);
  const memoryUsed = Number(rawMemoryUsed);
  const memoryFree = Number(rawMemoryFree);
  const processPressure = options.processPressure || {};
  if (
    options.guard?.allGreen !== true
    || options.hostPressure?.ok !== true
    || options.databaseCapacity?.measured !== true
    || !Number.isInteger(hostParallelism)
    || hostParallelism < 1
    || !Number.isInteger(databaseCap)
    || databaseCap < 1
    || rawCpuAverage == null
    || rawMemoryUsed == null
    || rawMemoryFree == null
    || !Number.isFinite(cpuAverage)
    || !Number.isFinite(memoryUsed)
    || !Number.isFinite(memoryFree)
    || processPressure.scan_enabled !== true
    || Number(processPressure.host_pressure_process_count || 0) !== 0
    || Number(processPressure.dependency_mutation_count || 0) !== 0
    || options.databaseCapacity.lockWaitCount !== 0
    || options.databaseCapacity.deadlockDelta !== 0
    || options.databaseCapacity.serializationFailureDelta !== 0
  ) throw new Error('focused_parallel_capacity_evidence_missing_or_red');
  const serializationEvidence = focusedNative.normalizeStructuredSerializationEvidence(options.databaseCapacity.serializationEvidence);
  return {
    hostGreen: true,
    hostPressure: false,
    databaseCapacityKnown: true,
    hostCpuGreen: true,
    hostMemoryGreen: true,
    activeRunnerPressureGreen: true,
    lockWaitCount: 0,
    deadlockCount: 0,
    serializationFailureCount: serializationEvidence.observedCount,
    serializationEvidence,
    immediateHostConnectionCap: Math.min(options.policy.hostConnectionCap, hostParallelism),
    databaseConnectionCap: Math.min(options.policy.databaseConnectionCap, databaseCap),
    hostMetrics: {
      cpuAveragePercent: cpuAverage,
      memoryUsedPercent: memoryUsed,
      freeMemoryMb: memoryFree,
    },
  };
}

function extractFocusedHostAdmissionEvidence(payload = {}) {
  const summary = payload?.summary;
  const hostPressure = payload?.status_snapshot?.host_pressure;
  const processPressure = summary?.process_pressure;
  const parallelCapacity = summary?.parallel_capacity;
  const productTarget = Number(parallelCapacity?.product_full_runtime_target);
  const productReady = Number(parallelCapacity?.full_runtime_ready_count);
  const validationCount = Number(parallelCapacity?.pr_deploy_validation_stack_count);
  const maxValidationCount = Number(parallelCapacity?.max_pr_deploy_validation_stacks);
  const topLevelFailures = payload?.failures;
  const hostFailures = hostPressure?.failures;
  const statusAllowed = new Set(['ok', 'warning']).has(String(payload?.status || ''));
  const valid = payload?.command === 'doctor'
    && statusAllowed
    && Array.isArray(topLevelFailures)
    && topLevelFailures.length === 0
    && hostPressure?.ok === true
    && Array.isArray(hostFailures)
    && hostFailures.length === 0
    && processPressure?.scan_enabled === true
    && String(processPressure?.scan_error || '') === ''
    && processPressure?.dependency_mutation_active === false
    && processPressure?.build_test_pressure_active === false
    && Number(processPressure?.host_pressure_process_count) === 0
    && Number(processPressure?.dependency_mutation_count) === 0
    && parallelCapacity?.host_allows_new_starts === true
    && parallelCapacity?.proof_capacity_available === true
    && Number.isInteger(productTarget)
    && productTarget > 0
    && productReady === productTarget
    && Number(summary?.stale_proof_capacity_leases) === 0
    && Number(summary?.runtime_missing_leases) === 0
    && Number(summary?.startup_pending_leases) === 0
    && Number(summary?.validation_stack_active_leases) === 1
    && Number(summary?.validation_stack_stale_leases) === 0
    && Number(summary?.validation_stack_runtime_missing_leases) === 0
    && Number(summary?.validation_stack_startup_pending_leases) === 0
    && Number(summary?.validation_stack_terminal_stop_required_leases) === 0
    && Number(summary?.validation_stack_residual_cleanup_required_leases) === 0
    && Number.isInteger(validationCount)
    && Number.isInteger(maxValidationCount)
    && maxValidationCount > 0
    && validationCount === 1
    && validationCount <= maxValidationCount;
  if (!valid) throw new Error('focused_parallel_capacity_host_guard_red_or_unknown');
  return {
    hostPressure,
    hostMetrics: hostPressure,
    processPressure,
    admission: {
      doctorStatus: payload.status,
      generatedAt: payload.generated_at,
      productFullRuntimeTarget: productTarget,
      fullRuntimeReadyCount: productReady,
      validationStackCount: validationCount,
      maxValidationStacks: maxValidationCount,
      proofCapacityAvailable: true,
      hostAllowsNewStarts: true,
    },
  };
}

function resolveFocusedNativeHostTimeout(context = {}) {
  return focused.validateFocusedHostTimeoutMs(
    context.focusedNativeAdmission?.policy?.hostTimeoutMs,
  );
}

async function runFocusedNativeIntegration(context = {}) {
  const focusedTimeoutMs = resolveFocusedNativeHostTimeout(context);
  let identity;
  try {
    identity = buildFocusedNativeSessionIdentity({
      cwd: context.cwd,
      options: context.options,
      branch: context.branch,
      headSha: context.headSha,
      leaseId: context.leaseId,
      ports: context.ports,
      policy: context.focusedNativeAdmission.policy,
      migrationFingerprint: context.preTestFingerprint,
      warmBaselineFingerprint: context.warmBaseline.fingerprint.digest,
    });
  } catch (error) {
    applyFocusedPreAdmissionFailure(context.result, error, context.files);
    writeJson(context.resultPath, context.result);
    throw error;
  }
  let canonicalFiles;
  try {
    const queue = focusedNative.resolveFocusedNativeQueue({
      cwd: context.cwd,
      files: context.files,
      policy: context.focusedNativeAdmission.policy,
    });
    canonicalFiles = queue.sortedQueue.map((entry) => entry.path);
    context.result.focused_parallel_canonical_files = canonicalFiles;
  } catch (error) {
    const queueError = new Error(`Focused canonical queue manifest invalid: ${error?.message || String(error)}`);
    applyFocusedPreAdmissionFailure(context.result, queueError, context.files);
    writeJson(context.resultPath, context.result);
    throw queueError;
  }
  const writerLockFingerprint = crypto.createHash('sha256')
    .update(`${context.sessionLock.path}\0${context.sessionLock.pid}\0${context.leaseId}`)
    .digest('hex');
  const captureGuard = ({ file, digest }) => captureFocusedNativeGuard({
    admission: context.focusedNativeAdmission,
    identity,
    writerLockFingerprint,
    result: context.result,
    resultPath: context.resultPath,
    cwd: context.cwd,
    outDir: context.outDir,
    logPath: context.logPath,
    activeCommandRef: context.activeCommandRef,
    options: context.options,
    branch: context.branch,
    headSha: context.headSha,
    ports: context.ports,
    leaseId: context.leaseId,
    file,
    digest,
  });
  let capacityEvidence;
  let preAdmissionGuard;
  let previousDeadlockCount = null;
  let previousSerializationFailureCount = 0;
  let focusedConnection = null;
  const resolveFocusedConnection = () => {
    if (!focusedConnection) {
      focusedConnection = focusedNative.resolvePgProveConnection({
        expectedPort: context.ports.db,
        cwd: context.cwd,
      });
    }
    return focusedConnection;
  };
  const sampleCapacity = async ({ phase, files, serializationEvidence }) => {
    const file = files[0];
    const digest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.resolve(context.cwd, file.replace(/\//gu, path.sep))))
      .digest('hex');
    let guard;
    try {
      guard = await captureGuard({ file, digest });
    } catch (error) {
      throw new Error(`Focused lifecycle guard evaluation failed: ${error?.message || String(error)}`);
    }
    const hostStep = await runSessionCommand(
      context.result,
      context.resultPath,
      `focused capacity host sample ${phase}`,
      process.execPath,
      [runtimeLeasesScript(), 'doctor', '--json'],
      { cwd: context.cwd, logPath: context.logPath, timeoutMs: 30000, activeCommandRef: context.activeCommandRef },
    );
    const hostPayload = parseJsonFromText(`${hostStep.stdout}\n${hostStep.stderr}`) || {};
    if (hostStep.exit !== 0) throw new Error('focused_parallel_capacity_host_guard_red_or_unknown');
    const hostAdmission = extractFocusedHostAdmissionEvidence(hostPayload);
    const connection = resolveFocusedConnection();
    const databaseCapacity = await focusedNative.captureFocusedDatabaseCapacityEvidence({
      connectionString: connection.connectionString,
      policy: context.focusedNativeAdmission.policy,
      previousDeadlockCount,
      previousSerializationFailureCount,
      serializationEvidence: focusedNative.normalizeStructuredSerializationEvidence(serializationEvidence),
    });
    previousDeadlockCount = databaseCapacity.deadlockCount;
    previousSerializationFailureCount = databaseCapacity.serializationFailureCount;
    return {
      ...buildFocusedNativeCapacityEvidence({
        guard,
        hostPressure: hostAdmission.hostPressure,
        hostMetrics: hostAdmission.hostMetrics,
        processPressure: hostAdmission.processPressure,
        hostParallelism: os.availableParallelism(),
        databaseCapacity,
        policy: context.focusedNativeAdmission.policy,
      }),
      hostAdmission: hostAdmission.admission,
      sampledAt: new Date().toISOString(),
      databaseCapacity,
      guard,
    };
  };
  try {
    const sample = await sampleCapacity({
      phase: 'pre_admission',
      files: canonicalFiles,
      serializationEvidence: focusedNative.normalizeStructuredSerializationEvidence({
        source: 'pre_admission_no_pg_prove_started',
        observedCount: 0,
        observations: [],
        sampleDigests: [],
      }),
    });
    preAdmissionGuard = sample.guard;
    capacityEvidence = sample;
    context.result.focused_parallel_wave_pre_admission = {
      status: 'green',
      queue_scope: 'derived_from_canonical_manifest',
      requested_jobs: context.focusedNativeAdmission.policy.requestedJobs,
      batch_size: context.focusedNativeAdmission.policy.batchSize,
      immediate_host_connection_cap: capacityEvidence.immediateHostConnectionCap,
      database_connection_cap: capacityEvidence.databaseConnectionCap,
      database_capacity: sample.databaseCapacity,
      host_metrics: capacityEvidence.hostMetrics,
      active_runner_pressure_green: capacityEvidence.activeRunnerPressureGreen,
      lock_wait_count: capacityEvidence.lockWaitCount,
      deadlock_count: capacityEvidence.deadlockCount,
      serialization_failure_count: capacityEvidence.serializationFailureCount,
      serialization_evidence: capacityEvidence.serializationEvidence,
      lifecycle_guard_all_green: true,
    };
    writeJson(context.resultPath, context.result);
  } catch (error) {
    applyFocusedPreAdmissionFailure(context.result, error, canonicalFiles);
    context.result.focused_parallel_wave_pre_admission = {
      status: 'hard_stopped_before_checkpoint_or_pg_prove',
      queue_scope: 'not_derived_due_to_pre_admission_failure',
      requested_jobs: context.focusedNativeAdmission.policy.requestedJobs,
      batch_size: context.focusedNativeAdmission.policy.batchSize,
      failure_class: context.result.failure_class,
      reason: error?.message || String(error),
    };
    writeJson(context.resultPath, context.result);
    throw error;
  }
  try {
    return await focusedNative.executeFocusedNativeSession({
    admission: context.focusedNativeAdmission,
    repairFocusedFailures: context.options.repairFocusedFailures,
    cwd: context.cwd,
    files: canonicalFiles,
    ports: context.ports,
    specIssue: context.options.specIssue,
    outDir: context.outDir,
    identity,
    writerLockFingerprint,
    capacityEvidence,
    preAdmissionGuard,
    focusedTimeoutMs,
    connection: resolveFocusedConnection(),
    sampleCapacity,
    runStep: (step) => runSessionCommand(
      context.result,
      context.resultPath,
      step.label,
      step.command,
      step.args,
      {
        cwd: context.cwd,
        logPath: context.logPath,
        env: step.env,
        timeoutMs: step.timeoutMs,
        activeCommandRef: context.activeCommandRef,
      },
    ),
    captureGuard,
    checkpointTransitionLifecycleEvidence: {
      ...(context.checkpointTransitionLifecycleEvidence || {}),
      currentGuard: preAdmissionGuard,
    },
    });
  } catch (error) {
    applyFocusedPreAdmissionFailure(context.result, error, canonicalFiles);
    writeJson(context.resultPath, context.result);
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const cwd = path.resolve(options.worktreePath || process.cwd());
  const files = parseFocusedFiles(options.files);
  const ports = parsePorts(options.ports);
  assertRequired(options, files, ports);
  let focusedNativeAdmission;
  try {
    focusedNativeAdmission = focusedNative.resolveFocusedNativeAdmission({ ...options, cwd });
  } catch (error) {
    die(error?.message || String(error));
  }
  if (focusedNativeAdmission.requested && !focusedNativeAdmission.enabled) {
    die(focusedNativeAdmission.blockReason || 'focused parallel-wave admission is disabled');
  }
  const activeCommandRef = { child: null };
  const control = {
    terminationRequested: false,
    signal: '',
    activeCommandRef,
    heartbeatLoop: null,
    result: null,
    resultPath: '',
  };
  const removeTerminationHandlers = installTerminationHandlers(control);

  const branch = gitValue(['branch', '--show-current'], cwd);
  const headSha = gitValue(['rev-parse', 'HEAD'], cwd).toLowerCase();
  if (!branch || !headSha) die('Unable to resolve git branch/head for validation session.');

  let reusableLease = null;
  let blockingStartingLease = null;
  let leaseStatus = null;
  let activeValidationOverlayGuard = { allowed: false, reason: 'reuse_active_not_requested' };
  leaseStatus = await runCommand(
    'validation lease status for reuse',
    process.execPath,
    [runtimeLeasesScript(), 'status', '--json'],
    { cwd, timeoutMs: 30000, activeCommandRef },
  );
  const leaseStatusPayload = parseJsonFromText(`${leaseStatus.stdout}\n${leaseStatus.stderr}`);
  if (options.reuseActive) {
    reusableLease = findReusableValidationLease(leaseStatusPayload, options, branch, headSha);
    activeValidationOverlayGuard = assessWorkspaceValidationOverlay(cwd, options, reusableLease);
  }
  blockingStartingLease = findBlockingStartingValidationLease(leaseStatusPayload, options, branch, headSha);

  const dirty = gitValue(['status', '--porcelain'], cwd, { trim: false });
  const dirtyGuard = buildDirtyGuard(dirty, {
    ...options,
    activeValidationOverlayDirty: activeValidationOverlayGuard.allowed ? ['supabase/config.toml'] : [],
  });
  if (!dirtyGuard.clean && options.requireClean) die('Working tree is dirty and --require-clean was set.');
  if (options.enforceDirtyGuard && dirtyGuard.unexpected_dirty.length) {
    die(`Dirty guard failed; unexpected dirty paths: ${dirtyGuard.unexpected_dirty.join(', ')}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/[-]/g, '').slice(0, 15);
  const sessionId = `${headSha.slice(0, 12)}-${stamp}`;
  const outDir = path.resolve(cwd, options.outDir);
  const resultPath = path.join(outDir, `pr-validation-session-${sessionId}.json`);
  const checkpointPath = path.join(outDir, `checkpoint-${headSha.slice(0, 12)}.json`);
  const logPath = path.join(outDir, `pr-validation-session-${sessionId}.log`);
  const heartbeatStopPathForLease = (id) => heartbeatStopFilePath(outDir, options, headSha, id);
  fs.mkdirSync(outDir, { recursive: true });
  const migrationFingerprint = computeDirectoryFingerprint(cwd, path.join('supabase', 'migrations'));
  const manifestState = branchManifestState(cwd);
  const validationBinding = {
    leaseId: String(reusableLease?.id || '').trim(),
    ownerThreadId: options.ownerThreadId,
    worktreeId: options.worktreeId,
    worktreePath: cwd,
    branch,
    headSha,
    prNumber: options.prNumber,
    projectId: options.projectId,
    ports,
  };
  const sessionLock = acquireValidationSessionLock(outDir, validationBinding);
  const warmBaseline = reusableLease
    ? findLeaseSessionBaselineFingerprint(outDir, validationBinding)
    : {
        fingerprint: migrationFingerprint,
        artifact_path: '',
        reason: 'new_validation_stack_uses_current_migration_fingerprint_baseline',
      };

  const result = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    branch,
    head_sha: headSha,
    pr_number: options.prNumber,
    spec_issue: options.specIssue,
    owner_thread_id: options.ownerThreadId,
    worktree_id: options.worktreeId,
    worktree_path: cwd,
    project_id: options.projectId,
    ports,
    focused_files: files,
    validation_resource: VALIDATION_RESOURCE,
    validation_owner: VALIDATION_OWNER,
    validation_stack_state: 'starting',
    github_quiet_mode: true,
    product_proof: false,
    steps: [],
    passed_files: [],
    failed_file: '',
    residual_disposition: '',
    reused_warm_stack: false,
    dirty_guard: dirtyGuard,
    active_validation_overlay_guard: activeValidationOverlayGuard,
    migration_fingerprint: migrationFingerprint,
    warm_baseline_migration_fingerprint: warmBaseline.fingerprint,
    warm_baseline_artifact_path: warmBaseline.artifact_path,
    warm_baseline_resolution: warmBaseline.reason,
    session_pid: process.pid,
    session_lock: { path: sessionLock.path, pid: sessionLock.pid },
    blocking_starting_lease_id: blockingStartingLease?.id || '',
  };
  control.result = result;
  control.resultPath = resultPath;
  refreshMeasurableFields(result, {
    cwd,
    options,
    migrationFingerprint,
    branchManifestState: manifestState,
    localAdmissionState: 'preflight_complete',
  });
  writeJson(resultPath, result);

  let leaseId = '';
  let heartbeatLoop = null;
  let shouldStop = true;
  let exitCode = 0;
  try {
    result.steps.push(leaseStatus);
    if (options.reuseActive) {
      writeJson(resultPath, result);
      if (reusableLease) {
        leaseId = String(reusableLease.id || '').trim();
        result.marker_lease_id = leaseId;
        result.reused_warm_stack = true;
        const recordedProcesses = inspectRecordedValidationProcesses(outDir, {
          ...validationBinding,
          leaseId,
        });
        result.validation_process_guard = recordedProcesses;
        const cleanupHeartbeatLoop = attachExactHeartbeatLoopForCleanup({
          leaseId,
          processState: recordedProcesses,
          stopFile: heartbeatStopPathForLease(leaseId),
        });
        if (cleanupHeartbeatLoop) {
          heartbeatLoop = cleanupHeartbeatLoop;
          control.heartbeatLoop = heartbeatLoop;
          result.heartbeat_loop = heartbeatLoop;
        }
        const reusableState = String(
          reusableLease.validation_stack_state || reusableLease.details?.state || '',
        ).trim();
        if (reusableState === 'terminal_stop_required') {
          const terminalPreflight = assessTerminalWarmReconciliation({
            lease: reusableLease,
            identityMatched: true,
            overlayGuard: activeValidationOverlayGuard,
            processState: recordedProcesses,
            currentFingerprint: migrationFingerprint,
            baselineFingerprint: warmBaseline.fingerprint,
            runtimeHealthy: true,
          });
          result.terminal_warm_reconciliation = {
            phase: 'pre_health',
            ...terminalPreflight,
          };
          if (!terminalPreflight.eligible) {
            throw new Error(`terminal warm reconciliation preflight failed: ${terminalPreflight.reason}`);
          }
        } else {
          if (
            recordedProcesses.scan_ok !== true ||
            Number(recordedProcesses.runner_count || 0) !== 0 ||
            Number(recordedProcesses.unbound_heartbeat_count || 0) !== 0 ||
            Number(recordedProcesses.exact_heartbeat_count || 0) !== 1
          ) {
            throw new Error('active warm validation lifecycle process guard failed');
          }
          if (!heartbeatLoop) {
            throw new Error('active warm validation lifecycle exact heartbeat could not be attached for cleanup');
          }
        }
        control.heartbeatLoop = heartbeatLoop;
        result.heartbeat_loop = heartbeatLoop;
        refreshMeasurableFields(result, {
          cwd,
          options,
          leaseId,
          migrationFingerprint,
          branchManifestState: manifestState,
          localAdmissionState: 'reusing_active_validation_stack',
        });
      }
    }
    const plan = buildSessionPlan({ reuseActive: options.reuseActive, reusableLease, blockingStartingLease });
    result.session_plan = plan;
    result.cold_start_reason = buildColdStartReason({ plan, options, reusableLease });
    refreshMeasurableFields(result, {
      cwd,
      options,
      plan,
      leaseId,
      migrationFingerprint,
      branchManifestState: manifestState,
      localAdmissionState: 'session_plan_ready',
      coldStartReason: result.cold_start_reason,
    });
    writeJson(resultPath, result);
    if (plan.blocked) {
      result.validation_stack_state = 'blocked_duplicate_starting';
      result.exact_cos_decision_needed = plan.owner_action;
      result.next_action = plan.owner_action;
      throw new Error(`matching starting validation lease blocks duplicate cold start: ${blockingStartingLease?.id || 'unknown'}`);
    }
    assertNotTerminated(control);

    if (plan.acquire_starting) {
      const acquireStarting = await runSessionCommand(
        result,
        resultPath,
        'validation lease acquire starting',
        process.execPath,
        buildLeaseArgs(options, 'starting', files, branch, headSha),
        { cwd, logPath, timeoutMs: 30000, activeCommandRef },
      );
      leaseId = extractLeaseId(acquireStarting);
      result.marker_lease_id = leaseId;
      if (acquireStarting.exit !== 0 || !leaseId) throw new Error('validation lease acquire starting failed');
      heartbeatLoop = startHeartbeatLoop({ cwd, leaseId, stopFile: heartbeatStopPathForLease(leaseId), logPath, sessionFile: resultPath });
      control.heartbeatLoop = heartbeatLoop;
      result.heartbeat_loop = heartbeatLoop;
      refreshMeasurableFields(result, {
        cwd,
        options,
        plan,
        leaseId,
        migrationFingerprint,
        branchManifestState: manifestState,
        localAdmissionState: 'validation_stack_starting',
        coldStartReason: result.cold_start_reason,
      });
      writeJson(resultPath, result);
    }
    assertNotTerminated(control);

    if (plan.local_start) {
      const localStartTimeouts = resolveLocalStartTimeouts(options);
      const localStart = await runSessionCommand(
        result,
        resultPath,
        'local:start',
        process.execPath,
        [workspaceScript('local-start.js')],
        {
          cwd,
          logPath,
          timeoutMs: localStartTimeouts.stepTimeoutMs,
          env: buildLocalStartEnv(options),
          activeCommandRef,
        },
      );
      if (localStart.exit !== 0) {
        const writerMayBeActive = Boolean(localStart.writer_may_be_active);
        result.local_start_failure_class = writerMayBeActive
          ? 'local_start_supervision_termination_unconfirmed'
          : classifyLocalStartFailure(localStart);
        if (writerMayBeActive) {
          shouldStop = false;
          result.validation_stack_state = 'terminal_stop_required';
          result.residual_disposition = 'cleanup_deferred_while_local_start_writer_may_be_active';
        }
        refreshMeasurableFields(result, {
          cwd,
          options,
          plan,
          leaseId,
          migrationFingerprint,
          branchManifestState: manifestState,
          failureClass: result.local_start_failure_class,
          localAdmissionState: writerMayBeActive ? 'local_start_writer_ambiguous' : 'local_start_failed',
          exactCosDecisionNeeded: writerMayBeActive
            ? 'reconcile_live_local_start_writer_before_owner_cleanup'
            : 'local_start_admission_failure',
          nextAction: writerMayBeActive
            ? 'hold_without_concurrent_cleanup_and_report_writer_identity'
            : 'stop_and_report_local_start_failure',
          coldStartReason: result.cold_start_reason,
        });
        writeJson(resultPath, result);
        throw new Error(`local:start failed (${result.local_start_failure_class})`);
      }
    } else if (plan.reused_stack_health_check) {
      const healthCheck = await runReusedStackHealthCheck(result, resultPath, cwd, ports, logPath, { activeCommandRef });
      if (healthCheck.exit !== 0) throw new Error('reused validation stack failed health check');
      const reusableState = String(
        reusableLease?.validation_stack_state || reusableLease?.details?.state || '',
      ).trim();
      if (reusableState === 'terminal_stop_required') {
        const terminalReconciliation = assessTerminalWarmReconciliation({
          lease: reusableLease,
          identityMatched: true,
          overlayGuard: activeValidationOverlayGuard,
          processState: result.validation_process_guard,
          currentFingerprint: migrationFingerprint,
          baselineFingerprint: warmBaseline.fingerprint,
          runtimeHealthy: true,
        });
        result.terminal_warm_reconciliation = {
          phase: 'health_confirmed',
          ...terminalReconciliation,
        };
        writeJson(resultPath, result);
        if (!terminalReconciliation.eligible) {
          throw new Error(`terminal warm reconciliation failed: ${terminalReconciliation.reason}`);
        }
      }
    }
    assertNotTerminated(control);

    const acquireActive = await runSessionCommand(
      result,
      resultPath,
      'validation lease acquire active',
      process.execPath,
      buildLeaseArgs(options, 'active', files, branch, headSha),
      { cwd, logPath, timeoutMs: 30000, activeCommandRef },
    );
    if (acquireActive.exit !== 0) throw new Error('validation lease acquire active failed');
    const acquireActivePayload = parseJsonFromText(`${acquireActive.stdout}\n${acquireActive.stderr}`) || {};
    result.validation_active_host_pressure = acquireActivePayload.host_pressure || null;
    if (acquireActivePayload.host_pressure?.ok === false) {
      throw new Error('validation lease active transition host pressure guard failed');
    }
    const activeLeaseId = extractLeaseId(acquireActive);
    if (!activeLeaseId) throw new Error('validation lease active transition returned no lease id');
    const previousHeartbeatPid = Number(heartbeatLoop?.pid || 0);
    const synced = syncHeartbeatLoopForLease({
      cwd,
      currentLeaseId: leaseId,
      nextLeaseId: activeLeaseId,
      heartbeatLoop,
      stopFileForLease: heartbeatStopPathForLease,
      logPath,
      sessionFile: resultPath,
    });
    leaseId = synced.leaseId;
    heartbeatLoop = synced.heartbeatLoop;
    control.heartbeatLoop = heartbeatLoop;
    result.marker_lease_id = leaseId;
    result.heartbeat_loop = heartbeatLoop;
    result.heartbeat_sync = synced;
    result.validation_stack_state = 'active';
    refreshMeasurableFields(result, {
      cwd,
      options,
      plan,
      leaseId,
      migrationFingerprint,
      branchManifestState: manifestState,
      localAdmissionState: 'validation_stack_active',
      coldStartReason: result.cold_start_reason,
    });
    writeJson(resultPath, result);
    if (
      synced.restarted &&
      previousHeartbeatPid > 0 &&
      previousHeartbeatPid !== Number(heartbeatLoop?.pid || 0) &&
      !(await waitForProcessExit(previousHeartbeatPid))
    ) {
      throw new Error('prior validation heartbeat did not exit after exact lease rebind');
    }
    if (!heartbeatLoop?.pid || !isProcessAlive(heartbeatLoop.pid)) {
      throw new Error('validation active transition did not produce a live exact heartbeat');
    }
    const postTransitionProcesses = inspectRecordedValidationProcesses(outDir, {
      ...validationBinding,
      leaseId,
    });
    result.validation_process_guard_after_active = postTransitionProcesses;
    if (
      postTransitionProcesses.scan_ok !== true ||
      Number(postTransitionProcesses.runner_count || 0) !== 0 ||
      Number(postTransitionProcesses.unbound_heartbeat_count || 0) !== 0 ||
      Number(postTransitionProcesses.exact_heartbeat_count || 0) !== 1
    ) {
      throw new Error('validation active transition heartbeat or runner guard failed');
    }
    const activeStatus = await runSessionCommand(
      result,
      resultPath,
      'validation lease status after active transition',
      process.execPath,
      [runtimeLeasesScript(), 'status', '--json'],
      { cwd, logPath, timeoutMs: 30000, activeCommandRef },
    );
    if (activeStatus.exit !== 0) throw new Error('validation lease active transition status readback failed');
    const activeStatusPayload = parseJsonFromText(`${activeStatus.stdout}\n${activeStatus.stderr}`);
    const activeLeaseReadback = findMatchingValidationLease(
      activeStatusPayload,
      options,
      branch,
      headSha,
      new Set(['active']),
    );
    if (!activeLeaseReadback || String(activeLeaseReadback.id || '') !== leaseId) {
      throw new Error('validation lease active transition did not materialize an exact active marker');
    }
    const activeOverlayReadback = assessWorkspaceValidationOverlay(cwd, options, activeLeaseReadback);
    if (!activeOverlayReadback.allowed) {
      throw new Error(`validation lease active transition overlay guard failed: ${activeOverlayReadback.reason}`);
    }
    const preTestDirtyGuard = buildDirtyGuard(
      gitValue(['status', '--porcelain'], cwd, { trim: false }),
      {
        ...options,
        activeValidationOverlayDirty: ['supabase/config.toml'],
      },
    );
    const preTestFingerprint = computeDirectoryFingerprint(cwd, path.join('supabase', 'migrations'));
    const preTestFingerprintComparison = compareMigrationFingerprints(
      preTestFingerprint,
      warmBaseline.fingerprint,
    );
    result.dirty_guard = preTestDirtyGuard;
    result.migration_fingerprint = preTestFingerprint;
    result.active_validation_overlay_guard = activeOverlayReadback;
    result.pre_pgtap_migration_fingerprint_comparison = preTestFingerprintComparison;
    if (preTestDirtyGuard.unexpected_dirty.length) {
      throw new Error(`pre-pgTAP dirty guard failed: ${preTestDirtyGuard.unexpected_dirty.join(', ')}`);
    }
    if (!preTestFingerprintComparison.matches) {
      throw new Error(`pre-pgTAP migration fingerprint guard failed: ${preTestFingerprintComparison.reason}`);
    }
    result.active_transition_readback = {
      lease_id: leaseId,
      state: 'active',
      stale: activeLeaseReadback.stale === true,
      expired: activeLeaseReadback.expired === true,
      heartbeat_count: postTransitionProcesses.exact_heartbeat_count,
      runner_count: postTransitionProcesses.runner_count,
    };
    if (result.terminal_warm_reconciliation?.eligible) {
      result.terminal_warm_reconciliation = {
        ...result.terminal_warm_reconciliation,
        phase: 'active_with_replacement_heartbeat_confirmed',
        replacement_heartbeat_pid: heartbeatLoop.pid,
        active_lease_id: leaseId,
      };
    }
    writeJson(resultPath, result);
    assertNotTerminated(control);

    if (focusedNativeAdmission.enabled) {
      const nativeOutcome = await runFocusedNativeIntegration({
        focusedNativeAdmission,
        options,
        cwd,
        files,
        ports,
        branch,
        headSha,
        leaseId,
        preTestFingerprint,
        warmBaseline,
        sessionLock,
        result,
        resultPath,
        outDir,
        logPath,
        activeCommandRef,
        checkpointTransitionLifecycleEvidence: buildFocusedCheckpointTransitionLifecycleEvidence({
          statusPayload: activeStatusPayload,
          ports,
          processGuard: postTransitionProcesses,
          overlayAllowed: activeOverlayReadback.allowed,
          migrationMatches: preTestFingerprintComparison.matches,
        }),
      });
      result.focused_parallel_wave = nativeOutcome.artifact;
      result.focused_repair_scheduler = nativeOutcome.schedulerArtifact;
      result.focused_parallel_wave_checkpoint_path = nativeOutcome.checkpointPath;
      result.passed_files = nativeOutcome.passedFiles;
      result.failed_files = nativeOutcome.failedFiles;
      exitCode = nativeOutcome.exitCode;
      applyFocusedNativeOutcome(result, nativeOutcome, options);
      if (nativeOutcome.exitCode !== 0 && options.keepWarmOnFailure && !nativeOutcome.artifact.hardStop) {
        shouldStop = false;
        result.validation_stack_state = 'active';
        result.residual_disposition = 'kept_warm_after_collected_fixture_failures';
      }
    } else {
    for (const file of files) {
      refreshMeasurableFields(result, {
        cwd,
        options,
        plan,
        leaseId,
        migrationFingerprint,
        branchManifestState: manifestState,
        currentTest: file,
        localAdmissionState: 'focused_test_running',
        coldStartReason: result.cold_start_reason,
      });
      writeJson(resultPath, result);
      const focused = await runSessionCommand(
        result,
        resultPath,
        `test:pgtap ${file}`,
        process.execPath,
        [pgtapScript()],
        { cwd, logPath, env: { PGTAP_ONLY_FILES: file }, activeCommandRef },
      );
      if (focused.exit === 0) {
        result.passed_files.push(file);
        refreshMeasurableFields(result, {
          cwd,
          options,
          plan,
          leaseId,
          migrationFingerprint,
          branchManifestState: manifestState,
          currentTest: file,
          localAdmissionState: 'focused_test_passed',
          coldStartReason: result.cold_start_reason,
        });
        writeJson(checkpointPath, {
          branch,
          head_sha: headSha,
          pr_number: options.prNumber,
          updated_at: new Date().toISOString(),
          passed_files: result.passed_files,
          failed_file: '',
          validation_resource: VALIDATION_RESOURCE,
          last_passed_test: file,
          next_sorted_focused_file: result.next_sorted_focused_file,
        });
        continue;
      }
      result.failed_file = file;
      exitCode = focused.exit || 1;
      result.failure_text = extractFailureText(focused);
      const focusedFailure = classifyFocusedPgtapFailure(result.failure_text);
      if (options.keepWarmOnFailure) {
        result.active_validation_overlay_guard = assessWorkspaceValidationOverlay(cwd, options, {
          ...activeLeaseReadback,
          id: leaseId,
        });
        result.dirty_guard = buildDirtyGuard(
          gitValue(['status', '--porcelain'], cwd, { trim: false }),
          {
            ...options,
            activeValidationOverlayDirty: ['supabase/config.toml'],
          },
        );
        result.migration_fingerprint = computeDirectoryFingerprint(cwd, path.join('supabase', 'migrations'));
        const warmDecision = classifyWarmFailurePreservation({
          focusedFailure,
          options,
          result,
          leaseId,
          heartbeatLoop,
        });
        result.keep_warm_failure_decision = warmDecision;
        shouldStop = false;
        if (warmDecision.preserveActive) {
          result.validation_stack_state = 'active';
          result.residual_disposition = 'kept_warm_after_known_fixture_failure';
          const reconcileActive = await runSessionCommand(
            result,
            resultPath,
            'validation lease reconcile active after known fixture failure',
            process.execPath,
            buildLeaseArgs(options, 'active', files, branch, headSha),
            { cwd, logPath, timeoutMs: 30000, activeCommandRef },
          );
          const reconciledLeaseId = extractLeaseId(reconcileActive);
          if (reconciledLeaseId) {
            const synced = syncHeartbeatLoopForLease({
              cwd,
              currentLeaseId: leaseId,
              nextLeaseId: reconciledLeaseId,
              heartbeatLoop,
              stopFileForLease: heartbeatStopPathForLease,
              logPath,
              sessionFile: resultPath,
            });
            leaseId = synced.leaseId;
            heartbeatLoop = synced.heartbeatLoop;
            control.heartbeatLoop = heartbeatLoop;
            result.marker_lease_id = leaseId;
            result.heartbeat_loop = heartbeatLoop;
            result.heartbeat_sync = synced;
          }
        } else {
          result.validation_stack_state = 'terminal_stop_required';
          const terminalStop = await runSessionCommand(
            result,
            resultPath,
            'validation lease mark terminal_stop_required',
            process.execPath,
            buildLeaseArgs(options, 'terminal_stop_required', files, branch, headSha),
            { cwd, logPath, timeoutMs: 30000, activeCommandRef },
          );
          const terminalLeaseId = extractLeaseId(terminalStop);
          if (terminalLeaseId) {
            const synced = syncHeartbeatLoopForLease({
              cwd,
              currentLeaseId: leaseId,
              nextLeaseId: terminalLeaseId,
              heartbeatLoop,
              stopFileForLease: heartbeatStopPathForLease,
              logPath,
              sessionFile: resultPath,
            });
            leaseId = synced.leaseId;
            heartbeatLoop = synced.heartbeatLoop;
            control.heartbeatLoop = heartbeatLoop;
            result.marker_lease_id = leaseId;
            result.heartbeat_loop = heartbeatLoop;
            result.heartbeat_sync = synced;
          }
        }
      }
      refreshMeasurableFields(result, {
        cwd,
        options,
        plan,
        leaseId,
        migrationFingerprint,
        branchManifestState: manifestState,
        currentTest: file,
        failureClass: focusedFailure.failureClass,
        failureText: result.failure_text,
        localAdmissionState: focusedFailure.localAdmissionState,
        exactCosDecisionNeeded: focusedFailure.exactCosDecisionNeeded,
        nextAction: focusedFailure.nextAction,
        coldStartReason: result.cold_start_reason,
      });
      break;
    }
    }

    if (!result.failed_file && options.keepWarm) {
      shouldStop = false;
      result.validation_stack_state = 'active';
      result.residual_disposition = 'kept_warm_by_owner_request';
      refreshKeepWarmSuccessResult(result, {
        cwd,
        options,
        plan,
        leaseId,
        migrationFingerprint,
        branchManifestState: manifestState,
        coldStartReason: result.cold_start_reason,
      });
    }
  } catch (error) {
    result.error = error?.message || String(error);
    const activeTransitionFailure = classifyValidationActiveTransitionFailure(result.error, {
      processState: result.validation_process_guard_after_active || result.validation_process_guard,
      focusedTest: result.focused_files?.[0] || '',
      steps: result.steps,
    });
    if (activeTransitionFailure) {
      result.failure_class = activeTransitionFailure.failureClass;
      result.exact_cos_decision_needed = activeTransitionFailure.exactCosDecisionNeeded;
      result.next_action = activeTransitionFailure.nextAction;
      result.local_admission_state = activeTransitionFailure.localAdmissionState;
    }
    if (error?.interrupted) {
      result.interrupted = control.signal || true;
      result.validation_stack_state = 'terminal_stop_required';
      result.exact_cos_decision_needed = 'validation_session_interrupted_owner_cleanup_requested';
      result.next_action = 'stop_release_validation_stack_before_retry';
    }
    exitCode = exitCode || 1;
  } finally {
    if (shouldStop) {
      const processState = result.validation_process_guard_after_active || result.validation_process_guard || {};
      const recordedHeartbeatCount = Number(processState.exact_heartbeat_count || 0) +
        Number(processState.unbound_heartbeat_count || 0) +
        Number(processState.ambiguous_process_count || 0);
      const heartbeatStop = !heartbeatLoop && recordedHeartbeatCount > 0
        ? {
          requested: false,
          pid: 0,
          exit_confirmed: false,
          reason: 'recorded_heartbeat_identity_not_exact_for_stop',
        }
        : await stopHeartbeatLoopAndWait(heartbeatLoop);
      result.heartbeat_stop = heartbeatStop;
      if (!heartbeatStop.exit_confirmed) {
        result.validation_stack_state = 'terminal_stop_required';
        result.residual_disposition = 'heartbeat_stop_unconfirmed_owner_attention_required';
        result.failure_class = result.failure_class || 'validation_heartbeat_stop_unconfirmed';
        result.exact_cos_decision_needed = 'approve_exact_heartbeat_residual_recovery';
        result.next_action = 'hold_before_owner_stop_release';
        result.local_admission_state = 'failed_before_pgtap';
        exitCode = exitCode || 1;
      } else {
        const localStop = await runSessionCommand(
          result,
          resultPath,
          'local:stop',
          process.execPath,
          [workspaceScript('local-stop.js')],
          { cwd, logPath, timeoutMs: 120000, activeCommandRef },
        );
        const releaseArgs = [
          runtimeLeasesScript(),
          'release',
          '--owner',
          VALIDATION_OWNER,
          '--lease-id',
          leaseId || 'missing',
          '--json',
        ];
        const release = leaseId
          ? await runSessionCommand(result, resultPath, 'validation lease release', process.execPath, releaseArgs, { cwd, logPath, timeoutMs: 30000, activeCommandRef })
          : { label: 'validation lease release', exit: 1, stdout: '', stderr: 'missing lease id' };
        if (!leaseId) result.steps.push(release);
        result.validation_stack_state = release.exit === 0 ? 'released' : 'residual_cleanup_required';
        result.residual_disposition = release.exit === 0 ? 'heartbeat_stopped_owner_stop_release_confirmed' : 'release_failed_owner_attention_required';
        if (localStop.exit !== 0 || release.exit !== 0) exitCode = exitCode || 1;
      }
    }
    finalizeSessionResult(result, {
      exitCode,
      cwd,
      options,
      leaseId,
      migrationFingerprint,
      branchManifestState: manifestState,
      logPath,
      checkpointPath,
    });
    writeJson(resultPath, result);
    console.log(JSON.stringify({
      status: result.status,
      result_path: resultPath,
      checkpoint_path: checkpointPath,
      validation_stack_state: result.validation_stack_state,
      passed_files: result.passed_files,
      failed_file: result.failed_file,
      local_start: result.local_start,
      reused_warm_stack: result.reused_warm_stack,
      lease_id: result.lease_id,
      failure_class: result.failure_class,
      local_start_failure_class: result.local_start_failure_class || '',
      next_sorted_focused_file: result.next_sorted_focused_file,
      product_proof: false,
    }, null, 2));
    sessionLock.release();
    removeTerminationHandlers();
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  if (process.argv[2] === '--heartbeat-child') heartbeatChildMain(process.argv.slice(3));
  else if (process.argv[2] === '--health-check-child') {
    healthCheckChildMain(process.argv.slice(3)).catch((error) => {
      console.error(error?.message || String(error));
      process.exit(1);
    });
  }
  else main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  buildFocusedNativeCapacityEvidence,
  extractFocusedHostAdmissionEvidence,
  buildFocusedNativeSessionIdentity,
  applyFocusedNativeOutcome,
  applyFocusedPreAdmissionFailure,
  runFocusedNativeIntegration,
  resolveFocusedNativeHostTimeout,
  refreshKeepWarmSuccessResult,
  finalizeSessionResult,
  parseFocusedFiles,
  parsePorts,
  buildValidationCommand,
  buildLeaseArgs,
  runReusedStackHealthCheck,
  findReusableValidationLease,
  buildSessionPlan,
  buildColdStartReason,
  findBlockingStartingValidationLease,
  findMatchingValidationLease,
  classifyWarmFailurePreservation,
  assessTerminalWarmReconciliation,
  compareMigrationFingerprints,
  computeDirectoryFingerprint,
  normalizeMigrationFingerprint,
  findLeaseSessionBaselineFingerprint,
  inspectRecordedValidationProcesses,
  acquireValidationSessionLock,
  resolveLocalStartTimeouts,
  buildLocalStartEnv,
  runCommand,
  runSessionCommand,
  terminateProcessTree,
  isProcessAlive,
  heartbeatExitReason,
  startHeartbeatLoop,
  stopHeartbeatLoopAndWait,
  attachExactHeartbeatLoopForCleanup,
  sanitizeText,
  parseGitStatusPorcelain,
  buildDirtyGuard,
  refreshMeasurableFields,
  assessValidationConfigOverlay,
  parseAutoOverlayPorts,
  classifyLocalStartFailure,
  classifyFocusedPgtapFailure,
  classifyValidationActiveTransitionFailure,
  syncHeartbeatLoopForLease,
  attachExistingHeartbeatLoop,
  heartbeatStopFilePath,
  isGeneratedDirtyPath,
  branchManifestState,
  VALIDATION_RESOURCE,
  VALIDATION_OWNER,
  VALIDATION_REUSE_STATES,
  VALIDATION_BLOCKING_STATES,
  DEFAULT_VALIDATION_LOCAL_START_STEP_TIMEOUT_MS,
  DEFAULT_VALIDATION_LOCAL_START_HARD_TIMEOUT_MS,
};
