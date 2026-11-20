#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_CLI_SHIM_BYTES = 64 * 1024;
const WINDOWS_MODERN_CMD_SHIM_TARGET_PATTERN = /^(?![ \t]*(?:@?rem(?:[ \t]|$)|::))[^"\r\n]*"%_prog%"[^\r\n]*"%dp0%[\\/]([^"\r\n]+?)"\s+%\*[ \t]*$/gim;
const WINDOWS_LEGACY_CMD_SHIM_TARGET_PATTERN = /^(?![ \t]*(?:@?rem(?:[ \t]|$)|::))[ \t]*@?(?:"%~dp0[\\/]node\.exe"|node(?:\.exe)?)(?:[ \t]+[^"\s]+)*[ \t]+"%~dp0[\\/]([^"\r\n]+?)"[ \t]+%\*[ \t]*$/gim;
const WINDOWS_DP0_INITIALIZER_PATTERN = /^[ \t]*@?set[ \t]+(?:"dp0=%~dp0"|dp0=%~dp0)[ \t]*$/im;

const CLI_PROBE_SPECS = Object.freeze([
  Object.freeze({
    id: 'cross_env_cli',
    package_name: 'cross-env',
    bin_name: 'cross-env',
    check: 'environment',
  }),
  Object.freeze({ id: 'jest_cli', package_name: 'jest', bin_name: 'jest', check: 'version' }),
  Object.freeze({ id: 'nx_cli', package_name: 'nx', bin_name: 'nx', check: 'version' }),
  Object.freeze({ id: 'eslint_cli', package_name: 'eslint', bin_name: 'eslint', check: 'version' }),
  Object.freeze({ id: 'tsc_cli', package_name: 'typescript', bin_name: 'tsc', check: 'version' }),
  Object.freeze({
    id: 'playwright_cli',
    package_name: '@playwright/test',
    bin_name: 'playwright',
    check: 'version',
  }),
]);

const PROBE_CONTRACT = Object.freeze({
  schema: 'masarx.unit-qualification-dependency-probe-contract.v3',
  revision: 3,
  required_probe_ids: Object.freeze([
    'expo',
    'metro',
    'parcel_watcher',
    'esbuild',
    'swc',
    'nx_native',
    'unrs_resolver',
    'sentry_cli',
    ...CLI_PROBE_SPECS.map((entry) => entry.id),
  ]),
  cli_probes: CLI_PROBE_SPECS,
  cli_shim_binding: Object.freeze({
    schema: 'masarx.unit-qualification-cli-shim-binding.v1',
    windows: 'cmd_targets_match_locked_package_bin',
    posix: 'relative_symlink_realpath_matches_locked_package_bin',
  }),
});

const CONTRACT = Object.freeze({
  schema: 'masarx.unit-qualification-dependency-install.v1',
  quarantine_timeout_ms: 60 * 1000,
  purge_timeout_ms: 30 * 60 * 1000,
  timeout_ms: 10 * 60 * 1000,
  windows_timeout_ms: 20 * 60 * 1000,
  probe_timeout_ms: 30 * 1000,
  metro_probe_timeout_ms: 120 * 1000,
  min_temp_free_bytes: 2 * 1024 * 1024 * 1024,
  npm_args: Object.freeze([
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--fund=false',
    '--prefer-offline',
    '--include=optional',
    '--bin-links=true',
    '--progress=false',
    '--fetch-retries=1',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=5000',
    '--fetch-timeout=30000',
  ]),
  required_probe_ids: PROBE_CONTRACT.required_probe_ids,
});

function resolveNpmInvocation(platform = process.platform, execPath = process.execPath) {
  if (platform !== 'win32') return { executable: 'npm', prefixArgs: [] };
  return {
    executable: execPath,
    prefixArgs: [
      path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ],
  };
}

function validateContract(contract = CONTRACT) {
  const errors = [];
  const args = Array.isArray(contract?.npm_args) ? contract.npm_args : [];
  if (contract?.schema !== 'masarx.unit-qualification-dependency-install.v1') {
    errors.push('schema_invalid');
  }
  if (!Number.isInteger(contract?.timeout_ms) || contract.timeout_ms < 60_000) {
    errors.push('timeout_invalid');
  }
  if (
    !Number.isInteger(contract?.windows_timeout_ms)
    || contract.windows_timeout_ms < contract.timeout_ms
  ) {
    errors.push('windows_timeout_invalid');
  }
  if (!Number.isInteger(contract?.quarantine_timeout_ms) || contract.quarantine_timeout_ms < 10_000) {
    errors.push('quarantine_timeout_invalid');
  }
  if (!Number.isInteger(contract?.purge_timeout_ms) || contract.purge_timeout_ms < 60_000) {
    errors.push('purge_timeout_invalid');
  }
  if (!Number.isInteger(contract?.probe_timeout_ms) || contract.probe_timeout_ms < 1_000) {
    errors.push('probe_timeout_invalid');
  }
  if (!Number.isInteger(contract?.metro_probe_timeout_ms) || contract.metro_probe_timeout_ms < 1_000) {
    errors.push('metro_probe_timeout_invalid');
  }
  if (!Number.isInteger(contract?.min_temp_free_bytes) || contract.min_temp_free_bytes < 1024 * 1024) {
    errors.push('min_temp_free_bytes_invalid');
  }
  if (args[0] !== 'ci') errors.push('npm_ci_required');
  for (const requiredArg of [
    '--ignore-scripts',
    '--no-audit',
    '--fund=false',
    '--prefer-offline',
    '--include=optional',
    '--bin-links=true',
    '--progress=false',
    '--fetch-retries=1',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=5000',
    '--fetch-timeout=30000',
  ]) {
    if (!args.includes(requiredArg)) errors.push(`npm_arg_missing:${requiredArg}`);
  }
  if (args.some((arg) => /^(?:--no-optional|--omit(?:=|$)|--production(?:=|$))/i.test(arg))) {
    errors.push('optional_platform_packages_must_be_preserved');
  }
  if (args.some((arg) => /^(?:--no-bin-links|--bin-links=(?:0|false|no|off))$/i.test(arg))) {
    errors.push('bin_links_must_be_enabled');
  }
  const probeIds = Array.isArray(contract?.required_probe_ids) ? contract.required_probe_ids : [];
  if (
    probeIds.length !== CONTRACT.required_probe_ids.length
    || new Set(probeIds).size !== CONTRACT.required_probe_ids.length
  ) {
    errors.push('required_probe_set_invalid');
  }
  for (const probeId of CONTRACT.required_probe_ids) {
    if (!probeIds.includes(probeId)) errors.push(`required_probe_missing:${probeId}`);
  }
  return { ok: errors.length === 0, errors };
}

function readEnvironmentValue(env, name) {
  const expected = String(name).toLowerCase();
  const entry = Object.entries(env || {}).find(([key]) => key.toLowerCase() === expected);
  return String(entry?.[1] || '').trim();
}

function validateInstallEnvironment(env = process.env) {
  const errors = [];
  if (readEnvironmentValue(env, 'NODE_ENV').toLowerCase() === 'production') {
    errors.push('node_env_production_would_omit_dev');
  }
  if (['1', 'true'].includes(readEnvironmentValue(env, 'npm_config_production').toLowerCase())) {
    errors.push('npm_config_production_would_omit_dev');
  }
  if (['production', 'prod'].includes(readEnvironmentValue(env, 'npm_config_only').toLowerCase())) {
    errors.push('npm_config_only_would_omit_dev');
  }
  const inheritedOmit = readEnvironmentValue(env, 'npm_config_omit')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const dependencyType of ['dev', 'peer']) {
    if (inheritedOmit.includes(dependencyType)) {
      errors.push(`npm_config_omit_would_exclude:${dependencyType}`);
    }
  }
  if (['0', 'false', 'no', 'off'].includes(
    readEnvironmentValue(env, 'npm_config_bin_links').toLowerCase(),
  )) {
    errors.push('npm_config_bin_links_would_disable_shims');
  }
  return { ok: errors.length === 0, errors };
}

function collectProcessSnapshot({
  platform = process.platform,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform === 'win32') {
    const command = [
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      "$ErrorActionPreference = 'Stop'",
      'Get-CimInstance Win32_Process | Where-Object { [int]$_.ProcessId -ne $PID } |',
      "  Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parent_pid';e={[int]$_.ParentProcessId}},@{n='name';e={[string]$_.Name}},@{n='command_line';e={[string]$_.CommandLine}},@{n='creation_ticks';e={if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }}} |",
      '  ConvertTo-Json -Compress',
    ].join('\n');
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const result = spawnSyncImpl(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (result?.error || result?.status !== 0) {
      throw new Error(`unit_qualification_process_snapshot_failed:${result?.error?.code || result?.status || 'unknown'}`);
    }
    const parsed = JSON.parse(String(result.stdout || '[]').replace(/^\uFEFF/, '') || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.pid),
      parent_pid: Number(entry.parent_pid),
      name: String(entry.name || ''),
      command_line: String(entry.command_line || ''),
      creation_ticks: String(entry.creation_ticks || ''),
      cwd: '',
    }));
  }

  const result = spawnSyncImpl('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`unit_qualification_process_snapshot_failed:${result?.error?.code || result?.status || 'unknown'}`);
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter(Boolean)
    .map((match) => {
      const pid = Number(match[1]);
      let cwd = '';
      if (platform === 'linux') {
        try {
          cwd = fsImpl.readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          // A process may exit between ps and the cwd read.
        }
      }
      return {
        pid,
        parent_pid: Number(match[2]),
        name: String(match[3] || ''),
        command_line: String(match[4] || ''),
        creation_ticks: '',
        cwd,
      };
    });
}

function detectCompetingNpmInstalls(processes = [], { currentPid = process.pid } = {}) {
  const byPid = new Map(processes.map((entry) => [Number(entry.pid), entry]));
  const npmCiPattern = /(?:^|\s)(?:npm(?:\.cmd)?|["'][^"']*[\\/]npm-cli\.js["']|[^\s]+[\\/]npm-cli\.js)\s+ci(?:\s|$)/i;
  const npmProcessName = /^(?:node(?:\.exe)?|npm(?:\.cmd)?)$/i;
  return processes
    .filter((entry) => Number(entry.pid) !== Number(currentPid))
    .filter((entry) => npmProcessName.test(String(entry.name || '')))
    .filter((entry) => npmCiPattern.test(String(entry.command_line || '')))
    .map((entry) => {
      const chain = [];
      const visited = new Set();
      let cursor = entry;
      while (cursor && chain.length < 8 && !visited.has(Number(cursor.pid))) {
        chain.push(cursor);
        visited.add(Number(cursor.pid));
        cursor = byPid.get(Number(cursor.parent_pid));
      }
      const workingDirectory = chain
        .map((processEntry) => String(processEntry.cwd || ''))
        .find(Boolean) || chain
        .map((processEntry) => String(processEntry.command_line || '').match(/-WorkingDirectory\s+['"]([^'"]+)['"]/i)?.[1] || '')
        .find(Boolean) || '';
      return {
        pid: Number(entry.pid),
        parent_pid: Number(entry.parent_pid),
        owner: workingDirectory || 'unknown',
      };
    });
}

function assertNoCompetingNpmInstall({
  processes = collectProcessSnapshot(),
  currentPid = process.pid,
} = {}) {
  const competitors = detectCompetingNpmInstalls(processes, { currentPid });
  if (competitors.length) {
    throw new Error(`unit_qualification_competing_npm_install:${JSON.stringify(competitors)}`);
  }
  return { ok: true, competitors: [] };
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTaskTempRoot(env = process.env, { cwd = process.cwd() } = {}) {
  const explicitRoot = String(env.MASARX_UNIT_QUALIFICATION_TEMP_ROOT || '').trim();
  const runnerTemp = String(env.RUNNER_TEMP || '').trim();
  const selectedRoot = explicitRoot || runnerTemp;
  if (!selectedRoot) {
    throw new Error('unit_qualification_temp_root_required');
  }
  const repoRoot = path.resolve(cwd);
  const taskTempRoot = path.resolve(selectedRoot, 'masarx-unit-qualification');
  if (isPathInside(repoRoot, taskTempRoot)) {
    throw new Error('unit_qualification_temp_root_inside_repository');
  }
  return taskTempRoot;
}

function prepareTaskTempRoot({
  contract = CONTRACT,
  cwd = process.cwd(),
  env = process.env,
  fsImpl = fs,
} = {}) {
  const taskTempRoot = resolveTaskTempRoot(env, { cwd });
  fsImpl.mkdirSync(taskTempRoot, { recursive: true });
  const realTaskTempRoot = fsImpl.realpathSync(taskTempRoot);
  const realRepoRoot = fsImpl.realpathSync(cwd);
  if (isPathInside(realRepoRoot, realTaskTempRoot)) {
    throw new Error('unit_qualification_real_temp_root_inside_repository');
  }
  if (typeof fsImpl.statfsSync !== 'function') {
    throw new Error('unit_qualification_temp_capacity_unavailable');
  }
  const stats = fsImpl.statfsSync(realTaskTempRoot);
  const freeBytes = Number(stats?.bavail) * Number(stats?.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < contract.min_temp_free_bytes) {
    throw new Error(`unit_qualification_temp_capacity_insufficient:${freeBytes || 0}:${contract.min_temp_free_bytes}`);
  }
  return { taskTempRoot: realTaskTempRoot, freeBytes };
}

function resolveLogDirectory(taskTempRoot) {
  const normalizedRoot = String(taskTempRoot || '').trim();
  if (!normalizedRoot) throw new Error('unit_qualification_task_temp_root_required');
  return path.join(path.resolve(normalizedRoot), 'npm-logs');
}

function findLatestDebugLog(logDirectory, fsImpl = fs, excludedPaths = new Set()) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(logDirectory, { withFileTypes: true });
  } catch {
    return '';
  }
  return entries
    .filter((entry) => entry.isFile() && /-debug-\d+\.log$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(logDirectory, entry.name);
      let modifiedMs = 0;
      try {
        modifiedMs = fsImpl.statSync(filePath).mtimeMs;
      } catch {
        // The caller still receives the path when a concurrent cleanup races the stat.
      }
      return { filePath, modifiedMs };
    })
    .filter((entry) => !excludedPaths.has(entry.filePath))
    .sort((left, right) => right.modifiedMs - left.modifiedMs || right.filePath.localeCompare(left.filePath))[0]
    ?.filePath || '';
}

function githubEscape(value) {
  return String(value || '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function reportDebugLog(logPath, { error = false } = {}) {
  if (!logPath) {
    console.error('[unit-qualification-dependencies] npm debug log: unavailable');
    return;
  }
  console.error(`[unit-qualification-dependencies] npm debug log: ${logPath}`);
  if (error && process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error title=npm dependency installation failed::npm debug log: ${githubEscape(logPath)}`);
  }
}

function resolveDependencyTreeTargets(cwd = process.cwd(), fsImpl = fs) {
  const repoRoot = path.resolve(cwd);
  const realRepoRoot = fsImpl.realpathSync(repoRoot);
  const manifest = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const workspacePatterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (!Array.isArray(workspacePatterns)) {
    throw new Error('unit_qualification_workspace_patterns_invalid');
  }

  const workspaceRoots = [];
  for (const rawPattern of workspacePatterns) {
    const pattern = String(rawPattern || '').trim().replace(/\\/g, '/');
    if (!pattern || path.posix.isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern)) {
      throw new Error(`unit_qualification_workspace_pattern_invalid:${pattern || '<empty>'}`);
    }
    const segments = pattern.split('/');
    if (segments.includes('..') || segments.includes('.') || segments.some((segment) => !segment)) {
      throw new Error(`unit_qualification_workspace_pattern_invalid:${pattern}`);
    }
    const wildcardCount = (pattern.match(/\*/g) || []).length;
    if (wildcardCount > 1 || (wildcardCount === 1 && !pattern.endsWith('/*'))) {
      throw new Error(`unit_qualification_workspace_glob_unsupported:${pattern}`);
    }
    if (!wildcardCount) {
      const workspaceRoot = path.resolve(repoRoot, ...segments);
      if (!isPathInside(repoRoot, workspaceRoot) || !fsImpl.existsSync(path.join(workspaceRoot, 'package.json'))) {
        throw new Error(`unit_qualification_workspace_missing:${pattern}`);
      }
      workspaceRoots.push(workspaceRoot);
      continue;
    }

    const parentSegments = segments.slice(0, -1);
    const workspaceParent = path.resolve(repoRoot, ...parentSegments);
    if (!isPathInside(repoRoot, workspaceParent)) {
      throw new Error(`unit_qualification_workspace_pattern_escapes:${pattern}`);
    }
    let entries;
    try {
      entries = fsImpl.readdirSync(workspaceParent, { withFileTypes: true });
    } catch {
      throw new Error(`unit_qualification_workspace_parent_missing:${parentSegments.join('/')}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = path.join(workspaceParent, entry.name);
      if (fsImpl.existsSync(path.join(workspaceRoot, 'package.json'))) {
        workspaceRoots.push(workspaceRoot);
      }
    }
  }

  const parentRoots = [repoRoot, ...new Set(workspaceRoots.map((entry) => path.resolve(entry)))];
  return parentRoots
    .map((parentRoot) => {
      const realParentRoot = fsImpl.realpathSync(parentRoot);
      if (!isPathInside(realRepoRoot, realParentRoot)) {
        throw new Error(`unit_qualification_dependency_parent_escapes:${parentRoot}`);
      }
      const target = path.join(parentRoot, 'node_modules');
      if (path.basename(target) !== 'node_modules' || !isPathInside(repoRoot, target)) {
        throw new Error(`unit_qualification_dependency_target_invalid:${target}`);
      }
      return target;
    })
    .sort((left, right) => left.localeCompare(right));
}

function resolveDependencyTreeQuarantinePlan({
  cwd = process.cwd(),
  taskTempRoot,
  fsImpl = fs,
} = {}) {
  const repoRoot = fsImpl.realpathSync(path.resolve(cwd));
  const tempRoot = fsImpl.realpathSync(path.resolve(taskTempRoot));
  if (isPathInside(repoRoot, tempRoot) || isPathInside(tempRoot, repoRoot)) {
    throw new Error('unit_qualification_quarantine_root_overlap');
  }
  const repoStats = fsImpl.statSync(repoRoot);
  const tempStats = fsImpl.statSync(tempRoot);
  const sameDevice = String(repoStats.dev) === String(tempStats.dev)
    && (process.platform !== 'win32'
      || path.parse(repoRoot).root.toLowerCase() === path.parse(tempRoot).root.toLowerCase());
  if (!sameDevice) throw new Error('unit_qualification_quarantine_cross_device');

  const quarantineRoot = path.join(tempRoot, 'dependency-tree-quarantine');
  const manifestPath = path.join(tempRoot, 'dependency-tree-quarantine-manifest.json');
  if (!isPathInside(tempRoot, quarantineRoot) || !isPathInside(tempRoot, manifestPath)) {
    throw new Error('unit_qualification_quarantine_destination_invalid');
  }
  const targets = resolveDependencyTreeTargets(repoRoot, fsImpl);
  const entries = targets.map((source) => {
    const sourceRelative = path.relative(repoRoot, source).replace(/\\/g, '/');
    const destination = path.resolve(quarantineRoot, ...sourceRelative.split('/'));
    if (!isPathInside(quarantineRoot, destination)) {
      throw new Error(`unit_qualification_quarantine_destination_escapes:${sourceRelative}`);
    }
    if (fsImpl.existsSync(source) && fsImpl.lstatSync(source).isSymbolicLink()) {
      throw new Error(`unit_qualification_quarantine_source_reparse:${sourceRelative}`);
    }
    return {
      source,
      source_relative: sourceRelative,
      destination,
      destination_relative: path.relative(tempRoot, destination).replace(/\\/g, '/'),
      existed: fsImpl.existsSync(source),
    };
  });
  return { repoRoot, tempRoot, quarantineRoot, manifestPath, entries };
}

function performDependencyTreeQuarantine({
  cwd = process.cwd(),
  taskTempRoot,
  fsImpl = fs,
  env = process.env,
} = {}) {
  const plan = resolveDependencyTreeQuarantinePlan({ cwd, taskTempRoot, fsImpl });
  const binding = plan.entries.map(({ source_relative, destination_relative, existed }) => ({
    source_relative,
    destination_relative,
    existed,
  }));
  const expected = String(env.MASARX_UNIT_QUALIFICATION_QUARANTINE_PLAN_JSON || '').trim();
  if (!expected || expected !== JSON.stringify(binding)) {
    throw new Error('unit_qualification_quarantine_plan_binding_invalid');
  }
  const moved = [];
  let moveError = '';
  for (const entry of plan.entries.filter((candidate) => candidate.existed)) {
    try {
      if (!fsImpl.existsSync(entry.source) || fsImpl.existsSync(entry.destination)) {
        throw new Error(`quarantine_move_precondition_failed:${entry.source_relative}`);
      }
      fsImpl.mkdirSync(path.dirname(entry.destination), { recursive: true });
      const realDestinationParent = fsImpl.realpathSync(path.dirname(entry.destination));
      if (!isPathInside(plan.quarantineRoot, realDestinationParent)) {
        throw new Error(`quarantine_destination_parent_escapes:${entry.source_relative}`);
      }
      fsImpl.renameSync(entry.source, entry.destination);
      moved.push(entry);
      if (fsImpl.existsSync(entry.source) || !fsImpl.existsSync(entry.destination)) {
        throw new Error(`quarantine_move_verification_failed:${entry.source_relative}`);
      }
    } catch (error) {
      moveError = String(error?.message || error);
      break;
    }
  }

  const rollback = [];
  if (moveError) {
    for (const entry of [...moved].reverse()) {
      let passed = false;
      let error = '';
      try {
        if (fsImpl.existsSync(entry.source) || !fsImpl.existsSync(entry.destination)) {
          throw new Error('rollback_precondition_failed');
        }
        fsImpl.renameSync(entry.destination, entry.source);
        passed = fsImpl.existsSync(entry.source) && !fsImpl.existsSync(entry.destination);
        if (!passed) throw new Error('rollback_verification_failed');
      } catch (rollbackError) {
        error = String(rollbackError?.message || rollbackError);
      }
      rollback.push({ source_relative: entry.source_relative, passed, error });
    }
  }
  const remainingSources = plan.entries
    .filter((entry) => fsImpl.existsSync(entry.source))
    .map((entry) => entry.source_relative);
  const movedDestinations = plan.entries
    .filter((entry) => fsImpl.existsSync(entry.destination))
    .map((entry) => entry.destination_relative);
  return {
    schema: 'masarx.unit-qualification-dependency-quarantine-child.v1',
    passed: !moveError && !remainingSources.length,
    error: moveError,
    moved_sources: moved.map((entry) => entry.source_relative),
    remaining_sources: remainingSources,
    moved_destinations: movedDestinations,
    rollback,
  };
}

function rollbackDependencyTreeQuarantine(plan, fsImpl = fs) {
  const rollback = [];
  for (const entry of [...plan.entries].reverse()) {
    if (!fsImpl.existsSync(entry.destination)) continue;
    let passed = false;
    let error = '';
    try {
      if (fsImpl.existsSync(entry.source)) throw new Error('rollback_source_collision');
      fsImpl.mkdirSync(path.dirname(entry.source), { recursive: true });
      fsImpl.renameSync(entry.destination, entry.source);
      passed = fsImpl.existsSync(entry.source) && !fsImpl.existsSync(entry.destination);
      if (!passed) throw new Error('rollback_verification_failed');
    } catch (rollbackError) {
      error = String(rollbackError?.message || rollbackError);
    }
    rollback.push({ source_relative: entry.source_relative, passed, error });
  }
  const missingSources = plan.entries
    .filter((entry) => entry.existed && !fsImpl.existsSync(entry.source))
    .map((entry) => entry.source_relative);
  const remainingDestinations = plan.entries
    .filter((entry) => fsImpl.existsSync(entry.destination))
    .map((entry) => entry.destination_relative);
  const passed = !missingSources.length
    && !remainingDestinations.length
    && rollback.every((entry) => entry.passed);
  if (passed && fsImpl.existsSync(plan.quarantineRoot)) {
    fsImpl.rmSync(plan.quarantineRoot, { recursive: true, force: true });
  }
  return { passed, rollback, missing_sources: missingSources, remaining_destinations: remainingDestinations };
}

function parseLastJsonLine(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Continue to the previous evidence line.
    }
  }
  return null;
}

function runDependencyTreeQuarantine({
  contract = CONTRACT,
  cwd = process.cwd(),
  env = process.env,
  taskTempRoot,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const plan = resolveDependencyTreeQuarantinePlan({ cwd, taskTempRoot, fsImpl });
  if (fsImpl.existsSync(plan.quarantineRoot) || fsImpl.existsSync(plan.manifestPath)) {
    throw new Error('unit_qualification_quarantine_collision');
  }
  const binding = plan.entries.map(({ source_relative, destination_relative, existed }) => ({
    source_relative,
    destination_relative,
    existed,
  }));
  const startedAt = new Date().toISOString();
  const existingSources = binding.filter((entry) => entry.existed).map((entry) => entry.source_relative);
  if (!existingSources.length) {
    return {
      schema: 'masarx.unit-qualification-dependency-quarantine.v1',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      passed: true,
      skipped_empty: true,
      timed_out: false,
      exit_code: 0,
      signal: null,
      error: '',
      entries: binding,
      remaining_sources: [],
      moved_destinations: [],
      rollback: [],
      purge_required: false,
      manifest_path: '',
      evidence: '',
    };
  }

  const manifest = {
    schema: 'masarx.unit-qualification-dependency-quarantine-manifest.v1',
    status: 'planned',
    repo_root: plan.repoRoot,
    temp_root: plan.tempRoot,
    quarantine_root: plan.quarantineRoot,
    entries: binding,
  };
  fsImpl.writeFileSync(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const result = spawnSyncImpl(process.execPath, [__filename, '--quarantine-dependency-tree'], {
    cwd,
    env: {
      ...env,
      MASARX_UNIT_QUALIFICATION_QUARANTINE_PLAN_JSON: JSON.stringify(binding),
    },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: contract.quarantine_timeout_ms,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  });
  let childReceipt = parseLastJsonLine(result?.stdout);
  const remainingSources = plan.entries
    .filter((entry) => fsImpl.existsSync(entry.source))
    .map((entry) => entry.source_relative);
  const movedDestinations = plan.entries
    .filter((entry) => fsImpl.existsSync(entry.destination))
    .map((entry) => entry.destination_relative);
  const timedOut = result?.error?.code === 'ETIMEDOUT';
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  let passed = !result?.error && exitCode === 0 && childReceipt?.passed === true && !remainingSources.length;
  if (passed) {
    const temporaryManifest = `${plan.manifestPath}.tmp-${process.pid}`;
    try {
      manifest.status = 'quarantined';
      manifest.quarantined_at = new Date().toISOString();
      fsImpl.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(temporaryManifest, plan.manifestPath);
    } catch (manifestError) {
      passed = false;
      const recovery = rollbackDependencyTreeQuarantine(plan, fsImpl);
      try {
        fsImpl.rmSync(temporaryManifest, { force: true });
      } catch {
        // Preserve the primary receipt failure and exact rollback evidence.
      }
      if (recovery.passed) {
        try {
          fsImpl.unlinkSync(plan.manifestPath);
        } catch {
          // A planned manifest is safer than deleting evidence without a receipt.
        }
      }
      childReceipt = {
        ...(childReceipt || {}),
        error: `quarantine_manifest_finalize_failed:${String(manifestError?.message || manifestError)}`,
        rollback: recovery.rollback,
        rollback_passed: recovery.passed,
        rollback_missing_sources: recovery.missing_sources,
        rollback_remaining_destinations: recovery.remaining_destinations,
      };
    }
  } else {
    const recovery = rollbackDependencyTreeQuarantine(plan, fsImpl);
    if (recovery.passed) {
      fsImpl.unlinkSync(plan.manifestPath);
    } else {
      manifest.status = 'rollback_failed';
      manifest.rollback_failed_at = new Date().toISOString();
      manifest.rollback = recovery;
      const temporaryManifest = `${plan.manifestPath}.tmp-${process.pid}`;
      fsImpl.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(temporaryManifest, plan.manifestPath);
    }
    childReceipt = {
      ...(childReceipt || {}),
      rollback: recovery.rollback,
      rollback_passed: recovery.passed,
      rollback_missing_sources: recovery.missing_sources,
      rollback_remaining_destinations: recovery.remaining_destinations,
    };
  }
  return {
    schema: 'masarx.unit-qualification-dependency-quarantine.v1',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    passed,
    skipped_empty: false,
    timed_out: timedOut,
    exit_code: exitCode,
    signal: result?.signal || null,
    error: result?.error ? String(result.error.message || result.error) : String(childReceipt?.error || ''),
    entries: binding,
    remaining_sources: remainingSources,
    moved_destinations: movedDestinations,
    rollback: Array.isArray(childReceipt?.rollback) ? childReceipt.rollback : [],
    purge_required: passed && movedDestinations.length > 0,
    manifest_path: fsImpl.existsSync(plan.manifestPath) ? plan.manifestPath : '',
    evidence: `${String(result?.stdout || '')}${String(result?.stderr || '')}`.slice(-16 * 1024),
  };
}

function validateDependencyTreeQuarantineManifest({ cwd, taskTempRoot, manifest, fsImpl = fs }) {
  const plan = resolveDependencyTreeQuarantinePlan({ cwd, taskTempRoot, fsImpl });
  const expectedEntries = plan.entries.map(({ source_relative, destination_relative }) => ({
    source_relative,
    destination_relative,
  }));
  const manifestEntries = Array.isArray(manifest?.entries)
    ? manifest.entries.map(({ source_relative, destination_relative }) => ({
      source_relative,
      destination_relative,
    }))
    : [];
  if (manifest?.schema !== 'masarx.unit-qualification-dependency-quarantine-manifest.v1'
    || manifest?.status !== 'quarantined'
    || manifest.repo_root !== plan.repoRoot
    || manifest.temp_root !== plan.tempRoot
    || manifest.quarantine_root !== plan.quarantineRoot
    || JSON.stringify(manifestEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('unit_qualification_quarantine_manifest_invalid');
  }
  return plan;
}

function runDependencyTreeQuarantinePurge({
  contract = CONTRACT,
  cwd = process.cwd(),
  env = process.env,
  taskTempRoot,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const tempRoot = fsImpl.realpathSync(path.resolve(taskTempRoot));
  const manifestPath = path.join(tempRoot, 'dependency-tree-quarantine-manifest.json');
  const startedAt = new Date().toISOString();
  if (!fsImpl.existsSync(manifestPath)) {
    const orphanRoot = path.join(tempRoot, 'dependency-tree-quarantine');
    if (fsImpl.existsSync(orphanRoot)) throw new Error('unit_qualification_quarantine_manifest_missing');
    return { schema: 'masarx.unit-qualification-dependency-purge.v1', started_at: startedAt, completed_at: new Date().toISOString(), passed: true, skipped_empty: true, timed_out: false, remaining: false };
  }
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  const plan = validateDependencyTreeQuarantineManifest({ cwd, taskTempRoot: tempRoot, manifest, fsImpl });
  const result = spawnSyncImpl(process.execPath, [__filename, '--purge-dependency-quarantine-child'], {
    cwd,
    env: { ...env, MASARX_UNIT_QUALIFICATION_QUARANTINE_MANIFEST_PATH: manifestPath },
    encoding: 'utf8', shell: false, windowsHide: true,
    timeout: contract.purge_timeout_ms, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024,
  });
  const remaining = fsImpl.existsSync(plan.quarantineRoot);
  const timedOut = result?.error?.code === 'ETIMEDOUT';
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  const passed = !result?.error && exitCode === 0 && !remaining;
  if (passed) fsImpl.unlinkSync(manifestPath);
  return {
    schema: 'masarx.unit-qualification-dependency-purge.v1', started_at: startedAt,
    completed_at: new Date().toISOString(), passed, skipped_empty: false, timed_out: timedOut,
    exit_code: exitCode, signal: result?.signal || null,
    error: result?.error ? String(result.error.message || result.error) : '', remaining,
    evidence: `${String(result?.stdout || '')}${String(result?.stderr || '')}`.slice(-16 * 1024),
  };
}

function performDependencyTreeQuarantinePurge({ env = process.env, fsImpl = fs } = {}) {
  const manifestPath = path.resolve(String(env.MASARX_UNIT_QUALIFICATION_QUARANTINE_MANIFEST_PATH || ''));
  if (!manifestPath || path.basename(manifestPath) !== 'dependency-tree-quarantine-manifest.json'
    || !fsImpl.existsSync(manifestPath)) {
    throw new Error('unit_qualification_quarantine_purge_manifest_invalid');
  }
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  const tempRoot = fsImpl.realpathSync(path.dirname(manifestPath));
  if (manifest.temp_root !== tempRoot || manifest.repo_root !== fsImpl.realpathSync(manifest.repo_root)) {
    throw new Error('unit_qualification_quarantine_purge_binding_invalid');
  }
  const plan = validateDependencyTreeQuarantineManifest({
    cwd: manifest.repo_root,
    taskTempRoot: tempRoot,
    manifest,
    fsImpl,
  });
  const quarantineRoot = plan.quarantineRoot;
  if (fsImpl.existsSync(quarantineRoot) && fsImpl.lstatSync(quarantineRoot).isSymbolicLink()) {
    throw new Error('unit_qualification_quarantine_purge_reparse');
  }
  fsImpl.rmSync(quarantineRoot, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
  if (fsImpl.existsSync(quarantineRoot)) throw new Error('unit_qualification_quarantine_purge_remaining');
  return { quarantine_root: quarantineRoot, passed: true };
}

function runInstall({
  contract = CONTRACT,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  processSnapshot,
} = {}) {
  const validation = validateContract(contract);
  if (!validation.ok) {
    throw new Error(`unit_qualification_dependency_contract_invalid:${validation.errors.join(',')}`);
  }
  const environmentValidation = validateInstallEnvironment(env);
  if (!environmentValidation.ok) {
    throw new Error(`unit_qualification_dependency_environment_invalid:${environmentValidation.errors.join(',')}`);
  }
  assertNoCompetingNpmInstall({
    processes: processSnapshot || collectProcessSnapshot({ fsImpl, spawnSyncImpl }),
  });
  const preparedTemp = prepareTaskTempRoot({ contract, cwd, env, fsImpl });
  const quarantine = runDependencyTreeQuarantine({
    contract, cwd, env, taskTempRoot: preparedTemp.taskTempRoot, fsImpl, spawnSyncImpl,
  });
  if (!quarantine.passed) {
    return {
      schema: 'masarx.unit-qualification-dependency-preparation.v1',
      passed: false,
      quarantine,
      install: null,
    };
  }
  const logDirectory = resolveLogDirectory(preparedTemp.taskTempRoot);
  fsImpl.mkdirSync(logDirectory, { recursive: true });
  const preexistingDebugLogs = new Set(
    fsImpl.readdirSync(logDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /-debug-\d+\.log$/i.test(entry.name))
      .map((entry) => path.join(logDirectory, entry.name)),
  );
  const invocation = resolveNpmInvocation(platform);
  const installTimeoutMs = resolveInstallTimeout(contract, platform);
  const startedAt = new Date().toISOString();
  console.log(`[unit-qualification-dependencies] npm ${contract.npm_args.join(' ')}`);
  const result = spawnSyncImpl(
    invocation.executable,
    [...invocation.prefixArgs, ...contract.npm_args],
    {
      cwd,
      env: {
        ...env,
        TMP: preparedTemp.taskTempRoot,
        TEMP: preparedTemp.taskTempRoot,
        TMPDIR: preparedTemp.taskTempRoot,
        npm_config_logs_dir: logDirectory,
        npm_config_logs_max: '20',
      },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: installTimeoutMs,
      killSignal: 'SIGTERM',
    },
  );
  const debugLog = findLatestDebugLog(logDirectory, fsImpl, preexistingDebugLogs);
  const timedOut = result?.error?.code === 'ETIMEDOUT';
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  const passed = !result?.error && exitCode === 0;
  if (!passed) reportDebugLog(debugLog, { error: true });
  const install = {
    schema: contract.schema,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    passed,
    timed_out: timedOut,
    timeout_ms: installTimeoutMs,
    exit_code: exitCode,
    signal: result?.signal || null,
    error: result?.error ? String(result.error.message || result.error) : '',
    debug_log_path: debugLog,
    log_directory: logDirectory,
    task_temp_root: preparedTemp.taskTempRoot,
    task_temp_free_bytes: preparedTemp.freeBytes,
  };
  return {
    schema: 'masarx.unit-qualification-dependency-preparation.v1',
    passed: install.passed,
    quarantine,
    install,
  };
}

function readPackageVersion(packageJsonPath, fsImpl = fs) {
  return String(JSON.parse(fsImpl.readFileSync(packageJsonPath, 'utf8')).version || '').trim();
}

function resolvePackageBinTarget(packageManifest, binName) {
  const mapping = packageManifest?.bin;
  if (typeof mapping === 'string') return String(mapping).trim();
  if (!mapping || typeof mapping !== 'object') return '';
  return String(mapping[binName] || '').trim();
}

function normalizeCliBinTarget(rawTarget) {
  const value = String(rawTarget || '').trim().replace(/\\/g, '/');
  if (!value
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)) {
    return '';
  }
  const normalized = path.posix.normalize(value.replace(/^(?:\.\/)+/, ''));
  if (!normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')) {
    return '';
  }
  return normalized;
}

function pathsMatch(leftPath, rightPath, platform) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '');
  const left = normalize(leftPath);
  const right = normalize(rightPath);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolvePortableRelativePath(basePath, relativeTarget) {
  return path.resolve(basePath, ...String(relativeTarget).split(/[\\/]+/).filter(Boolean));
}

function trimWindowsCmdAsciiWhitespace(value) {
  return String(value || '').replace(/^[ \t]+|[ \t]+$/g, '');
}

function hasReachableModernWindowsShimLauncher(content, launcherMatch) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => trimWindowsCmdAsciiWhitespace(line))
    .filter(Boolean);
  if (lines.length !== 15
    || lines[14] !== trimWindowsCmdAsciiWhitespace(launcherMatch[0])) return false;
  const expectedLines = [
    /^@?echo[ \t]+off$/i,
    /^@?goto[ \t]+start$/i,
    /^:find_dp0$/i,
    /^@?set[ \t]+(?:"dp0=%~dp0"|dp0=%~dp0)$/i,
    /^@?exit[ \t]+\/b$/i,
    /^:start$/i,
    /^@?setlocal$/i,
    /^@?call[ \t]+:find_dp0$/i,
    /^@?if[ \t]+exist[ \t]+"%dp0%[\\/]node\.exe"[ \t]+\($/i,
    /^@?set[ \t]+"_prog=%dp0%[\\/]node\.exe"$/i,
    /^\)[ \t]+else[ \t]+\($/i,
    /^@?set[ \t]+"_prog=node"$/i,
    /^@?set[ \t]+pathext=%pathext:;\.js;=;%$/i,
    /^\)$/,
    /^endlocal[ \t]+&[ \t]+goto[ \t]+#_undefined_#[ \t]+2>nul[ \t]+\|\|[ \t]+title[ \t]+%comspec%[ \t]+&[ \t]+"%_prog%"[ \t]+"%dp0%[\\/][^"\r\n]+"[ \t]+%\*$/i,
  ];
  return expectedLines.every((pattern, index) => pattern.test(lines[index]));
}

function hasReachableLegacyWindowsShimLaunchers(content, launcherMatches) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => trimWindowsCmdAsciiWhitespace(line))
    .filter(Boolean);
  if (launcherMatches.length !== 2 || lines.length !== 7) return false;
  if (lines[1] !== trimWindowsCmdAsciiWhitespace(launcherMatches[0][0])
    || lines[5] !== trimWindowsCmdAsciiWhitespace(launcherMatches[1][0])) {
    return false;
  }
  const expectedLines = [
    /^@?if[ \t]+exist[ \t]+"%~dp0[\\/]node\.exe"[ \t]+\($/i,
    /^@?"%~dp0[\\/]node\.exe"[ \t]+"%~dp0[\\/][^"\r\n]+"[ \t]+%\*$/i,
    /^\)[ \t]+else[ \t]+\($/i,
    /^@?setlocal$/i,
    /^@?set[ \t]+pathext=%pathext:;\.js;=;%$/i,
    /^@?node(?:\.exe)?[ \t]+"%~dp0[\\/][^"\r\n]+"[ \t]+%\*$/i,
    /^\)$/,
  ];
  return expectedLines.every((pattern, index) => pattern.test(lines[index]));
}

