#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildInventory, renderPriorityMatrix } = require('./security-audit-inventory');

const DEFAULT_THRESHOLD_SEVERITIES = Object.freeze(['high', 'critical']);

function resolveNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveNpmAuditInvocation() {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm audit --json'],
    };
  }
  return {
    command: resolveNpmCommand(),
    args: ['audit', '--json'],
  };
}

function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeSeverity(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeThresholdSeverities(values) {
  const items = Array.isArray(values) ? values : String(values || '').split(',');
  const seen = new Set();
  for (const item of items) {
    const normalized = normalizeSeverity(item);
    if (!normalized) continue;
    seen.add(normalized);
  }
  if (!seen.size) {
    for (const value of DEFAULT_THRESHOLD_SEVERITIES) seen.add(value);
  }
  return [...seen].sort();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value, 'utf8');
}

function parseJsonFromNpmAuditOutput(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('npm audit produced empty output');

  try {
    return JSON.parse(text);
  } catch {
    // npm can include warning lines before JSON; recover by slicing first/last braces.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) {
      throw new Error('Unable to parse npm audit JSON payload');
    }
    const sliced = text.slice(first, last + 1);
    return JSON.parse(sliced);
  }
}

function runNpmAudit({ repoRoot }) {
  const invocation = resolveNpmAuditInvocation();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
    env: process.env,
  });
  if (result.error) {
    throw new Error(`npm audit failed to execute: ${result.error.message}`);
  }

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const combined = stdout.trim() ? stdout : stderr;
  const payload = parseJsonFromNpmAuditOutput(combined);

  // npm audit exits non-zero when vulnerabilities exist; this is expected.
  if (result.status !== 0 && !payload) {
    throw new Error(`npm audit exited with status ${result.status}`);
  }

  return payload;
}

function findingSignature(finding) {
  const packageName = String(finding?.package_name || '').trim();
  const severity = normalizeSeverity(finding?.severity || '');
  if (!packageName || !severity) return '';
  return `${packageName}|${severity}`;
}

function canonicalizeSignature(rawSignature) {
  const text = String(rawSignature || '').trim();
  if (!text) return '';
  const [rawPackageName = '', rawSeverity = ''] = text.split('|');
  const packageName = String(rawPackageName || '').trim();
  const severity = normalizeSeverity(rawSeverity);
  if (!packageName || !severity) return '';
  return `${packageName}|${severity}`;
}

function toSignatureRecords(findings, thresholdSeverities) {
  const allowed = new Set(normalizeThresholdSeverities(thresholdSeverities));
  const records = new Map();
  for (const finding of findings || []) {
    const severity = normalizeSeverity(finding?.severity);
    if (!allowed.has(severity)) continue;
    const signature = findingSignature(finding);
    if (signature) {
      records.set(signature, {
        signature,
        package_name: String(finding?.package_name || ''),
        severity,
        vulnerable_range: String(finding?.vulnerable_range || '*'),
        runtime_exposure: String(finding?.runtime_exposure || 'unknown'),
        priority: String(finding?.priority || ''),
      });
    }
  }
  return records;
}

function loadBaseline(baselineFile) {
  if (!fs.existsSync(baselineFile)) {
    throw new Error(`Baseline file not found: ${baselineFile}`);
  }
  const baseline = readJson(baselineFile);
  const list = Array.isArray(baseline?.allowed_signatures) ? baseline.allowed_signatures : [];
  const signatures = [...new Set(list.map((value) => canonicalizeSignature(value)).filter(Boolean))].sort();
  return { baseline, signatures, signatureSet: new Set(signatures) };
}

