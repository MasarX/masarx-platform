#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CONFIG_PATH,
  readConfig,
  validateCache,
} = require('./install-workflow-lint-toolchain');

const QUEUE_SCHEMA_DIAGNOSTIC = 'unexpected key "queue" for "concurrency" section';
const QUEUE_SCHEMA_IGNORE = QUEUE_SCHEMA_DIAGNOSTIC;
const QUEUE_SCHEMA_EXPECTED_OUTPUT = `<stdin>:6:3: unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group" [syntax-check]\n  |\n6 |   queue: max\n  |   ^~~~~~`;
const QUEUE_PROBE = `name: Actionlint queue schema probe
on: workflow_dispatch
concurrency:
  group: actionlint-queue-schema-probe
  cancel-in-progress: false
  queue: max
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
    - run: echo ok
`;

function indentation(line) {
  return String(line || '').match(/^\s*/)[0].length;
}

function queueConcurrencyBlocks(source, file = '<workflow>') {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)concurrency:\s*(?:#.*)?$/.exec(lines[index]);
    if (!match) continue;
    const baseIndent = match[1].length;
    const values = new Map();
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (!line.trim() || /^\s*#/.test(line)) {
        end += 1;
        continue;
      }
      if (indentation(line) <= baseIndent) break;
      const field = /^\s+([A-Za-z-]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (field && indentation(line) === baseIndent + 2) values.set(field[1], field[2]);
      end += 1;
    }
    if (!values.has('queue')) continue;
    if (values.get('queue') !== 'max') throw new Error(`${file}:${index + 1}: concurrency.queue must be exactly 'max'.`);
    if (values.get('cancel-in-progress') !== 'false') throw new Error(`${file}:${index + 1}: queue:max requires cancel-in-progress:false.`);
    if (!String(values.get('group') || '').trim()) throw new Error(`${file}:${index + 1}: queued concurrency requires a non-empty group.`);
    blocks.push({ line: index + 1, group: values.get('group') });
  }
  return blocks;
}

function workflowFiles(root = process.cwd()) {
  const directory = path.join(root, '.github', 'workflows');
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.resolve(directory, entry.name))
    .sort();
  if (files.length === 0) throw new Error(`No top-level workflow YAML files found under ${directory}.`);
  return files;
}

function verifyQueuedConcurrency(files) {
  let count = 0;
  for (const file of files) count += queueConcurrencyBlocks(fs.readFileSync(file, 'utf8'), file).length;
  return count;
}

function commandOutput(result) {
  return `${String(result?.stdout || '')}${String(result?.stderr || '')}`;
}

function explicitAbsolutePath(name, value) {
  const resolved = String(value || '').trim();
  if (!resolved) throw new Error(`${name} must be explicitly exported by the verified workflow lint toolchain.`);
  if (!path.isAbsolute(resolved)) throw new Error(`${name} must be an absolute path; got "${resolved}".`);
  return path.resolve(resolved);
}

function verifyToolchainContract({
  executable = process.env.ACTIONLINT_BIN,
  shellcheckExecutable = process.env.SHELLCHECK_BIN,
  manifestPath = process.env.WORKFLOW_LINT_TOOLCHAIN_MANIFEST,
  configPath = CONFIG_PATH,
  spawn = spawnSync,
} = {}) {
  const actionlintPath = explicitAbsolutePath('ACTIONLINT_BIN', executable);
  const shellcheckPath = explicitAbsolutePath('SHELLCHECK_BIN', shellcheckExecutable);
  const resolvedManifest = explicitAbsolutePath('WORKFLOW_LINT_TOOLCHAIN_MANIFEST', manifestPath);
  const { config, digest } = readConfig(configPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Workflow lint toolchain manifest is unreadable: ${error.message}`);
  }
  const targetDir = path.dirname(resolvedManifest);
  const verified = validateCache({
    targetDir,
    config,
    digest,
    targetId: manifest.target,
    spawn,
  });
  if (verified.manifestPath !== resolvedManifest
    || verified.actionlintPath !== actionlintPath
    || verified.shellcheckPath !== shellcheckPath) {
    throw new Error('Workflow lint toolchain exports do not match the verified absolute cache paths.');
  }
  return { ...verified, config, versionsProbed: true };
}

function runBounded(spawn, executable, args, options, label, timeoutMs) {
  const result = spawn(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGTERM') throw new Error(`${label} timed out after ${timeoutMs}ms.`);
  if (result?.error) throw new Error(`${label} failed to start: ${result.error.message || result.error}`);
  return result;
}

function runActionlint({
  files = workflowFiles(),
  executable = process.env.ACTIONLINT_BIN,
  shellcheckExecutable = process.env.SHELLCHECK_BIN,
  spawn = spawnSync,
  verifyToolchain = verifyToolchainContract,
} = {}) {
  const verified = verifyToolchain({ executable, shellcheckExecutable, spawn });
  const resolvedActionlint = explicitAbsolutePath('ACTIONLINT_BIN', verified?.actionlintPath || executable);
  const resolvedShellcheck = explicitAbsolutePath('SHELLCHECK_BIN', verified?.shellcheckPath || shellcheckExecutable);
  const config = verified?.config;
  if (!config || verified?.versionsProbed !== true) throw new Error('Workflow lint toolchain verification did not prove exact versions.');
  const queueBlockCount = verifyQueuedConcurrency(files);
  const shellcheckArgument = `-shellcheck=${resolvedShellcheck}`;
  const probe = runBounded(spawn, resolvedActionlint, [shellcheckArgument, '-'], {
    cwd: process.cwd(), input: QUEUE_PROBE,
  }, 'actionlint queue-schema probe', config.timeouts.probe_ms);
  const probeOutput = commandOutput(probe);
  if (probe.status === 0) throw new Error('Pinned actionlint now accepts concurrency.queue natively; remove the queue schema adapter and its ignore before proceeding.');
  const normalizedProbeOutput = probeOutput.replace(/\r\n/g, '\n').trim();
  if (normalizedProbeOutput !== QUEUE_SCHEMA_EXPECTED_OUTPUT) {
    throw new Error(`Actionlint queue probe failed for an unexpected reason:\n${probeOutput}`);
  }

  const lint = runBounded(spawn, resolvedActionlint,
    [shellcheckArgument, '-ignore', QUEUE_SCHEMA_IGNORE, ...files],
    { cwd: process.cwd() }, 'actionlint workflow lint', config.timeouts.lint_ms);
  if (lint.stdout) process.stdout.write(lint.stdout);
  if (lint.stderr) process.stderr.write(lint.stderr);
  if (lint.status !== 0) throw new Error(`actionlint exited with status ${lint.status}.`);
  process.stdout.write(`[actionlint-current-schema] OK (${files.length} workflows; ${queueBlockCount} queue:max blocks independently verified).\n`);
  return { workflowCount: files.length, queueBlockCount };
}

if (require.main === module) {
  try {
    runActionlint();
  } catch (error) {
    console.error(`[actionlint-current-schema] ${String(error?.stack || error)}`);
    process.exit(1);
  }
}

module.exports = {
  CONFIG_PATH,
  QUEUE_PROBE,
  QUEUE_SCHEMA_DIAGNOSTIC,
  QUEUE_SCHEMA_EXPECTED_OUTPUT,
  QUEUE_SCHEMA_IGNORE,
  explicitAbsolutePath,
  queueConcurrencyBlocks,
  runActionlint,
  verifyQueuedConcurrency,
  verifyToolchainContract,
  workflowFiles,
};