function assertCliShimBinding({
  spec,
  repoRoot,
  shimPath,
  shimRelative,
  cliPath,
  realPackageRoot,
  realCliPath,
  platform,
  fsImpl,
}) {
  const fail = (kind) => {
    throw new Error(`cli_shim_target_${kind}:${spec.id}:${shimRelative}`);
  };
  const shimStat = fsImpl.lstatSync(shimPath);

  if (platform === 'win32') {
    if (!shimStat.isFile()) {
      throw new Error(`cli_shim_invalid:${spec.id}:${shimRelative}`);
    }
    if (!Number.isSafeInteger(shimStat.size)
      || shimStat.size <= 0
      || shimStat.size > MAX_CLI_SHIM_BYTES) {
      fail('invalid');
    }
    const content = fsImpl.readFileSync(shimPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_CLI_SHIM_BYTES) fail('invalid');
    WINDOWS_MODERN_CMD_SHIM_TARGET_PATTERN.lastIndex = 0;
    WINDOWS_LEGACY_CMD_SHIM_TARGET_PATTERN.lastIndex = 0;
    const modernMatches = Array.from(content.matchAll(WINDOWS_MODERN_CMD_SHIM_TARGET_PATTERN));
    const legacyMatches = Array.from(content.matchAll(WINDOWS_LEGACY_CMD_SHIM_TARGET_PATTERN));
    WINDOWS_MODERN_CMD_SHIM_TARGET_PATTERN.lastIndex = 0;
    WINDOWS_LEGACY_CMD_SHIM_TARGET_PATTERN.lastIndex = 0;
    const matches = [...modernMatches, ...legacyMatches];
    if (matches.length === 0) fail('invalid');
    if (modernMatches.length > 0 && legacyMatches.length > 0) fail('invalid');
    if (modernMatches.length > 0 && !WINDOWS_DP0_INITIALIZER_PATTERN.test(content)) fail('invalid');
    if (modernMatches.length > 0
      && (modernMatches.length !== 1
        || !hasReachableModernWindowsShimLauncher(content, modernMatches[0]))) {
      fail('invalid');
    }
    if (legacyMatches.length > 0
      && !hasReachableLegacyWindowsShimLaunchers(content, legacyMatches)) {
      fail('invalid');
    }
    for (const match of matches) {
      const rawTarget = String(match[1] || '');
      if (!rawTarget
        || rawTarget !== rawTarget.trim()
        || rawTarget.includes('\0')
        || rawTarget.includes('%')
        || rawTarget.includes('!')
        || path.posix.isAbsolute(rawTarget)
        || path.win32.isAbsolute(rawTarget)
        || /^[A-Za-z]:/.test(rawTarget)) {
        fail('invalid');
      }
      const resolvedTarget = resolvePortableRelativePath(path.dirname(shimPath), rawTarget);
      if (!isPathInside(repoRoot, resolvedTarget)) fail('escape');
      if (!pathsMatch(resolvedTarget, cliPath, platform)) fail('mismatch');
    }
    return;
  }

  if (!shimStat.isSymbolicLink()) {
    throw new Error(`cli_shim_invalid:${spec.id}:${shimRelative}`);
  }
  const rawTarget = String(fsImpl.readlinkSync(shimPath) || '').trim();
  if (!rawTarget
    || rawTarget.includes('\0')
    || path.posix.isAbsolute(rawTarget)
    || path.win32.isAbsolute(rawTarget)
    || /^[A-Za-z]:/.test(rawTarget)) {
    fail('escape');
  }
  const resolvedTarget = resolvePortableRelativePath(path.dirname(shimPath), rawTarget);
  if (!isPathInside(repoRoot, resolvedTarget)) fail('escape');
  if (!pathsMatch(resolvedTarget, cliPath, platform)) fail('mismatch');

  let realShimTarget;
  try {
    realShimTarget = fsImpl.realpathSync(shimPath);
  } catch {
    fail('invalid');
  }
  if (!isPathInside(realPackageRoot, realShimTarget)) fail('escape');
  if (!pathsMatch(realShimTarget, realCliPath, platform)) fail('mismatch');
  try {
    fsImpl.accessSync(shimPath, fs.constants.X_OK);
  } catch {
    throw new Error(`cli_shim_not_executable:${spec.id}:${shimRelative}`);
  }
}

