#!/usr/bin/env node
/**
 * pr-change-classify.js
 *
 * Lightweight GitHub Actions helper for PR workflows.
 * Determines whether a heavy preview+cloud verify should run for the current PR event.
 *
 * Behavior:
 * - pull_request.edited: skip (no new commits; avoid redundant preview/verify)
 * - pull_request.synchronize: diff event.before..event.after (incremental update),
 *   but only to optimize substeps. Full preview validation still reruns when the
 *   cumulative PR diff requires it.
 * - pull_request.opened/reopened: diff merge-base(base.sha, head.sha)..head.sha (full PR diff)
 * - merge_group.checks_requested: diff merge_group.base_sha..merge_group.head_sha (merge queue synthetic ref)
 * - skip when changed files are docs/plan artifacts only (docs/** or *.md)
 * - On pull_request.synchronize, enables change-aware skipping of expensive verify steps
 *   (db push + edge deploy) when the prior head SHA already passed reviewer_gate and the
 *   incremental diff contains no relevant changes, without allowing incremental docs/ui
 *   pushes to bypass preview reruns for a PR whose full diff is still preview-required.
 *
 * Outputs (github-output):
 * - skip_preview: 1|0
 * - run_fast_checks: 1|0
 * - skip_reason: string
 * - change_profile: string (optional)
 * - skip_full_preview: 1|0 (skip preview project + cloud verify; still run fast checks)
 * - diff_range: "<from>..<to>" or ""
 * - changed_count: number
 * - has_migrations: 1|0 (incremental range)
 * - has_pgtap: 1|0 (incremental range)
 * - has_db_contract_changes: 1|0 (migrations or pgTAP SQL changed)
 * - has_edge: 1|0 (incremental range)
 * - has_landing: 1|0 (landing surfaces changed)
 * - skip_db_push: 1|0 (safe only on synchronize + prior success)
 * - skip_edge_deploy: 1|0 (safe only on synchronize + prior success)
 * - prior_reviewer_gate_success: 1|0 (only computed when needed)
 * - impact_surfaces: comma-separated impacted surfaces
 * - required_suites: comma-separated required suites from surface registry impact selection
 * - selection_confidence: explicit|unknown
 * - fallback_to_full: 1|0
 * - fallback_reason: string
 * - skip_reasons: comma-separated reasons
 * - changed_files_json: json array of changed files
 * - unmatched_files_json: json array of unmatched files
 * - selected_suites_json: json array of selected suites
 * - skipped_suites_json: json array of skipped suites
 * - impacted_surface_ids_json: json array of effective impacted deploy surface ids
 * - suite_*: deterministic suite flags for workflow conditions
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  exportImpactMapFromCompiledRegistry,
  resolveImpactPayloadForPaths,
  listImpactSurfaceIds: listImpactSurfaceIdsFromRegistry,
  listImpactSuites: listImpactSuitesFromRegistry,
} = require('./deploy-surface-registry');

function die(msg) {
  console.error(`[pr-change-classify] ${msg}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function normalizeChangedPath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const classifyConfigRel = normalizeChangedPath(process.env.PR_CHANGE_CLASSIFY_CONFIG || 'config/ci/pr-change-classify.json');
const classifyConfigPath = path.isAbsolute(classifyConfigRel)
  ? classifyConfigRel
  : path.join(repoRoot, classifyConfigRel);

const defaultClassifierConfig = {
  version: 1,
  profiles: [
    {
      id: 'docs',
      reason: 'docs_only',
      skip_preview: true,
      run_fast_checks: false,
      include_re: ['^docs/', '^\\.github/', '\\.mdx?$'],
      exclude_re: [],
    },
  ],
};

function loadClassifierConfig(configPath) {
  const file = String(configPath || '').trim();
  if (!file || !fs.existsSync(file)) return defaultClassifierConfig;
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object') return defaultClassifierConfig;
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  if (!profiles.length) return defaultClassifierConfig;
  return parsed;
}

function normalizeImpactSurfaceId(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function normalizeSuiteId(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function loadImpactMapConfig() {
  const { registry } = loadDeploySurfaceRegistry({});
  const compiled = compileRegistry(registry);
  return exportImpactMapFromCompiledRegistry(compiled);
}

function compileImpactRegistry() {
  const { registry } = loadDeploySurfaceRegistry({});
  return compileRegistry(registry);
}

function compileImpactMap() {
  return compileImpactRegistry();
}

function compileRegexList(list) {
  const raw = Array.isArray(list) ? list : [];
  const out = [];
  for (const pattern of raw) {
    const s = String(pattern || '').trim();
    if (!s) continue;
    try {
      out.push(new RegExp(s));
    } catch (e) {
      console.warn(`[pr-change-classify] Ignoring invalid regex pattern "${s}": ${e.message}`);
    }
  }
  return out;
}

function compileProfiles(config) {
  const cfg = config && typeof config === 'object' ? config : defaultClassifierConfig;
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  const out = [];
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    const id = String(profile.id || '').trim();
    const reason = String(profile.reason || '').trim();
    const includeRe = compileRegexList(profile.include_re);
    if (!id || !reason || includeRe.length === 0) continue;
    out.push({
      id,
      reason,
      skipPreview: Boolean(profile.skip_preview),
      runFastChecks: profile.run_fast_checks == null ? true : Boolean(profile.run_fast_checks),
      includeRe,
      excludeRe: compileRegexList(profile.exclude_re),
    });
  }
  return out.length ? out : compileProfiles(defaultClassifierConfig);
}

const compiledProfiles = compileProfiles(loadClassifierConfig(classifyConfigPath));
const compiledImpactRegistry = compileImpactRegistry();

function parseArgs() {
  const out = { format: '' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (a === '--format') out.format = String(argv[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
  }
  return out;
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

function parseRepoFullName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw || !raw.includes('/')) return { owner: '', repo: '' };
  const [owner, repo] = raw.split('/', 2).map((v) => String(v || '').trim());
  if (!owner || !repo) return { owner: '', repo: '' };
  return { owner, repo };
}

async function fetchCompareChangedFiles({
  owner,
  repo,
  base,
  head,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const o = String(owner || '').trim();
  const r = String(repo || '').trim();
  const b = String(base || '').trim();
  const h = String(head || '').trim();
  const t = String(token || '').trim();
  if (!o || !r || !b || !h || !t || typeof fetchImpl !== 'function') {
    return { ok: false, files: [], truncated: false, reason: 'compare_api_unavailable' };
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/compare/${encodeURIComponent(b)}...${encodeURIComponent(h)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${t}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'masarx-pr-change-classify',
      },
    });
  } catch {
    return { ok: false, files: [], truncated: false, reason: 'compare_api_network_error' };
  }

  if (!res || !res.ok) {
    return {
      ok: false,
      files: [],
      truncated: false,
      reason: `compare_api_http_${String(res && res.status ? res.status : 'error')}`,
    };
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, files: [], truncated: false, reason: 'compare_api_parse_error' };
  }

  const files = [];
  const seen = new Set();
  const rawFiles = Array.isArray(payload?.files) ? payload.files : [];
  for (const entry of rawFiles) {
    const name = normalizeChangedPath(entry && entry.filename ? entry.filename : '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    files.push(name);
  }

  // REST compare endpoint returns at most 300 files; fail closed when ambiguous.
  const truncated = files.length >= 300;
  return { ok: true, files, truncated, reason: truncated ? 'compare_api_truncated' : 'compare_api' };
}

async function resolveChangedFilesForRange({
  action,
  from,
  to,
  diffRange,
  diffNameOnlyFn = diffNameOnly,
  compareFetchFn = fetchCompareChangedFiles,
  repoFullName = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
}) {
  const range = String(diffRange || '').trim();
  const a = String(action || '').trim();
  const start = String(from || '').trim();
  const end = String(to || '').trim();

  if (!range || !start || !end) {
    return { changedFiles: [], diffRange: range, unknown: true, source: 'missing_range' };
  }

  try {
    const files = diffNameOnlyFn(range);
    return { changedFiles: files, diffRange: range, unknown: false, source: 'git' };
  } catch {
    const { owner, repo } = parseRepoFullName(repoFullName);
    const fallback = await compareFetchFn({ owner, repo, base: start, head: end, token });
    if (fallback && fallback.ok && !fallback.truncated) {
      const compareRange = `${start}...${end}`;
      console.log(
        `[pr-change-classify] Fallback compare API used for action=${a || '<unknown>'} range=${compareRange} files=${fallback.files.length}`,
      );
      return {
        changedFiles: fallback.files,
        diffRange: compareRange,
        unknown: false,
        source: 'compare_api',
      };
    }
    return {
      changedFiles: [],
      diffRange: range,
      unknown: true,
      source: fallback && fallback.reason ? fallback.reason : 'diff_failed',
    };
  }
}

function uniqLines(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = String(line || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function matchesAny(reList, text) {
  const list = Array.isArray(reList) ? reList : [];
  const s = String(text || '');
  for (const re of list) {
    if (re && re.test(s)) return true;
  }
  return false;
}

function matchesProfilePath(profile, filePath) {
  if (!profile) return false;
  const p = normalizeChangedPath(filePath);
  if (!p) return false;
  if (!matchesAny(profile.includeRe, p)) return false;
  if (profile.excludeRe && matchesAny(profile.excludeRe, p)) return false;
  return true;
}

function resolveDocsProfile(profiles = compiledProfiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.find((p) => p && p.id === 'docs') || list.find((p) => p && p.reason === 'docs_only') || null;
}

function isDocOnlyPath(p, profiles = compiledProfiles) {
  const docs = resolveDocsProfile(profiles);
  return matchesProfilePath(docs, p);
}

function isDocsOnlyChangeSet(changedFiles, profiles = compiledProfiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return false;
  return files.every((f) => isDocOnlyPath(f, profiles));
}

function classifyChangeSet(changedFiles, profiles = compiledProfiles) {
  const files = Array.isArray(changedFiles) ? changedFiles.map(normalizeChangedPath).filter(Boolean) : [];
  const base = { skipPreview: false, runFastChecks: true, reason: 'requires_preview', profileId: '' };
  if (files.length === 0) return base;

  const list = Array.isArray(profiles) ? profiles : [];
  for (const profile of list) {
    if (!profile || !profile.skipPreview) continue;
    if (files.every((f) => matchesProfilePath(profile, f))) {
      return {
        skipPreview: true,
        runFastChecks: Boolean(profile.runFastChecks),
        reason: profile.reason,
        profileId: profile.id,
      };
    }
  }
  return base;
}

function matchImpactSurfacePath(surface, filePath) {
  if (!surface) return false;
  const p = normalizeChangedPath(filePath);
  if (!p) return false;
  if (!matchesAny(surface.includeRe, p)) return false;
  if (surface.excludeRe && matchesAny(surface.excludeRe, p)) return false;
  return true;
}

function listImpactSurfaceIds(impactRegistry = compiledImpactRegistry) {
  return listImpactSurfaceIdsFromRegistry(impactRegistry);
}

function listImpactSuites(impactRegistry = compiledImpactRegistry) {
  return listImpactSuitesFromRegistry(impactRegistry);
}

function classifyImpactSelection(changedFiles, {
  impactMap = compiledImpactRegistry,
  unknown = false,
  forceFull = false,
  forceReason = '',
} = {}) {
  return resolveImpactPayloadForPaths(impactMap, changedFiles, {
    unknown,
    forceFull,
    forceReason,
  });
}

function isLandingSurfacePath(p) {
  const filePath = String(p || '').trim();
  if (!filePath) return false;
  if (filePath.startsWith('docs/marketing/landing-v2/')) return true;
  if (filePath.startsWith('docs/marketing/brand/')) return true;
  if (filePath.startsWith('scripts/frontend/')) return true;
  if (filePath === 'playwright.landing.config.ts') return true;
  if (filePath.startsWith('tests/landing-e2e/')) return true;
  if (filePath.startsWith('tests/unit/landing-')) return true;
  return false;
}

function hasLandingChanges(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some(isLandingSurfacePath);
}

function isLandingOnlyChangeSet(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return false;
  if (!files.some(isLandingSurfacePath)) return false;

  return files.every((p) => {
    const filePath = String(p || '').trim();
    if (!filePath) return false;
    if (isLandingSurfacePath(filePath)) return true;

    // Allow shared config adjustments that are part of the landing pipeline.
    if (filePath === 'package.json') return true;
    if (filePath === 'package-lock.json') return true;

    // Allow related runbooks to be bundled with landing changes.
    if (filePath.startsWith('docs/ops/runbooks/landing-')) return true;

    return isDocOnlyPath(filePath);
  });
}

function isMigrationPath(p) {
  const filePath = String(p || '').trim();
  if (!filePath) return false;
  if (!filePath.startsWith('supabase/migrations/')) return false;
  return /\.sql$/i.test(filePath);
}

function isPgtapPath(p) {
  const filePath = String(p || '').trim();
  if (!filePath) return false;
  if (filePath === 'supabase/tests/pgtap/.pgtap-skip.json') return true;
  if (!filePath.startsWith('supabase/tests/pgtap/')) return false;
  return /\.sql$/i.test(filePath);
}

function isEdgePath(p) {
  const filePath = String(p || '').trim();
  if (!filePath) return false;
  return (
    filePath.startsWith('supabase/functions/') ||
    filePath.startsWith('scripts/edge/') ||
    filePath.startsWith('config/edge/')
  );
}

function hasMigrationChanges(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some(isMigrationPath);
}

function hasPgtapChanges(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some(isPgtapPath);
}

function hasEdgeChanges(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some(isEdgePath);
}

function shouldSkipPreview(action, changedFiles, profiles = compiledProfiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (action === 'edited') {
    return { skip: true, runFastChecks: false, reason: 'pr_edited', profileId: '' };
  }
  if (action === 'merge_group') {
    if (files.length === 0) {
      return { skip: false, runFastChecks: true, reason: 'merge_group_requires_preview', profileId: '' };
    }

    const classification = classifyChangeSet(files, profiles);
    const profileId = String(classification.profileId || '').trim();
    const allowSkippableProfile = classification.skipPreview && (profileId === 'docs' || profileId === 'ci');
    if (allowSkippableProfile) {
      return {
        skip: true,
        runFastChecks: true,
        reason: classification.reason,
        profileId,
      };
    }

    if (isLandingOnlyChangeSet(files)) {
      return {
        skip: false,
        runFastChecks: true,
        reason: 'landing_only',
        profileId: 'landing',
      };
    }

    return {
      skip: false,
      runFastChecks: true,
      reason: classification.reason || 'requires_preview',
      profileId: classification.profileId || '',
    };
  }
  if (files.length === 0) {
    return { skip: true, runFastChecks: false, reason: 'no_changes', profileId: '' };
  }


  if (isLandingOnlyChangeSet(files)) {
    return { skip: false, runFastChecks: true, reason: 'landing_only', profileId: 'landing' };
  }

  const classification = classifyChangeSet(files, profiles);
  if (classification.skipPreview) {
    const reason = action === 'synchronize' ? `${classification.reason}_incremental` : classification.reason;
    return {
      skip: true,
      runFastChecks: Boolean(classification.runFastChecks),
      reason,
      profileId: classification.profileId || '',
    };
  }

  return { skip: false, runFastChecks: true, reason: 'requires_preview', profileId: '' };
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function applyForcePreviewPolicy({
  action,
  decision,
  forcePreview = false,
}) {
  const base = decision && typeof decision === 'object'
    ? decision
    : { skip: false, runFastChecks: true, reason: 'requires_preview', profileId: '' };
  if (!forcePreview) return base;
  // Preserve "edited" and main->dev sync skips (no commit delta / policy skip).
  const reason = String(base.reason || '').trim();
  if (action === 'edited' || reason === 'main_to_dev_sync') return base;
  // For merge-group CI/docs-only profiles, keep preview skipped while still running fast checks.
  if (action === 'merge_group' && (base.profileId === 'docs' || base.profileId === 'ci')) {
    return {
      ...base,
      skip: true,
      runFastChecks: true,
    };
  }
  return {
    ...base,
    skip: false,
    runFastChecks: true,
    reason: `${reason || 'requires_preview'}_force_preview`,
  };
}

function computeVerifySkips({ action, skipPreview, hasMigrations, hasEdge, priorReviewerGateSuccess }) {
  const a = String(action || '').trim();
  if (!a) return { skipDbPush: false, skipEdgeDeploy: false };
  if (a === 'merge_group') {
    if (skipPreview) return { skipDbPush: false, skipEdgeDeploy: false };
    // Merge queue runs must push schema every time to avoid stale preview
    // DB state when projects are reused across queue cycles.
    return {
      skipDbPush: false,
      skipEdgeDeploy: !hasEdge,
    };
  }
  if (a !== 'synchronize') return { skipDbPush: false, skipEdgeDeploy: false };
  if (skipPreview) return { skipDbPush: false, skipEdgeDeploy: false };
  if (!priorReviewerGateSuccess) return { skipDbPush: false, skipEdgeDeploy: false };
  return {
    skipDbPush: !hasMigrations,
    skipEdgeDeploy: !hasEdge,
  };
}

function applyPriorReviewerGateRequirement(action, decision, priorReviewerGateSuccess, fullPrSkippable = false) {
  if (action !== 'synchronize') return decision;
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.skip !== true) return decision;

  const reason = String(decision.reason || '').trim();
  const incremental = reason.endsWith('_incremental');
  if (!incremental) return decision;

  // If the full PR diff is skippable (any profile), incremental skippable pushes should always skip.
  if (fullPrSkippable) return decision;

  // Incremental docs/ui-only pushes must not suppress preview validation for a PR whose
  // cumulative diff still requires preview. Prior reviewer gate success only allows
  // downstream substep optimizations (db push / edge deploy), not preview bypass.
  if (priorReviewerGateSuccess) {
    return {
      ...decision,
      skip: false,
      runFastChecks: true,
      reason: `${reason}_full_pr_requires_preview`,
    };
  }

  return {
    ...decision,
    skip: false,
    runFastChecks: true,
    reason: `${reason}_needs_prior_reviewer_gate_success`,
  };
}

async function hasPriorReviewerGateSuccess({ owner, repo, sha, token, checkName = 'reviewer_gate' }) {
  const o = String(owner || '').trim();
  const r = String(repo || '').trim();
  const s = String(sha || '').trim();
  const t = String(token || '').trim();
  if (!o || !r || !s || !t) return false;

  const url = `https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/commits/${encodeURIComponent(s)}/check-runs`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${t}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'masarx-pr-change-classify',
    },
  });
  if (!res.ok) return false;
  const json = await res.json().catch(() => null);
  const runs = Array.isArray(json?.check_runs) ? json.check_runs : [];
  const target = String(checkName || '').trim();
  for (const run of runs) {
    if (String(run?.name || '').trim() !== target) continue;
    const conclusion = String(run?.conclusion || '').trim().toLowerCase();
    const status = String(run?.status || '').trim().toLowerCase();
    if (status === 'completed' && conclusion === 'success') return true;
  }
  return false;
}

function diffNameOnly(range) {
  const res = spawnSync('git', ['diff', '--name-only', range], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(res.stderr || `git diff failed (${res.status})`);
  }
  return uniqLines(res.stdout || '');
}

function gitMergeBase(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return '';
  const res = spawnSync('git', ['merge-base', left, right], { encoding: 'utf8' });
  if (res.status !== 0) return '';
  return String(res.stdout || '').trim();
}

function computeMergeBaseDiffRange(baseSha, headSha, mergeBaseFn = gitMergeBase) {
  const base = String(baseSha || '').trim();
  const head = String(headSha || '').trim();
  if (!base || !head) return '';
  const mb = mergeBaseFn(base, head);
  return `${(mb || base)}..${head}`;
}

function computeFullPrDocsOnly({ baseSha, headSha, diffNameOnlyFn = diffNameOnly, mergeBaseFn = gitMergeBase }) {
  const range = computeMergeBaseDiffRange(baseSha, headSha, mergeBaseFn);
  if (!range) return false;
  try {
    return isDocsOnlyChangeSet(diffNameOnlyFn(range));
  } catch {
    return false;
  }
}

function computeFullPrLandingOnly({ baseSha, headSha, diffNameOnlyFn = diffNameOnly, mergeBaseFn = gitMergeBase }) {
  const range = computeMergeBaseDiffRange(baseSha, headSha, mergeBaseFn);
  if (!range) return false;
  try {
    return isLandingOnlyChangeSet(diffNameOnlyFn(range));
  } catch {
    return false;
  }
}

function computeFullPrSkipDecision({ baseSha, headSha, diffNameOnlyFn = diffNameOnly, mergeBaseFn = gitMergeBase, profiles = compiledProfiles }) {
  const range = computeMergeBaseDiffRange(baseSha, headSha, mergeBaseFn);
  const base = { skipPreview: false, runFastChecks: true, reason: 'requires_preview', profileId: '' };
  if (!range) return base;
  try {
    const files = diffNameOnlyFn(range);
    return classifyChangeSet(files, profiles);
  } catch {
    return base;
  }
}

function computeFullPrImpactSelection({
  baseSha,
  headSha,
  diffNameOnlyFn = diffNameOnly,
  mergeBaseFn = gitMergeBase,
}) {
  const range = computeMergeBaseDiffRange(baseSha, headSha, mergeBaseFn);
  if (!range) {
    return classifyImpactSelection([], {
      unknown: true,
      forceFull: true,
      forceReason: 'full_pr_impact_missing_range',
    });
  }
  try {
    const files = diffNameOnlyFn(range);
    return classifyImpactSelection(files, { unknown: false });
  } catch {
    return classifyImpactSelection([], {
      unknown: true,
      forceFull: true,
      forceReason: 'full_pr_impact_unavailable',
    });
  }
}

function extractDiffRange(evt) {
  const action = String(evt && evt.action || '').trim();
  if (action === 'checks_requested' && evt && evt.merge_group) {
    const from = String(evt?.merge_group?.base_sha || '').trim();
    const to = String(evt?.merge_group?.head_sha || '').trim();
    if (from && to) return { action: 'merge_group', from, to };
  }
  if (!action) return { action: '', from: '', to: '' };
  if (action === 'synchronize') {
    const from = String(evt.before || '').trim();
    const to = String(evt.after || '').trim();
    if (from && to) return { action, from, to };
  }
  if (action === 'opened' || action === 'reopened') {
    const from = String(evt?.pull_request?.base?.sha || '').trim();
    const to = String(evt?.pull_request?.head?.sha || '').trim();
    if (from && to) return { action, from, to };
  }
  return { action, from: '', to: '' };
}

function resolveDiffOverride(env = process.env) {
  const action = String(env.PR_CHANGE_CLASSIFY_ACTION || '').trim();
  const from = String(env.PR_CHANGE_CLASSIFY_FROM_SHA || '').trim();
  const to = String(env.PR_CHANGE_CLASSIFY_TO_SHA || '').trim();
  const preferMergeBase = isTruthy(env.PR_CHANGE_CLASSIFY_PREFER_MERGE_BASE);
  if (!action && !from && !to) return null;
  return {
    action,
    from,
    to,
    preferMergeBase,
  };
}

function isMainToDevSyncPullRequest(evt) {
  const pr = evt?.pull_request || null;
  const baseRef = String(pr?.base?.ref || '').trim();
  const headRef = String(pr?.head?.ref || '').trim();
  if (baseRef !== 'dev') return false;

  // Only apply automation skips to same-repo PRs.
  const headRepo = String(pr?.head?.repo?.full_name || '').trim();
  const baseRepo = String(pr?.base?.repo?.full_name || '').trim();
  if (headRepo && baseRepo && headRepo !== baseRepo) return false;

  if (headRef === 'main') return true;

  const marker = '<!-- masarx-main-to-dev-sync -->';
  const title = String(pr?.title || '').trim().toLowerCase();
  const body = String(pr?.body || '');
  if (headRef.startsWith('automation/sync-main-to-dev/')) {
    if (body.includes(marker)) return true;
    if (title.startsWith('chore: sync main -> dev')) return true;
  }

  return false;
}

async function main() {
  const { format } = parseArgs();

  const evtPath = process.env.GITHUB_EVENT_PATH;
  if (!evtPath || !fs.existsSync(evtPath)) die('GITHUB_EVENT_PATH missing or unreadable.');
  const evt = readJson(evtPath);
  if (!evt) die('Failed to parse event JSON.');

  const override = resolveDiffOverride(process.env);
  const descriptor = override || extractDiffRange(evt);
  const action = String(descriptor?.action || '').trim();
  const from = String(descriptor?.from || '').trim();
  const to = String(descriptor?.to || '').trim();
  const preferMergeBase = Boolean(descriptor?.preferMergeBase);
  let changedFiles = [];
  let diffRange = '';
  let changeSource = '';
  let unknown = false;

  if (action === 'edited') {
    // No commit changes: skip immediately.
  } else if (from && to) {
    diffRange = preferMergeBase || action === 'opened' || action === 'reopened'
      ? computeMergeBaseDiffRange(from, to)
      : `${from}..${to}`;

    const resolved = await resolveChangedFilesForRange({
      action,
      from,
      to,
      diffRange,
    });
    changedFiles = resolved.changedFiles;
    diffRange = resolved.diffRange;
    unknown = resolved.unknown;
    changeSource = resolved.source;
  } else {
    // Unknown action or missing SHAs; be safe and require preview.
    unknown = true;
    changeSource = 'missing_shas';
  }

  const hasMigrations = hasMigrationChanges(changedFiles);
  const hasPgtap = hasPgtapChanges(changedFiles);
  const hasDbContractChanges = hasMigrations || hasPgtap;
  const hasEdge = hasEdgeChanges(changedFiles);
  const hasLanding = hasLandingChanges(changedFiles);
  const incrementalLandingOnly = isLandingOnlyChangeSet(changedFiles) ? !hasMigrations && !hasEdge : false;
  let skipFullPreview = incrementalLandingOnly && action !== 'synchronize' && action !== 'merge_group';

  const forcePreview = isTruthy(process.env.PR_CHANGE_CLASSIFY_FORCE_PREVIEW);

  let decision = unknown
    ? { skip: false, runFastChecks: true, reason: 'unknown_event', profileId: '' }
    : shouldSkipPreview(action, changedFiles);

  // Branch sync PRs (main -> dev) should not reprovision preview projects or re-run cloud verify:
  // those commits already passed gates on `main` and we're only aligning the integration branch.
  if (!unknown && action !== 'edited' && isMainToDevSyncPullRequest(evt)) {
    decision = { skip: true, runFastChecks: false, reason: 'main_to_dev_sync', profileId: '' };
  }

  // Prevent skippable incremental commits from bypassing a required preview/verify run,
  // and enable safe skipping of db push / edge deploy on incremental pushes after a known-good run.
  let priorOk = false;
  let fullPrDocsOnly = false;
  let impactSelection = classifyImpactSelection(changedFiles, {
    unknown,
    forceFull: false,
    forceReason: '',
  });
  if (!unknown && action === 'synchronize') {
    const baseSha = String(evt?.pull_request?.base?.sha || '').trim();
    const headSha = String(evt?.pull_request?.head?.sha || '').trim();
    let fullPrSkippable = false;
    let fullPrSkipDecision = null;
    let fullPrLandingOnly = false;
    if (baseSha && headSha) {
      fullPrDocsOnly = computeFullPrDocsOnly({ baseSha, headSha });
      fullPrSkipDecision = computeFullPrSkipDecision({ baseSha, headSha });
      fullPrSkippable = Boolean(fullPrSkipDecision && fullPrSkipDecision.skipPreview);
      fullPrLandingOnly = computeFullPrLandingOnly({ baseSha, headSha });
      impactSelection = computeFullPrImpactSelection({ baseSha, headSha });
    }

    // Only skip full preview for landing-only PRs when the *full PR diff* is landing-only.
    // Prevent incremental landing commits from bypassing required cloud preview for backend-impacting PRs.
    skipFullPreview = fullPrLandingOnly;

    const needsPriorOk =
      (decision.skip && String(decision.reason || '').endsWith('_incremental') && !fullPrSkippable) ||
      (!decision.skip && (!hasMigrations || !hasEdge));
    if (needsPriorOk) {
      const repoFull = String(process.env.GITHUB_REPOSITORY || '').trim();
      const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
      const [owner, repo] = repoFull.includes('/') ? repoFull.split('/', 2) : ['', ''];
      priorOk = await hasPriorReviewerGateSuccess({ owner, repo, sha: from, token, checkName: 'reviewer_gate' });
    }

    if (decision.skip && String(decision.reason || '').endsWith('_incremental')) {
      decision = applyPriorReviewerGateRequirement(action, decision, priorOk, fullPrSkippable);
    }

    // If incremental diff looks non-skippable but the full PR is skippable (e.g. base merges),
    // skip preview to avoid unnecessary cloud work for docs/UI-only PRs.
    if (!decision.skip && fullPrSkippable && fullPrSkipDecision) {
      decision = {
        skip: true,
        runFastChecks: Boolean(fullPrSkipDecision.runFastChecks),
        reason: fullPrSkipDecision.reason,
        profileId: fullPrSkipDecision.profileId || '',
      };
    }
  }

  decision = applyForcePreviewPolicy({ action, decision, forcePreview });

  const verifySkips = computeVerifySkips({
    action,
    skipPreview: decision.skip === true,
    hasMigrations,
    hasEdge,
    priorReviewerGateSuccess: priorOk,
  });

  const selectedSuites = Array.isArray(impactSelection.selectedSuites) ? impactSelection.selectedSuites : [];
  const hasSuite = (suiteId) => selectedSuites.includes(normalizeSuiteId(suiteId)) ? '1' : '0';

  const out = {
    skip_preview: decision.skip ? '1' : '0',
    run_fast_checks: decision.runFastChecks ? '1' : '0',
    skip_reason: decision.reason,
    change_profile: decision.profileId || '',
    skip_full_preview: skipFullPreview ? '1' : '0',
    diff_range: diffRange,
    changed_count: String(changedFiles.length),
    has_migrations: hasMigrations ? '1' : '0',
    has_pgtap: hasPgtap ? '1' : '0',
    has_db_contract_changes: hasDbContractChanges ? '1' : '0',
    has_edge: hasEdge ? '1' : '0',
    has_landing: hasLanding ? '1' : '0',
    skip_db_push: verifySkips.skipDbPush ? '1' : '0',
    skip_edge_deploy: verifySkips.skipEdgeDeploy ? '1' : '0',
    prior_reviewer_gate_success: priorOk ? '1' : '0',
    full_pr_docs_only: fullPrDocsOnly ? '1' : '0',
    change_source: changeSource || (unknown ? 'unknown' : 'git'),
    impact_surfaces: impactSelection.impactSurfaces.join(','),
    required_suites: impactSelection.requiredSuites.join(','),
    selection_confidence: impactSelection.selectionConfidence,
    fallback_to_full: impactSelection.fallbackToFull ? '1' : '0',
    fallback_reason: impactSelection.fallbackReason || '',
    skip_reasons: impactSelection.skipReasons.join(','),
    changed_files_json: JSON.stringify(impactSelection.changedFiles),
    unmatched_files_json: JSON.stringify(impactSelection.unmatchedFiles),
    selected_suites_json: JSON.stringify(impactSelection.selectedSuites),
    skipped_suites_json: JSON.stringify(impactSelection.skippedSuites),
    impacted_surface_ids_json: JSON.stringify(impactSelection.impactedSurfaceIds || []),
    suite_lint_structure: hasSuite('lint_structure'),
    suite_lint_frontend: hasSuite('lint_frontend'),
    suite_test_unit: hasSuite('test_unit'),
    suite_test_ui: hasSuite('test_ui'),
    suite_landing_build: hasSuite('landing_build'),
    suite_landing_e2e: hasSuite('landing_e2e'),
    suite_verify_cloud_core: hasSuite('verify_cloud_core'),
    suite_pgtap: hasSuite('pgtap'),
    suite_integration: hasSuite('integration'),
    suite_edge_deploy: hasSuite('edge_deploy'),
  };

  const fmt = String(format || '').trim().toLowerCase();
  if (fmt === 'github-output') {
    writeGithubOutput(out);
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }

  const extra = diffRange ? `range=${diffRange}` : 'range=<none>';
  console.log(
    `[pr-change-classify] action=${action || '<unknown>'} ${extra} changed=${out.changed_count} ` +
    `skip_preview=${out.skip_preview} run_fast_checks=${out.run_fast_checks} source=${out.change_source} (${out.skip_reason})`
  );
}

if (require.main === module) {
  main().catch((e) => die(e && e.message ? e.message : String(e)));
}

module.exports = {
  isDocOnlyPath,
  isDocsOnlyChangeSet,
  classifyChangeSet,
  isLandingSurfacePath,
  hasLandingChanges,
  isLandingOnlyChangeSet,
  isMigrationPath,
  isPgtapPath,
  isEdgePath,
  hasMigrationChanges,
  hasPgtapChanges,
  hasEdgeChanges,
  shouldSkipPreview,
  isTruthy,
  applyForcePreviewPolicy,
  computeVerifySkips,
  parseRepoFullName,
  fetchCompareChangedFiles,
  resolveChangedFilesForRange,
  computeMergeBaseDiffRange,
  computeFullPrDocsOnly,
  computeFullPrLandingOnly,
  computeFullPrSkipDecision,
  computeFullPrImpactSelection,
  applyPriorReviewerGateRequirement,
  hasPriorReviewerGateSuccess,
  extractDiffRange,
  resolveDiffOverride,
  isMainToDevSyncPullRequest,
  normalizeImpactSurfaceId,
  normalizeSuiteId,
  loadImpactMapConfig,
  compileImpactMap,
  matchImpactSurfacePath,
  listImpactSurfaceIds,
  listImpactSuites,
  classifyImpactSelection,
  uniqLines,
};
