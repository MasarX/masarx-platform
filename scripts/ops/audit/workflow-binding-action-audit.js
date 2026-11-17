#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

function toPosix(filePath) {
  return String(filePath || '').split(path.sep).join('/');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const options = {
    repoRoot,
    configFile: path.join(repoRoot, 'config', 'ops', 'workflow-binding-audit.json'),
    json: false,
    changedOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    const next = String(argv[index + 1] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--changed-only') {
      options.changedOnly = true;
      continue;
    }
    if (token === '--repo-root' && next) {
      options.repoRoot = path.resolve(next);
      index += 1;
      continue;
    }
    if (token.startsWith('--repo-root=')) {
      options.repoRoot = path.resolve(token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--config' && next) {
      options.configFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--config=')) {
      options.configFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printUsage() {
  console.log('Usage: node scripts/ops/audit/workflow-binding-action-audit.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --config <path>      Audit config file (default: config/ops/workflow-binding-audit.json)');
  console.log('  --repo-root <path>   Repository root (default: inferred from cwd)');
  console.log('  --changed-only       Only enforce changed-file guardrails');
  console.log('  --json               Print machine-readable JSON');
  console.log('  --help, -h           Show usage');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function compilePatterns(patterns = []) {
  return patterns.map((pattern) => new RegExp(String(pattern), 'm'));
}

function matchesAny(value, patterns = []) {
  const text = String(value || '');
  return compilePatterns(patterns).some((pattern) => pattern.test(text));
}

function missingPatterns(value, patterns = []) {
  const text = String(value || '');
  return patterns.filter((pattern) => !(new RegExp(String(pattern), 'm')).test(text));
}

function getChangedFiles() {
  const override = String(process.env.WORKFLOW_BINDING_AUDIT_FILES || '').trim();
  if (override) {
    return override
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const commands = [
    ['git', ['diff', '--name-only']],
    ['git', ['diff', '--name-only', '--cached']],
    ['git', ['ls-files', '--others', '--exclude-standard']],
  ];

  const files = [];
  const seen = new Set();
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`workflow-binding-audit git command failed: ${command} ${args.join(' ')}`);
    }
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const filePath = line.trim();
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      files.push(filePath);
    }
  }
  return files;
}

function resolveInventoryFiles(entry = {}) {
  const files = [entry.file, ...(Array.isArray(entry.related_files) ? entry.related_files : [])]
    .map((value) => toPosix(String(value || '').trim()))
    .filter(Boolean);
  return [...new Set(files)];
}

function evaluateInventory(config, repoRoot) {
  const issues = [];
  const findings = [];
  const coveredFiles = new Set();
  const defaultRegistrySeedFile = String(config.registry_seed_file || '').trim();

  for (const entry of Array.isArray(config.inventory) ? config.inventory : []) {
    const entryFiles = resolveInventoryFiles(entry);
    entryFiles.forEach((filePath) => coveredFiles.add(filePath));
    const primaryFile = String(entry.file || '').trim();
    const absolutePath = path.join(repoRoot, primaryFile);
    if (!primaryFile || !fs.existsSync(absolutePath)) {
      issues.push(`[workflow-binding-audit] Missing inventory file for ${entry.key || 'unknown'}: ${primaryFile || '<unset>'}`);
      continue;
    }

    const content = readText(absolutePath);
    const missingRequired = missingPatterns(content, entry.required_patterns || []);
    missingRequired.forEach((pattern) => {
      issues.push(
        `[workflow-binding-audit] ${primaryFile} missing required pattern for ${entry.key}: ${pattern}`,
      );
    });

    const forbiddenMatched = (entry.forbidden_patterns || []).filter((pattern) =>
      new RegExp(String(pattern), 'm').test(content),
    );
    forbiddenMatched.forEach((pattern) => {
      issues.push(
        `[workflow-binding-audit] ${primaryFile} matched forbidden pattern for ${entry.key}: ${pattern}`,
      );
    });

    const bindingKey = String(entry.binding_key || '').trim();
    if (bindingKey) {
      // Append-only adopters may name their actual seed; an explicit empty override
      // is invalid evidence, not permission to fall back to the historical seed.
      const registrySeedFile = Object.prototype.hasOwnProperty.call(entry, 'registry_seed_file')
        ? String(entry.registry_seed_file || '').trim()
        : defaultRegistrySeedFile;
      const registrySeedPath = registrySeedFile ? path.join(repoRoot, registrySeedFile) : null;
      const registrySeedContent = registrySeedPath && fs.existsSync(registrySeedPath)
        ? readText(registrySeedPath) : '';
      if (!registrySeedContent.trim()) {
        issues.push(
          `[workflow-binding-audit] Missing or empty registry seed for ${bindingKey}: ${toPosix(registrySeedFile) || '<unset>'}`,
        );
      }
      const bindingPattern = new RegExp(`'${escapeRegExp(bindingKey)}'`, 'm');
      if (!bindingPattern.test(registrySeedContent)) {
        issues.push(
          `[workflow-binding-audit] Binding key ${bindingKey} is not seeded in ${toPosix(registrySeedFile)}`,
        );
      }
    }

    findings.push({
      key: entry.key,
      label: entry.label || entry.key,
      classification: entry.classification || null,
      configurability: entry.configurability || null,
      binding_key: bindingKey || null,
      file: toPosix(primaryFile),
      related_files: entryFiles.slice(1),
    });
  }

  return { findings, issues, coveredFiles };
}

function auditChangedFiles(config, repoRoot, coveredFiles) {
  const issues = [];
  const findings = [];
  const changedFiles = getChangedFiles().map(toPosix);
  const watchFiles = config.guardrail?.watch_files || [];
  const businessActionMarkers = config.guardrail?.business_action_markers || [];
  const directActionMarkers = config.guardrail?.direct_action_markers || [];
  const workflowBindingMarkers = config.guardrail?.workflow_binding_markers || [];
  const ignoreFiles = config.guardrail?.ignore_files || [];

  for (const filePath of changedFiles) {
    if (!matchesAny(filePath, watchFiles)) continue;
    if (matchesAny(filePath, ignoreFiles)) continue;

    const absolutePath = path.join(repoRoot, filePath);
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) continue;

    const content = readText(absolutePath);
    const hasBusinessMarkers = matchesAny(content, businessActionMarkers);
    if (!hasBusinessMarkers) continue;

    const hasDirectMarkers = matchesAny(content, directActionMarkers);
    const hasBindingMarkers = matchesAny(content, workflowBindingMarkers);
    const isCovered = coveredFiles.has(filePath);

    findings.push({
      file: filePath,
      covered: isCovered,
      has_direct_markers: hasDirectMarkers,
      has_binding_markers: hasBindingMarkers,
    });

    if (!isCovered) {
      issues.push(
        `[workflow-binding-audit] Changed file ${filePath} contains business-action markers but is not registered in config/ops/workflow-binding-audit.json.`,
      );
      continue;
    }

    if (hasDirectMarkers && !hasBindingMarkers) {
      issues.push(
        `[workflow-binding-audit] Changed file ${filePath} contains direct business-action markers without workflow binding markers.`,
      );
    }
  }

  return { findings, issues, changedFiles };
}

function runAudit(options = parseArgs()) {
  const config = readJson(options.configFile);
  const repoRoot = options.repoRoot;
  const inventory = options.changedOnly
    ? { findings: [], issues: [], coveredFiles: new Set() }
    : evaluateInventory(config, repoRoot);
  const changed = auditChangedFiles(config, repoRoot, inventory.coveredFiles);
  const issues = [...inventory.issues, ...changed.issues];
  const result = {
    ok: issues.length === 0,
    config_file: toPosix(path.relative(repoRoot, options.configFile)),
    inventory_findings: inventory.findings,
    changed_findings: changed.findings,
    changed_files: changed.changedFiles,
    issues,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[workflow-binding-audit] Summary');
    console.log(`- config: ${result.config_file}`);
    console.log(`- inventory: ${result.inventory_findings.length}`);
    console.log(`- changed business-action files: ${result.changed_findings.length}`);
    console.log(`- issues: ${result.issues.length}`);
  }

  if (!result.ok) {
    throw new Error(result.issues.join('\n'));
  }

  if (!options.json) {
    console.log('[workflow-binding-audit] OK');
  }
  return result;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      runAudit(options);
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  auditChangedFiles,
  evaluateInventory,
  getChangedFiles,
  parseArgs,
  resolveInventoryFiles,
  resolveRepoRoot,
  runAudit,
  toPosix,
};