function createCliProbes({
  repoRoot = process.cwd(),
  fsImpl = fs,
  platform = process.platform,
  execPath = process.execPath,
  spawnSyncImpl = spawnSync,
} = {}) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  return CLI_PROBE_SPECS.map((spec) => ({
    id: spec.id,
    run() {
      const packageRoot = path.join(repoRoot, 'node_modules', ...spec.package_name.split('/'));
      const manifestPath = path.join(packageRoot, 'package.json');
      if (!fsImpl.existsSync(manifestPath)) {
        throw new Error(`cli_package_manifest_missing:${spec.id}`);
      }
      const packageManifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
      const lockEntry = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'))
        .packages?.[`node_modules/${spec.package_name}`];
      const installedVersion = String(packageManifest.version || '').trim();
      const lockedVersion = String(lockEntry?.version || '').trim();
      if (!installedVersion || installedVersion !== lockedVersion) {
        throw new Error(
          `cli_version_mismatch:${spec.id}:${installedVersion}:${lockedVersion}`,
        );
      }

      const binTarget = resolvePackageBinTarget(packageManifest, spec.bin_name);
      if (!binTarget) throw new Error(`cli_bin_mapping_missing:${spec.id}:${spec.bin_name}`);
      const normalizedBinTarget = normalizeCliBinTarget(binTarget);
      if (!normalizedBinTarget) throw new Error(`cli_bin_target_invalid:${spec.id}`);
      const lockedBinTarget = normalizeCliBinTarget(
        resolvePackageBinTarget(lockEntry, spec.bin_name),
      );
      if (!lockedBinTarget) throw new Error(`cli_lock_bin_target_invalid:${spec.id}`);
      if (normalizedBinTarget !== lockedBinTarget) {
        throw new Error(`cli_lock_bin_target_mismatch:${spec.id}`);
      }
      const cliPath = resolvePortableRelativePath(packageRoot, normalizedBinTarget);
      if (!isPathInside(packageRoot, cliPath)
        || !fsImpl.existsSync(cliPath)
        || !fsImpl.lstatSync(cliPath).isFile()) {
        throw new Error(`cli_bin_target_invalid:${spec.id}`);
      }
      let realPackageRoot;
      let realCliPath;
      try {
        realPackageRoot = fsImpl.realpathSync(packageRoot);
        realCliPath = fsImpl.realpathSync(cliPath);
      } catch {
        throw new Error(`cli_bin_target_invalid:${spec.id}`);
      }
      if (!isPathInside(realPackageRoot, realCliPath)) {
        throw new Error(`cli_bin_target_invalid:${spec.id}`);
      }

      const shimBase = path.join(repoRoot, 'node_modules', '.bin', spec.bin_name);
      const shimPath = platform === 'win32' ? `${shimBase}.cmd` : shimBase;
      const shimRelative = path.relative(repoRoot, shimPath).replace(/\\/g, '/');
      if (!fsImpl.existsSync(shimPath)) {
        throw new Error(`cli_shim_missing:${spec.id}:${shimRelative}`);
      }
      assertCliShimBinding({
        spec,
        repoRoot,
        shimPath,
        shimRelative,
        cliPath,
        realPackageRoot,
        realCliPath,
        platform,
        fsImpl,
      });

      const crossEnvToken = 'ready';
      const cliArgs = spec.check === 'environment'
        ? [
            `MASARX_CROSS_ENV_PROBE=${crossEnvToken}`,
            execPath,
            '-e',
            'process.stdout.write(process.env.MASARX_CROSS_ENV_PROBE || "")',
          ]
        : ['--version'];
      const result = spawnSyncImpl(execPath, [cliPath, ...cliArgs], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: CONTRACT.probe_timeout_ms,
        killSignal: 'SIGTERM',
        maxBuffer: 1024 * 1024,
      });
      if (result?.error || result?.status !== 0) {
        throw new Error(
          `cli_probe_failed:${spec.id}:${result?.error?.code || result?.status || 'unknown'}`,
        );
      }
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      if (spec.check === 'environment') {
        if (output !== crossEnvToken) throw new Error(`cli_environment_probe_invalid:${spec.id}`);
      } else if (!output.includes(installedVersion)) {
        throw new Error(`cli_version_output_mismatch:${spec.id}:${installedVersion}`);
      }
      return {
        package: spec.package_name,
        version: installedVersion,
        bin_name: spec.bin_name,
        cli_path: path.relative(repoRoot, cliPath).replace(/\\/g, '/'),
        shim_path: shimRelative,
      };
    },
  }));
}

