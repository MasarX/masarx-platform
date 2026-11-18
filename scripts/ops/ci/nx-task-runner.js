#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_PACKAGE = require(path.join(__dirname, '..', '..', '..', 'package.json'));
const ROOT_NX_PROJECT = String(ROOT_PACKAGE?.name || '').trim().toLowerCase();

function die(message) {
  console.error(`[nx-task-runner] ${message}`);
  process.exit(1);
}

function parseCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function parseRequiredCsv(raw, option) {
  const values = parseCsv(raw);
  if (!values.length) throw new Error(`At least one value is required for ${option}.`);
  return values;
}

function readRequiredOptionValue(argv, index, option) {
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function readInlineOptionValue(token, option) {
  const value = String(token).slice(option.length + 1).trim();
  if (!value) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    mode: 'run-many',
    targets: [],
    projects: [],
    files: [],
    outputStyle: 'static',
    fallbackCommand: '',
    fallbackArgsJson: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) {
      throw new Error('Unsupported empty argument.');
    }
    if (token === '--mode') {
      out.mode = readRequiredOptionValue(argv, i, token);
      i += 1;
    } else if (token.startsWith('--mode=')) out.mode = readInlineOptionValue(token, '--mode');
    else if (token === '--targets') {
      out.targets = parseRequiredCsv(readRequiredOptionValue(argv, i, token), token);
      i += 1;
    } else if (token.startsWith('--targets=')) out.targets = parseRequiredCsv(readInlineOptionValue(token, '--targets'), '--targets');
    else if (token === '--projects') {
      out.projects = parseRequiredCsv(readRequiredOptionValue(argv, i, token), token);
      i += 1;
    } else if (token.startsWith('--projects=')) out.projects = parseRequiredCsv(readInlineOptionValue(token, '--projects'), '--projects');
    else if (token === '--files') {
      out.files = parseRequiredCsv(readRequiredOptionValue(argv, i, token), token);
      i += 1;
    } else if (token.startsWith('--files=')) out.files = parseRequiredCsv(readInlineOptionValue(token, '--files'), '--files');
    else if (token === '--output-style') {
      out.outputStyle = readRequiredOptionValue(argv, i, token);
      i += 1;
    } else if (token.startsWith('--output-style=')) out.outputStyle = readInlineOptionValue(token, '--output-style');
    else if (token === '--fallback-command') {
      out.fallbackCommand = readRequiredOptionValue(argv, i, token);
      i += 1;
    } else if (token.startsWith('--fallback-command=')) out.fallbackCommand = readInlineOptionValue(token, '--fallback-command');
    else if (token === '--fallback-args-json') {
      out.fallbackArgsJson = readRequiredOptionValue(argv, i, token);
      i += 1;
    } else if (token.startsWith('--fallback-args-json=')) out.fallbackArgsJson = readInlineOptionValue(token, '--fallback-args-json');
    else throw new Error(`Unsupported argument "${token}".`);
  }

  return out;
}

function loadJsonArray(raw, fallback = []) {
  const text = String(raw || '').trim();
  if (!text) return Array.isArray(fallback) ? fallback.slice() : [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value || '').trim()).filter(Boolean)
      : Array.isArray(fallback) ? fallback.slice() : [];
  } catch {
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
}

function parseStrictStringArray(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(`${label} must be a valid JSON array of exact non-empty strings.`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((value) => typeof value !== 'string' || !value || value !== value.trim())
  ) {
    throw new Error(`${label} must be a valid JSON array of exact non-empty strings.`);
  }
  return Array.from(new Set(parsed));
}

function resolveFiles(args, env = process.env) {
  if (args.files.length) return Array.from(new Set(args.files));
  if (Object.prototype.hasOwnProperty.call(env, 'NX_TASK_FILES_JSON')) {
    return parseStrictStringArray(env.NX_TASK_FILES_JSON, 'NX_TASK_FILES_JSON');
  }
  if (Object.prototype.hasOwnProperty.call(env, 'LOCAL_GATE_CHANGED_FILES_JSON')) {
    return parseStrictStringArray(env.LOCAL_GATE_CHANGED_FILES_JSON, 'LOCAL_GATE_CHANGED_FILES_JSON');
  }
  const legacyFiles = parseCsv(env.LOCAL_GATE_CHANGED_FILES);
  if (legacyFiles.length) return legacyFiles;
  if (String(args.mode || '').trim().toLowerCase() === 'affected') {
    throw new Error('Affected execution requires explicit files or a validated JSON selection.');
  }
  return [];
}

