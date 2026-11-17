#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * with-preview-env.js
 *
 * Provision a Supabase preview environment (if needed) and run a command with
 * an ephemeral overlay in ENV_FILE.
 *
 * This keeps local repos free of long-lived static project credentials while still
 * supporting local PR/feature end-to-end cloud workflows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync: defaultSpawnSync } = require('child_process');

function printHelp() {
  console.log([
    'Usage:',
    '  npm run with-preview-env -- --pr <PR_NUMBER> -- <command...>',
    '  npm run with-preview-env -- --name <workspace-name> -- <command...>',
    '  npm run with-preview-env -- --pr <PR_NUMBER> --env-file /tmp/preview.env.cloud -- <command...>',
    '',
    'Options:',
    '  --pr <number>            PR number (used to compute deterministic workspace name).',
    '  --name <workspace-name>   Explicit workspace name.',
    '  --env-file <path>        Use a custom overlay file instead of a temp file.',
    '  --keep                    Keep the generated env file for inspection/debug.',
    '  --help, -h               Show this message and exit.',
    '',
    'Notes:',
    '  - Preview credentials are loaded from existing environment variables (typically GitHub Actions secrets).',
    '  - The generated overlay is deleted by default after the command completes.',
    '  - Child command inherits dynamic ENV_FILE only for process scope.',
  ].join('\n'));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    keep: false,
    pr: '',
    name: '',
    envFile: '',
    command: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') continue;
    if (token === '--help' || token === '-h') {
      args.help = true;
      return args;
    }
    if (token === '--') {
      args.command = argv.slice(i + 1);
      return args;
    }
    if (token === '--keep') {
      args.keep = true;
      continue;
    }
    if (token === '--pr' || token.startsWith('--pr=')) {
      args.pr = token.startsWith('--pr=')
        ? token.slice('--pr='.length)
        : argv[i + 1] || '';
      if (!token.startsWith('--pr=')) i += 1;
      continue;
    }
    if (token === '--name' || token.startsWith('--name=')) {
      args.name = token.startsWith('--name=')
        ? token.slice('--name='.length)
        : argv[i + 1] || '';
      if (!token.startsWith('--name=')) i += 1;
      continue;
    }
    if (token === '--env-file' || token.startsWith('--env-file=')) {
      args.envFile = token.startsWith('--env-file=')
        ? token.slice('--env-file='.length)
        : argv[i + 1] || '';
      if (!token.startsWith('--env-file=')) i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    args.command = argv.slice(i);
    return args;
  }

  return args;
}

function parsePreviewJson(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('{');
  if (start < 0) return null;
  const candidate = text.slice(start);
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function defaultEnvFile({ explicitEnvFile }) {
  if (explicitEnvFile) return explicitEnvFile;
  const token = crypto.randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), `masarx-preview-${token}.env.cloud`);
}

function isSuccessStatus(status, signal) {
  if (status === null || status === undefined) return false;
  if (typeof status === 'number') return status === 0;
  return !signal;
}

function normalizeStatus(result = {}) {
  if (result.error) return 1;
  if (typeof result.status === 'number') return result.status;
  if (result.signal) return 1;
  return 0;
}

function shouldCleanupEnvFile({
  shouldKeep,
  explicitEnvFile,
  explicitEnvPreExisted,
  cleanupPath,
}) {
  if (shouldKeep || !cleanupPath) return false;
  if (!explicitEnvFile) return true;

  const resolvedCleanup = path.resolve(String(cleanupPath));
  const resolvedExplicit = path.resolve(String(explicitEnvFile));
  if (resolvedCleanup !== resolvedExplicit) return false;
  return !explicitEnvPreExisted;
}

function withPreviewEnvRun({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  spawnSync = defaultSpawnSync,
  removeFile = fs.unlinkSync,
  fileExistsSync = fs.existsSync,
  keepFile = false,
  now = Date.now,
  previewScript = path.join(__dirname, 'preview-project.js'),
  nodeCommand = process.execPath,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return { status: 0, skipped: true };
  }

  if (!args.pr && !args.name) throw new Error('Missing --pr or --name for preview workspace resolution.');
  if (!args.command || args.command.length === 0) {
    throw new Error('Missing command. Provide a command after `--` or as the first positional argument.');
  }
  const shouldKeep = keepFile || Boolean(args.keep);

  const explicitEnvFile = args.envFile ? path.resolve(args.envFile) : '';
  const explicitEnvPreExisted = Boolean(explicitEnvFile) && Boolean(fileExistsSync(explicitEnvFile));
  const envFile = defaultEnvFile({
    explicitEnvFile,
  });
  const previewEnv = {
    ...env,
    ENV_FILE: envFile,
    ENV_FILE_APPEND: '0',
  };
  const previewArgs = [previewScript, '--format', 'json'];
  if (args.pr) previewArgs.push('--pr', String(args.pr));
  if (args.name) previewArgs.push('--name', args.name);

  const previewResult = spawnSync(nodeCommand, previewArgs, {
    encoding: 'utf8',
    cwd,
    env: previewEnv,
  });
  let commandResult;
  let payload;
  let command = '';
  let commandArgs = [];
  try {
    const previewStatus = normalizeStatus(previewResult);
    if (!isSuccessStatus(previewStatus, previewResult.signal)) {
      const msg = String(previewResult.stderr || previewResult.stdout || '').trim();
      if (previewResult.error) {
        throw previewResult.error;
      }
      throw new Error(`preview-project failed${msg ? `: ${msg}` : ''}`);
    }
    payload = parsePreviewJson(previewResult.stdout || '');
    if (!payload || !payload.env_file) {
      throw new Error('preview-project did not return env_file metadata in JSON output.');
    }

    const childEnv = {
      ...env,
      ENV_FILE: payload.env_file,
      ENV_FILE_APPEND: '0',
    };
    [command, ...commandArgs] = args.command;

    commandResult = spawnSync(command, commandArgs, {
      cwd,
      env: childEnv,
      stdio: 'inherit',
    });
    if (commandResult.error) throw commandResult.error;
  } finally {
    const cleanupPath = payload?.env_file || envFile;
    if (
      shouldCleanupEnvFile({
        shouldKeep,
        explicitEnvFile,
        explicitEnvPreExisted,
        cleanupPath,
      })
    ) {
      try {
        removeFile(cleanupPath);
      } catch {
        // no-op; cleanup remains best-effort
      }
    }
  }

  const status = normalizeStatus(commandResult);
  if (!isSuccessStatus(status, commandResult.signal)) {
    const signalLabel = commandResult.signal ? ` (signal=${commandResult.signal})` : '';
    throw new Error(`Command failed: ${[command, ...commandArgs].join(' ')}${signalLabel}`);
  }

  return {
    status,
    payload,
    envFile,
    command: [command, ...commandArgs].join(' '),
    timestamp: now(),
  };
}

function main() {
  try {
    const result = withPreviewEnvRun();
    process.exit(result.status);
  } catch (err) {
    console.error(`[with-preview-env] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parsePreviewJson,
  shouldCleanupEnvFile,
  withPreviewEnvRun,
};