function createProbes({
  repoRoot = process.cwd(),
  fsImpl = fs,
  platform = process.platform,
  execPath = process.execPath,
  spawnSyncImpl = spawnSync,
} = {}) {
  const fromRoot = (...segments) => path.join(repoRoot, ...segments);
  const resolveExpoLockEntry = (fieldOpsRoot, expoRoot, lock) => {
    const resolvedExpoRoot = fsImpl.realpathSync(expoRoot);
    const repoRootPath = path.resolve(repoRoot);
    let lookupDir = path.resolve(fieldOpsRoot);
    while (true) {
      const candidate = path.join(lookupDir, 'node_modules', 'expo');
      const lockKey = path.relative(repoRootPath, candidate).replace(/\\/g, '/');
      if (lock.packages?.[lockKey]) {
        try {
          if (fsImpl.realpathSync(candidate) === resolvedExpoRoot) {
            return { key: lockKey, entry: lock.packages[lockKey] };
          }
        } catch {
          // A missing lookup candidate is not the resolved package path; continue up the chain.
        }
      }
      if (lookupDir === repoRootPath) break;
      const parent = path.dirname(lookupDir);
      if (parent === lookupDir || !isPathInside(repoRootPath, parent)) break;
      lookupDir = parent;
    }
    throw new Error('expo_lock_entry_unresolved');
  };
  return [
    {
      id: 'expo',
      run() {
        const fieldOpsRoot = fromRoot('apps', 'fieldops');
        const packageJsonPath = require.resolve('expo/package.json', { paths: [fieldOpsRoot] });
        const cliPath = require.resolve('expo/bin/cli', { paths: [fieldOpsRoot] });
        const expoRoot = path.dirname(packageJsonPath);
        if (!isPathInside(expoRoot, cliPath)) throw new Error('expo_cli_resolution_invalid');
        const installed = readPackageVersion(packageJsonPath, fsImpl);
        const lock = JSON.parse(fsImpl.readFileSync(fromRoot('package-lock.json'), 'utf8'));
        const locked = resolveExpoLockEntry(fieldOpsRoot, expoRoot, lock).entry?.version;
        if (!installed || installed !== locked) throw new Error(`expo_version_mismatch:${installed}:${locked || ''}`);
        return { version: installed, cli_path: path.relative(repoRoot, cliPath).replace(/\\/g, '/') };
      },
    },
    {
      id: 'metro',
      run() {
        const config = require(fromRoot('apps', 'fieldops', 'metro.config.js'));
        if (!config?.resolver || !Array.isArray(config.watchFolders)) throw new Error('metro_config_invalid');
        return { resolver: true, watch_folder_count: config.watchFolders.length };
      },
    },
    {
      id: 'parcel_watcher',
      run() {
        const watcher = require(fromRoot('node_modules', '@parcel', 'watcher'));
        if (typeof watcher.subscribe !== 'function') throw new Error('parcel_watcher_binding_unavailable');
        return { binding: true };
      },
    },
    {
      id: 'esbuild',
      run() {
        const esbuild = require(fromRoot('node_modules', 'esbuild'));
        const transformed = esbuild.transformSync('let unitQualification = 1', { minify: true });
        if (!String(transformed?.code || '').trim()) throw new Error('esbuild_transform_failed');
        return { version: esbuild.version };
      },
    },
    {
      id: 'swc',
      run() {
        const swc = require(require.resolve('@swc/core', { paths: [repoRoot] }));
        const transformed = swc.transformSync('const unitQualification = 1');
        if (!String(transformed?.code || '').trim()) throw new Error('swc_transform_failed');
        return { version: swc.version };
      },
    },
    {
      id: 'nx_native',
      run() {
        const nxNative = require(require.resolve('nx/src/native', { paths: [repoRoot] }));
        const exportCount = Object.keys(nxNative || {}).length;
        if (!exportCount) throw new Error('nx_native_binding_unavailable');
        return { export_count: exportCount };
      },
    },
    {
      id: 'unrs_resolver',
      run() {
        const resolver = require(fromRoot('node_modules', 'unrs-resolver'));
        const exportCount = Object.keys(resolver || {}).length;
        if (!exportCount) throw new Error('unrs_resolver_binding_unavailable');
        return { export_count: exportCount };
      },
    },
    {
      id: 'sentry_cli',
      run() {
        const fieldOpsRoot = fromRoot('apps', 'fieldops');
        const packageJsonPath = require.resolve('@sentry/cli/package.json', { paths: [fieldOpsRoot] });
        const expectedVersion = readPackageVersion(packageJsonPath);
        const cliPath = require(require.resolve('@sentry/cli', { paths: [fieldOpsRoot] })).getPath();
        if (!fsImpl.existsSync(cliPath)) throw new Error('sentry_cli_binary_missing');
        const result = spawnSyncImpl(cliPath, ['--version'], {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: CONTRACT.probe_timeout_ms,
        });
        if (result?.error || result?.status !== 0) {
          throw new Error(`sentry_cli_probe_failed:${result?.error?.message || result?.status || 'unknown'}`);
        }
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (!output.includes(expectedVersion)) throw new Error('sentry_cli_version_mismatch');
        return { version: expectedVersion };
      },
    },
    ...createCliProbes({ repoRoot, fsImpl, platform, execPath, spawnSyncImpl }),
  ];
}

