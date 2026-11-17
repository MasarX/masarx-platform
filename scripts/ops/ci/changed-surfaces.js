#!/usr/bin/env node
/**
 * changed-surfaces.js
 *
 * Determines which deploy surfaces were affected by the current GitHub event.
 *
 * Supports:
 * - pull_request (opened/reopened/synchronize)
 * - merge_group (checks_requested)
 * - push (before..after)
 *
 * Safe defaults:
 * - When the diff is unknown or ambiguous, it fails closed by returning all surfaces.
 */
/* eslint-disable no-console */
const fs = require('fs');

const {
  computeMergeBaseDiffRange,
  resolveChangedFilesForRange,
} = require('./pr-change-classify');

const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  listSurfaceIds,
  filterSurfaceIdsForStage,
  resolveImpactPayloadForPaths,
  resolveRequiredPreviewSurfaceIds,
} = require('./deploy-surface-registry');

function die(msg) {
  console.error(`[changed-surfaces] ${msg}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; run with --format json locally.');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v == null ? '' : v)}`);
  }
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function parseCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    config: '',
    format: '',
    failClosed: true,
    paths: [],
    action: '',
    from: '',
    to: '',
    preferMergeBase: null,
    stage: '',
  };
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--config') out.config = String(args[++i] || '').trim();
    else if (a.startsWith('--config=')) out.config = a.split('=').slice(1).join('=').trim();
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
    else if (a === '--paths') out.paths = parseCsv(args[++i] || '');
    else if (a.startsWith('--paths=')) out.paths = parseCsv(a.split('=').slice(1).join('=').trim());
    else if (a === '--action') out.action = String(args[++i] || '').trim();
    else if (a.startsWith('--action=')) out.action = a.split('=').slice(1).join('=').trim();
    else if (a === '--from') out.from = String(args[++i] || '').trim();
    else if (a.startsWith('--from=')) out.from = a.split('=').slice(1).join('=').trim();
    else if (a === '--to') out.to = String(args[++i] || '').trim();
    else if (a.startsWith('--to=')) out.to = a.split('=').slice(1).join('=').trim();
    else if (a === '--prefer-merge-base') {
      const raw = args[i + 1] && !String(args[i + 1]).startsWith('--') ? String(args[++i] || '').trim() : '1';
      out.preferMergeBase = raw !== '0';
    } else if (a.startsWith('--prefer-merge-base=')) {
      const raw = a.split('=').slice(1).join('=').trim();
      out.preferMergeBase = raw !== '0';
    }
    else if (a === '--stage') out.stage = String(args[++i] || '').trim();
    else if (a.startsWith('--stage=')) out.stage = a.split('=').slice(1).join('=').trim();
    else if (a === '--fail-closed') {
      const raw = args[i + 1] && !String(args[i + 1]).startsWith('--') ? String(args[++i] || '').trim() : '1';
      out.failClosed = raw !== '0';
    } else if (a.startsWith('--fail-closed=')) {
      const raw = a.split('=').slice(1).join('=').trim();
      out.failClosed = raw !== '0';
    }
  }
  return out;
}

function resolveExplicitDiffDescriptor({ action, from, to, preferMergeBase } = {}) {
  const normalizedAction = String(action || '').trim();
  const normalizedFrom = String(from || '').trim();
  const normalizedTo = String(to || '').trim();
  if (!normalizedAction && !normalizedFrom && !normalizedTo) return null;
  return {
    kind: 'explicit',
    action: normalizedAction || 'opened',
    from: normalizedFrom,
    to: normalizedTo,
    preferMergeBase: preferMergeBase == null ? false : Boolean(preferMergeBase),
  };
}

function extractDiffDescriptor({ eventName, eventPayload }) {
  const name = String(eventName || '').trim();
  const evt = eventPayload && typeof eventPayload === 'object' ? eventPayload : {};

  if (evt.merge_group) {
    const from = String(evt?.merge_group?.base_sha || '').trim();
    const to = String(evt?.merge_group?.head_sha || '').trim();
    if (from && to) return { kind: 'merge_group', action: 'checks_requested', from, to, preferMergeBase: false };
  }

  if (evt.pull_request) {
    const action = String(evt.action || '').trim();
    if (action === 'synchronize') {
      const from = String(evt.before || '').trim();
      const to = String(evt.after || '').trim();
      if (from && to) return { kind: 'pull_request', action, from, to, preferMergeBase: false };
    }
    if (action === 'opened' || action === 'reopened') {
      const from = String(evt?.pull_request?.base?.sha || '').trim();
      const to = String(evt?.pull_request?.head?.sha || '').trim();
      if (from && to) return { kind: 'pull_request', action, from, to, preferMergeBase: true };
    }
    return { kind: 'pull_request', action, from: '', to: '', preferMergeBase: false };
  }

  if (name === 'push') {
    const from = String(evt.before || '').trim();
    const to = String(evt.after || '').trim();
    if (from && to) return { kind: 'push', action: 'push', from, to, preferMergeBase: false };
  }

  return { kind: name || 'unknown', action: '', from: '', to: '', preferMergeBase: false };
}

