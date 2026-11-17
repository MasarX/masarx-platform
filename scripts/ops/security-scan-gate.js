#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { buildInventory, renderPriorityMatrix, validateNpmAuditReport } = require('./security-audit-inventory');
const { redactRuntimeOutput } = require('./workspace/docker-runtime/redaction');
const { isSensitiveCredentialKey } = require('./workspace/docker-runtime/secret-policy');

const DEFAULT_THRESHOLD_SEVERITIES = Object.freeze(['high', 'critical']);

function resolveNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveNpmAuditInvocation() {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm audit --json --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=120000'],
    };
  }
  return {
    command: resolveNpmCommand(),
    args: ['audit', '--json', '--package-lock-only', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=120000'],
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

function redactAuditOutput(value, repoRoot) {
  const privateValues = Object.entries(process.env)
    .filter(([key]) => isSensitiveCredentialKey(key) || /AUTH|COOKIE|PROXY/i.test(key))
    .map(([, secret]) => secret).filter(Boolean);
  privateValues.push(repoRoot, process.env.HOME, process.env.USERPROFILE);
  const forms = privateValues.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  const secrets = [...new Set(forms)].sort((left, right) => right.length - left.length);
  const redactText = input => {
    // Remove credential structures before short environment values can break their delimiters.
    let text = redactRuntimeOutput(input
      .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, '[redacted-url]')
      .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '[redacted-authorization]')
      .replace(/(["']?(?:(?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/giu, '$1[redacted]'));
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text;
  };
  const sanitize = (input, depth = 0) => {
    if ((input === null || ['string', 'number', 'boolean'].includes(typeof input))
      && privateValues.includes(String(input))) return '[redacted]';
    if (depth >= 8) return '[redacted-depth-limit]';
    if (typeof input === 'string') {
      let decoded;
      try {
        decoded = parseJsonFromNpmAuditOutput(input);
      } catch {
        // Undecodable structured/escaped data must never fall back to raw output.
        if (['{', '[', '"'].includes(input.trimStart().charAt(0)) || /[\\{}]/u.test(input)) {
          return '[redacted-invalid-json]';
        }
        return redactText(input);
      }
      return sanitize(decoded, depth + 1);
    }
    if (Array.isArray(input)) return input.map(item => sanitize(item, depth + 1));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [
        redactText(key),
        isSensitiveCredentialKey(key) || /AUTH|COOKIE|PROXY/i.test(key) ? '[redacted]' : sanitize(item, depth + 1),
      ]));
    }
    return input;
  };
  const redacted = sanitize(String(value || ''));
  return typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
}

function runNpmAudit({ repoRoot, auditFile }) {
  const invocation = resolveNpmAuditInvocation();
  const attemptsFile = auditFile ? `${auditFile}.attempts.log` : null;
  // A new acquisition replaces stale diagnostics; recovery keeps its failed attempts.
  if (attemptsFile) fs.rmSync(attemptsFile, { force: true });
  const cacheDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'masarx-npm-audit-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(cache|prefer_online|prefer_offline|offline)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    npm_config_cache: cacheDir,
    npm_config_prefer_online: 'true',
    npm_config_prefer_offline: 'false',
    npm_config_offline: 'false',
  });
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 128,
        windowsHide: true,
        env,
      });
      const stdout = String(result.stdout || '');
      const stderr = String(result.stderr || '');
      let report;
      const status = Number.isInteger(result.status) ? result.status : null;
      const diagnostics = () => {
        const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        const code = result.error?.code || report?.error?.code;
        const allowedCodes = ['ENOAUDIT', 'EAUDITNOLOCK', 'ENOLOCK', 'ENOPACKAGELOCK', 'ENOENT', 'EACCES', 'EPERM',
          'ENOBUFS', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPROXYAUTH',
          'E401', 'E403', 'E404', 'E500', 'E502', 'E503', 'E504', 'EUSAGE', 'ERESOLVE', 'EINTEGRITY'];
        const allowedSignals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGQUIT'];
        return JSON.stringify({ status, signal: allowedSignals.includes(result.signal) ? result.signal : null,
          error_code: allowedCodes.includes(code) ? code : null,
          stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr),
          schema: { record: isRecord(report), has_error: isRecord(report) && Object.hasOwn(report, 'error'),
            audit_report_version: Number.isSafeInteger(report?.auditReportVersion) ? report.auditReportVersion : null,
            vulnerabilities_record: isRecord(report?.vulnerabilities),
            metadata_vulnerabilities_record: isRecord(report?.metadata?.vulnerabilities) },
        });
      };
      let failure;
      if (result.error) failure = 'npm audit failed to execute';
      else if (result.signal || ![0, 1].includes(result.status)) failure = `npm audit exited with status ${status}`;
      else {
        try {
          report = parseJsonFromNpmAuditOutput(stdout.trim() ? stdout : stderr);
          return validateNpmAuditReport(report);
        } catch {
          failure = 'Invalid npm audit report';
        }
      }
      if (attemptsFile) {
        ensureDir(attemptsFile);
        fs.appendFileSync(attemptsFile, `${JSON.stringify({ attempt, diagnostics: JSON.parse(diagnostics()),
          stdout: redactAuditOutput(stdout, repoRoot), stderr: redactAuditOutput(stderr, repoRoot) })}\n`,
          { encoding: 'utf8', mode: 0o600 });
      }
      const errorShaped = report !== null && typeof report === 'object' && !Array.isArray(report)
        && Object.hasOwn(report, 'error');
      if (result.error || result.signal || ![0, 1].includes(result.status) || !errorShaped || attempt === 3) {
        throw new Error(`${failure}; diagnostics=${diagnostics()}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function findingIdentity(finding) {
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  if (!nonempty(finding?.package_name) || finding.package_name.includes('|')
    || !['info', 'low', 'moderate', 'high', 'critical'].includes(normalizeSeverity(finding.severity))
    || !nonempty(finding.vulnerable_range) || !nonempty(finding.runtime_exposure)
    || !Array.isArray(finding.advisory_dependencies) || !finding.advisory_dependencies.every(nonempty)
    || !Array.isArray(finding.advisories) || !Array.isArray(finding.nodes) || !finding.nodes.length
    || !finding.advisories.length && !finding.advisory_dependencies.length) {
    throw new Error('Invalid exact security finding identity');
  }
  const advisories = finding.advisories.map(advisory => {
    if (!Number.isSafeInteger(advisory.source) || advisory.source <= 0
      || !nonempty(advisory.url) || !nonempty(advisory.range)
      || !['info', 'low', 'moderate', 'high', 'critical'].includes(advisory.severity)) {
      throw new Error('Invalid exact security advisory identity');
    }
    return [advisory.source, advisory.url, advisory.range, advisory.severity, advisory.dependency];
  });
  const nodes = finding.nodes.map(node => {
    if (!nonempty(node.path) || !nonempty(node.version)
      || typeof node.dev !== 'boolean' || typeof node.optional !== 'boolean') {
      throw new Error('Invalid exact security installed-node identity');
    }
    return [node.path, node.version, node.dev, node.optional];
  });
  const sorted = values => values.map(value => JSON.stringify(value)).sort().map(value => JSON.parse(value));
  // Derived meta-ranges describe other releases; installed nodes and inherited advisories bind this risk.
  const derivedOnly = !advisories.length && finding.advisory_dependencies.length > 0;
  return [finding.package_name, normalizeSeverity(finding.severity), derivedOnly ? null : finding.vulnerable_range,
    finding.runtime_exposure, [...finding.advisory_dependencies].sort(), sorted(advisories), sorted(nodes)];
}

function findingSignature(finding, findings = [finding]) {
  const byPackage = new Map(findings.map(value => [value.package_name, value]));
  const closure = new Map();
  function visit(value) {
    if (!value) throw new Error('Missing inherited security advisory finding');
    if (closure.has(value.package_name)) return;
    closure.set(value.package_name, findingIdentity(value));
    for (const dependency of value.advisory_dependencies) visit(byPackage.get(dependency));
  }
  visit(finding);
  const identity = [...closure.keys()].sort().map(key => closure.get(key));
  return `${finding.package_name}|${normalizeSeverity(finding.severity)}|sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function canonicalizeSignature(rawSignature) {
  if (typeof rawSignature !== 'string'
    || !/^[^|\s]+\|(info|low|moderate|high|critical)\|sha256:[a-f0-9]{64}$/.test(rawSignature)) {
    throw new Error('Invalid exact security baseline signature; legacy package-only exceptions must be rebound');
  }
  return rawSignature;
}

function toSignatureRecords(findings, thresholdSeverities) {
  const allowed = new Set(normalizeThresholdSeverities(thresholdSeverities));
  const records = new Map();
  for (const finding of findings || []) {
    const severity = normalizeSeverity(finding?.severity);
    if (!allowed.has(severity)) continue;
    const signature = findingSignature(finding, findings);
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
  if (Object.prototype.hasOwnProperty.call(baseline, 'expires_at')) {
    const expiry = baseline.expires_at;
    const timestamp = typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry)
      ? Date.parse(`${expiry}T00:00:00.000Z`) : NaN;
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== expiry) {
      throw new Error('Invalid accepted-risk baseline expiry');
    }
    if (new Date().toISOString().slice(0, 10) > expiry) throw new Error('Accepted-risk baseline expired');
  }
  if (!Array.isArray(baseline?.allowed_signatures)) throw new Error('Invalid security baseline signatures');
  const list = baseline.allowed_signatures;
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

function createStageReporter() {
  let startedAt;
  const stageStarts = new Map();
  return (stage, phase, source) => {
    try {
      const now = process.hrtime.bigint();
      if (startedAt === undefined) startedAt = now;
      const milliseconds = since => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number((now - since) / 1000000n)));
      if (phase === 'begin') stageStarts.set(stage, now);
      const record = {
        version: 1, stage, phase, elapsed_ms: milliseconds(startedAt),
        ...(phase === 'complete' ? { duration_ms: milliseconds(stageStarts.get(stage)) } : {}),
        ...(stage === 'audit' ? { source } : {}),
      };
      // Synchronous output survives an outer timeout while npm audit blocks this process.
      // Only fixed stage names and timing fields enter this diagnostic channel.
      fs.writeSync(1, `[security-scan-stage] ${JSON.stringify(record)}\n`);
    } catch {
      // Diagnostics must not change the gate result or replace its original error.
    }
  };
}