function resolveInstallTimeout(contract = CONTRACT, platform = process.platform) {
  return platform === 'win32' ? contract.windows_timeout_ms : contract.timeout_ms;
}

function runSingleProbe({ probeId, probes = createProbes() } = {}) {
  let processIdentity = null;
  if (process.env.MASARX_DEPENDENCY_PROJECTION_PROBE_IDENTITY === '1') {
    const entry = collectProcessSnapshot().find((candidate) => Number(candidate.pid) === process.pid);
    const creationTicks = String(entry?.creation_ticks || '');
    if (!entry || (process.platform === 'win32' && !/^[1-9]\d*$/.test(creationTicks))) {
      return {
        schema: 'masarx.unit-qualification-dependency-probe.v1',
        id: String(probeId || ''),
        passed: false,
        error: 'probe_process_identity_unavailable',
      };
    }
    processIdentity = { pid: process.pid, creation_ticks: creationTicks };
  }
  const matches = probes.filter((probe) => probe.id === probeId);
  if (matches.length !== 1) {
    return {
      schema: 'masarx.unit-qualification-dependency-probe.v1',
      id: String(probeId || ''),
      passed: false,
      error: matches.length ? 'probe_id_ambiguous' : 'probe_id_unknown',
      process_identity: processIdentity,
    };
  }
  try {
    return {
      schema: 'masarx.unit-qualification-dependency-probe.v1',
      id: probeId,
      passed: true,
      evidence: matches[0].run() || {},
      process_identity: processIdentity,
    };
  } catch (error) {
    return {
      schema: 'masarx.unit-qualification-dependency-probe.v1',
      id: probeId,
      passed: false,
      error: String(error?.message || error),
      process_identity: processIdentity,
    };
  }
}

