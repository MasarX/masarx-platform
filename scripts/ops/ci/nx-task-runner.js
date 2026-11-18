#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require('child_process');
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

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    mode: 'run-many',
    targets: [],
    projects: [],
    files: [],
    outputStyle: 'static',
    fallbackCommand: '',
    fallbackArgsJson: '',
    allowFallbackOnError: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--mode') out.mode = String(argv[i + 1] || '').trim() || out.mode;
    else if (token.startsWith('--mode=')) out.mode = token.split('=').slice(1).join('=').trim() || out.mode;
    else if (token === '--targets') out.targets = parseCsv(argv[i + 1]);
    else if (token.startsWith('--targets=')) out.targets = parseCsv(token.split('=').slice(1).join('='));
    else if (token === '--projects') out.projects = parseCsv(argv[i + 1]);
    else if (token.startsWith('--projects=')) out.projects = parseCsv(token.split('=').slice(1).join('='));
    else if (token === '--files') out.files = parseCsv(argv[i + 1]);
    else if (token.startsWith('--files=')) out.files = parseCsv(token.split('=').slice(1).join('='));
    else if (token === '--output-style') out.outputStyle = String(argv[i + 1] || '').trim() || out.outputStyle;
    else if (token.startsWith('--output-style=')) out.outputStyle = token.split('=').slice(1).join('=').trim() || out.outputStyle;
    else if (token === '--fallback-command') out.fallbackCommand = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--fallback-command=')) out.fallbackCommand = token.split('=').slice(1).join('=').trim();
    else if (token === '--fallback-args-json') out.fallbackArgsJson = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--fallback-args-json=')) out.fallbackArgsJson = token.split('=').slice(1).join('=').trim();
    else if (token === '--allow-fallback-on-error') out.allowFallbackOnError = !/^(0|false|no|off)$/i.test(String(argv[i + 1] || '').trim());
    else if (token.startsWith('--allow-fallback-on-error=')) out.allowFallbackOnError = !/^(0|false|no|off)$/i.test(token.split('=').slice(1).join('=').trim());
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

function resolveFiles(args, env = process.env) {
  if (args.files.length) return Array.from(new Set(args.files));
  const jsonFiles = loadJsonArray(env.NX_TASK_FILES_JSON || env.LOCAL_GATE_CHANGED_FILES_JSON);
  if (jsonFiles.length) return Array.from(new Set(jsonFiles));
  return parseCsv(env.LOCAL_GATE_CHANGED_FILES);
}

function resolveFallbackArgs(args) {
  if (!args.fallbackArgsJson) return [];
  const parsed = loadJsonArray(args.fallbackArgsJson);
  return parsed.map((value) => String(value || ''));
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

function shellRequired(command) {
  return process.platform === 'win32' && (command === 'npx' || command === 'npm' || /\.cmd$/i.test(command));
}

function runCommand(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env,
    shell: shellRequired(command),
  });
  if (result.error) {
    return { ok: false, status: result.status || 1, error: result.error.message };
  }
  return { ok: result.status === 0, status: result.status || 0, error: '' };
}

function runCommandCapture(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env,
    shell: shellRequired(command),
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status || 0,
    error: result.error ? result.error.message : '',
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function buildNxArgs({ mode, targets, projects, files, outputStyle }) {
  const nextMode = String(mode || 'run-many').trim().toLowerCase();
  const nextTargets = Array.from(new Set((Array.isArray(targets) ? targets : []).map((value) => String(value || '').trim()).filter(Boolean)));
  const nextProjects = Array.from(new Set((Array.isArray(projects) ? projects : []).map((value) => String(value || '').trim()).filter(Boolean)));
  const nextFiles = Array.from(new Set((Array.isArray(files) ? files : []).map((value) => String(value || '').trim()).filter(Boolean)));

  if (!nextTargets.length) {
    throw new Error('At least one target is required.');
  }
  if (nextMode !== 'affected' && nextMode !== 'run-many') {
    throw new Error(`Unsupported mode "${mode}".`);
  }

  const args = ['--no-install', 'nx', nextMode, `--targets=${nextTargets.join(',')}`, `--outputStyle=${String(outputStyle || 'static').trim() || 'static'}`];
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
    const detail = String(result.error || result.stderr || '').trim();
    throw new Error(`Nx affected project discovery failed (exit ${result.status})${detail ? `: ${detail}` : ''}.`);
  }

  const resolvedProjects = parseJsonArray(result.stdout);
  const resolvedSet = new Set(resolvedProjects.map((value) => value.toLowerCase()));
  return requestedProjects.filter((value) => resolvedSet.has(value.toLowerCase()));
}

