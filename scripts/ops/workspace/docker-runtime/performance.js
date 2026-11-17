const fs = require('fs');
const path = require('path');
const { gitMetadataFromEnv } = require('./git-metadata');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  return startMs && endMs && endMs >= startMs ? endMs - startMs : null;
}

function describeMissingTiming(key, sources = {}) {
  const { attempt, backend, browser, runtime, fieldopsSurface } = sources;
  if (key === 'runtime_attempt_total') {
    if (!attempt) return 'runtime_attempt_missing';
    return 'runtime_attempt_timestamps_missing';
  }
  if (key === 'docker_up_attempt_total') {
    if (!attempt) return 'runtime_attempt_missing';
    return attempt.command === 'up' ? 'docker_up_attempt_timestamps_missing' : `runtime_attempt_command_${attempt.command || 'unknown'}`;
  }
  if (key === 'docker_test_attempt_total') {
    if (!attempt) return 'runtime_attempt_missing';
    return attempt.command === 'test' ? 'docker_test_attempt_timestamps_missing' : `runtime_attempt_command_${attempt.command || 'unknown'}`;
  }
  if (key === 'cold_backend_start') {
    if (!backend) return 'backend_proof_summary_missing';
    return 'supabase_cli_v1_backend_did_not_record_cold_start_ms';
  }
  if (key === 'warm_backend_reuse') {
    if (!backend) return 'backend_proof_summary_missing';
    return 'supabase_cli_v1_backend_did_not_record_warm_reuse_ms';
  }
  if (key === 'browser_proof_duration') {
    if (!browser) return 'browser_proof_summary_missing';
    return 'browser_proof_duration_ms_missing';
  }
  if (key === 'fieldops_proof_duration') {
    if (!browser) return 'browser_proof_summary_missing';
    if (!fieldopsSurface) return 'fieldops_browser_surface_missing';
    return 'fieldops_browser_surface_duration_ms_missing';
  }
  if (key === 'runtime_container_proof_duration') {
    if (!runtime) return 'runtime_container_proof_summary_missing';
    return 'runtime_container_proof_duration_ms_missing';
  }
  return 'timing_unavailable';
}

function buildTimingUnavailableReasons(timing = {}, sources = {}) {
  return Object.fromEntries(
    Object.entries(timing)
      .filter(([_key, value]) => value == null)
      .map(([key]) => [key, describeMissingTiming(key, sources)]),
  );
}

function parseComposePsJson(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const entries = [];
  for (const line of trimmed.split(/\r?\n/u).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) entries.push(...parsed);
      else entries.push(parsed);
    } catch {
      return [];
    }
  }
  return entries;
}

function buildDockerRuntimePerformanceSummary(plan = {}, options = {}) {
  const envGitMetadata = gitMetadataFromEnv(process.env);
  const attempt = readJsonSafe(plan.artifacts?.attempt_file || '');
  const dependency = readJsonSafe(plan.artifacts?.dependency_summary_file || '');
  const backend = readJsonSafe(plan.artifacts?.backend_summary_file || '');
  const auth = readJsonSafe(plan.artifacts?.auth_summary_file || '');
  const browser = readJsonSafe(path.join(plan.artifacts?.root || '.', 'browser-proof-summary.json'));
  const runtime = readJsonSafe(path.join(plan.artifacts?.root || '.', 'in-container-proof-summary.json'));
  const dockerEntries = parseComposePsJson(options.dockerPsStdout || '');
  const browserSurfaces = Array.isArray(browser?.surfaces) ? browser.surfaces : [];
  const fieldopsSurface = browserSurfaces.find((surface) => surface.service === 'fieldops-metro');
  const proofTimes = {
    dependency_generated_at: dependency?.generated_at || '',
    backend_generated_at: backend?.generated_at || '',
    auth_generated_at: auth?.generated_at || '',
    browser_generated_at: browser?.generated_at || '',
    runtime_generated_at: runtime?.generated_at || '',
  };
  const timingMs = {
    runtime_attempt_total: durationMs(attempt?.started_at, attempt?.completed_at || attempt?.updated_at),
    docker_up_attempt_total: attempt?.command === 'up' ? durationMs(attempt?.started_at, attempt?.completed_at || attempt?.updated_at) : null,
    docker_test_attempt_total: attempt?.command === 'test' ? durationMs(attempt?.started_at, attempt?.completed_at || attempt?.updated_at) : null,
    cold_backend_start: backend?.performance?.cold_backend_start_ms ?? null,
    warm_backend_reuse: backend?.performance?.warm_backend_reuse_ms ?? null,
    browser_proof_duration: browser?.duration_ms ?? null,
    fieldops_proof_duration: fieldopsSurface?.duration_ms ?? null,
    runtime_container_proof_duration: runtime?.duration_ms ?? null,
  };
  const timingUnavailableReasons = buildTimingUnavailableReasons(timingMs, {
    attempt,
    backend,
    browser,
    runtime,
    fieldopsSurface,
  });
  const summary = {
    generated_at: new Date().toISOString(),
    status: 'passed',
    proof: 'docker-runtime-performance-baseline',
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
    timing_ms: timingMs,
    timing_unavailable_reasons: timingUnavailableReasons,
    resources: {
      active_compose_containers: dockerEntries.filter((entry) => /running|up/i.test(String(entry.State || entry.Status || ''))).length,
      compose_container_count: dockerEntries.length,
      service_count: Array.isArray(plan.services) ? plan.services.length : 0,
      browser_context_count: new Set(browserSurfaces.map((surface) => surface.browser_context_id).filter(Boolean)).size,
      browser_surface_count: browserSurfaces.length,
      host: options.hostSummary || null,
      docker_system: options.dockerSystemSummary || null,
    },
    proof_times: proofTimes,
    acceptance: {
      boot_and_proof_timing_recorded: Boolean(attempt),
      timing_unavailable_reasons_recorded: Object.values(timingUnavailableReasons).every(Boolean),
      browser_context_count_recorded: true,
      container_count_recorded: true,
      cpu_memory_disk_snapshot_recorded: Boolean(options.hostSummary || options.dockerSystemSummary),
      native_android_out_of_scope: true,
    },
  };
  const missing = [];
  if (!attempt) missing.push('runtime_attempt_missing');
  if (!summary.acceptance.container_count_recorded) missing.push('container_count_missing');
  summary.status = missing.length ? 'failed' : 'passed';
  summary.missing = missing;
  return summary;
}

function writeDockerRuntimePerformanceSummary(plan, options = {}) {
  const summary = buildDockerRuntimePerformanceSummary(plan, options);
  const filePath = options.summaryFile || path.join(plan.artifacts.root, 'performance-summary.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { summary, file: filePath };
}

module.exports = {
  buildTimingUnavailableReasons,
  buildDockerRuntimePerformanceSummary,
  writeDockerRuntimePerformanceSummary,
};