function runProbeInChild(probe, {
  contract = CONTRACT,
  repoRoot = process.cwd(),
  spawnSyncImpl = spawnSync,
  onChildResult = () => {},
  env = process.env,
} = {}) {
  const timeoutMs = probe.id === 'metro' ? contract.metro_probe_timeout_ms : contract.probe_timeout_ms;
  const result = spawnSyncImpl(process.execPath, [__filename, '--run-probe', probe.id], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  });
  const receipt = parseLastJsonLine(result?.stdout);
  onChildResult({
    pid: Number.isInteger(result?.pid) ? result.pid : null,
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    error_code: result?.error?.code || null,
    process_identity: receipt?.process_identity || null,
  });
  if (result?.error?.code === 'ETIMEDOUT') {
    const receiptState = receipt?.schema === 'masarx.unit-qualification-dependency-probe.v1'
      && receipt.id === probe.id && typeof receipt.passed === 'boolean'
      ? (receipt.passed ? 'passed' : 'failed')
      : 'none';
    throw new Error(`probe_timed_out:${probe.id}:${timeoutMs}:receipt=${receiptState}`);
  }
  if (result?.error) {
    throw new Error(`probe_child_failed:${probe.id}:${result.error.message}`);
  }
  if (result?.status !== 0 || receipt?.passed !== true) {
    throw new Error(`probe_failed:${probe.id}:${receipt?.error || result?.status || 'invalid_receipt'}`);
  }
  if (receipt.schema !== 'masarx.unit-qualification-dependency-probe.v1' || receipt.id !== probe.id) {
    throw new Error(`probe_receipt_invalid:${probe.id}`);
  }
  return receipt.evidence || {};
}