function evaluateAgainstBaseline({ findings, baselineSignatures, thresholdSeverities }) {
  const currentBySignature = toSignatureRecords(findings, thresholdSeverities);
  const baselineSet = new Set((baselineSignatures || []).map((value) => canonicalizeSignature(value)).filter(Boolean));

  const currentSignatures = [...currentBySignature.keys()].sort();
  const unexpectedSignatures = currentSignatures.filter((signature) => !baselineSet.has(signature));
  const resolvedSignatures = [...baselineSet].sort().filter((signature) => !currentBySignature.has(signature));

  return {
    current_count: currentSignatures.length,
    baseline_count: baselineSet.size,
    unexpected_signatures: unexpectedSignatures.map((signature) => currentBySignature.get(signature)),
    resolved_signatures: resolvedSignatures,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const options = {
    repoRoot,
    lockFile: path.join(repoRoot, 'package-lock.json'),
    baselineFile: path.join(repoRoot, 'config', 'ci', 'security-audit-baseline.json'),
    auditFile: path.join(repoRoot, 'security-audit.json'),
    inventoryFile: path.join(repoRoot, 'security-vulnerability-inventory.json'),
    matrixFile: path.join(repoRoot, 'security-priority-matrix.md'),
    summaryFile: path.join(repoRoot, 'security-scan-summary.json'),
    thresholdSeverities: [...DEFAULT_THRESHOLD_SEVERITIES],
    signedOffBy: '',
    generatedAt: new Date().toISOString(),
    bypass: parseBool(process.env.SECURITY_SCAN_BYPASS || ''),
    useExistingAuditFile: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    const next = String(argv[index + 1] || '').trim();
    if (!token) continue;
    if (token === '--repo-root' && next) {
      options.repoRoot = path.resolve(next);
      index += 1;
      continue;
    }
    if (token.startsWith('--repo-root=')) {
      options.repoRoot = path.resolve(token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--lock-file' && next) {
      options.lockFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--lock-file=')) {
      options.lockFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--baseline-file' && next) {
      options.baselineFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--baseline-file=')) {
      options.baselineFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--audit-file' && next) {
      options.auditFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--audit-file=')) {
      options.auditFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--use-existing-audit-file') {
      options.useExistingAuditFile = true;
      continue;
    }
    if (token === '--inventory-file' && next) {
      options.inventoryFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--inventory-file=')) {
      options.inventoryFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--matrix-file' && next) {
      options.matrixFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--matrix-file=')) {
      options.matrixFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--summary-file' && next) {
      options.summaryFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--summary-file=')) {
      options.summaryFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--threshold-severities' && next) {
      options.thresholdSeverities = normalizeThresholdSeverities(next);
      index += 1;
      continue;
    }
    if (token.startsWith('--threshold-severities=')) {
      options.thresholdSeverities = normalizeThresholdSeverities(token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--signed-off-by' && next) {
      options.signedOffBy = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--signed-off-by=')) {
      options.signedOffBy = token.split('=').slice(1).join('=').trim();
      continue;
    }
    if (token === '--generated-at' && next) {
      options.generatedAt = new Date(next).toISOString();
      index += 1;
      continue;
    }
    if (token.startsWith('--generated-at=')) {
      options.generatedAt = new Date(token.split('=').slice(1).join('=').trim()).toISOString();
      continue;
    }
    if (token === '--bypass') {
      options.bypass = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function runCli(options = parseArgs()) {
  const auditReport = options.useExistingAuditFile && fs.existsSync(options.auditFile)
    ? readJson(options.auditFile)
    : runNpmAudit({ repoRoot: options.repoRoot });
  writeJson(options.auditFile, auditReport);

  const lockData = readJson(options.lockFile);
  const inventory = buildInventory({
    auditReport,
    lockData,
    repoRoot: options.repoRoot,
    generatedAt: options.generatedAt,
    auditFile: options.auditFile,
    lockFile: options.lockFile,
    signedOffBy: options.signedOffBy,
  });
  const matrix = renderPriorityMatrix(inventory);

  writeJson(options.inventoryFile, inventory);
  writeText(options.matrixFile, matrix);

  const baselineState = loadBaseline(options.baselineFile);
  const evaluation = evaluateAgainstBaseline({
    findings: inventory.findings || [],
    baselineSignatures: baselineState.signatures,
    thresholdSeverities: options.thresholdSeverities,
  });

  const summary = {
    generated_at: options.generatedAt,
    threshold_severities: normalizeThresholdSeverities(options.thresholdSeverities),
    baseline_file: path.relative(options.repoRoot, options.baselineFile).split(path.sep).join('/'),
    audit_file: path.relative(options.repoRoot, options.auditFile).split(path.sep).join('/'),
    inventory_file: path.relative(options.repoRoot, options.inventoryFile).split(path.sep).join('/'),
    matrix_file: path.relative(options.repoRoot, options.matrixFile).split(path.sep).join('/'),
    bypass_applied: Boolean(options.bypass),
    counts: {
      current_threshold_findings: evaluation.current_count,
      baseline_threshold_findings: evaluation.baseline_count,
      unexpected_threshold_findings: evaluation.unexpected_signatures.length,
      resolved_threshold_findings: evaluation.resolved_signatures.length,
    },
    unexpected_signatures: evaluation.unexpected_signatures,
    resolved_signatures: evaluation.resolved_signatures,
  };
  writeJson(options.summaryFile, summary);

  console.log(
    `[security-scan-gate] threshold=${summary.threshold_severities.join(',')} current=${summary.counts.current_threshold_findings} baseline=${summary.counts.baseline_threshold_findings} unexpected=${summary.counts.unexpected_threshold_findings} resolved=${summary.counts.resolved_threshold_findings}`,
  );
  if (summary.unexpected_signatures.length) {
    console.log('[security-scan-gate] Unexpected signatures:');
    for (const record of summary.unexpected_signatures) {
      console.log(`- ${record.signature}`);
    }
  }
  if (summary.bypass_applied && summary.unexpected_signatures.length) {
    console.warn('[security-scan-gate] Bypass enabled; allowing unexpected high/critical findings.');
  }

  if (summary.unexpected_signatures.length && !summary.bypass_applied) {
    throw new Error(
      `Detected ${summary.unexpected_signatures.length} net-new high/critical findings relative to baseline ${summary.baseline_file}`,
    );
  }

  return summary;
}

if (require.main === module) {
  try {
    runCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`security-scan-gate: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  canonicalizeSignature,
  DEFAULT_THRESHOLD_SEVERITIES,
  evaluateAgainstBaseline,
  findingSignature,
  normalizeThresholdSeverities,
  parseArgs,
  parseJsonFromNpmAuditOutput,
  resolveNpmAuditInvocation,
  resolveNpmCommand,
  runCli,
  toSignatureRecords,
};