function maybeRunFallback(args, env, reason) {
  if (!args.fallbackCommand) {
    throw new Error(reason);
  }
  console.warn(`[nx-task-runner] ${reason}; falling back to "${args.fallbackCommand}".`);
  const fallbackArgs = resolveFallbackArgs(args);
  const result = runCommand(args.fallbackCommand, fallbackArgs, env);
  if (!result.ok) {
    throw new Error(`Fallback command failed (exit ${result.status}).`);
  }
}

function skipAffectedSelection(reason, files = []) {
  console.warn(`[nx-task-runner] ${reason}; no selected affected project tasks to run.`);
  return { mode: 'skipped', files };
}

function runNxTaskRunner({
  args = parseArgs(),
  env = process.env,
  runCommandCaptureImpl = runCommandCapture,
} = {}) {
  const files = resolveFiles(args, env);
  if (shouldBypassNxForRootProject(args)) {
    maybeRunFallback(args, env, 'Bypassing Nx run-many for the root project.');
    return { mode: 'fallback', files, bypassedNx: true };
  }
  if (String(args.mode || '').trim().toLowerCase() === 'affected' && files.length === 0) {
    return skipAffectedSelection('No changed files were available for nx affected.', []);
  }

  if (!nxAvailable()) {
    maybeRunFallback(args, env, 'Nx is not installed.');
    return { mode: 'fallback', files };
  }

  let nxArgs;
  let effectiveMode = String(args.mode || 'run-many').trim().toLowerCase();
  let effectiveProjects = Array.isArray(args.projects) ? args.projects.slice() : [];
  try {
    if (effectiveMode === 'affected' && effectiveProjects.length > 0) {
      const affectedProjects = resolveAffectedProjectSubset({
        projects: effectiveProjects,
        files,
        env,
        runCommandCaptureImpl,
      });
      if (!affectedProjects.length) {
        return skipAffectedSelection('No selected projects were affected.', files);
      }
      effectiveMode = 'run-many';
      effectiveProjects = affectedProjects;
    }
    nxArgs = buildNxArgs({
      mode: effectiveMode,
      targets: args.targets,
      projects: effectiveProjects,
      files,
      outputStyle: args.outputStyle,
    });
  } catch (error) {
    if (effectiveMode === 'affected' && effectiveProjects.length > 0 && /\(exit 0\)/.test(error.message || '')) {
      return skipAffectedSelection(error.message || 'Nx affected project discovery failed.', files);
    }
    if (!args.allowFallbackOnError) throw error;
    maybeRunFallback(args, env, error.message || String(error));
    return { mode: 'fallback', files };
  }

  const result = runCommand('npx', nxArgs, env);
  if (!result.ok) {
    if (!args.allowFallbackOnError) {
      throw new Error(`Nx command failed (exit ${result.status}).`);
    }
    maybeRunFallback(args, env, `Nx command failed (exit ${result.status}).`);
    return { mode: 'fallback', files };
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
  nxAvailable,
  parseJsonArray,
  parseArgs,
  resolveAffectedProjectSubset,
  resolveFiles,
  shouldBypassNxForRootProject,
  skipAffectedSelection,
  runNxTaskRunner,
};
