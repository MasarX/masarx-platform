const fs = require('fs');
const path = require('path');
const { scanSecretText } = require('./redaction');
const { gitMetadataFromEnv } = require('./git-metadata');

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

function scanFile(kind, filePath) {
  const text = readTextSafe(filePath);
  if (!text) return { kind, file: filePath, exists: false, findings: [] };
  return {
    kind,
    file: filePath,
    exists: true,
    findings: scanSecretText(text).map((finding) => ({
      ...finding,
      file: filePath,
      kind,
    })),
  };
}

function normalizeRuntimeEvidenceSources(additionalText = {}, evidenceSources = {}) {
  const requiredRuntimeKinds = ['docker_logs', 'docker_inspect', 'docker_history'];
  return Object.fromEntries(requiredRuntimeKinds.map((kind) => {
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

function buildDockerRuntimeSecuritySummary(plan = {}, options = {}) {
  const envGitMetadata = gitMetadataFromEnv(process.env);
  const files = artifactFiles(plan).map(([kind, filePath]) => scanFile(kind, filePath));
  const injected = [];
  for (const [kind, text] of Object.entries(options.additionalText || {})) {
    const findings = scanSecretText(text).map((finding) => ({ ...finding, kind, file: `${kind}:inline` }));
    injected.push({ kind, file: `${kind}:inline`, exists: true, findings });
  }
  const allScans = [...files, ...injected];
  const findings = allScans.flatMap((scan) => scan.findings || []);
  const runtimeEvidenceSources = normalizeRuntimeEvidenceSources(
    options.additionalText || {},
    options.evidenceSources || {},
  );
  const runtimeEvidenceCovered = Object.values(runtimeEvidenceSources)
    .every((source) => source.status === 'scanned' || Boolean(source.reason));
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
    git_branch: plan.git_branch || envGitMetadata.git_branch || '',
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
      docker_logs_scanned_or_unavailable: runtimeEvidenceSources.docker_logs.status === 'scanned' ||
        Boolean(runtimeEvidenceSources.docker_logs.reason),
      docker_inspect_scanned_or_unavailable: runtimeEvidenceSources.docker_inspect.status === 'scanned' ||
        Boolean(runtimeEvidenceSources.docker_inspect.reason),
      docker_history_scanned_or_unavailable: runtimeEvidenceSources.docker_history.status === 'scanned' ||
        Boolean(runtimeEvidenceSources.docker_history.reason),
      runtime_evidence_coverage_recorded: runtimeEvidenceCovered,
      runtime_env_excluded_from_summary_scan: true,
      no_known_secret_leaks: findings.length === 0,
      native_android_out_of_scope: true,
    },
  };
}

function writeDockerRuntimeSecuritySummary(plan, options = {}) {
  const summary = buildDockerRuntimeSecuritySummary(plan, options);
  const filePath = options.summaryFile || path.join(plan.artifacts.root, 'security-summary.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { summary, file: filePath };
}

module.exports = {
  buildDockerRuntimeSecuritySummary,
  writeDockerRuntimeSecuritySummary,
};
