const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactRuntimeOutput, scanSecretText } = require('./redaction');
const { gitMetadataFromEnv } = require('./git-metadata');
const { isSensitiveRuntimeAssignment } = require('./secret-policy');

const REQUIRED_RUNTIME_EVIDENCE_KINDS = [
  'docker_logs',
  'docker_inspect',
  'docker_history',
];
const REQUIRED_SECURITY_ACCEPTANCE_KEYS = [
  'summaries_scanned',
  'rendered_compose_scanned',
  'docker_logs_scanned',
  'docker_inspect_scanned',
  'docker_history_scanned',
  'runtime_evidence_coverage_recorded',
  'runtime_env_excluded_from_summary_scan',
  'no_known_secret_leaks',
  'native_android_out_of_scope',
];

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function artifactFiles(plan = {}) {
  const root = plan.artifacts?.root || '';
  return [
    ['summary', plan.artifacts?.summary_file],
    ['compose_yaml', plan.artifacts?.compose_file],
    ['compose_rendered', plan.artifacts?.compose_config_file],
    ['runtime_attempt', plan.artifacts?.attempt_file],
    ['dependency_summary', plan.artifacts?.dependency_summary_file],
    ['backend_summary', plan.artifacts?.backend_summary_file],
    ['auth_summary', plan.artifacts?.auth_summary_file],
    ['browser_summary', root ? path.join(root, 'browser-proof-summary.json') : ''],
    ['runtime_summary', root ? path.join(root, 'in-container-proof-summary.json') : ''],
    ['performance_summary', root ? path.join(root, 'performance-summary.json') : ''],
    ['doctor_summary', root ? path.join(root, 'docker-runtime-doctor-summary.json') : ''],
  ].filter(([, filePath]) => filePath);
}

function secretScanOptions(plan = {}) {
  return {
    expectedSafeMetadataValues: {
      ...(plan.runtime_env || {}),
      ...(plan.dependency_env || {}),
      AUTH_PASSWORD_FILE: plan.artifacts?.auth_password_file || '',
      SCHEMA_KEY: plan.backend?.schema_key || '',
      SCHEMA_KEY_SOURCE: plan.backend?.schema_key_source || '',
      TRANSITION_DESIRED_SCHEMA_KEY: plan.backend?.schema_key || '',
    },
  };
}

function scanFile(kind, filePath, plan = {}) {
  const text = readTextSafe(filePath);
  if (!text) return { kind, file: filePath, exists: false, findings: [] };
  return {
    kind,
    file: filePath,
    exists: true,
    findings: scanSecretText(text, secretScanOptions(plan)).map((finding) => ({
      ...finding,
      file: filePath,
      kind,
    })),
  };
}

function buildRuntimeEvidencePayload(kind, rawText = '', plan = {}) {
  const text = String(rawText || '');
  const scanOptions = secretScanOptions(plan);
  return {
    text: redactRuntimeOutput(text, scanOptions),
    findings: scanSecretText(text, scanOptions).map((finding) => ({
      id: finding.id,
      count: finding.count,
      kind,
      file: `${kind}:inline`,
    })),
  };
}