function runProbes({
  probes = createProbes(),
  contract = CONTRACT,
  runProbeImpl = (probe) => runProbeInChild(probe, { contract }),
  rethrowErrorImpl = () => false,
} = {}) {
  const startedAt = new Date().toISOString();
  const results = probes.map((probe) => {
    const probeStartedAt = new Date().toISOString();
    try {
      const evidence = runProbeImpl(probe) || {};
      return {
        id: probe.id,
        passed: true,
        started_at: probeStartedAt,
        completed_at: new Date().toISOString(),
        evidence,
      };
    } catch (error) {
      if (rethrowErrorImpl(error, probe)) throw error;
      return {
        id: probe.id,
        passed: false,
        started_at: probeStartedAt,
        completed_at: new Date().toISOString(),
        error: String(error?.message || error),
      };
    }
  });
  const resultIds = results.map((entry) => entry.id);
  const missingProbeIds = contract.required_probe_ids.filter((probeId) => !resultIds.includes(probeId));
  const duplicateProbeIds = resultIds.filter((probeId, index) => resultIds.indexOf(probeId) !== index);
  return {
    schema: 'masarx.unit-qualification-dependency-probes.v1',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    passed: results.every((entry) => entry.passed) && !missingProbeIds.length && !duplicateProbeIds.length,
    failed_probe_ids: results.filter((entry) => !entry.passed).map((entry) => entry.id),
    missing_probe_ids: missingProbeIds,
    duplicate_probe_ids: [...new Set(duplicateProbeIds)],
    results,
  };
}