function runCli(options = parseArgs()) {
  const reportStage = createStageReporter();
  const useExistingAuditFile = options.useExistingAuditFile && fs.existsSync(options.auditFile);
  const auditSource = useExistingAuditFile ? 'existing' : 'live';
  reportStage('audit', 'begin', auditSource);
  const auditReport = useExistingAuditFile
    ? readJson(options.auditFile)
    : runNpmAudit({ repoRoot: options.repoRoot, auditFile: options.auditFile });
  reportStage('audit', 'complete', auditSource);
  reportStage('inventory', 'begin');
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
  reportStage('inventory', 'complete');

  reportStage('write_inventory', 'begin');
  writeJson(options.inventoryFile, inventory);
  writeText(options.matrixFile, matrix);
  reportStage('write_inventory', 'complete');

  reportStage('evaluate', 'begin');
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
  reportStage('evaluate', 'complete');
  reportStage('write_summary', 'begin');
  writeJson(options.summaryFile, summary);
  reportStage('write_summary', 'complete');

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

  if (summary.resolved_signatures.length) {
    throw new Error(
      `Detected ${summary.resolved_signatures.length} resolved high/critical baseline signatures; prune stale entries from ${summary.baseline_file}`,
    );
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
  runNpmAudit,
  toSignatureRecords,
};