function buildDockerInspectEvidencePayload(
  stdout = '',
  stderr = '',
  plan = {},
  expectedEnvByService = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    const invalid = buildRuntimeEvidencePayload(
      'docker_inspect',
      `${stdout || ''}\n${stderr || ''}`,
      plan,
    );
    return {
      ...invalid,
      findings: [...invalid.findings, {
        id: 'docker_inspect_invalid_payload',
        count: 1,
        kind: 'docker_inspect',
        file: 'docker_inspect:inline',
      }],
      images: [],
    };
  }
  if (!Array.isArray(parsed)) {
    const invalid = buildRuntimeEvidencePayload(
      'docker_inspect',
      `${stdout || ''}\n${stderr || ''}`,
      plan,
    );
    return {
      ...invalid,
      findings: [...invalid.findings, {
        id: 'docker_inspect_invalid_payload',
        count: 1,
        kind: 'docker_inspect',
        file: 'docker_inspect:inline',
      }],
      images: [],
    };
  }

  const images = Array.from(new Set(parsed
    .flatMap((entry) => [entry?.Image, entry?.Config?.Image])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)));

  let mismatches = parsed.length ? 0 : 1;
  const serviceCounts = new Map();
  for (const container of parsed) {
    const config = container?.Config;
    const serviceName = String(config?.Labels?.['com.docker.compose.service'] || '');
    if (serviceName) serviceCounts.set(serviceName, (serviceCounts.get(serviceName) || 0) + 1);
    if (!Object.prototype.hasOwnProperty.call(expectedEnvByService, serviceName)
      || !Array.isArray(config?.Env)) {
      mismatches += 1;
      continue;
    }
    const expected = expectedEnvByService[serviceName];
    const expectedSensitive = Object.fromEntries(Object.entries(expected)
      .filter(([key, value]) => isSensitiveRuntimeAssignment(
        key,
        String(value ?? ''),
        { expectedSafeMetadataValues: {} },
      ))
      .map(([key, value]) => [key, String(value ?? '')]));
    const assignments = new Map();
    let duplicate = false;
    for (const entry of config.Env) {
      const assignment = String(entry || '');
      const separator = assignment.indexOf('=');
      if (separator <= 0) continue;
      const key = assignment.slice(0, separator);
      if (assignments.has(key)) duplicate = true;
      else assignments.set(key, assignment.slice(separator + 1));
    }
    const actualSensitive = Object.fromEntries(Array.from(assignments)
      .filter(([key, value]) => isSensitiveRuntimeAssignment(
        key,
        value,
        { expectedSafeMetadataValues: {} },
      )));
    const expectedKeys = Object.keys(expectedSensitive).sort();
    const actualKeys = Object.keys(actualSensitive).sort();
    if (
      duplicate
      || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
      || expectedKeys.some((key) => actualSensitive[key] !== expectedSensitive[key])
    ) {
      mismatches += 1;
    }
    config.Env = config.Env.map((entry) => {
      const assignment = String(entry || '');
      const separator = assignment.indexOf('=');
      if (separator <= 0) return assignment;
      const key = assignment.slice(0, separator);
      const value = assignment.slice(separator + 1);
      if (Object.prototype.hasOwnProperty.call(expectedSensitive, key)
        && expectedSensitive[key] === value) {
        return `${key}=[redacted]`;
      }
      return assignment;
    });
  }
  const persistentServices = new Set(
    (plan.services || []).filter((serviceName) => serviceName !== 'test-runner'),
  );
  for (const serviceName of Object.keys(expectedEnvByService)) {
    const count = serviceCounts.get(serviceName) || 0;
    if ((persistentServices.has(serviceName) && count !== 1) || count > 1) {
      mismatches += 1;
    }
  }

  const kind = 'docker_inspect';
  const file = `${kind}:inline`;
  const text = `${JSON.stringify(parsed)}\n${stderr || ''}`;
  const findings = scanSecretText(text, secretScanOptions(plan)).map((finding) => ({
    id: finding.id,
    count: finding.count,
    kind,
    file,
  }));
  if (mismatches) {
    findings.push({
      id: 'docker_inspect_sensitive_env_mismatch',
      count: mismatches,
      kind,
      file,
    });
  }
  return {
    text: redactRuntimeOutput(text, secretScanOptions(plan)),
    findings,
    images,
  };
}

function normalizeRuntimeEvidenceSources(additionalText = {}, evidenceSources = {}) {
  return Object.fromEntries(REQUIRED_RUNTIME_EVIDENCE_KINDS.map((kind) => {
    const source = evidenceSources[kind] || {};
    const text = Object.prototype.hasOwnProperty.call(additionalText, kind)
      ? String(additionalText[kind] || '')
      : '';
    const scanned = source.status === 'scanned' || (text.length > 0 && source.status !== 'unavailable');
    return [kind, {
      status: scanned ? 'scanned' : 'unavailable',
      reason: scanned ? '' : (source.reason || 'not_collected'),
      exit_code: Number.isFinite(Number(source.exit_code)) ? Number(source.exit_code) : null,
      bytes_scanned: scanned ? Buffer.byteLength(text, 'utf8') : 0,
    }];
  }));
}

function dockerRuntimeSecuritySummaryMismatch(summary, expected = {}) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return 'summary';
  for (const [key, value] of Object.entries({
    status: 'passed',
    proof: 'docker-runtime-security-scan',
    ...expected,
  })) {
    if (String(summary[key] ?? '') !== String(value ?? '')) return key;
  }
  if (!Array.isArray(summary.findings) || summary.findings.length !== 0) return 'findings';
  const acceptanceMismatch = REQUIRED_SECURITY_ACCEPTANCE_KEYS.find(
    (key) => summary.acceptance?.[key] !== true,
  );
  if (acceptanceMismatch) return `acceptance.${acceptanceMismatch}`;
  const sourceMismatch = REQUIRED_RUNTIME_EVIDENCE_KINDS.find((kind) => {
    const source = summary.runtime_evidence_sources?.[kind];
    return source?.status !== 'scanned' || String(source.reason || '') !== ''
      || !Number.isFinite(source.bytes_scanned) || source.bytes_scanned <= 0;
  });
  return sourceMismatch ? `runtime_evidence_sources.${sourceMismatch}` : '';
}