function completeQualification({
  preparation,
  probes,
  runPurgeImpl = runDependencyTreeQuarantinePurge,
} = {}) {
  if (!preparation?.passed || !preparation?.install?.task_temp_root) {
    return { passed: false, purge: null };
  }
  const purge = runPurgeImpl({
    taskTempRoot: preparation.install.task_temp_root,
  });
  return {
    passed: probes?.passed === true && purge?.passed === true,
    purge,
  };
}

function main() {
  const validation = validateContract();
  if (!validation.ok) throw new Error(validation.errors.join(','));
  const probeArgumentIndex = process.argv.indexOf('--run-probe');
  if (probeArgumentIndex !== -1) {
    const receipt = runSingleProbe({ probeId: process.argv[probeArgumentIndex + 1] });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (!receipt.passed) process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--quarantine-dependency-tree')) {
    const taskTempRoot = resolveTaskTempRoot(process.env);
    const receipt = performDependencyTreeQuarantine({ taskTempRoot });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (!receipt.passed) process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--purge-dependency-quarantine-child')) {
    process.stdout.write(`${JSON.stringify(performDependencyTreeQuarantinePurge())}\n`);
    return;
  }
  if (process.argv.includes('--purge-dependency-quarantine')) {
    const taskTempRoot = resolveTaskTempRoot(process.env);
    const receipt = runDependencyTreeQuarantinePurge({ taskTempRoot });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (!receipt.passed) process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--print-contract')) {
    process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
    return;
  }
  const preparation = runInstall();
  if (!preparation.passed) {
    process.stdout.write(`${JSON.stringify({ contract: CONTRACT, ...preparation, probes: null })}\n`);
    process.exitCode = 1;
    return;
  }
  const probes = runProbes();
  const completion = completeQualification({ preparation, probes });
  if (!completion.passed) reportDebugLog(preparation.install.debug_log_path, { error: true });
  process.stdout.write(`${JSON.stringify({
    contract: CONTRACT,
    ...preparation,
    passed: completion.passed,
    probes,
    purge: completion.purge,
  })}\n`);
  if (!completion.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  CLI_PROBE_SPECS,
  CONTRACT,
  PROBE_CONTRACT,
  assertCliShimBinding,
  assertNoCompetingNpmInstall,
  collectProcessSnapshot,
  completeQualification,
  createCliProbes,
  createProbes,
  detectCompetingNpmInstalls,
  findLatestDebugLog,
  githubEscape,
  isPathInside,
  parseLastJsonLine,
  performDependencyTreeQuarantine,
  performDependencyTreeQuarantinePurge,
  rollbackDependencyTreeQuarantine,
  readPackageVersion,
  reportDebugLog,
  prepareTaskTempRoot,
  resolveLogDirectory,
  resolveDependencyTreeTargets,
  resolveDependencyTreeQuarantinePlan,
  resolveInstallTimeout,
  resolveNpmInvocation,
  resolveTaskTempRoot,
  runInstall,
  runDependencyTreeQuarantine,
  runDependencyTreeQuarantinePurge,
  runProbeInChild,
  runProbes,
  runSingleProbe,
  validateDependencyTreeQuarantineManifest,
  validateContract,
  validateInstallEnvironment,
};
