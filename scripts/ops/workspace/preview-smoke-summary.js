#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    manifest: '',
    out: '',
    mdOut: '',
    mode: '',
    requiredSurfaces: '',
    a2zReport: '',
    benchmarkJson: '',
    keepResources: '',
    runA2z: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const next = String(argv[i + 1] || '').trim();
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = '1';
  }
  return out;
}

function writeJson(targetPath, payload) {
  const fullPath = path.resolve(String(targetPath || '').trim());
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return fullPath;
}

function writeText(targetPath, content) {
  const fullPath = path.resolve(String(targetPath || '').trim());
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function readJsonSafe(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  if (!resolved || !fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function parseCsv(raw) {
  return Array.from(new Set(
    String(raw || '')
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ));
}

function normalizeSurfaceStatus(surfaceId, status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'missing';
  if (surfaceId === 'db') {
    if (value === 'deployed' || value === 'prewarmed') return 'ready';
    if (value === 'skipped') return 'skipped';
    if (value === 'failed') return 'failed';
    return value;
  }
  if (value === 'deployed' || value === 'prewarmed') return 'ready';
  if (value === 'skipped') return 'skipped';
  if (value === 'failed') return 'failed';
  return value;
}

function resolveRequiredSurfaces({ raw, manifest }) {
  const explicit = parseCsv(raw);
  if (explicit.length > 0) return explicit;
  const surfaces = manifest?.surfaces && typeof manifest.surfaces === 'object'
    ? manifest.surfaces
    : {};
  const derived = [];
  for (const [surfaceId, surface] of Object.entries(surfaces)) {
    if (String(surface?.required_for_run || '').trim() === '0') continue;
    derived.push(surfaceId);
  }
  return derived;
}

function summarizeSurfaceStates({ manifest, requiredSurfaces }) {
  const surfaces = manifest?.surfaces && typeof manifest.surfaces === 'object'
    ? manifest.surfaces
    : {};
  return requiredSurfaces.map((surfaceId) => {
    const surface = surfaces[surfaceId] && typeof surfaces[surfaceId] === 'object'
      ? surfaces[surfaceId]
      : {};
    const normalizedStatus = normalizeSurfaceStatus(surfaceId, surface.status);
    return {
      surface_id: surfaceId,
      raw_status: String(surface.status || '').trim() || 'missing',
      normalized_status: normalizedStatus,
      reason: String(surface.reason || '').trim(),
      required_for_run: String(surface.required_for_run || '').trim() !== '0',
    };
  });
}

function expectedChecksForSurfaces(requiredSurfaces) {
  const checks = [];
  const wanted = new Set(requiredSurfaces);
  if (wanted.has('db')) checks.push('workflow_intake_smoke');
  if (wanted.has('console') || wanted.has('portal')) checks.push('ui_surface_smoke');
  if (wanted.has('landing')) checks.push('landing_smoke');
  if (wanted.has('docs')) checks.push('docs_smoke');
  if (wanted.has('mobile_fieldops')) checks.push('mobile_preview_state');
  return checks;
}

function summarizeGlobalSmoke({ globalSmoke, expectedChecks }) {
  const checks = Array.isArray(globalSmoke?.checks) ? globalSmoke.checks : [];
  const checksByName = new Map(checks.map((entry) => [String(entry?.check || '').trim(), entry]));
  const partialReasons = [];
  const failureReasons = [];
  const expected = expectedChecks.map((checkName) => {
    const row = checksByName.get(checkName);
    if (!row) {
      partialReasons.push(`missing_check:${checkName}`);
      return {
        check: checkName,
        status: 'missing',
        reason: 'missing_check_result',
      };
    }
    if (row.ok === false) {
      failureReasons.push(`failed_check:${checkName}`);
      return {
        check: checkName,
        status: 'failed',
        reason: String(row.error || '').trim(),
      };
    }
    if (row.skipped) {
      partialReasons.push(`skipped_check:${checkName}:${String(row.reason || '').trim() || 'unknown'}`);
      return {
        check: checkName,
        status: 'skipped',
        reason: String(row.reason || '').trim(),
      };
    }
    return {
      check: checkName,
      status: 'passed',
      reason: '',
    };
  });
  return {
    expected,
    partialReasons,
    failureReasons,
    report_path: globalSmoke ? String(globalSmoke.report_path || '').trim() : '',
  };
}

function summarizeA2z({ a2zReport, requested }) {
  const out = {
    requested,
    present: Boolean(a2zReport),
    status: requested ? 'missing' : 'not_requested',
    blockers: [],
    group_status_counts: {},
    partialReasons: [],
    failureReasons: [],
  };
  if (!requested) return out;
  if (!a2zReport) {
    out.partialReasons.push('a2z_report_missing');
    return out;
  }

  const blockers = Array.isArray(a2zReport.blockers) ? a2zReport.blockers.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const groups = a2zReport.groups && typeof a2zReport.groups === 'object' ? a2zReport.groups : {};
  const counts = {};
  let hasFailure = false;
  let hasPartial = false;

  for (const value of Object.values(groups)) {
    const status = String(value?.status || 'unknown').trim().toLowerCase() || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    if (status === 'failed' || status === 'blocked') hasFailure = true;
    else if (status === 'partial' || status === 'missing' || status === 'not_run') hasPartial = true;
  }

  out.present = true;
  out.blockers = blockers;
  out.group_status_counts = counts;
  if (blockers.length > 0 || hasFailure) {
    out.status = 'failed';
    if (blockers.length > 0) out.failureReasons.push(...blockers.map((value) => `a2z_blocker:${value}`));
    if (hasFailure) out.failureReasons.push('a2z_group_failure');
    return out;
  }
  if (hasPartial) {
    out.status = 'partial';
    out.partialReasons.push('a2z_group_partial');
    return out;
  }
  out.status = 'passed';
  return out;
}

function buildPreviewSmokeSummary({
  manifest,
  manifestPath,
  globalSmoke,
  a2zReport,
  benchmarkReport,
  requiredSurfaces,
  mode,
  keepResources,
  runA2z,
}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Preview manifest missing or invalid: ${manifestPath}`);
  }
  const required = resolveRequiredSurfaces({ raw: requiredSurfaces, manifest });
  const surfaceStates = summarizeSurfaceStates({ manifest, requiredSurfaces: required });
  const expectedChecks = expectedChecksForSurfaces(required);
  const globalSmokeSummary = summarizeGlobalSmoke({ globalSmoke, expectedChecks });
  const a2zRequested =
    String(runA2z || '').trim().toLowerCase() === 'true' ||
    String(runA2z || '').trim() === '1' ||
    Boolean(a2zReport) ||
    String(mode || '').trim().toLowerCase() === 'a2z' ||
    String(process.env.PREVIEW_SMOKE_RUN_A2Z || '').trim() === '1';
  const a2zSummary = summarizeA2z({ a2zReport, requested: a2zRequested });
  const manifestWarnings = Array.isArray(manifest.warnings) ? manifest.warnings.map((value) => String(value || '').trim()).filter(Boolean) : [];

  const partialReasons = [...globalSmokeSummary.partialReasons, ...a2zSummary.partialReasons];
  const failureReasons = [...globalSmokeSummary.failureReasons, ...a2zSummary.failureReasons];
  for (const row of surfaceStates) {
    if (row.normalized_status === 'failed') {
      failureReasons.push(`surface_failed:${row.surface_id}`);
    } else if (row.normalized_status !== 'ready') {
      partialReasons.push(`surface_not_ready:${row.surface_id}:${row.raw_status}`);
    }
  }
  if (!globalSmoke) {
    partialReasons.push('global_smoke_missing');
  }

  const normalizedMode = String(mode || '').trim().toLowerCase() || 'preview';
  let coverageStatus = 'complete';
  if (normalizedMode === 'benchmark') {
    coverageStatus = failureReasons.length > 0 ? 'failed' : 'benchmark_only';
  } else if (failureReasons.length > 0) {
    coverageStatus = 'failed';
  } else if (partialReasons.length > 0) {
    coverageStatus = 'partial';
  }

  return {
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    global_smoke_report_path: globalSmokeSummary.report_path || `${manifestPath}.global-smoke.json`,
    required_surfaces: required,
    expected_checks: expectedChecks,
    surface_states: surfaceStates,
    manifest_warnings: manifestWarnings,
    keep_resources: Boolean(keepResources),
    mode: normalizedMode,
    coverage_status: coverageStatus,
    status: coverageStatus === 'failed' ? 'failed' : coverageStatus === 'partial' ? 'warning' : 'passed',
    partial_reasons: Array.from(new Set(partialReasons)),
    failure_reasons: Array.from(new Set(failureReasons)),
    a2z: {
      requested: a2zSummary.requested,
      present: a2zSummary.present,
      status: a2zSummary.status,
      blockers: a2zSummary.blockers,
      group_status_counts: a2zSummary.group_status_counts,
    },
    benchmark: benchmarkReport
      ? {
          present: true,
          summary_keys: Object.keys(benchmarkReport),
        }
      : {
          present: false,
          summary_keys: [],
        },
    checks: globalSmokeSummary.expected,
  };
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push('### Preview Smoke Summary');
  lines.push('');
  lines.push(`- Coverage: \`${summary.coverage_status}\``);
  lines.push(`- Mode: \`${summary.mode}\``);
  lines.push(`- Required Surfaces: \`${summary.required_surfaces.join(',') || '<none>'}\``);
  lines.push(`- Keep Resources: \`${summary.keep_resources ? 'true' : 'false'}\``);
  lines.push('');
  if (summary.failure_reasons.length > 0) {
    lines.push('#### Failures');
    for (const reason of summary.failure_reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }
  if (summary.partial_reasons.length > 0) {
    lines.push('#### Partial Coverage');
    for (const reason of summary.partial_reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }
  lines.push('#### Surface States');
  lines.push('| Surface | Status | Reason |');
  lines.push('|---|---|---|');
  for (const row of summary.surface_states) {
    lines.push(`| ${row.surface_id} | ${row.raw_status} | ${row.reason || '<none>'} |`);
  }
  lines.push('');
  lines.push('#### Smoke Checks');
  lines.push('| Check | Status | Reason |');
  lines.push('|---|---|---|');
  for (const row of summary.checks) {
    lines.push(`| ${row.check} | ${row.status} | ${row.reason || '<none>'} |`);
  }
  lines.push('');
  if (summary.a2z.requested) {
    lines.push('#### Frontend A-Z');
    lines.push(`- Status: \`${summary.a2z.status}\``);
    if (summary.a2z.blockers.length > 0) {
      lines.push(`- Blockers: \`${summary.a2z.blockers.join(', ')}\``);
    }
    if (Object.keys(summary.a2z.group_status_counts).length > 0) {
      lines.push(`- Group Status Counts: \`${JSON.stringify(summary.a2z.group_status_counts)}\``);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs();
  const manifestRaw = String(args.manifest || '').trim();
  if (!manifestRaw) {
    throw new Error('Missing --manifest');
  }
  const manifestPath = path.resolve(manifestRaw);
  const manifest = readJsonSafe(manifestPath);
  const globalSmoke = readJsonSafe(`${manifestPath}.global-smoke.json`);
  const a2zReport = readJsonSafe(args.a2zReport);
  const benchmarkReport = readJsonSafe(args.benchmarkJson);
  const summary = buildPreviewSmokeSummary({
    manifest,
    manifestPath,
    globalSmoke,
    a2zReport,
    benchmarkReport,
    requiredSurfaces: args.requiredSurfaces,
    mode: args.mode,
    keepResources: args.keepResources === '1' || args.keepResources === 'true',
    runA2z: args.runA2z,
  });

  const outPath = writeJson(args.out || `${manifestPath}.smoke-summary.json`, summary);
  const mdPath = writeText(args.mdOut || `${manifestPath}.smoke-summary.md`, buildMarkdown(summary));
  console.log(`[preview-smoke-summary] wrote ${outPath}`);
  console.log(`[preview-smoke-summary] wrote ${mdPath}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, buildMarkdown(summary), 'utf8');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[preview-smoke-summary] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  buildPreviewSmokeSummary,
  buildMarkdown,
  expectedChecksForSurfaces,
  resolveRequiredSurfaces,
  summarizeA2z,
  summarizeGlobalSmoke,
  summarizeSurfaceStates,
};