function buildDockerRuntimeSecuritySummary(plan = {}, options = {}) {
  if (options.cleanupOnlyEvidence) {
    const evidence = options.cleanupOnlyEvidence;
    const scanned = evidence.sources.flatMap(source => [...scanSecretText(source.text, secretScanOptions(plan)),
      ...(!source.privateConfiguration && !source.restrictedRetiredAuthority ? (evidence.knownSecrets || []).flatMap(value => {
        const count = value.length >= 6 ? source.text.split(value).length - 1 : 0;
        return count ? [{ id: 'known_private_configuration_value_exposure', count }] : [];
      }) : [])]
      .map(finding => ({ id: finding.id, count: finding.count, kind: source.kind,
        disposition: source.privateConfiguration ? 'private_configuration_expected_values_unverified'
          : source.restrictedRetiredAuthority ? 'restricted_retired_lock_authority' : 'exposure' })));
    const exposed = scanned.filter(finding => finding.disposition === 'exposure');
    const approved = evidence.restrictedEvidenceApproval;
    const inspectBinding = approved?.inspect_binding;
    let projectedText;
    if (inspectBinding) {
      const source = evidence.sources.find(source => source.kind === inspectBinding.source_kind);
      if (!source?.kind.startsWith('resource_inspect:container:')
        || source.resourceFingerprint !== inspectBinding.resource_fingerprint
        || JSON.stringify(inspectBinding.paths) !== JSON.stringify([
          'HostConfig.Binds.0', 'Mounts.0.Destination', 'Config.Healthcheck.Test.1', 'Config.Image',
        ])) throw new Error('interrupted_cleanup_inspect_binding_invalid');
      const raw = JSON.parse(source.text);
      if (!raw.Id || raw.Id !== inspectBinding.resource_id || raw.Image !== inspectBinding.image_id
        || !/^sha256:[a-f0-9]{64}$/.test(raw.Image || '')) throw new Error('interrupted_cleanup_inspect_identity_changed');
      projectedText = JSON.stringify(Object.fromEntries(inspectBinding.paths.map(field => {
        const value = field.split('.').reduce((object, key) => Object.hasOwn(object || {}, key) ? object[key] : undefined, raw);
        if (typeof value !== 'string') throw new Error('interrupted_cleanup_inspect_field_missing');
        return [field, value];
      })));
      const projected = [...scanSecretText(projectedText, secretScanOptions(plan)),
        ...(evidence.knownSecrets || []).flatMap(value => {
          const count = value.length >= 6 ? projectedText.split(value).length - 1 : 0;
          return count ? [{ id: 'known_private_configuration_value_exposure', count }] : [];
        })].map(finding => ({ id: finding.id, count: finding.count }));
      if (JSON.stringify(projected) !== JSON.stringify(exposed.filter(f => f.kind === source.kind)
        .map(f => ({ id: f.id, count: f.count })))) throw new Error('interrupted_cleanup_unbound_inspect_finding');
    }
    const actual = exposed.map(finding => ({ ...finding,
      sha256: crypto.createHash('sha256').update(finding.kind === inspectBinding?.source_kind ? projectedText
        : evidence.sources.find(source => source.kind === finding.kind).text).digest('hex'),
    }));
    if (approved && JSON.stringify(approved.findings) !== JSON.stringify(actual)) {
      throw new Error('interrupted_cleanup_restricted_evidence_changed');
    }
    const restrictedFindings = approved ? actual.map(finding => ({ ...finding,
      disposition: 'approved_restricted_evidence_uncertain', uncertainty: 'identifier_context_not_proven',
    })) : [];
    const findings = approved ? [] : exposed;
    return {
      generated_at: new Date().toISOString(),
      proof: 'interrupted-recovery-current-security-scan',
      purpose: 'cleanup-only', qualification_eligible: false,
      historical_startup_settlement: 'unproven',
      status: findings.length ? 'failed' : restrictedFindings.length ? 'restricted_cleanup_accepted' : 'passed', findings,
      restricted_evidence_findings: restrictedFindings,
      restricted_evidence_approval_sha256: approved?.sha256 || null,
      restricted_inspect_binding: inspectBinding || null,
      private_configuration_findings: scanned.filter(finding => finding.disposition === 'private_configuration_expected_values_unverified'),
      restricted_authority_findings: scanned.filter(finding => finding.disposition === 'restricted_retired_lock_authority'),
      expected_configuration_values_verified: false,
      owner: plan.owner, workspace_id: plan.workspace_id,
      compose_project: plan.compose_project_name, runtime_driver: 'docker',
      git_head: plan.git_head, git_tree: plan.git_tree,
      absence: evidence.absence,
      scanned_surfaces: evidence.sources.map(source => ({ kind: source.kind,
        bytes_scanned: Buffer.byteLength(source.text), private_configuration: source.privateConfiguration === true,
        restricted_retired_authority: source.restrictedRetiredAuthority === true,
        sha256: crypto.createHash('sha256').update(source.text).digest('hex') })),
      runtime_evidence_sources: Object.fromEntries(REQUIRED_RUNTIME_EVIDENCE_KINDS.map(kind => [kind,
        { status: 'absent', reason: 'browser_runtime_never_published', bytes_scanned: 0 }])),
      acceptance: { no_known_secret_leaks: findings.length === 0 && restrictedFindings.length === 0,
        cleanup_disposition_accepted: findings.length === 0, cleanup_scope_scanned: true },
    };
  }
  const envGitMetadata = gitMetadataFromEnv(process.env);
  const files = artifactFiles(plan).map(([kind, filePath]) => scanFile(kind, filePath, plan));
  const precomputedFindings = Array.isArray(options.precomputedFindings)
    ? options.precomputedFindings.map((finding) => ({
      id: String(finding?.id || ''),
      count: Number(finding?.count || 0),
      kind: String(finding?.kind || ''),
      file: String(finding?.file || ''),
    })).filter((finding) => finding.id && finding.kind && finding.count > 0)
    : [];
  const injected = [];
  for (const [kind, text] of Object.entries(options.additionalText || {})) {
    const findings = [
      ...scanSecretText(text, secretScanOptions(plan))
        .map((finding) => ({ ...finding, kind, file: `${kind}:inline` })),
      ...precomputedFindings.filter((finding) => finding.kind === kind),
    ];
    injected.push({ kind, file: `${kind}:inline`, exists: true, findings });
  }
  for (const finding of precomputedFindings) {
    if (injected.some((scan) => scan.kind === finding.kind)) continue;
    injected.push({ kind: finding.kind, file: finding.file, exists: true, findings: [finding] });
  }
  const allScans = [...files, ...injected];
  const findings = allScans.flatMap((scan) => scan.findings || []);
  const runtimeEvidenceSources = normalizeRuntimeEvidenceSources(
    options.additionalText || {},
    options.evidenceSources || {},
  );
  const runtimeEvidenceFailures = options.requireRuntimeEvidence === true
    ? Object.entries(runtimeEvidenceSources)
      .filter(([, source]) => source.status !== 'scanned' || source.bytes_scanned <= 0)
      .map(([kind]) => ({
        id: 'runtime_evidence_unavailable',
        count: 1,
        kind,
        file: `${kind}:inline`,
      }))
    : [];
  findings.push(...runtimeEvidenceFailures);
  const runtimeEvidenceCovered = Object.values(runtimeEvidenceSources)
    .every((source) => source.status === 'scanned' && source.bytes_scanned > 0);
  return {
    generated_at: new Date().toISOString(),
    status: findings.length ? 'failed' : 'passed',
    proof: 'docker-runtime-security-scan',
    workspace_id: plan.workspace_id || '',
    owner: plan.owner || '',
    compose_project: plan.compose_project_name || '',
    backend_project: plan.backend?.compose_project_name || '',
    runtime_driver: 'docker',
    git_head: plan.git_head || envGitMetadata.git_head || '',
    git_tree: plan.git_tree || '',
    git_branch: plan.git_branch || envGitMetadata.git_branch || '',
    runtime_authority_receipt_sha256: String(
      plan.runtime_authority_proof?.receiptSha256
        || plan.runtime_authority_proof?.receipt_sha256 || '',
    ),
    git_worktree: plan.git_worktree || envGitMetadata.git_worktree || '',
    git_status_clean: plan.git_status_clean ?? envGitMetadata.git_status_clean,
    git_dirty_files_count: plan.git_dirty_files_count ?? envGitMetadata.git_dirty_files_count,
    scanned_surfaces: allScans.map((scan) => ({
      kind: scan.kind,
      file: scan.file,
      exists: scan.exists,
      finding_count: scan.findings.length,
      finding_ids: scan.findings.map((finding) => finding.id),
    })),
    runtime_evidence_sources: runtimeEvidenceSources,
    excluded_private_env_files: [
      plan.artifacts?.env_file || '',
      plan.artifacts?.auth_password_file || '',
    ].filter(Boolean),
    findings,
    acceptance: {
      summaries_scanned: true,
      rendered_compose_scanned: true,
      docker_logs_scanned: runtimeEvidenceSources.docker_logs.status === 'scanned',
      docker_inspect_scanned: runtimeEvidenceSources.docker_inspect.status === 'scanned',
      docker_history_scanned: runtimeEvidenceSources.docker_history.status === 'scanned',
      runtime_evidence_coverage_recorded: runtimeEvidenceCovered,
      runtime_env_excluded_from_summary_scan: true,
      no_known_secret_leaks: findings.length === 0,
      native_android_out_of_scope: true,
    },
  };
}