function resolveFallbackArgs(args) {
  if (!args.fallbackArgsJson) return [];
  const parsed = loadJsonArray(args.fallbackArgsJson);
  return parsed.map((value) => String(value || ''));
}

function normalizeCommandName(command) {
  return path.basename(String(command || '').trim()).toLowerCase();
}

function normalizeValues(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  ));
}

function isEquivalentFallback(args = {}, { rootPackage = ROOT_PACKAGE } = {}) {
  if (!['npm', 'npm.cmd'].includes(normalizeCommandName(args.fallbackCommand))) return false;
  const fallbackArgs = resolveFallbackArgs(args);
  if (fallbackArgs.length !== 2 || fallbackArgs[0] !== 'run') return false;

  const fallbackScript = String(fallbackArgs[1] || '').trim();
  const packageScripts = rootPackage?.scripts && typeof rootPackage.scripts === 'object'
    ? rootPackage.scripts
    : {};
  const fallbackCommand = String(packageScripts[fallbackScript] || '').trim();
  if (!fallbackScript || !fallbackCommand) return false;

  const mode = String(args.mode || 'run-many').trim().toLowerCase();
  const targets = normalizeValues(args.targets);
  const projects = normalizeValues(args.projects);
  if (
    mode === 'run-many'
    && targets.length === 1
    && projects.length === 1
    && projects[0] === ROOT_NX_PROJECT
  ) {
    return fallbackScript.toLowerCase() === targets[0];
  }

  const frontendProjects = ['@masarx/console', '@masarx/portal'];
  const frontendTargets = ['lint', 'typecheck'];
  if (
    mode !== 'affected'
    || projects.length !== frontendProjects.length
    || targets.length !== frontendTargets.length
    || !frontendProjects.every((project) => projects.includes(project))
    || !frontendTargets.every((target) => targets.includes(target))
  ) {
    return false;
  }

  const normalizedFallbackCommand = fallbackCommand.replace(/\s+/g, ' ').trim().toLowerCase();
  const canonicalFallbackCommand = [
    'npm --prefix apps/console run lint',
    'npm --prefix apps/console run typecheck',
    'npm --prefix apps/portal run lint',
    'npm --prefix apps/portal run typecheck',
  ].join(' && ');
  return normalizedFallbackCommand === canonicalFallbackCommand;
}