async function resolveChangedFiles({ descriptor, explicitFrom, explicitTo }) {
  const from = String(explicitFrom || descriptor?.from || '').trim();
  const to = String(explicitTo || descriptor?.to || '').trim();
  const action = String(descriptor?.action || descriptor?.kind || '').trim();
  if (!from || !to) {
    return { changedFiles: [], diffRange: '', unknown: true, source: 'missing_shas' };
  }

  const diffRange = descriptor?.preferMergeBase ? computeMergeBaseDiffRange(from, to) : `${from}..${to}`;
  return resolveChangedFilesForRange({ action, from, to, diffRange });
}

async function main() {
  const args = parseArgs();
  const fmt = String(args.format || '').trim().toLowerCase();
  const failClosed = args.failClosed == null ? true : Boolean(args.failClosed);

  const { registry } = loadDeploySurfaceRegistry({ configPath: args.config });
  const compiled = compileRegistry(registry);
  const allSurfaceIds = listSurfaceIds(compiled);

  let changedFiles = [];
  let diffRange = '';
  let unknown = false;
  let source = '';

  if (args.paths && args.paths.length) {
    changedFiles = args.paths;
    source = 'paths_arg';
  } else {
    const evtPath = process.env.GITHUB_EVENT_PATH;
    if (!evtPath || !fs.existsSync(evtPath)) die('GITHUB_EVENT_PATH missing or unreadable.');
    const evt = readJson(evtPath);
    if (!evt) die('Failed to parse event JSON.');

    const descriptor = resolveExplicitDiffDescriptor({
      action: args.action,
      from: args.from,
      to: args.to,
      preferMergeBase: args.preferMergeBase,
    }) || extractDiffDescriptor({ eventName: process.env.GITHUB_EVENT_NAME || '', eventPayload: evt });
    const resolved = await resolveChangedFiles({ descriptor, explicitFrom: args.from, explicitTo: args.to });
    changedFiles = resolved.changedFiles;
    diffRange = resolved.diffRange;
    unknown = Boolean(resolved.unknown);
    source = String(resolved.source || '') || (unknown ? 'unknown' : 'git');
  }

  const impactPayload = resolveImpactPayloadForPaths(compiled, changedFiles, {
    unknown,
    failClosed,
    stage: args.stage,
  });
  const classificationUnknown = Boolean(impactPayload.unknown);
  const surfaceIds = Array.isArray(impactPayload.surfaceIds) ? impactPayload.surfaceIds : allSurfaceIds;
  const requiredPreviewSurfaceIds = Array.isArray(impactPayload.requiredPreviewSurfaceIds)
    ? impactPayload.requiredPreviewSurfaceIds
    : resolveRequiredPreviewSurfaceIds({ compiled, surfaceIds });
  const unmatched = Array.isArray(impactPayload.unmatchedFiles) ? impactPayload.unmatchedFiles : [];

  const out = {
    surface_ids: surfaceIds.join(','),
    surfaces_json: JSON.stringify(surfaceIds),
    required_preview_surface_ids: requiredPreviewSurfaceIds.join(','),
    required_preview_surfaces_json: JSON.stringify(requiredPreviewSurfaceIds),
    console_portal_e2e_profile: impactPayload.consolePortalE2EProfile || 'full',
    diff_range: diffRange,
    changed_count: String(changedFiles.length),
    unknown: classificationUnknown ? '1' : '0',
    change_source: source || (classificationUnknown ? 'unknown' : 'git'),
    unmatched_count: String(unmatched.length),
    impact_surfaces: impactPayload.impactSurfaces.join(','),
    required_suites: impactPayload.requiredSuites.join(','),
    selection_confidence: impactPayload.selectionConfidence,
    fallback_to_full: impactPayload.fallbackToFull ? '1' : '0',
    fallback_reason: impactPayload.fallbackReason || '',
    selected_suites_json: JSON.stringify(impactPayload.selectedSuites || []),
    skipped_suites_json: JSON.stringify(impactPayload.skippedSuites || []),
    unmatched_files_json: JSON.stringify(impactPayload.unmatchedFiles || []),
    impacted_surface_ids_json: JSON.stringify(impactPayload.impactedSurfaceIds || []),
  };

  if (fmt === 'github-output') writeGithubOutput(out);
  else process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => die(e && e.message ? e.message : String(e)));
}

module.exports = {
  extractDiffDescriptor,
  resolveExplicitDiffDescriptor,
  resolveRequiredPreviewSurfaceIds,
  filterSurfaceIdsForStage,
};
