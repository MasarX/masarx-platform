#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CONFIG_PATH = path.join(repoRoot, 'config', 'ci', 'deploy-cli-contract.json');
const EXACT_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/;

function die(message) {
  throw new Error(`[require-cli-version] ${message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    tool: '',
    config: '',
    format: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    if (token === '--tool') {
      out.tool = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--tool=')) {
      out.tool = token.split('=').slice(1).join('=').trim();
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
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function loadCliContract(configPath) {
  const targetPath = resolveConfigPath(configPath);
  if (!fs.existsSync(targetPath)) {
    die(`Missing config: ${path.relative(repoRoot, targetPath).replace(/\\/g, '/')}`);
  }
  const payload = readJson(targetPath);
  if (!payload || typeof payload !== 'object') die('CLI contract config must be a JSON object.');
  if (Number(payload.version || 0) !== 1) die(`Unsupported CLI contract version: ${payload.version || '<missing>'}`);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length === 0) die('CLI contract config must define tools[].');
  const normalizedTools = tools.map((entry, index) => normalizeTool(entry, index));
  return {
    configPath: targetPath,
    tools: normalizedTools,
  };
}

function normalizeTool(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    die(`tools[${index}] must be an object.`);
  }
  const toolId = String(entry.tool_id || '').trim().toLowerCase();
  const displayName = String(entry.display_name || '').trim();
  const packageName = String(entry.package_name || '').trim();
  const repoVar = String(entry.repo_var || '').trim();
  if (!toolId) die(`tools[${index}] missing tool_id.`);
  if (!displayName) die(`tools[${index}] missing display_name.`);
  if (!packageName) die(`tools[${index}] missing package_name.`);
  if (!repoVar) die(`tools[${index}] missing repo_var.`);
  return {
    toolId,
    displayName,
    packageName,
    repoVar,
    required: entry.required !== false,
    exactSemverRequired: entry.exact_semver_required !== false,
  };
}

function getToolContract(contract, toolId) {
  const target = String(toolId || '').trim().toLowerCase();
  if (!target) die('Missing --tool <tool_id>.');
  const tool = (contract.tools || []).find((entry) => entry.toolId === target);
  if (!tool) {
    die(`Unknown tool "${target}". Expected one of: ${contract.tools.map((entry) => entry.toolId).join(', ')}`);
  }
  return tool;
}

function validateVersion(tool, env = process.env) {
  const version = String(env[tool.repoVar] || '').trim();
  if (!version) {
    if (tool.required) {
      die(`Missing ${tool.repoVar} (repo variable). Pin the ${tool.displayName} version for deterministic automation.`);
    }
    return '';
  }
  if (tool.exactSemverRequired && !EXACT_SEMVER_RE.test(version)) {
    die(`${tool.repoVar} must be an exact semver-like version (got: ${version}).`);
  }
  return version;
}

function buildContractResult(tool, version) {
  return {
    tool_id: tool.toolId,
    display_name: tool.displayName,
    repo_var: tool.repoVar,
    version,
    package_name: tool.packageName,
    package_spec: `${tool.packageName}@${version}`,
    exact_semver_required: tool.exactSemverRequired ? '1' : '0',
  };
}

function writeGithubOutput(values) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; omit --format github-output for local runs.');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const contract = loadCliContract(args.config);
  const tool = getToolContract(contract, args.tool);
  const version = validateVersion(tool);
  const result = buildContractResult(tool, version);
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
  EXACT_SEMVER_RE,
  parseArgs,
  resolveConfigPath,
  loadCliContract,
  normalizeTool,
  getToolContract,
  validateVersion,
  buildContractResult,
  main,
};