function writeDockerRuntimeSecuritySummary(plan, options = {}) {
  const summary = buildDockerRuntimeSecuritySummary(plan, options);
  const artifactRoot = path.resolve(plan.artifacts.root);
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Docker runtime security summary root must be a real directory.');
  }
  const rootReal = fs.realpathSync(artifactRoot);
  const filePath = path.resolve(
    options.summaryFile || path.join(rootReal, 'security-summary.json'),
  );
  if (path.dirname(filePath) !== rootReal) {
    throw new Error('Docker runtime security summary escaped its artifact root.');
  }
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isDirectory()) {
      throw new Error('Docker runtime security summary destination must not be a directory.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const content = `${JSON.stringify(summary, null, 2)}\n`;
  const bytes = Buffer.from(content, 'utf8');
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const temporaryPath = path.join(
    rootReal,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let fd;
  let temporaryIdentity;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    const before = fs.fstatSync(fd);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
    if (!before.isFile() || before.uid !== currentUid || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600 || before.size !== 0) {
      throw new Error('Docker runtime security summary temporary file is invalid.');
    }
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const afterFd = fs.fstatSync(fd);
    if (!afterFd.isFile() || afterFd.dev !== before.dev || afterFd.ino !== before.ino
      || afterFd.size !== bytes.length || (afterFd.mode & 0o777) !== 0o600
      || afterFd.uid !== currentUid || afterFd.nlink !== 1) {
      throw new Error('Docker runtime security summary temporary identity changed.');
    }
    temporaryIdentity = {
      dev: afterFd.dev,
      ino: afterFd.ino,
      size: afterFd.size,
      mode: afterFd.mode,
      uid: afterFd.uid,
      nlink: afterFd.nlink,
    };
    fs.closeSync(fd);
    fd = undefined;
    const temporaryPathStat = fs.lstatSync(temporaryPath);
    if (temporaryPathStat.dev !== temporaryIdentity.dev
      || temporaryPathStat.ino !== temporaryIdentity.ino) {
      throw new Error('Docker runtime security summary temporary path changed.');
    }
    fs.renameSync(temporaryPath, filePath);
    const directoryFd = fs.openSync(
      rootReal,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      const current = fs.lstatSync(temporaryPath);
      if (temporaryIdentity
        && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
        fs.unlinkSync(temporaryPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  let readFd;
  try {
    const beforeRead = fs.lstatSync(filePath);
    readFd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(readFd);
    const readBytes = fs.readFileSync(readFd);
    const afterRead = fs.fstatSync(readFd);
    const afterPath = fs.lstatSync(filePath);
    const stable = [opened, afterRead, afterPath].every((stat) => (
      stat.isFile() && !stat.isSymbolicLink()
      && stat.dev === temporaryIdentity.dev && stat.ino === temporaryIdentity.ino
      && stat.size === bytes.length && (stat.mode & 0o777) === 0o600
      && stat.uid === temporaryIdentity.uid && stat.nlink === 1
    ));
    if (!stable || beforeRead.dev !== temporaryIdentity.dev
      || beforeRead.ino !== temporaryIdentity.ino || !readBytes.equals(bytes)
      || crypto.createHash('sha256').update(readBytes).digest('hex') !== expectedHash) {
      throw new Error('Docker runtime security summary stable readback failed.');
    }
  } finally {
    if (readFd !== undefined) fs.closeSync(readFd);
  }
  return { summary, file: filePath };
}

module.exports = {
  buildDockerInspectEvidencePayload,
  buildDockerRuntimeSecuritySummary,
  buildRuntimeEvidencePayload,
  dockerRuntimeSecuritySummaryMismatch,
  secretScanOptions,
  writeDockerRuntimeSecuritySummary,
};
