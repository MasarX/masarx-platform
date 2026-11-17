#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CONFIG_PATH = path.join(repoRoot, 'config', 'ci', 'runner-classes.json');
const VALID_MODES = new Set(['primary', 'breakglass']);

function die(message) {
  throw new Error(`[resolve-runner-config] ${message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    runnerClass: '',
    runnerLabelsJson: '',
    config: '',
    format: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    if (token === '--runner-class') {
      out.runnerClass = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--runner-class=')) {
      out.runnerClass = token.split('=').slice(1).join('=').trim();
    } else if (token === '--runner-labels-json') {
      out.runnerLabelsJson = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--runner-labels-json=')) {
      out.runnerLabelsJson = token.split('=').slice(1).join('=').trim();
    } else if (token === '--config') {
      out.config = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--config=')) {
      out.config = token.split('=').slice(1).join('=').trim();
    } else if (token === '--format') {
      out.format = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--format=')) {
      out.format = token.split('=').slice(1).join('=').trim();
    }
  }
  return out;
}

function resolveConfigPath(configPath) {
  const raw = String(configPath || '').trim();
  if (!raw) return DEFAULT_CONFIG_PATH;
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function normalizeClassConfig(classId, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    die(`runner class "${classId}" must be a JSON object.`);
  }
  const repositoryVar = String(entry.repository_var || '').trim();
  if (!repositoryVar) die(`runner class "${classId}" missing repository_var.`);
  const defaultLabels = normalizeLabelArray(entry.default_runner_labels_json, `${classId}.default_runner_labels_json`);
  const breakglassLabels = normalizeLabelArray(
    entry.breakglass_runner_labels_json,
    `${classId}.breakglass_runner_labels_json`,
  );
  return {
    classId,
    repositoryVar,
    defaultRunnerLabelsJson: defaultLabels,
    breakglassRunnerLabelsJson: breakglassLabels,
    expectedPrimaryLabelsJson: normalizeLabelArray(
      entry.expected_primary_labels_json || entry.default_runner_labels_json,
      `${classId}.expected_primary_labels_json`,
    ),
    expectedRunnerGroupName: String(entry.expected_runner_group_name || '').trim(),
    purpose: String(entry.purpose || '').trim(),
    trustTier: String(entry.trust_tier || '').trim(),
  };
}

function normalizeLabelArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    die(`${label} must be a non-empty array.`);
  }
  return value.map((entry, index) => {
    const normalized = String(entry || '').trim();
    if (!normalized) die(`${label}[${index}] must be a non-empty string.`);
    return normalized;
  });
}

function loadRunnerClasses(configPath) {
  const targetPath = resolveConfigPath(configPath);
  if (!fs.existsSync(targetPath)) {
    die(`Missing config: ${path.relative(repoRoot, targetPath).replace(/\\/g, '/')}`);
  }
  const payload = readJson(targetPath);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    die('Runner class config must be a JSON object.');
  }
  if (Number(payload.version || 0) !== 2) {
    die(`Unsupported runner class config version: ${payload.version || '<missing>'}`);
  }
  const classes = payload.classes && typeof payload.classes === 'object' ? payload.classes : null;
  if (!classes) die('Runner class config missing classes.');
  const normalized = {};
  for (const [classId, entry] of Object.entries(classes)) {
    normalized[classId] = normalizeClassConfig(classId, entry);
  }
  return {
    configPath: targetPath,
    enterprise_runner_mode_var: String(payload.enterprise_runner_mode_var || '').trim(),
    enterprise_runner_breakglass_var: String(payload.enterprise_runner_breakglass_var || '').trim(),
    breakglass_repository_var: String(payload.breakglass_repository_var || '').trim(),
    classes: normalized,
  };
}

function normalizeMode(env = process.env) {
  const rawMode = String(env.ENTERPRISE_RUNNER_MODE || 'primary').trim().toLowerCase();
  const rawBreakglass = String(env.ENTERPRISE_RUNNER_BREAKGLASS || '0').trim();
  if (!VALID_MODES.has(rawMode)) {
    die(`ENTERPRISE_RUNNER_MODE must be one of ${Array.from(VALID_MODES).join(', ')} (got: ${rawMode || '<empty>'}).`);
  }
  const breakglassEnabled = rawBreakglass === '1' || rawMode === 'breakglass';
  return {
    enterpriseMode: rawMode,
    breakglassEnabled,
  };
}

function getRunnerClass(contract, runnerClassId) {
  const classId = String(runnerClassId || '').trim();
  if (!classId) die('Missing --runner-class <id>.');
  const entry = contract.classes[classId];
  if (!entry) {
    die(`Unknown runner class "${classId}". Expected one of: ${Object.keys(contract.classes).join(', ')}`);
  }
  return entry;
}

function parseLabelJson(rawValue, repositoryVar) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    die(`${repositoryVar} must be valid JSON label array (${error.message}).`);
  }
  return normalizeLabelArray(parsed, repositoryVar);
}

function resolveRunner(entry, env = process.env, overrideLabelsJson = '') {
  const mode = normalizeMode(env);
  const configuredLabels = parseLabelJson(env[entry.repositoryVar], entry.repositoryVar);
  const sharedBreakglassLabels = parseLabelJson(env.RUNNER_LABELS_BREAKGLASS_JSON, 'RUNNER_LABELS_BREAKGLASS_JSON');
  const overrideLabels = parseLabelJson(overrideLabelsJson, 'runner_labels_json');
  if (overrideLabels) {
    const runnerLabel = String(overrideLabels[0] || '').trim();
    if (!runnerLabel) {
      die(`Resolved override labels for "${entry.classId}" must include at least one label.`);
    }
    return {
      runner_class: entry.classId,
      repository_var: entry.repositoryVar,
      runner_label: runnerLabel,
      runner_labels_json: JSON.stringify(overrideLabels),
      resolution_source: 'input-override',
      enterprise_mode: mode.enterpriseMode,
      breakglass_enabled: mode.breakglassEnabled ? '1' : '0',
      trust_tier: entry.trustTier,
      purpose: entry.purpose,
    };
  }
  const labels = mode.breakglassEnabled
    ? sharedBreakglassLabels || entry.breakglassRunnerLabelsJson
    : configuredLabels || entry.defaultRunnerLabelsJson;
  const resolutionSource = mode.breakglassEnabled
    ? sharedBreakglassLabels
      ? 'shared-breakglass-repository-var'
      : 'breakglass'
    : configuredLabels
      ? 'repository-var'
      : 'config-default';
  const runnerLabel = String(labels[0] || '').trim();
  if (!runnerLabel) {
    die(`Resolved runner labels for "${entry.classId}" must include at least one label.`);
  }
  return {
    runner_class: entry.classId,
    repository_var: entry.repositoryVar,
    runner_label: runnerLabel,
    runner_labels_json: JSON.stringify(labels),
    resolution_source: resolutionSource,
    enterprise_mode: mode.enterpriseMode,
    breakglass_enabled: mode.breakglassEnabled ? '1' : '0',
    trust_tier: entry.trustTier,
    purpose: entry.purpose,
  };
}

function writeGithubOutput(values) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; omit --format github-output for local runs.');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const contract = loadRunnerClasses(args.config);
  const runnerEntry = getRunnerClass(contract, args.runnerClass);
  const result = resolveRunner(runnerEntry, env, args.runnerLabelsJson);
  const format = String(args.format || '').trim().toLowerCase();
  if (format === 'github-output') {
    writeGithubOutput(result);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  VALID_MODES,
  parseArgs,
  resolveConfigPath,
  normalizeLabelArray,
  normalizeClassConfig,
  loadRunnerClasses,
  normalizeMode,
  getRunnerClass,
  parseLabelJson,
  resolveRunner,
  main,
};