function shouldBypassNxForRootProject(args = {}) {
  const mode = String(args.mode || 'run-many').trim().toLowerCase();
  const fallbackCommand = String(args.fallbackCommand || '').trim();
  const projects = Array.from(new Set(
    (Array.isArray(args.projects) ? args.projects : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  ));
  return mode === 'run-many'
    && Boolean(fallbackCommand)
    && Boolean(ROOT_NX_PROJECT)
    && projects.length === 1
    && projects[0] === ROOT_NX_PROJECT;
}

function nxAvailable(cwd = process.cwd()) {
  try {
    require.resolve('nx/package.json', { paths: [cwd] });
    return true;
  } catch {
    return false;
  }
}

function resolveCommandInvocation(command, commandArgs, {
  platform = process.platform,
  processExecPath = process.execPath,
  existsSyncImpl = fs.existsSync,
} = {}) {
  const executable = String(command || '').trim();
  const args = Array.isArray(commandArgs) ? commandArgs.slice() : [];
  const commandName = normalizeCommandName(executable);
  if (String(platform).toLowerCase() !== 'win32' || !['npm', 'npm.cmd', 'npx', 'npx.cmd'].includes(commandName)) {
    return { executable, args };
  }

  const pathImpl = path.win32;
  const cliName = commandName.startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
  const cliPath = pathImpl.join(pathImpl.dirname(processExecPath), 'node_modules', 'npm', 'bin', cliName);
  if (!existsSyncImpl(cliPath)) {
    throw new Error(`Bundled ${cliName} was not found for shell-free Windows execution.`);
  }
  return {
    executable: processExecPath,
    args: [cliPath, ...args],
  };
}

function deterministicNxEnv(env = process.env) {
  return { ...env, NX_DAEMON: 'false' };
}

function commandResult(result) {
  const ok = !result.error && !result.signal && result.status === 0;
  return {
    ok,
    status: ok ? 0 : (Number.isInteger(result.status) && result.status !== 0 ? result.status : 1),
    error: result.error?.message || (result.signal ? `Terminated by ${result.signal}` : ''),
  };
}

function runCommand(command, commandArgs, env = process.env, options = {}) {
  let invocation;
  try {
    invocation = resolveCommandInvocation(command, commandArgs, options);
  } catch (error) {
    return { ok: false, status: 1, error: error.message || String(error) };
  }
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl(invocation.executable, invocation.args, {
    stdio: 'inherit',
    env: deterministicNxEnv(env),
    shell: false,
    windowsHide: true,
  });
  return commandResult(result);
}

function runCommandCapture(command, commandArgs, env = process.env, options = {}) {
  let invocation;
  try {
    invocation = resolveCommandInvocation(command, commandArgs, options);
  } catch (error) {
    return {
      ok: false,
      status: 1,
      error: error.message || String(error),
      stdout: '',
      stderr: '',
    };
  }
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl(invocation.executable, invocation.args, {
    encoding: 'utf8',
    env: deterministicNxEnv(env),
    shell: false,
    windowsHide: true,
  });
  return {
    ...commandResult(result),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function validateRunnerArgs({ mode, targets } = {}) {
  const nextMode = String(mode || 'run-many').trim().toLowerCase();
  if (nextMode !== 'affected' && nextMode !== 'run-many') {
    throw new Error(`Unsupported mode "${mode}".`);
  }
  if (
    !Array.isArray(targets)
    || targets.length === 0
    || targets.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('At least one target is required.');
  }
}

function validateNxArgumentValues({ targets, projects, files, outputStyle } = {}) {
  for (const [label, values] of [['target', targets], ['project', projects], ['file', files]]) {
    const invalidValue = (Array.isArray(values) ? values : [])
      .find((value) => /[,\u0000-\u001f\u007f]/.test(String(value)));
    if (invalidValue !== undefined) {
      throw new Error(`Nx ${label} values must not contain commas or control characters.`);
    }
  }
  const nextOutputStyle = String(outputStyle || 'static').trim() || 'static';
  if (!/^[a-z][a-z0-9-]*$/i.test(nextOutputStyle)) {
    throw new Error('Nx output style must be a canonical identifier.');
  }
  return nextOutputStyle;
}

function buildNxArgs({ mode, targets, projects, files, outputStyle }) {
  validateRunnerArgs({ mode, targets });
  const nextMode = String(mode || 'run-many').trim().toLowerCase();
  const nextTargets = Array.from(new Set((Array.isArray(targets) ? targets : []).map((value) => String(value || '').trim()).filter(Boolean)));
  const nextProjects = Array.from(new Set((Array.isArray(projects) ? projects : []).map((value) => String(value || '').trim()).filter(Boolean)));
  const nextFiles = Array.from(new Set((Array.isArray(files) ? files : []).map((value) => String(value || '').trim()).filter(Boolean)));
  const nextOutputStyle = validateNxArgumentValues({
    targets: nextTargets,
    projects: nextProjects,
    files: nextFiles,
    outputStyle,
  });

  const args = ['--no-install', 'nx', nextMode, `--targets=${nextTargets.join(',')}`, `--outputStyle=${nextOutputStyle}`];
  if (nextProjects.length) {
    args.push(`--projects=${nextProjects.join(',')}`);
  }
  if (nextMode === 'affected' && nextFiles.length) {
    args.push(`--files=${nextFiles.join(',')}`);
  }
  if (nextMode === 'run-many') {
    args.push('--excludeTaskDependencies');
  }

  return args;
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(String(raw || '').trim() || '[]');
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parseJsonArrayStrict(raw, label) {
  const text = String(raw || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return a valid JSON array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} did not return a valid JSON array.`);
  }
  if (parsed.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
  return Array.from(new Set(parsed.map((value) => value.trim())));
}

function resolveAffectedProjectSubset({
  projects = [],
  files = [],
  env = process.env,
  runCommandCaptureImpl = runCommandCapture,
} = {}) {
  const requestedProjects = Array.from(new Set((Array.isArray(projects) ? projects : []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (!requestedProjects.length) return [];

  const showArgs = [
    '--no-install',
    'nx',
    'show',
    'projects',
    '--affected',
    '--json',
    `--projects=${requestedProjects.join(',')}`,
  ];
  const nextFiles = Array.from(new Set((Array.isArray(files) ? files : []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (nextFiles.length) {
    showArgs.push(`--files=${nextFiles.join(',')}`);
  }

  const result = runCommandCaptureImpl('npx', showArgs, env);
  if (!result.ok) {
    throw new Error(`Nx affected project discovery failed (exit ${result.status})${result.error ? ': ' + result.error : ''}.`);
  }

  const resolvedProjects = parseJsonArrayStrict(result.stdout, 'Nx affected project discovery');
  const requestedSet = new Set(requestedProjects.map((value) => value.toLowerCase()));
  const unknownProject = resolvedProjects.find((value) => !requestedSet.has(value.toLowerCase()));
  if (unknownProject) {
    throw new Error(`Nx affected project discovery returned unknown project "${unknownProject}".`);
  }
  const resolvedSet = new Set(resolvedProjects.map((value) => value.toLowerCase()));
  return requestedProjects.filter((value) => resolvedSet.has(value.toLowerCase()));
}

function maybeRunFallback(args, env, reason, {
  logger = console,
  rootPackage = ROOT_PACKAGE,
  runCommandImpl = runCommand,
} = {}) {
  if (!args.fallbackCommand) {
    throw new Error(reason);
  }
  if (!isEquivalentFallback(args, { rootPackage })) {
    throw new Error(`${reason} Declared fallback is not target-equivalent.`);
  }
  logger.warn(`[nx-task-runner] ${reason}; falling back to "${args.fallbackCommand}".`);
  const fallbackArgs = resolveFallbackArgs(args);
  const result = runCommandImpl(args.fallbackCommand, fallbackArgs, env);
  if (!result.ok) {
    throw new Error(`Fallback command failed (exit ${result.status})${result.error ? ': ' + result.error : ''}.`);
  }
}

function runNxTaskRunner({
  args = parseArgs(),
  env = process.env,
  logger = console,
  nxAvailableImpl = nxAvailable,
  rootPackage = ROOT_PACKAGE,
  runCommandImpl = runCommand,
  runCommandCaptureImpl = runCommandCapture,
} = {}) {
  validateRunnerArgs(args);
  const files = resolveFiles(args, env);
  validateNxArgumentValues({ ...args, files });
  if (shouldBypassNxForRootProject(args)) {
    maybeRunFallback(args, env, 'Bypassing Nx run-many for the root project.', {
      logger,
      rootPackage,
      runCommandImpl,
    });
    return { mode: 'fallback', files, bypassedNx: true };
  }
  if (String(args.mode || '').trim().toLowerCase() === 'affected' && files.length === 0) {
    return { mode: 'skipped', files: [], reason: 'no_changed_files' };
  }

  if (!nxAvailableImpl(process.cwd())) {
    maybeRunFallback(args, env, 'Nx is not installed.', {
      logger,
      rootPackage,
      runCommandImpl,
    });
    return { mode: 'fallback', files };
  }

  let effectiveMode = String(args.mode || 'run-many').trim().toLowerCase();
  let effectiveProjects = Array.isArray(args.projects) ? args.projects.slice() : [];
  if (effectiveMode === 'affected' && effectiveProjects.length > 0) {
    const affectedProjects = resolveAffectedProjectSubset({
      projects: effectiveProjects,
      files,
      env,
      runCommandCaptureImpl,
    });
    if (!affectedProjects.length) {
      return { mode: 'skipped', files, reason: 'no_selected_projects' };
    }
    effectiveMode = 'run-many';
    effectiveProjects = affectedProjects;
  }
  const nxArgs = buildNxArgs({
    mode: effectiveMode,
    targets: args.targets,
    projects: effectiveProjects,
    files,
    outputStyle: args.outputStyle,
  });

  const result = runCommandImpl('npx', nxArgs, env);
  if (!result.ok) {
    throw new Error(`Nx command failed (exit ${result.status})${result.error ? ': ' + result.error : ''}.`);
  }

  return {
    mode: effectiveMode,
    files,
    nxArgs,
    projects: effectiveProjects,
  };
}

if (require.main === module) {
  try {
    runNxTaskRunner();
  } catch (error) {
    die(error.message || String(error));
  }
}

module.exports = {
  buildNxArgs,
  isEquivalentFallback,
  nxAvailable,
  parseJsonArray,
  parseArgs,
  resolveCommandInvocation,
  resolveAffectedProjectSubset,
  resolveFiles,
  runCommand,
  runCommandCapture,
  shouldBypassNxForRootProject,
  validateNxArgumentValues,
  runNxTaskRunner,
};
