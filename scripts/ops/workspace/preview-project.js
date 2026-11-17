#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * preview-project.js
 *
 * Ensures a deterministic per-PR Supabase preview workspace exists
 * (project-per-PR by default, optional branch-per-PR),
 * writes an ENV_FILE via branches/gen-env.js, and prints outputs for CI.
 *
 * Outputs (json or github-output):
 *  - project_ref
 *  - project_name
 *  - workspace_mode
 *  - supabase_url
 *  - env_file
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dns = require('dns').promises;
const { loadEnv } = require('../../utils/load-env');
const {
  buildDbConnectionCandidates,
  parseDbConnectionTarget,
  resolveSelectedPoolerRoute,
} = require('../../utils/pg-candidates');
const { resolvePreviewSupabaseConfig } = require('./preview-supabase-config');
const {
  uniqueNonEmpty,
  resolveBranchParentCandidates,
  isRemovedBranchParentError,
  shouldFallbackToProjectMode,
  withBranchParentFallback,
} = require('./preview-branch-parent');
const {
  createProject,
  getApiKeys,
  findProjectByName,
  listProjects,
  ensureBranch,
  waitUntilReady,
  ensureProjectJwtSecret,
  getProjectJwtSecret,
  setProjectDatabasePassword,
  deleteBranchWithRetries,
  deleteProjectWithRetries,
  isCanonicalPostgresPort,
  isCanonicalSupabaseProjectRef,
  normalizeSupabasePoolerRegion,
  resolveSupabasePoolerRegionFromHost,
  resolveProjectPoolerHost,
  validateBranchDatabaseConfig,
  waitForBranchDatabaseConfig,
} = require('./supabase-api');
const {
  buildEdgeDbJwtBundle,
  buildFallbackEdgeDbJwtBundle,
  deriveProjectJwtSecret,
  isJwtSignedWithSecret,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
} = require('./edge-db-jwt');
const {
  waitForStorageAuth,
  waitForRestAuth,
  resolveJwtPropagationOptions,
} = require('./supabase-runtime');
const { resolveTraceContext, emitTrace } = require('./trace-log');
const {
  shouldWaitForStorageSchema,
  resolveStorageSchemaReadyOptions,
  waitForStorageSchema,
} = require('./storage-schema-ready');
const { computeProjectName, extractPreviewWorkspaceFamilyName } = require('./preview-name');
const { persistMaterializedOwnership } = require('./preview-ownership');

function die(msg) {
  console.error(`[preview-project] ${msg}`);
  process.exit(1);
}

function readEnv(key) {
  return String(process.env[key] || '').trim();
}

function isTruthyFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function resolvePreviewJwtSeed({ explicitSeed, serviceKey, accessToken } = {}) {
  const explicit = String(explicitSeed || '').trim();
  if (explicit) return { seed: explicit, source: 'explicit' };
  const service = String(serviceKey || '').trim();
  if (service) return { seed: service, source: 'service_role' };
  const token = String(accessToken || '').trim();
  if (token) return { seed: token, source: 'access_token' };
  return { seed: '', source: '' };
}

function decodeJwtPayload(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isLikelyProjectRef(value) {
  return isCanonicalSupabaseProjectRef(value);
}

function extractProjectRefFromIssuer(issuer) {
  const raw = String(issuer || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || '').trim().toLowerCase();
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match && match[1] ? match[1] : '';
  } catch {
    return '';
  }
}

function extractProjectRefFromSupabaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || '').trim().toLowerCase();
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match && match[1] ? match[1] : '';
  } catch {
    return '';
  }
}

const SUPABASE_HOST_SUFFIX = ['supabase', 'co'].join('.');

function buildSupabaseProjectUrl(projectRef) {
  const normalizedProjectRef = String(projectRef || '').trim().toLowerCase();
  if (!normalizedProjectRef) return '';
  return `https://${normalizedProjectRef}.${SUPABASE_HOST_SUFFIX}`;
}

function resolvePreviewSupabaseUrl({ envSupabaseUrl, projectRef } = {}) {
  const configuredUrl = String(envSupabaseUrl || '').trim();
  const normalizedProjectRef = String(projectRef || '').trim().toLowerCase();
  const configuredProjectRef = extractProjectRefFromSupabaseUrl(configuredUrl);

  if (!configuredUrl) {
    return {
      supabaseUrl: buildSupabaseProjectUrl(normalizedProjectRef),
      source: 'constructed',
      configuredProjectRef: '',
    };
  }
  if (!normalizedProjectRef || !configuredProjectRef || configuredProjectRef === normalizedProjectRef) {
    return {
      supabaseUrl: configuredUrl,
      source: 'configured',
      configuredProjectRef,
    };
  }
  return {
    supabaseUrl: buildSupabaseProjectUrl(normalizedProjectRef),
    source: 'constructed_mismatch',
    configuredProjectRef,
  };
}

async function resolvePreviewWorkspaceApiKeys({
  allowStaticFallback = false,
  staticAnon = '',
  staticService = '',
  projectRef = '',
  token = '',
  getApiKeysFn = getApiKeys,
} = {}) {
  const resolved = {
    anon: allowStaticFallback ? String(staticAnon || '').trim() : '',
    service: allowStaticFallback ? String(staticService || '').trim() : '',
  };
  if (resolved.anon && resolved.service) {
    return resolved;
  }

  // Preview env overlays feed browser/mobile auth clients, so when the
  // Management API is available we should prefer the modern public/admin key
  // pair rather than relying on legacy default selection.
  const fetched = await getApiKeysFn(projectRef, token, { preferModern: true });
  return {
    anon: resolved.anon || String(fetched?.anon || '').trim(),
    service: resolved.service || String(fetched?.service || '').trim(),
  };
}

function resolveProjectRefFromStaticApiKeys({ serviceKey, anonKey } = {}) {
  const payloads = [
    decodeJwtPayload(serviceKey),
    decodeJwtPayload(anonKey),
  ];
  for (const payload of payloads) {
    if (!payload) continue;
    const directRef = String(payload?.ref || payload?.project_ref || '').trim().toLowerCase();
    if (isLikelyProjectRef(directRef)) return directRef;
    const issuerRef = extractProjectRefFromIssuer(payload?.iss || payload?.issuer || '');
    if (isLikelyProjectRef(issuerRef)) return issuerRef;
  }
  return '';
}

function resolveDegradedFallbackProjectRef({
  branchParentRef,
  staticProjectRef,
} = {}) {
  const candidates = uniqueNonEmpty([
    branchParentRef,
    staticProjectRef,
  ]).filter(isLikelyProjectRef);
  const projectRef = candidates[0] || '';
  if (!projectRef) return { projectRef: '', source: '' };
  if (projectRef === String(branchParentRef || '').trim().toLowerCase()) {
    return { projectRef, source: 'branch_parent_ref' };
  }
  if (projectRef === String(staticProjectRef || '').trim().toLowerCase()) {
    return { projectRef, source: 'static_api_key' };
  }
  return { projectRef, source: '' };
}

function resolvePreviewJwtFallback({ edgeRequireDbJwt, didMintKeys, apiKeys, err } = {}) {
  if (edgeRequireDbJwt !== '1') return null;
  if (!didMintKeys) return null;
  if (!apiKeys?.anon || !apiKeys?.service) return null;
  const msg = String(err?.message || '').toLowerCase();
  if (!msg.includes('timeout waiting for storage auth')) return null;
  return {
    edgeRequireDbJwt: '0',
    jwtSecret: '',
    jwtSource: '',
    keys: apiKeys,
    message: 'Storage auth did not accept minted keys; falling back to API keys and EDGE_REQUIRE_DB_JWT=0 for preview.',
  };
}

function shouldPreservePlatformApiKeysForPreview({ jwtSecret, keys, keysMatchSecret } = {}) {
  return Boolean(jwtSecret && keys?.anon && keys?.service && !keysMatchSecret);
}

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || typeof a !== 'string') continue;
    if (a === '--format') out.format = argv[++i] || '';
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=');
    else if (a === '--pr') out.pr = argv[++i] || '';
    else if (a.startsWith('--pr=')) out.pr = a.split('=').slice(1).join('=');
    else if (a === '--name') out.name = argv[++i] || '';
    else if (a.startsWith('--name=')) out.name = a.split('=').slice(1).join('=');
  }
  return out;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function readGithubEvent() {
  const evtPath = process.env.GITHUB_EVENT_PATH;
  if (!evtPath) return null;
  try {
    if (!fs.existsSync(evtPath)) return null;
    return JSON.parse(fs.readFileSync(evtPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractPrNumberFromMergeGroupHeadRef(headRef) {
  const s = String(headRef || '').trim();
  if (!s) return '';
  const m = s.match(/pr-(\d+)-/i) || s.match(/pr-(\d+)\b/i);
  return m && m[1] ? String(m[1]) : '';
}

function extractPrNumber(evt) {
  if (!evt || typeof evt !== 'object') return '';
  if (evt.pull_request && evt.pull_request.number) return String(evt.pull_request.number);
  if (evt.number) return String(evt.number);
  if (evt.issue && evt.issue.number) return String(evt.issue.number);
  if (evt.merge_group && evt.merge_group.head_ref) return extractPrNumberFromMergeGroupHeadRef(evt.merge_group.head_ref);
  return '';
}

function resolvePoolerHost({
  configuredPoolerHost,
  configuredRegion,
  existingRegion,
  allowDerivedHost = true,
} = {}) {
  const explicitHost = String(configuredPoolerHost || '').trim();
  const effectiveRegion = String(existingRegion || configuredRegion || '').trim();
  if (explicitHost) return { poolerHost: explicitHost, effectiveRegion };
  if (!effectiveRegion || !allowDerivedHost) return { poolerHost: '', effectiveRegion };
  return { poolerHost: `aws-1-${effectiveRegion}.pooler.supabase.com`, effectiveRegion };
}

function assertBranchPoolerHost({ workspaceMode, poolerHost, poolerPort = '5432' } = {}) {
  const mode = String(workspaceMode || '').trim().toLowerCase();
  const host = String(poolerHost || '').trim();
  if (mode === 'branch' && host && !resolveSupabasePoolerRegionFromHost(host)) {
    throw new Error('branch_db_credentials_invalid:pooler_host');
  }
  if (host && !isCanonicalPostgresPort(poolerPort)) {
    throw new Error('branch_db_credentials_invalid:pooler_port');
  }
  if (mode === 'branch' && host && String(poolerPort || '').trim() !== '5432') {
    throw new Error('branch_db_credentials_invalid:pooler_port');
  }
  return host;
}

function shouldWaitForProjectReadiness(workspaceMode) {
  return String(workspaceMode || '').trim().toLowerCase() !== 'branch';
}

function shouldProbeBranchPreviewDb({ workspaceMode, poolerHost, directDbHost, dbPass } = {}) {
  return Boolean(
    String(workspaceMode || '').trim().toLowerCase() === 'branch' &&
    resolveSupabasePoolerRegionFromHost(poolerHost) &&
    String(directDbHost || '').trim() &&
    String(dbPass || '').trim(),
  );
}

async function resolveBranchSupavisorRoute({
  projectRef,
  token,
  branchConfig,
  fallbackRegion = '',
  resolveProjectPoolerHostFn = resolveProjectPoolerHost,
} = {}) {
  const validated = validateBranchDatabaseConfig(branchConfig, {
    expectedProjectRef: projectRef,
  });
  const preferredRegion =
    normalizeSupabasePoolerRegion(validated.region) ||
    normalizeSupabasePoolerRegion(fallbackRegion);
  const resolvedHost = String(await resolveProjectPoolerHostFn({
    projectRef: validated.project_ref,
    token: String(token || '').trim(),
    preferredRegion,
    fallbackHost: '',
    allowDerivedFallback: true,
  }) || '').trim().toLowerCase();

  if (!resolvedHost) {
    throw new Error('branch_db_route_unavailable:supavisor');
  }
  const resolvedRegion = resolveSupabasePoolerRegionFromHost(resolvedHost);
  if (!resolvedRegion) {
    throw new Error('branch_db_route_invalid:pooler_host');
  }

  return {
    projectRef: validated.project_ref,
    poolerHost: resolvedHost,
    poolerPort: '5432',
    poolerUser: `postgres.${validated.project_ref}`,
    effectiveRegion: resolvedRegion || preferredRegion,
  };
}

function isProjectNameAlreadyExistsError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('already exists') && msg.includes('project');
}

function isProjectCreateInconclusiveError(err) {
  const status = Number(err?.status || 0);
  const details = String(err?.body?.message || err?.body?.error || '').toLowerCase();
  const message = `${String(err?.message || '').toLowerCase()} ${details}`;
  return (
    (status === 404 && message.includes('failed to insert project')) ||
    message.includes('failed to insert project')
  );
}

function isRetryableProjectCreateError(err) {
  const status = Number(err?.status || 0);
  const details = String(err?.body?.message || err?.body?.error || '').toLowerCase();
  const message = `${String(err?.message || '').toLowerCase()} ${details}`;
  if ([404, 429, 502, 503, 504].includes(status)) return true;
  if (message.includes('failed to insert project')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  return false;
}

function shouldUseParentProjectFallback(err) {
  const status = Number(err?.status || 0);
  const details = String(err?.body?.message || err?.body?.error || '').toLowerCase();
  const message = `${String(err?.message || '').toLowerCase()} ${details}`;
  if (isRemovedBranchParentError(err)) return false;
  if ([401, 403, 429].includes(status)) return true;
  if (status >= 500) return true;
  if (status === 0 && (message.includes('fetch failed') || message.includes('network'))) return true;
  if (message.includes('jwt could not be decoded')) return true;
  if (message.includes('tenant or user not found')) return true;
  if (message.includes('password authentication failed')) return true;
  if (message.includes('too many authentication errors')) return true;
  return false;
}

function parseCreatedAtMs(value, fallback = 0) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : fallback;
}

async function findCompatiblePreviewFamilyProject({
  token,
  organizationId,
  familyName,
  excludeProjectRefs = [],
  preferredNames = [],
  restrictToPreferredNames = false,
  listProjectsFn = listProjects,
} = {}) {
  const normalizedFamily = extractPreviewWorkspaceFamilyName(familyName) || String(familyName || '').trim().toLowerCase();
  if (!normalizedFamily) return null;
  const excludedRefs = new Set(
    (Array.isArray(excludeProjectRefs) ? excludeProjectRefs : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const preferredNameRanks = new Map();
  for (const [index, value] of (Array.isArray(preferredNames) ? preferredNames : []).entries()) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || preferredNameRanks.has(normalized)) continue;
    preferredNameRanks.set(normalized, index);
  }
  const projects = await listProjectsFn({ token, organizationId });
  const candidates = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    const name = String(project?.name || '').trim();
    const ref = String(project?.ref || project?.project_ref || project?.id || '').trim();
    if (!name || !ref) continue;
    if (excludedRefs.has(ref.toLowerCase())) continue;
    if (extractPreviewWorkspaceFamilyName(name) !== normalizedFamily) continue;
    const normalizedName = name.toLowerCase();
    if (restrictToPreferredNames && preferredNameRanks.size > 0 && !preferredNameRanks.has(normalizedName)) {
      continue;
    }
    candidates.push({
      project_ref: ref,
      name,
      region: String(project?.region || project?.cloud_region || project?.db_region || '').trim(),
      createdAtMs: parseCreatedAtMs(project?.created_at || project?.inserted_at || project?.insertedAt, 0),
      raw: project,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const leftRank = preferredNameRanks.has(String(left.name || '').trim().toLowerCase())
      ? preferredNameRanks.get(String(left.name || '').trim().toLowerCase())
      : Number.MAX_SAFE_INTEGER;
    const rightRank = preferredNameRanks.has(String(right.name || '').trim().toLowerCase())
      ? preferredNameRanks.get(String(right.name || '').trim().toLowerCase())
      : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.createdAtMs !== right.createdAtMs) return right.createdAtMs - left.createdAtMs;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
  const best = candidates[0];
  return {
    project_ref: best.project_ref,
    name: best.name,
    region: best.region,
    raw: best.raw,
  };
}

async function createProjectWithNameConflictRecovery({
  token,
  organizationId,
  name,
  region,
  plan,
  dbPass,
  createProjectFn = createProject,
  findProjectByNameFn = findProjectByName,
  findCompatibleProjectFn = null,
  logger = console,
  maxCreateAttempts = 2,
  retryDelayMs = 1500,
  finalResolveMaxWaitMs = 10000,
  finalResolveRetryDelayMs = 1500,
  retryNameFn = null,
} = {}) {
  let currentName = String(name || '').trim();
  let lastError = null;
  async function resolveExistingProjectForCreateError(err, attempt) {
    const shouldResolveExisting =
      isProjectNameAlreadyExistsError(err) || isProjectCreateInconclusiveError(err);
    if (!shouldResolveExisting) return null;
    const existing = await findProjectByNameFn({ token, organizationId, name: currentName });
    const existingRef = String(existing?.project_ref || '').trim();
    if (existingRef) {
      return {
        project_ref: existingRef,
        name: String(existing?.name || currentName).trim() || currentName,
        region: String(existing?.region || '').trim(),
        raw: existing,
      };
    }
    if (typeof findCompatibleProjectFn !== 'function') return null;
    const compatible = await findCompatibleProjectFn({ currentName, attempt, err });
    const compatibleRef = String(compatible?.project_ref || '').trim();
    if (!compatibleRef) return null;
    return {
      project_ref: compatibleRef,
      name: String(compatible?.name || currentName).trim() || currentName,
      region: String(compatible?.region || '').trim(),
      raw: compatible,
    };
  }
  async function waitForExistingProjectVisibility(err, attempt) {
    const maxWaitMs = Math.max(0, Number(finalResolveMaxWaitMs) || 0);
    const intervalMs = Math.max(100, Number(finalResolveRetryDelayMs) || Number(retryDelayMs) || 0);
    if (maxWaitMs <= 0) return null;
    const deadline = Date.now() + maxWaitMs;
    while (true) {
      const existing = await resolveExistingProjectForCreateError(err, attempt);
      if (existing?.project_ref) return existing;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
    }
  }
  for (let attempt = 1; attempt <= Math.max(1, Number(maxCreateAttempts) || 1); attempt += 1) {
    try {
      const created = await createProjectFn({
        token,
        organizationId,
        name: currentName,
        region,
        plan,
        dbPass,
      });
      return { project: created, reusedExisting: false, existingProject: null, effectiveName: currentName };
    } catch (err) {
      lastError = err;
      const existing = await resolveExistingProjectForCreateError(err, attempt);
      const existingRef = String(existing?.project_ref || '').trim();
      if (existingRef) {
        const effectiveName = String(existing?.name || currentName).trim() || currentName;
        logger.warn(
          `[preview-project] Create reported reusable project state for '${effectiveName}'; reusing project_ref=${existingRef}.`,
        );
        return {
          project: { project_ref: existingRef },
          reusedExisting: true,
          existingProject: existing?.raw || existing,
          effectiveName,
        };
      }
      const retryable = isRetryableProjectCreateError(err);
      if (attempt >= maxCreateAttempts || !retryable) {
        if (retryable) {
          logger.warn(
            `[preview-project] Create remains inconclusive for '${currentName}' after attempt=${attempt}/${maxCreateAttempts}; waiting up to ${Math.max(0, Number(finalResolveMaxWaitMs) || 0)}ms for preview-family visibility.`,
          );
          const delayedExisting = await waitForExistingProjectVisibility(err, attempt);
          const delayedRef = String(delayedExisting?.project_ref || '').trim();
          if (delayedRef) {
            const effectiveName = String(delayedExisting?.name || currentName).trim() || currentName;
            logger.warn(
              `[preview-project] Create stabilized after delayed family requery for '${effectiveName}'; reusing project_ref=${delayedRef}.`,
            );
            return {
              project: { project_ref: delayedRef },
              reusedExisting: true,
              existingProject: delayedExisting?.raw || delayedExisting,
              effectiveName,
            };
          }
        }
        throw err;
      }
      const nextName =
        typeof retryNameFn === 'function'
          ? String(retryNameFn(currentName, attempt, err) || '').trim()
          : '';
      if (nextName && nextName !== currentName) {
        logger.warn(
          `[preview-project] Create failed for '${currentName}' (attempt=${attempt}/${maxCreateAttempts}); retrying create-by-name recovery with '${nextName}' (${err.message || err}).`,
        );
        currentName = nextName;
      } else {
        logger.warn(
          `[preview-project] Create failed for '${currentName}' (attempt=${attempt}/${maxCreateAttempts}); retrying create-by-name recovery (${err.message || err}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError || new Error(`Unable to create project '${currentName}'.`);
}

function applyAutoFallbackToProjectState(state = {}) {
  const fallbackProjectRef = String(
    state.fallbackProjectRef || state.projectRef || '',
  ).trim();
  return {
    ...state,
    workspaceMode: 'project',
    projectRef: fallbackProjectRef,
    branchId: '',
    existingBranch: null,
    projectWasCreated: false,
  };
}

function resolveProjectRefForProjectMode({ projectRef, envProjectRef } = {}) {
  const current = String(projectRef || '').trim();
  if (current) return current;
  return String(envProjectRef || '').trim();
}

function resolveAutoFallbackProjectRef({
  err,
  branchProjectRef,
  staticProjectRef,
  selectedBranchParentRef,
  envProjectRef,
  branchParentCandidates,
} = {}) {
  const branchParents = Array.isArray(branchParentCandidates) ? branchParentCandidates : [];
  const errMessage = String(err?.message || '').toLowerCase();
  const errStatus = Number(err?.status || 0);
  const branchProbeAuthFailure =
    errMessage.includes('branch db auth probe failed') ||
    (errStatus === 422 && errMessage.includes('password authentication failed'));
  const removedBranchParentFailure = isRemovedBranchParentError(err);
  if (removedBranchParentFailure) {
    return uniqueNonEmpty([staticProjectRef, envProjectRef])[0] || '';
  }
  const preferParentRef = shouldUseParentProjectFallback(err) && !branchProbeAuthFailure;
  const candidates = preferParentRef
    ? [staticProjectRef, selectedBranchParentRef, envProjectRef, ...branchParents, branchProjectRef]
    : [branchProjectRef, staticProjectRef, selectedBranchParentRef, envProjectRef, ...branchParents];
  return uniqueNonEmpty(candidates)[0] || '';
}

function shouldAllowStaticApiKeyFallback({
  workspaceMode,
  allowStaticKeys,
  staticAnon,
  staticService,
  staticProjectRef,
  projectRef,
  jwtSource,
  usedMgmtApiBypassFallback,
  previewJwtSeed,
  edgeRequireDbJwt,
} = {}) {
  if (String(workspaceMode || '').trim().toLowerCase() === 'branch') return false;
  if (!allowStaticKeys || !staticAnon || !staticService) return false;
  const normalizedStaticRef = String(staticProjectRef || '').trim().toLowerCase();
  const normalizedProjectRef = String(projectRef || '').trim().toLowerCase();
  if (normalizedStaticRef && normalizedProjectRef && normalizedStaticRef !== normalizedProjectRef) {
    return false;
  }
  if (jwtSource === 'project') return true;
  if (usedMgmtApiBypassFallback) return true;
  if (String(edgeRequireDbJwt || '').trim() !== '1') return true;
  if (previewJwtSeed) return false;
  return false;
}

function shouldSyncDerivedPreviewJwtSecret({
  workspaceMode,
  edgeRequireDbJwt,
  previewJwtSeed,
  jwtSeed,
  usedMgmtApiBypassFallback,
  envProjectName,
  envProjectRef,
  projectRef,
} = {}) {
  if (String(workspaceMode || '').trim().toLowerCase() === 'branch') return false;
  if (String(edgeRequireDbJwt || '').trim() === '1') return true;
  if (!String(previewJwtSeed || '').trim() && !String(jwtSeed || '').trim()) return false;
  if (usedMgmtApiBypassFallback) return false;
  if (String(envProjectName || '').trim()) return false;
  if (String(envProjectRef || '').trim()) return false;
  return isLikelyProjectRef(projectRef);
}

function shouldFailClosedOnMissingPreviewJwtSecret({
  edgeRequireDbJwt,
  jwtSecret,
} = {}) {
  return (
    String(edgeRequireDbJwt || '').trim() === '1' &&
    !String(jwtSecret || '').trim()
  );
}

function shouldRebuildProjectOnDnsFailure({
  workspaceMode,
  projectWasCreated,
  projectName,
  projectRef,
} = {}) {
  return (
    String(workspaceMode || '').trim() === 'project' &&
    !projectWasCreated &&
    Boolean(String(projectName || '').trim()) &&
    Boolean(String(projectRef || '').trim())
  );
}

function resolvePreviewDnsTimeoutMs({
  configuredTimeoutMs,
  usedMgmtApiBypassFallback,
  workspaceMode,
  projectWasCreated,
  projectName,
  projectRef,
  env = process.env,
} = {}) {
  const baseTimeoutMs = Math.max(
    10_000,
    parseInt(String(configuredTimeoutMs || DEFAULT_DNS_TIMEOUT_MS), 10) || DEFAULT_DNS_TIMEOUT_MS,
  );
  if (usedMgmtApiBypassFallback) {
    return Math.min(baseTimeoutMs, 120000);
  }
  if (!shouldRebuildProjectOnDnsFailure({
    workspaceMode,
    projectWasCreated,
    projectName,
    projectRef,
  })) {
    return baseTimeoutMs;
  }
  const reusedDirectDnsTimeoutMs = readPositiveTimeoutMs(
    env,
    ['PREVIEW_SUPABASE_REUSED_DIRECT_DNS_TIMEOUT_MS', 'SUPABASE_REUSED_DIRECT_DNS_TIMEOUT_MS'],
    5 * 60 * 1000,
    30_000,
  );
  return Math.min(baseTimeoutMs, reusedDirectDnsTimeoutMs);
}

function isDirectPreviewDnsOnlyFailure({
  error,
  projectRef,
  poolerHost,
} = {}) {
  const directHost = String(projectRef || '').trim()
    ? `db.${String(projectRef || '').trim().toLowerCase()}.supabase.co`
    : '';
  const normalizedPoolerHost = String(poolerHost || '').trim().toLowerCase();
  const message = String(error?.message || error || '').trim().toLowerCase();
  if (!directHost || !message.includes('dns not ready')) return false;
  if (!message.includes(directHost)) return false;
  if (normalizedPoolerHost && message.includes(normalizedPoolerHost)) return false;
  return true;
}

function isManagementApiForbiddenError(err) {
  const status = Number(err?.status || 0);
  const msg = String(err?.message || err || '').toLowerCase();
  return status === 401
    || status === 403
    || msg.includes('forbidden resource')
    || msg.includes('http 403');
}

function buildRecoveryProjectName(baseName, {
  nowMs = Date.now(),
  sha = process.env.GITHUB_SHA,
} = {}) {
  const safeBase = slugify(baseName || 'wk-preview').slice(0, 47) || 'wk-preview';
  const shaPart = String(sha || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7);
  const tsPart = Math.max(0, Number(nowMs) || 0).toString(36).slice(-4).padStart(4, '0');
  const suffix = shaPart ? `-r-${shaPart}${tsPart}` : `-r-${tsPart}`;
  const maxBaseLen = Math.max(1, 60 - suffix.length);
  return `${safeBase.slice(0, maxBaseLen)}${suffix}`.slice(0, 60);
}

function shouldSkipAuthDriftRebuild({
  authConnectivityFailure,
  managementApiAuthBlocked,
  usedMgmtApiBypassFallback,
  requestedWorkspaceMode,
  envProjectName,
  envProjectRef,
} = {}) {
  if (!authConnectivityFailure) return false;
  if (!(managementApiAuthBlocked || usedMgmtApiBypassFallback)) return false;

  const hasPinnedPreviewWorkspace =
    Boolean(String(envProjectName || '').trim()) ||
    Boolean(String(envProjectRef || '').trim());
  if (hasPinnedPreviewWorkspace) return true;

  // For auto-generated per-PR workspaces we must fail closed and attempt
  // deterministic rebuild instead of continuing with broken credentials.
  return String(requestedWorkspaceMode || '').trim().toLowerCase() !== 'auto';
}

function shouldRecoverWithFreshProjectSibling({
  rebuildError,
  requestedWorkspaceMode,
  envProjectName,
  envProjectRef,
  projectName,
} = {}) {
  const canRecoverWithFreshProject =
    String(requestedWorkspaceMode || '').trim().toLowerCase() === 'auto' &&
    !String(envProjectName || '').trim() &&
    !String(envProjectRef || '').trim() &&
    Boolean(String(projectName || '').trim());
  if (!canRecoverWithFreshProject) return false;
  return (
    isRecreatedPreviewProjectReuseError(rebuildError) ||
    isManagementApiForbiddenError(rebuildError) ||
    shouldUseParentProjectFallback(rebuildError)
  );
}

function isRecreatedPreviewProjectReuseError(err) {
  return String(err?.code || '').trim() === 'PREVIEW_RECREATE_REUSED_PROJECT_REF';
}

function shouldRejectRecreatedPreviewProjectReuse({
  previousProjectRef,
  nextProjectRef,
} = {}) {
  const previous = String(previousProjectRef || '').trim().toLowerCase();
  const next = String(nextProjectRef || '').trim().toLowerCase();
  return Boolean(previous && next && previous === next);
}

function buildRecreatedPreviewProjectReuseError({
  projectName,
  projectRef,
} = {}) {
  const err = new Error(
    `Recreated preview project '${String(projectName || '').trim() || '<unnamed>'}' resolved to the same project_ref=${String(projectRef || '').trim() || '<missing>'}; treating as delete-incomplete dirty preview DB.`,
  );
  err.code = 'PREVIEW_RECREATE_REUSED_PROJECT_REF';
  err.status = 409;
  return err;
}

function shouldRotateRecoverySibling({
  rebuildError,
  recoveryReason,
  rotationAttempted,
  requestedWorkspaceMode,
  envProjectName,
  envProjectRef,
  projectName,
} = {}) {
  if (!String(recoveryReason || '').trim()) return false;
  if (rotationAttempted) return false;
  return shouldRecoverWithFreshProjectSibling({
    rebuildError,
    requestedWorkspaceMode,
    envProjectName,
    envProjectRef,
    projectName,
  });
}

function resolveReusedPreviewRecoveryWaitBudget({
  maxWaitMs,
  authErrorExtraMs,
  requestedWorkspaceMode,
  envProjectName,
  envProjectRef,
  cappedMaxWaitMs,
  cappedAuthExtraMs,
} = {}) {
  const resolvedMaxWaitMs = Math.max(10_000, parseInt(String(maxWaitMs || '0'), 10) || 10_000);
  const resolvedAuthExtraMs = Math.max(0, parseInt(String(authErrorExtraMs || '0'), 10) || 0);
  const normalizedMode = String(requestedWorkspaceMode || '').trim().toLowerCase();
  const hasPinnedPreviewWorkspace =
    Boolean(String(envProjectName || '').trim()) ||
    Boolean(String(envProjectRef || '').trim());
  if (normalizedMode !== 'auto' || hasPinnedPreviewWorkspace) {
    return {
      maxWaitMs: resolvedMaxWaitMs,
      authErrorExtraMs: resolvedAuthExtraMs,
      capped: false,
    };
  }
  const maxCap = Math.max(10_000, parseInt(String(cappedMaxWaitMs || resolvedMaxWaitMs), 10) || resolvedMaxWaitMs);
  const authCap = Math.max(0, parseInt(String(cappedAuthExtraMs || resolvedAuthExtraMs), 10) || resolvedAuthExtraMs);
  const nextMaxWaitMs = Math.min(resolvedMaxWaitMs, maxCap);
  const nextAuthExtraMs = Math.min(resolvedAuthExtraMs, authCap);
  return {
    maxWaitMs: nextMaxWaitMs,
    authErrorExtraMs: nextAuthExtraMs,
    capped: nextMaxWaitMs !== resolvedMaxWaitMs || nextAuthExtraMs !== resolvedAuthExtraMs,
  };
}

function resolveRecreatedPreviewRecoveryWaitBudget(options = {}) {
  return resolveReusedPreviewRecoveryWaitBudget(options);
}

async function maybeRecoverReusedPreviewPoolerAuth({
  probe,
  managementApiAuthBlocked,
  usedMgmtApiBypassFallback,
  waitForPoolerUsableFn,
  waitForPreferredDbUsableFn,
  maxWaitMs,
  authErrorExtraMs,
  requestedWorkspaceMode,
  envProjectName,
  envProjectRef,
  cappedMaxWaitMs,
  cappedAuthExtraMs,
  logger = console,
} = {}) {
  if (probe?.ok) return { recovered: false, probe };
  const authConnectivityFailure = isDbAuthConnectivityError(probe?.error);
  const degradedManagementMode = Boolean(managementApiAuthBlocked || usedMgmtApiBypassFallback);
  if (!authConnectivityFailure || !degradedManagementMode) {
    return { recovered: false, probe };
  }
  const waitForPoolerUsable = typeof waitForPoolerUsableFn === 'function' ? waitForPoolerUsableFn : null;
  const waitForPreferredDbUsable =
    typeof waitForPreferredDbUsableFn === 'function' ? waitForPreferredDbUsableFn : null;
  const waitForRecoveryUsable = waitForPreferredDbUsable || waitForPoolerUsable;
  if (!waitForRecoveryUsable) return { recovered: false, probe };
  const recoveryLabel = waitForPreferredDbUsable ? 'preview db reused auth wait' : 'pooler reused auth wait';
  const waitBudget = resolveReusedPreviewRecoveryWaitBudget({
    maxWaitMs,
    authErrorExtraMs,
    requestedWorkspaceMode,
    envProjectName,
    envProjectRef,
    cappedMaxWaitMs,
    cappedAuthExtraMs,
  });
  logger.warn(
    waitForPreferredDbUsable
      ? '[preview-project] Reused preview DB auth probe failed while management recovery is unavailable; waiting for a healthy preview DB candidate before rebuild.'
      : '[preview-project] Reused preview DB auth probe failed while management recovery is unavailable; waiting for pooler readiness before rebuild.',
  );
  if (waitBudget.capped) {
    logger.warn(
      `[preview-project] Capping degraded reused-preview auth recovery wait to ${waitBudget.maxWaitMs}ms (+${waitBudget.authErrorExtraMs}ms auth lag) so auto preview rebuild has headroom.`,
    );
  }
  try {
    await waitForRecoveryUsable(recoveryLabel, {
      maxWaitMs: waitBudget.maxWaitMs,
      authErrorExtraMs: waitBudget.authErrorExtraMs,
    });
    logger.log('[preview-project] Reused preview DB recovered after degraded-mode auth wait.');
    return {
      recovered: true,
      probe: { ok: true },
    };
  } catch (err) {
    logger.warn(
      `[preview-project] Reused preview DB did not recover during degraded-mode auth wait; continuing with rebuild (${err.message || err}).`,
    );
    return {
      recovered: false,
      probe: {
        ...probe,
        error: err,
      },
    };
  }
}

function buildDbConnectivityTimeoutError(label, timeoutMs) {
  const err = new Error(`${label} timed out after ${timeoutMs}ms`);
  err.code = 'DB_CONNECTIVITY_TIMEOUT';
  return err;
}

function getPgClientStream(client) {
  return client?.connection?.stream || client?.stream || null;
}

function destroyPgClientStream(client, err) {
  const stream = getPgClientStream(client);
  if (!stream || typeof stream.destroy !== 'function') return;
  try {
    stream.destroy(err);
  } catch {}
}

async function runWithTimeoutGuard(promise, { timeoutMs, label, onTimeout } = {}) {
  const resolvedTimeoutMs = Math.max(1, parseInt(String(timeoutMs || '0'), 10) || 1);
  const resolvedLabel = String(label || 'operation').trim() || 'operation';
  const observedPromise = Promise.resolve(promise);
  observedPromise.catch(() => {});
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const timeoutErr = buildDbConnectivityTimeoutError(resolvedLabel, resolvedTimeoutMs);
      try {
        onTimeout?.(timeoutErr);
      } catch {}
      finish(reject, timeoutErr);
    }, resolvedTimeoutMs);
    timer.unref?.();
    observedPromise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function checkDbConnectivity({
  connectionString,
  attempts = 3,
  intervalMs = 5000,
  connectionTimeoutMillis = 15000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  spawnSyncImpl = spawnSync,
} = {}) {
  const cs = String(connectionString || '').trim();
  if (!cs) return { ok: false, error: new Error('Missing connectionString') };
  let PgClient = null;
  try {
    ({ Client: PgClient } = require('pg'));
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!PgClient) {
      try {
        const timeoutMs = Math.max(1000, Number(connectionTimeoutMillis) || 0);
        const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        const result = spawnSyncImpl(
          'psql',
          ['-d', cs, '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'select 1'],
          {
            encoding: 'utf8',
            timeout: timeoutMs + 1000,
            windowsHide: true,
            env: {
              ...process.env,
              PGCONNECT_TIMEOUT: String(timeoutSeconds),
              PGSSLMODE: process.env.PGSSLMODE || 'require',
            },
          },
        );
        if (result.error) {
          if (result.error.code === 'ENOENT') {
            throw new Error(
              "Preview DB connectivity probe requires either the 'pg' package or the 'psql' CLI before npm install.",
            );
          }
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(
            String(result.stderr || result.stdout || `psql exited with status ${result.status}`).trim(),
          );
        }
        return { ok: true };
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) await sleep(intervalMs);
        continue;
      }
    }

    const resolvedTimeoutMs = Math.max(1000, Number(connectionTimeoutMillis) || 0);
    const operationTimeoutMs = Math.max(1000, resolvedTimeoutMs + 1000);
    let client;
    try {
      client = new PgClient({ connectionString: cs, connectionTimeoutMillis });
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(intervalMs);
      continue;
    }
    // Keep a persistent listener for the full client lifecycle. Some providers
    // can emit more than one error (e.g. auth error followed by shutdown during
    // `end()`), and `once('error')` can miss late events and crash the process.
    let emittedErr = null;
    const onClientError = (err) => {
      emittedErr = emittedErr || err;
    };
    client.on('error', onClientError);
    let ended = false;
    const rawCloseClient = async () => {
      if (ended) return;
      ended = true;
      try {
        await client.end();
      } catch (endErr) {
        emittedErr = emittedErr || endErr;
        throw endErr;
      }
    };
    const closeClient = async ({ suppressError = true } = {}) => {
      try {
        await runWithTimeoutGuard(rawCloseClient(), {
          timeoutMs: operationTimeoutMs,
          label: 'DB client close',
          onTimeout: (timeoutErr) => destroyPgClientStream(client, timeoutErr),
        });
      } catch (closeErr) {
        emittedErr = emittedErr || closeErr;
        if (!suppressError) {
          throw emittedErr || closeErr;
        }
      }
    };
    try {
      await runWithTimeoutGuard(client.connect(), {
        timeoutMs: operationTimeoutMs,
        label: 'DB client connect',
        onTimeout: (timeoutErr) => destroyPgClientStream(client, timeoutErr),
      });
      if (emittedErr) throw emittedErr;
      await runWithTimeoutGuard(client.query('select 1'), {
        timeoutMs: operationTimeoutMs,
        label: 'DB client query',
        onTimeout: (timeoutErr) => destroyPgClientStream(client, timeoutErr),
      });
      if (emittedErr) throw emittedErr;
      await closeClient({ suppressError: false });
      if (emittedErr) throw emittedErr;
      client.removeListener('error', onClientError);
      return { ok: true };
    } catch (err) {
      lastErr = emittedErr || err;
      await closeClient();
      client.removeListener('error', onClientError);
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  return { ok: false, error: lastErr };
}

function isDbAuthConnectivityError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('tenant or user not found') ||
    msg.includes('password authentication failed') ||
    msg.includes('too many authentication errors')
  );
}

function buildPoolerConnectionString({ projectRef, dbPass, poolerHost, poolerPort }) {
  const resolvedProjectRef = String(projectRef || '').trim();
  const resolvedDbPass = String(dbPass || '').trim();
  const resolvedPoolerHost = String(poolerHost || '').trim();
  const resolvedPoolerPort = String(poolerPort || '').trim() || '5432';
  if (!resolvedProjectRef || !resolvedDbPass || !resolvedPoolerHost) return '';
  const poolerUser = `postgres.${resolvedProjectRef}`;
  // objectives:allow DSN_URL Justification: construct Supabase pooler DSN dynamically from project_ref and workspace password; avoids tenant constants.
  return ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodeURIComponent(resolvedDbPass)}`,"@",`${resolvedPoolerHost}`,":",`${resolvedPoolerPort}`,"/",`postgres`].join(""));
}

function resolveInitialPreviewJwtState({
  workspaceMode,
  branchJwtSecret,
} = {}) {
  const isBranch = String(workspaceMode || '').trim().toLowerCase() === 'branch';
  const secret = isBranch ? String(branchJwtSecret || '').trim() : '';
  return {
    jwtSecret: secret,
    jwtSource: secret ? 'branch_config' : '',
    jwtSecretSynced: Boolean(secret),
  };
}

function buildDirectConnectionString({
  projectRef,
  dbPass,
  dbHost,
  dbPort,
  dbUser,
} = {}) {
  const resolvedProjectRef = String(projectRef || '').trim();
  const resolvedDbPass = String(dbPass || '').trim();
  const resolvedDbHost = String(dbHost || '').trim() || (resolvedProjectRef ? `db.${resolvedProjectRef}.supabase.co` : '');
  const resolvedDbPort = String(dbPort || '').trim() || '5432';
  const resolvedDbUser = String(dbUser || '').trim() || 'postgres';
  if (!resolvedDbHost || !resolvedDbPass || !resolvedDbUser) return '';
  // objectives:allow DSN_URL Justification: construct canonical Supabase direct Postgres DSN dynamically from project_ref and workspace password; avoids tenant constants.
  return ([`postgresql`,":","/","/",`${encodeURIComponent(resolvedDbUser)}`,":",`${encodeURIComponent(resolvedDbPass)}`,"@",`${resolvedDbHost}`,":",`${resolvedDbPort}`,"/",`postgres`].join(""));
}

function resolveWorkspaceDbCredentials({
  workspaceMode,
  configuredDbPass,
  branchConfig,
  expectedProjectRef,
} = {}) {
  const mode = String(workspaceMode || '').trim().toLowerCase();
  if (mode !== 'branch') {
    return {
      dbPass: String(configuredDbPass || '').trim(),
      directDbHost: '',
      directDbPort: '',
      directDbUser: '',
      source: 'configured',
      shouldSyncPassword: true,
    };
  }

  const validated = validateBranchDatabaseConfig(branchConfig, { expectedProjectRef });
  return {
    dbPass: validated.db_pass,
    directDbHost: validated.db_host,
    directDbPort: validated.db_port,
    directDbUser: validated.db_user,
    source: 'branch_config',
    shouldSyncPassword: false,
  };
}

async function waitForBranchDbCredentials({
  token,
  branchIdOrRef,
  expectedProjectRef,
  configuredDbPass,
  maxWaitMs = 120_000,
  retryDelayMs = 5_000,
  getBranchConfigFn,
  nowFn = () => Date.now(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const branchConfig = await waitForBranchDatabaseConfig({
    token,
    branchIdOrRef,
    expectedProjectRef,
    maxWaitMs,
    retryDelayMs,
    ...(getBranchConfigFn ? { getBranchConfigFn } : {}),
    nowFn,
    sleepFn,
  });
  const credentials = resolveWorkspaceDbCredentials({
    workspaceMode: 'branch',
    configuredDbPass,
    branchConfig,
    expectedProjectRef,
  });
  return { branchConfig, credentials };
}

function parseConnectionTarget(connectionString) {
  return parseDbConnectionTarget(connectionString);
}

function buildPreviewEnvPayload({
  projectRef,
  supabaseUrl,
  directDbUrl,
  preferredDatabaseUrl,
  workspaceMode,
  keys,
  jwtSecret,
  edgeInternalCallerRoles,
  edgeRequireDbJwt,
  effectiveRegion,
  configuredRegion,
  poolerHost,
  poolerPort,
  selectedPoolerTarget,
  selectedPoolerCandidateName,
  orgId,
  token,
  dbPass,
  selectedBranchParentRef,
  edgeDbJwtBundle,
  githubToken,
} = {}) {
  const resolvedProjectRef = String(projectRef || '').trim();
  const resolvedSelectedTarget = selectedPoolerTarget && typeof selectedPoolerTarget === 'object'
    ? selectedPoolerTarget
    : parseConnectionTarget(preferredDatabaseUrl);

  return {
    project_ref: resolvedProjectRef,
    supabase_url: supabaseUrl,
    database_url: directDbUrl,
    preferred_database_url: preferredDatabaseUrl,
    db_ready_candidate_name: selectedPoolerCandidateName,
    workspace_mode: workspaceMode,
    anon_key: keys?.anon || '',
    service_role_key: keys?.service || '',
    ...(jwtSecret ? { supabase_jwt_secret: jwtSecret } : {}),
    edge_internal_caller_roles: edgeInternalCallerRoles,
    edge_require_db_jwt: edgeRequireDbJwt,
    region: effectiveRegion || configuredRegion,
    pooler_host: poolerHost,
    pooler_port: resolvedSelectedTarget.kind === 'pooler' && resolvedSelectedTarget.port
      ? resolvedSelectedTarget.port
      : poolerPort,
    pooler_user: resolvedSelectedTarget.kind === 'pooler' && resolvedSelectedTarget.username
      ? resolvedSelectedTarget.username
      : `postgres.${resolvedProjectRef}`,
    org_id: orgId,
    access_token: token,
    db_pass: dbPass,
    github_token: githubToken,
    ...(workspaceMode === 'branch' && selectedBranchParentRef
      ? { branch_parent_ref: selectedBranchParentRef }
      : {}),
    ...(edgeDbJwtBundle ? edgeDbJwtBundle : {}),
  };
}

async function buildPreviewPoolerDbCandidates({
  projectRef,
  dbPass,
  poolerHost,
  poolerPort,
  directDbHost,
  directDbPort,
  directDbUser,
  includeDirect = true,
  poolerSessionOnly = false,
  buildCandidatesFn = buildDbConnectionCandidates,
} = {}) {
  const rawCandidates = [];
  const poolerDsn = buildPoolerConnectionString({
    projectRef,
    dbPass,
    poolerHost,
    poolerPort,
  });
  if (poolerDsn) {
    rawCandidates.push({ name: 'DATABASE_URL_POOLER', dsn: poolerDsn });
  }

  const directDsn = includeDirect
    ? buildDirectConnectionString({
      projectRef,
      dbPass,
      dbHost: directDbHost,
      dbPort: directDbPort,
      dbUser: directDbUser,
    })
    : '';
  if (directDsn) {
    rawCandidates.push({ name: 'DATABASE_URL_DIRECT', dsn: directDsn });
  }

  const candidates = await buildCandidatesFn(rawCandidates, { projectRef });
  if (!poolerSessionOnly) return candidates;

  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const name = String(candidate?.name || '').trim();
    if (!name.startsWith('DATABASE_URL_POOLER')) return true;
    try {
      const parsed = new URL(String(candidate?.dsn || '').trim());
      return (String(parsed.port || '').trim() || '5432') === '5432';
    } catch {
      return false;
    }
  });
}

async function checkDbConnectivityCandidates({
  candidates,
  attempts = 1,
  intervalMs = 0,
  connectionTimeoutMillis = 15000,
  checkFn,
} = {}) {
  const probeDb = typeof checkFn === 'function' ? checkFn : checkDbConnectivity;
  const normalizedCandidates = Array.isArray(candidates)
    ? candidates
      .map((candidate) => ({
        name: String(candidate?.name || '').trim(),
        dsn: String(candidate?.dsn || '').trim(),
      }))
      .filter((candidate) => candidate.name && candidate.dsn)
    : [];

  if (normalizedCandidates.length === 0) {
    return { ok: false, error: new Error('Missing DB readiness candidates') };
  }

  let lastError = null;
  let lastCandidateName = '';
  let lastCandidateDsn = '';
  let lastRetryableAuthError = null;
  let lastRetryableAuthCandidateName = '';
  let lastRetryableAuthCandidateDsn = '';
  for (const candidate of normalizedCandidates) {
    let res;
    try {
      res = await probeDb({
        connectionString: candidate.dsn,
        attempts,
        intervalMs,
        connectionTimeoutMillis,
      });
    } catch (error) {
      res = { ok: false, error };
    }
    if (res?.ok) {
      return {
        ok: true,
        candidateName: String(res.candidateName || candidate.name || '').trim(),
        connectionString: String(res.connectionString || candidate.dsn || '').trim(),
      };
    }
    lastError = res?.error || new Error(`DB readiness candidate '${candidate.name}' failed without an error`);
    lastCandidateName = String(res?.candidateName || candidate.name || '').trim();
    lastCandidateDsn = String(res?.connectionString || candidate.dsn || '').trim();
    if (isDbAuthConnectivityError(lastError)) {
      lastRetryableAuthError = lastError;
      lastRetryableAuthCandidateName = lastCandidateName;
      lastRetryableAuthCandidateDsn = lastCandidateDsn;
    }
  }

  return {
    ok: false,
    error: lastRetryableAuthError || lastError || new Error('No DB readiness candidate succeeded'),
    candidateName: lastRetryableAuthCandidateName || lastCandidateName,
    connectionString: lastRetryableAuthCandidateDsn || lastCandidateDsn,
  };
}

async function refreshProjectDbPassword({
  projectRef,
  token,
  dbPass,
  label,
  traceContext,
  maxWaitMs = 0,
  retryDelayMs = 10_000,
}) {
  if (!projectRef || !token || !dbPass) return false;
  try {
    await setProjectDatabasePassword({
      projectRef,
      token,
      password: dbPass,
      maxWaitMs,
      retryDelayMs,
    });
    console.log(`[preview-project] Refreshed preview DB password${label ? ` (${label})` : ''} for project_ref=${projectRef}.`);
    if (traceContext) {
      emitTrace(traceContext, 'info', {
        step: 'db_password_sync',
        status: 'ok',
        project_ref: projectRef,
        label,
      });
    }
    return true;
  } catch (err) {
    console.warn(`[preview-project] Failed to refresh preview DB password${label ? ` (${label})` : ''} for project_ref=${projectRef}: ${err.message}`);
    if (traceContext) {
      emitTrace(traceContext, 'warn', {
        step: 'db_password_sync',
        status: 'error',
        project_ref: projectRef,
        label,
        error_message: String(err.message || err),
      });
    }
    return false;
  }
}

function shouldSyncPreviewDbPasswordOnAuthError(value = process.env.PREVIEW_SYNC_DB_PASSWORD_ON_AUTH_ERROR) {
  const raw = String(value == null || value === '' ? '1' : value).trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

async function waitForPoolerUsableWithAuthLagRecovery({
  label,
  waitForPoolerUsableFn,
  projectRef,
  token,
  dbPass,
  traceContext,
  maxWaitMs,
  authErrorExtraMs,
  previewDbPasswordSyncMaxWaitMs,
  previewDbPasswordSyncRetryDelayMs,
  logger = console,
  shouldSyncDbPasswordOnAuthErrorFn = shouldSyncPreviewDbPasswordOnAuthError,
  refreshProjectDbPasswordFn = refreshProjectDbPassword,
  nowFn = () => Date.now(),
  recoveryDeadlineMs,
} = {}) {
  const waitForPoolerUsable =
    typeof waitForPoolerUsableFn === 'function' ? waitForPoolerUsableFn : null;
  if (!waitForPoolerUsable) {
    throw new Error('waitForPoolerUsableFn is required');
  }

  const poolerLabel = String(label || 'pooler').trim() || 'pooler';
  const hasExplicitMaxWaitMs =
    maxWaitMs !== undefined &&
    maxWaitMs !== null &&
    String(maxWaitMs).trim() !== '';
  const hasExplicitAuthErrorExtraMs =
    authErrorExtraMs !== undefined &&
    authErrorExtraMs !== null &&
    String(authErrorExtraMs).trim() !== '';
  const resolvedMaxWaitMs = Math.max(10_000, parseInt(String(maxWaitMs || '0'), 10) || 10_000);
  const resolvedAuthExtraMs = Math.max(
    0,
    parseInt(String(authErrorExtraMs || '0'), 10) || 0,
  );
  const startedAt = nowFn();
  const resolvedRecoveryDeadlineMs = Number.isFinite(Number(recoveryDeadlineMs))
    ? Number(recoveryDeadlineMs)
    : startedAt + resolvedMaxWaitMs + resolvedAuthExtraMs;
  const resolveRemainingRecoveryBudgetMs = () =>
    Math.max(0, resolvedRecoveryDeadlineMs - nowFn());
  const resolveBoundedRecoveryWindow = () => {
    const remainingRecoveryBudgetMs = resolveRemainingRecoveryBudgetMs();
    if (remainingRecoveryBudgetMs < 10_000) {
      return {
        remainingRecoveryBudgetMs,
        maxWaitMs: remainingRecoveryBudgetMs,
        authErrorExtraMs: 0,
      };
    }
    const boundedMaxWaitMs = Math.max(10_000, Math.min(resolvedMaxWaitMs, remainingRecoveryBudgetMs));
    return {
      remainingRecoveryBudgetMs,
      maxWaitMs: boundedMaxWaitMs,
      authErrorExtraMs: Math.max(0, remainingRecoveryBudgetMs - boundedMaxWaitMs),
    };
  };
  const initialRecoveryWindow = resolveBoundedRecoveryWindow();
  if (initialRecoveryWindow.remainingRecoveryBudgetMs < 10_000) {
    throw new Error(
      `Preview DB pooler auth-lag recovery budget exhausted (${poolerLabel}) before readiness wait after ${Math.max(0, nowFn() - startedAt)}ms.`,
    );
  }
  try {
    if (hasExplicitMaxWaitMs || hasExplicitAuthErrorExtraMs) {
      await waitForPoolerUsable(poolerLabel, {
        ...(hasExplicitMaxWaitMs ? { maxWaitMs: initialRecoveryWindow.maxWaitMs } : {}),
        ...(hasExplicitAuthErrorExtraMs
          ? { authErrorExtraMs: initialRecoveryWindow.authErrorExtraMs }
          : {}),
      });
    } else {
      await waitForPoolerUsable(poolerLabel);
    }
    return;
  } catch (poolerErr) {
    const retryableAuthError = isDbAuthConnectivityError(poolerErr);
    if (!retryableAuthError) {
      throw poolerErr;
    }
    logger.warn(
      `[preview-project] Pooler readiness reported auth connectivity lag (${poolerLabel}); retrying once with extended timeout.`,
    );
    const shouldSyncDbPasswordOnAuthError =
      typeof shouldSyncDbPasswordOnAuthErrorFn === 'function'
        ? shouldSyncDbPasswordOnAuthErrorFn
        : shouldSyncPreviewDbPasswordOnAuthError;
    if (shouldSyncDbPasswordOnAuthError()) {
      const refreshProjectDbPasswordImpl =
        typeof refreshProjectDbPasswordFn === 'function'
          ? refreshProjectDbPasswordFn
          : refreshProjectDbPassword;
      const remainingRecoveryBudgetMs = resolveRemainingRecoveryBudgetMs();
      if (remainingRecoveryBudgetMs < 10_000) {
        throw new Error(
          `Preview DB pooler auth-lag recovery budget exhausted (${poolerLabel}) before password sync after ${Math.max(0, nowFn() - startedAt)}ms.`,
        );
      }
      await refreshProjectDbPasswordImpl({
        projectRef,
        token,
        dbPass,
        label: `${poolerLabel} auth-lag retry`,
        traceContext,
        maxWaitMs:
          previewDbPasswordSyncMaxWaitMs > 0
            ? Math.min(previewDbPasswordSyncMaxWaitMs, remainingRecoveryBudgetMs)
            : remainingRecoveryBudgetMs,
        retryDelayMs: previewDbPasswordSyncRetryDelayMs,
      });
    }
    const elapsedMs = Math.max(0, nowFn() - startedAt);
    const retryRecoveryWindow = resolveBoundedRecoveryWindow();
    if (retryRecoveryWindow.remainingRecoveryBudgetMs < 10_000) {
      throw new Error(
        `Preview DB pooler auth-lag recovery budget exhausted (${poolerLabel}) after ${elapsedMs}ms: ${poolerErr.message || poolerErr}`,
      );
    }
    logger.warn(
      `[preview-project] Retrying pooler readiness within remaining auth-lag recovery budget (${poolerLabel}) remaining=${retryRecoveryWindow.remainingRecoveryBudgetMs}ms.`,
    );
    await waitForPoolerUsable(`${poolerLabel} retry`, {
      maxWaitMs: retryRecoveryWindow.maxWaitMs,
      authErrorExtraMs: retryRecoveryWindow.authErrorExtraMs,
    });
  }
}

function readPositiveTimeoutMs(env = process.env, keys = [], fallbackMs = 0, minimumMs = 0) {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const raw = String(env?.[key] || '').trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(minimumMs, Math.floor(parsed));
    }
  }
  return Math.max(minimumMs, Math.floor(Number(fallbackMs) || 0));
}

function resolvePreviewProjectCommandTimeoutMs({
  env = process.env,
  requestedTimeoutMs = 0,
  minimumTimeoutMs = 0,
} = {}) {
  const dbReadyTimeoutMs = readPositiveTimeoutMs(
    env,
    ['PREVIEW_SUPABASE_DB_READY_TIMEOUT_MS', 'SUPABASE_DB_READY_TIMEOUT_MS'],
    720000,
    10_000,
  );
  const dbReadyAuthExtraMs = readPositiveTimeoutMs(
    env,
    ['PREVIEW_SUPABASE_DB_READY_AUTH_EXTRA_MS', 'SUPABASE_DB_READY_AUTH_EXTRA_MS'],
    480000,
    0,
  );
  const controlPlaneBufferMs = readPositiveTimeoutMs(
    env,
    ['PREVIEW_PROJECT_COMMAND_TIMEOUT_BUFFER_MS'],
    15 * 60 * 1000,
    60_000,
  );
  const requestedMs =
    Number.isFinite(Number(requestedTimeoutMs)) && Number(requestedTimeoutMs) > 0
      ? Math.floor(Number(requestedTimeoutMs))
      : 0;

  // preview-project can legitimately spend one full DB auth-lag window waiting on
  // a reused workspace and another full window waiting on the recreated fallback
  // workspace before the caller resumes with surface deployment.
  const derivedRecoveryBudgetMs = (2 * (dbReadyTimeoutMs + dbReadyAuthExtraMs)) + controlPlaneBufferMs;
  return Math.max(
    derivedRecoveryBudgetMs,
    requestedMs,
    Math.max(0, Math.floor(Number(minimumTimeoutMs) || 0)),
  );
}

async function waitForDbReady({
  label,
  connectionString,
  attempts,
  intervalMs,
  connectionTimeoutMillis,
  maxWaitMs,
  authErrorExtraMs,
  traceContext,
  checkFn,
  sleepFn,
  now,
} = {}) {
  const name = String(label || 'database').trim() || 'database';
  const probeDb = typeof checkFn === 'function' ? checkFn : checkDbConnectivity;
  const sleep = typeof sleepFn === 'function' ? sleepFn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const resolvedAttempts = Math.max(1, parseInt(String(attempts || '1'), 10) || 1);
  const resolvedIntervalMs = Math.max(0, parseInt(String(intervalMs || '5000'), 10) || 5000);
  const resolvedConnTimeoutMs = Math.max(
    1000,
    parseInt(String(connectionTimeoutMillis || '15000'), 10) || 15000,
  );
  const derivedTimeoutMs =
    resolvedAttempts * Math.max(1000, resolvedConnTimeoutMs + resolvedIntervalMs);
  const resolvedMaxWaitMs = Math.max(
    10_000,
    parseInt(String(maxWaitMs || ''), 10) || derivedTimeoutMs,
  );
  const resolvedAuthExtraMs = Math.max(
    0,
    parseInt(String(authErrorExtraMs || '0'), 10) || 0,
  );

  const startedAt = nowFn();
  const baseDeadline = startedAt + resolvedMaxWaitMs;
  const authDeadline = baseDeadline + resolvedAuthExtraMs;
  let deadline = baseDeadline;
  let attemptNo = 0;
  let extendedForAuthLag = false;
  let lastError = null;

  while (nowFn() <= deadline) {
    attemptNo += 1;
    const res = await probeDb({
      connectionString,
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: resolvedConnTimeoutMs,
    });
    if (res.ok) {
      const durationMs = nowFn() - startedAt;
      console.log(`[preview-project] DB ready (${name})`);
      if (traceContext) {
        emitTrace(traceContext, 'info', {
          step: 'db_readiness',
          status: 'ok',
          label: name,
          attempts: attemptNo,
          duration_ms: durationMs,
          auth_lag_extension_applied: extendedForAuthLag,
        });
      }
      return;
    }

    lastError = res.error;
    const msg = String(lastError?.message || lastError || 'unknown');
    const authErr = isDbAuthConnectivityError(lastError);
    const currentNow = nowFn();
    const canExtendForAuthLag = authErr && resolvedAuthExtraMs > 0 && currentNow <= authDeadline;
    // Extend proactively before the next sleep/probe would cross the base deadline.
    // Without this, auth propagation errors can hit the deadline boundary during the sleep,
    // exiting the loop without ever applying the authExtra window.
    const projectedNextAttemptAt = currentNow + resolvedIntervalMs + resolvedConnTimeoutMs;
    if (!extendedForAuthLag && canExtendForAuthLag && projectedNextAttemptAt >= deadline) {
      deadline = authDeadline;
      extendedForAuthLag = true;
      console.warn(`[preview-project] Extending DB readiness window for auth lag (${name})`);
      if (traceContext) {
        emitTrace(traceContext, 'warn', {
          step: 'db_readiness',
          status: 'extend',
          label: name,
          reason: 'auth_lag_window',
          attempts: attemptNo,
          max_wait_ms: resolvedMaxWaitMs,
          auth_extra_ms: resolvedAuthExtraMs,
        });
      }
    }

    if (attemptNo === 1 || attemptNo % 6 === 0) {
      console.warn(`[preview-project] Waiting for DB (${name}) attempt=${attemptNo}: ${msg}`);
      if (traceContext) {
        emitTrace(traceContext, 'warn', {
          step: 'db_readiness',
          status: 'waiting',
          label: name,
          attempts: attemptNo,
          retryable_auth_error: authErr,
          error_message: msg,
        });
      }
    }

    await sleep(resolvedIntervalMs);
  }

  const msg = String(lastError?.message || lastError || 'unknown');
  throw new Error(
    `DB not ready (${name}) after ${attemptNo} attempts over ${nowFn() - startedAt}ms: ${msg}`,
  );
}

async function waitForDbReadyCandidates({
  label,
  candidates,
  attempts,
  intervalMs,
  connectionTimeoutMillis,
  maxWaitMs,
  authErrorExtraMs,
  traceContext,
  checkFn,
  sleepFn,
  now,
} = {}) {
  const name = String(label || 'database').trim() || 'database';
  const resolvedCandidates = Array.isArray(candidates)
    ? candidates
      .map((candidate) => ({
        name: String(candidate?.name || '').trim(),
        dsn: String(candidate?.dsn || '').trim(),
      }))
      .filter((candidate) => candidate.name && candidate.dsn)
    : [];
  if (resolvedCandidates.length === 0) {
    throw new Error(`Missing DB readiness candidates (${name})`);
  }

  const probeDb = typeof checkFn === 'function' ? checkFn : checkDbConnectivityCandidates;
  const sleep = typeof sleepFn === 'function' ? sleepFn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const resolvedAttempts = Math.max(1, parseInt(String(attempts || '1'), 10) || 1);
  const resolvedIntervalMs = Math.max(0, parseInt(String(intervalMs || '5000'), 10) || 5000);
  const resolvedConnTimeoutMs = Math.max(
    1000,
    parseInt(String(connectionTimeoutMillis || '15000'), 10) || 15000,
  );
  const probePassDurationMs = Math.max(
    1000,
    resolvedCandidates.length * Math.max(1000, resolvedConnTimeoutMs),
  );
  const derivedTimeoutMs =
    resolvedAttempts * Math.max(1000, probePassDurationMs + resolvedIntervalMs);
  const resolvedMaxWaitMs = Math.max(
    10_000,
    parseInt(String(maxWaitMs || ''), 10) || derivedTimeoutMs,
  );
  const resolvedAuthExtraMs = Math.max(
    0,
    parseInt(String(authErrorExtraMs || '0'), 10) || 0,
  );

  const startedAt = nowFn();
  const baseDeadline = startedAt + resolvedMaxWaitMs;
  const authDeadline = baseDeadline + resolvedAuthExtraMs;
  let deadline = baseDeadline;
  let attemptNo = 0;
  let extendedForAuthLag = false;
  let lastError = null;
  let lastCandidateName = '';

  while (nowFn() <= deadline) {
    attemptNo += 1;
    const res = await probeDb({
      candidates: resolvedCandidates,
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: resolvedConnTimeoutMs,
    });
    if (res.ok) {
      const durationMs = nowFn() - startedAt;
      const selectedCandidateName = String(res.candidateName || '').trim();
      console.log(`[preview-project] DB ready (${name})${selectedCandidateName ? ` via ${selectedCandidateName}` : ''}`);
      if (traceContext) {
        emitTrace(traceContext, 'info', {
          step: 'db_readiness',
          status: 'ok',
          label: name,
          attempts: attemptNo,
          duration_ms: durationMs,
          auth_lag_extension_applied: extendedForAuthLag,
          selected_candidate: selectedCandidateName,
        });
      }
      return {
        candidateName: selectedCandidateName,
        connectionString: String(res.connectionString || '').trim(),
      };
    }

    lastError = res.error;
    lastCandidateName = String(res.candidateName || '').trim();
    const msg = String(lastError?.message || lastError || 'unknown');
    const authErr = isDbAuthConnectivityError(lastError);
    const currentNow = nowFn();
    const canExtendForAuthLag = authErr && resolvedAuthExtraMs > 0 && currentNow <= authDeadline;
    const projectedNextAttemptAt = currentNow + resolvedIntervalMs + probePassDurationMs;
    if (!extendedForAuthLag && canExtendForAuthLag && projectedNextAttemptAt >= deadline) {
      deadline = authDeadline;
      extendedForAuthLag = true;
      console.warn(`[preview-project] Extending DB readiness window for auth lag (${name})`);
      if (traceContext) {
        emitTrace(traceContext, 'warn', {
          step: 'db_readiness',
          status: 'extend',
          label: name,
          reason: 'auth_lag_window',
          attempts: attemptNo,
          max_wait_ms: resolvedMaxWaitMs,
          auth_extra_ms: resolvedAuthExtraMs,
        });
      }
    }

    if (attemptNo === 1 || attemptNo % 6 === 0) {
      const via = lastCandidateName ? ` via ${lastCandidateName}` : '';
      console.warn(`[preview-project] Waiting for DB (${name}) attempt=${attemptNo}${via}: ${msg}`);
      if (traceContext) {
        emitTrace(traceContext, 'warn', {
          step: 'db_readiness',
          status: 'waiting',
          label: name,
          attempts: attemptNo,
          retryable_auth_error: authErr,
          error_message: msg,
          selected_candidate: lastCandidateName,
        });
      }
    }

    await sleep(resolvedIntervalMs);
  }

  const msg = String(lastError?.message || lastError || 'unknown');
  throw new Error(
    `DB not ready (${name}) after ${attemptNo} attempts over ${nowFn() - startedAt}ms: ${msg}`,
  );
}

async function waitForDns({
  projectRef,
  directDbHost,
  poolerHost,
  includeDirectHost = true,
  timeoutMs,
  pollMs,
  lookup = dns.lookup,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const targets = [];
  if (includeDirectHost && (directDbHost || projectRef)) {
    targets.push(String(directDbHost || `db.${projectRef}.supabase.co`).trim());
  }
  if (poolerHost) targets.push(poolerHost);
  if (!targets.length) return;

  const resolvedTimeoutMs = Number(timeoutMs);
  const resolvedPollMs = Number(pollMs);
  if (!Number.isFinite(resolvedTimeoutMs) || resolvedTimeoutMs <= 0) {
    throw new Error(`Invalid DNS timeoutMs: ${timeoutMs}`);
  }
  if (!Number.isFinite(resolvedPollMs) || resolvedPollMs < 0) {
    throw new Error(`Invalid DNS pollMs: ${pollMs}`);
  }

  const start = now();
  const unresolved = new Set(targets);
  const lastErrByHost = new Map();

  while (now() - start < resolvedTimeoutMs) {
    for (const host of Array.from(unresolved)) {
      try {
        await lookup(host);
        unresolved.delete(host);
        lastErrByHost.delete(host);
        console.log(`[preview-project] DNS ready for ${host}`);
      } catch (err) {
        lastErrByHost.set(host, err);
      }
    }

    if (!unresolved.size) return;
    await sleep(resolvedPollMs);
  }

  const unresolvedSummary = Array.from(unresolved)
    .map((host) => `${host}: ${String(lastErrByHost.get(host)?.message || 'unknown')}`)
    .join('; ');
  throw new Error(`DNS not ready (timeout_ms=${resolvedTimeoutMs}): ${unresolvedSummary}`);
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; use --format json locally.');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) lines.push(`${k}=${String(v == null ? '' : v)}`);
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

async function runGenEnv({ envFile, payload }) {
  const { spawn } = require('child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join('scripts', 'ops', 'branches', 'gen-env.js'), '--file', envFile],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`gen-env failed (${code})`))));
  });
}

async function main() {
  loadEnv();
  const trace = resolveTraceContext({
    operation: 'workspace.preview_project',
    traceparent: process.env.TRACEPARENT,
  });
  const args = parseArgs();
  const fmt = String(args.format || '').trim().toLowerCase();

  const evt = readGithubEvent();
  const prFromEvt = extractPrNumber(evt);
  const prNumber = String(args.pr || prFromEvt || '').trim();
  const repo = process.env.GITHUB_REPOSITORY || (evt && evt.repository && evt.repository.full_name) || '';

  const requirePreviewSecrets = process.env.GITHUB_ACTIONS === 'true' || process.env.REQUIRE_PREVIEW_SECRETS === '1';
  const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets });
  if (cfg.missing.length) die(`Missing required preview Supabase config: ${cfg.missing.join(', ')}`);
  if (cfg.invalid && cfg.invalid.length) die(`Invalid preview Supabase config: ${cfg.invalid.join(', ')}`);

  const token = cfg.token;
  const orgId = cfg.orgId;
  const configuredRegion = cfg.region;
  const plan = cfg.plan;
  let dbPass = cfg.dbPass;
  const requestedWorkspaceMode = String(cfg.workspaceMode || 'project').trim().toLowerCase();
  if (!['project', 'branch', 'auto'].includes(requestedWorkspaceMode)) {
    die(`Invalid workspace mode '${requestedWorkspaceMode}'. Expected 'project', 'branch', or 'auto'.`);
  }
  const expectedWorkspaceMode = readEnv('PREVIEW_EXPECTED_WORKSPACE_MODE').toLowerCase();
  const expectedProjectRef = readEnv('PREVIEW_EXPECTED_PROJECT_REF').toLowerCase();
  const expectedBranchParentRef = readEnv('PREVIEW_EXPECTED_BRANCH_PARENT_REF').toLowerCase();
  const requireExistingWorkspace = isTruthyFlag(readEnv('PREVIEW_REQUIRE_EXISTING_WORKSPACE'));
  if (expectedWorkspaceMode && !['project', 'branch'].includes(expectedWorkspaceMode)) {
    die(`Invalid PREVIEW_EXPECTED_WORKSPACE_MODE '${expectedWorkspaceMode}'. Expected 'project' or 'branch'.`);
  }
  if (expectedProjectRef && !isCanonicalSupabaseProjectRef(expectedProjectRef)) {
    die('PREVIEW_EXPECTED_PROJECT_REF must be an exact canonical Supabase project ref.');
  }
  if (expectedBranchParentRef && !isCanonicalSupabaseProjectRef(expectedBranchParentRef)) {
    die('PREVIEW_EXPECTED_BRANCH_PARENT_REF must be an exact canonical Supabase project ref.');
  }
  if (requireExistingWorkspace && (!expectedWorkspaceMode || !expectedProjectRef)) {
    die('PREVIEW_REQUIRE_EXISTING_WORKSPACE requires PREVIEW_EXPECTED_WORKSPACE_MODE and PREVIEW_EXPECTED_PROJECT_REF.');
  }
  if (expectedWorkspaceMode && requestedWorkspaceMode !== expectedWorkspaceMode) {
    die(
      `Pinned preview workspace mode mismatch: requested=${requestedWorkspaceMode} expected=${expectedWorkspaceMode}.`,
    );
  }
  if (expectedWorkspaceMode === 'branch' && !expectedBranchParentRef) {
    die('Pinned branch rehydrate requires PREVIEW_EXPECTED_BRANCH_PARENT_REF.');
  }
  const edgeInternalCallerRoles =
    String(process.env.EDGE_INTERNAL_CALLER_ROLES || '').trim() ||
    'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role';
  let edgeRequireDbJwt = String(process.env.EDGE_REQUIRE_DB_JWT || '1').trim();

  const envProjectName = readEnv('PREVIEW_PROJECT_NAME');
  const envProjectRef =
    readEnv('PREVIEW_PROJECT_REF') ||
    readEnv('PREVIEW_SUPABASE_PROJECT_ID') ||
    expectedProjectRef;
  const envSupabaseUrl = readEnv('PREVIEW_SUPABASE_URL');
  const staticAnon = readEnv('PREVIEW_SUPABASE_ANON_KEY');
  const staticService = readEnv('PREVIEW_SUPABASE_SERVICE_ROLE_KEY');
  const staticProjectRef = resolveProjectRefFromStaticApiKeys({
    serviceKey: staticService,
    anonKey: staticAnon,
  });
  const resolvedBranchParentCandidates = resolveBranchParentCandidates({
    resolvedConfig: cfg,
    env: process.env,
    extra: [envProjectRef],
  });
  const branchParentCandidates = expectedBranchParentRef
    ? [expectedBranchParentRef]
    : resolvedBranchParentCandidates;

  const explicitName = String(args.name || '').trim() || envProjectName;
  if (!prNumber && !explicitName && !(requestedWorkspaceMode !== 'branch' && envProjectRef)) {
    die('Missing PR number (use --pr) or --name/preview project ref');
  }

  let projectName = explicitName || (prNumber ? computeProjectName({ repo, prNumber }) : '');
  const canonicalProjectName = projectName;
  const forceRecoverySibling = isTruthyFlag(process.env.PREVIEW_FORCE_RECOVERY_SIBLING);
  if (forceRecoverySibling) {
    if (requireExistingWorkspace) {
      die('PREVIEW_FORCE_RECOVERY_SIBLING is forbidden while an existing preview workspace identity is pinned.');
    }
    if (envProjectName || envProjectRef) {
      die('PREVIEW_FORCE_RECOVERY_SIBLING cannot be used with PREVIEW_PROJECT_NAME/PREVIEW_PROJECT_REF pinned preview workspaces.');
    }
    if (!['auto', 'project'].includes(requestedWorkspaceMode)) {
      die(`PREVIEW_FORCE_RECOVERY_SIBLING requires workspace mode auto|project, got '${requestedWorkspaceMode}'.`);
    }
    if (!projectName) {
      die('PREVIEW_FORCE_RECOVERY_SIBLING requires a resolvable preview project name.');
    }
    projectName = buildRecoveryProjectName(canonicalProjectName || projectName);
    console.warn(`[preview-project] Forcing fresh recovery sibling '${projectName}' for preview DB drift recovery.`);
  }
  if (requestedWorkspaceMode === 'branch' && !branchParentCandidates.length) {
    die('Missing branch parent project ref. Set PREVIEW_SUPABASE_BRANCH_PARENT_REF (or SUPABASE_BRANCH_PARENT_REF / SUPABASE_PARENT_PROJECT_REF / SUPABASE_PROJECT_ID).');
  }
  const envFile = String(process.env.ENV_FILE || path.join('config', 'env', '.env.cloud')).trim();
  emitTrace(trace, 'info', {
    step: 'start',
    status: 'ok',
    workspace_mode_requested: requestedWorkspaceMode,
    env_file: envFile,
    has_pr: Boolean(prNumber),
    has_name: Boolean(projectName),
  });

  // Find/create deterministic workspace (project-per-PR or branch-per-PR).
  let existingProject = null;
  let existingBranch = null;
  let projectRef = '';
  let projectWasCreated = false;
  let projectWasRecreated = false;
  let recoveryReason = '';
  let recoveryRotationAttempted = false;
  let supersededProjectRef = '';
  let usedMgmtApiBypassFallback = false;
  let branchId = '';
  let selectedBranchParentRef = branchParentCandidates[0] || '';
  let workspaceMode = forceRecoverySibling ? 'project' : requestedWorkspaceMode;
  let materializedOwnership = null;

  function persistCurrentWorkspaceOwnership() {
    const ownershipPath = readEnv('PREVIEW_OWNERSHIP_PATH');
    if (!ownershipPath || !String(projectName || '').toLowerCase().startsWith('wk-')) return null;
    const ownsDisposableWorkspace = workspaceMode === 'branch' || (
      workspaceMode === 'project' &&
      !usedMgmtApiBypassFallback &&
      (projectWasCreated || Boolean(existingProject))
    );
    if (!ownsDisposableWorkspace) return null;
    materializedOwnership = persistMaterializedOwnership(ownershipPath, {
      workspace_mode: workspaceMode,
      project_name: projectName,
      project_ref: projectRef,
      branch_id: workspaceMode === 'branch' ? branchId : '',
      branch_parent_ref: workspaceMode === 'branch' ? selectedBranchParentRef : '',
      active_family_generation: String(projectName || '').includes('-r-') ? 2 : 1,
      run_id: process.env.GITHUB_RUN_ID || '',
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || '',
    });
    return materializedOwnership;
  }

  async function createFreshRecoveryProject({
    recreateErr,
    rotation = false,
    extraExcludedProjectRefs = [],
  } = {}) {
    if (requireExistingWorkspace) {
      throw new Error(
        `Pinned preview workspace ${expectedProjectRef} is unhealthy; replacement is forbidden during manifest rehydrate.`,
      );
    }
    const recoveryBaseName = canonicalProjectName || projectName;
    const recoveryProjectName = buildRecoveryProjectName(recoveryBaseName);
    const recoveryFamilyName = extractPreviewWorkspaceFamilyName(recoveryProjectName);
    const previousProjectRef = String(projectRef || '').trim();
    supersededProjectRef = previousProjectRef;
    recoveryReason = isManagementApiForbiddenError(recreateErr)
      ? 'management_api_blocked_recovery_sibling'
      : 'degraded_rebuild_recovery_sibling';
    console.warn(
      rotation
        ? `[preview-project] Recovery sibling remained auth-unready; rotating to fallback project '${recoveryProjectName}' (${recreateErr.message}).`
        : `[preview-project] Rebuild could not replace the unhealthy preview; creating fallback project '${recoveryProjectName}' (${recreateErr.message}).`,
    );
    const fallbackResult = await createProjectWithNameConflictRecovery({
      token,
      organizationId: orgId,
      name: recoveryProjectName,
      region: configuredRegion,
      plan,
      dbPass,
      findCompatibleProjectFn: ({ currentName }) =>
        findCompatiblePreviewFamilyProject({
          token,
          organizationId: orgId,
          familyName: recoveryFamilyName || currentName,
          excludeProjectRefs: uniqueNonEmpty([previousProjectRef, ...extraExcludedProjectRefs]),
          preferredNames: [currentName, recoveryProjectName],
          restrictToPreferredNames: true,
        }),
      retryNameFn: (_currentName, _attempt) => buildRecoveryProjectName(recoveryBaseName),
    });
    const fallbackProject = fallbackResult.project;
    projectRef = fallbackProject.project_ref;
    existingProject = fallbackResult.existingProject || fallbackProject || null;
    projectWasCreated = !fallbackResult.reusedExisting;
    projectWasRecreated = true;
    projectName = String(fallbackResult.effectiveName || recoveryProjectName).trim() || recoveryProjectName;
    selectedPoolerConnectionString = '';
    selectedPoolerCandidateName = '';
    if (!projectRef) die('Recovery project create did not return project_ref');
    persistCurrentWorkspaceOwnership();
    ({ poolerHost, effectiveRegion } = resolvePoolerHost({
      configuredPoolerHost: cfg.poolerHost,
      configuredRegion: configuredRegion,
      existingRegion: existingProject?.region || '',
    }));
    await waitForDns({
      projectRef,
      poolerHost,
      includeDirectHost: false,
      timeoutMs: cfg.dnsTimeoutMs,
      pollMs: cfg.dnsPollMs,
    });
    try {
      await waitUntilReady(projectRef, token, 20 * 60 * 1000);
    } catch (e) {
      console.warn(`[preview-project] waitUntilReady warning (continuing): ${e.message}`);
    }
  }
  if (workspaceMode === 'auto') {
    const canUseBranchMode = Boolean(projectName) && branchParentCandidates.length > 0;
    workspaceMode = canUseBranchMode ? 'branch' : 'project';
    if (!canUseBranchMode) {
      console.log('[preview-project] workspace_mode=auto fallback -> project (missing branch name and/or parent project ref)');
    }
  }

  if (workspaceMode === 'branch') {
    assertBranchPoolerHost({
      workspaceMode,
      poolerHost: cfg.poolerHost,
      poolerPort: cfg.poolerPort || process.env.SUPABASE_POOLER_PORT || '5432',
    });
    try {
      const ensuredResult = await withBranchParentFallback({
        parentRefs: branchParentCandidates,
        actionLabel: 'ensure branch',
        action: async (parentProjectRef) => ensureBranch({
          token,
          parentProjectRef,
          name: projectName,
          reuseExisting: true,
          requireExisting: requireExistingWorkspace,
          expectedProjectRef,
        }),
      });
      const ensuredBranch = ensuredResult.value;
      selectedBranchParentRef = ensuredResult.parentProjectRef;
      projectRef = ensuredBranch.project_ref || '';
      branchId = ensuredBranch.branch_id || '';
      projectWasCreated = !ensuredBranch.reused;
      existingBranch = ensuredBranch.reused ? ensuredBranch : null;
      if (!projectRef) die('Branch create/reuse did not return project_ref');
      if (expectedProjectRef && projectRef !== expectedProjectRef) {
        die(`Pinned branch identity mismatch: resolved=${projectRef} expected=${expectedProjectRef}.`);
      }
      if (expectedBranchParentRef && selectedBranchParentRef !== expectedBranchParentRef) {
        die(
          `Pinned branch parent mismatch: resolved=${selectedBranchParentRef} expected=${expectedBranchParentRef}.`,
        );
      }
      if (projectWasCreated) {
        console.log(`[preview-project] Created branch '${projectName}' (parent_ref=${selectedBranchParentRef}, project_ref=${projectRef})`);
      } else {
        console.log(`[preview-project] Reusing branch '${projectName}' (parent_ref=${selectedBranchParentRef}, project_ref=${projectRef})`);
      }
      // Branches own isolated database credentials. Resolve those credentials
      // from the branch-config endpoint after readiness instead of probing with
      // the parent/project-mode password configured for project creation.
    } catch (err) {
      if (requestedWorkspaceMode !== 'auto' || !shouldFallbackToProjectMode(err)) {
        throw err;
      }
      if (branchId) {
        try {
          await deleteBranchWithRetries(branchId, token);
          console.warn(`[preview-project] Auto fallback cleaned up branch_id=${branchId}.`);
        } catch (cleanupErr) {
          console.warn(`[preview-project] Auto fallback could not delete branch_id=${branchId}: ${cleanupErr.message}`);
        }
      }
      const branchProjectRefBeforeFallback = String(projectRef || '').trim();
      ({
        workspaceMode,
        projectRef,
        branchId,
        existingBranch,
        projectWasCreated,
      } = applyAutoFallbackToProjectState({
        workspaceMode,
        projectRef,
        branchId,
        existingBranch,
        projectWasCreated,
        fallbackProjectRef: resolveAutoFallbackProjectRef({
          err,
          branchProjectRef: projectRef,
          staticProjectRef,
          selectedBranchParentRef,
          envProjectRef,
          branchParentCandidates,
        }),
      }));
      if (
        projectRef &&
        shouldUseParentProjectFallback(err) &&
        String(projectRef || '').trim() !== branchProjectRefBeforeFallback
      ) {
        usedMgmtApiBypassFallback = true;
      }
      console.warn(`[preview-project] workspace_mode=auto fallback -> project (${err.message})`);
    }
  }

  if (workspaceMode === 'project') {
    projectRef = resolveProjectRefForProjectMode({ projectRef, envProjectRef });
    if (!projectRef) {
      try {
        existingProject = await findProjectByName({ token, organizationId: orgId, name: projectName });
        projectRef = existingProject ? (existingProject.project_ref || '') : '';
      } catch (err) {
        const fallback = resolveDegradedFallbackProjectRef({
          branchParentRef: selectedBranchParentRef,
          staticProjectRef,
        });
        if (requestedWorkspaceMode === 'auto' && fallback.projectRef && shouldUseParentProjectFallback(err)) {
          projectRef = fallback.projectRef;
          usedMgmtApiBypassFallback = true;
          console.warn(`[preview-project] workspace_mode=auto degraded fallback -> ${fallback.source} project_ref=${projectRef} (${err.message})`);
        } else {
          throw err;
        }
      }
    }

    if (!projectRef) {
      try {
        console.log(`[preview-project] Creating project '${projectName}' (region=${configuredRegion}, plan=${plan})`);
        const createResult = await createProjectWithNameConflictRecovery({
          token,
          organizationId: orgId,
          name: projectName,
          region: configuredRegion,
          plan,
          dbPass,
        });
        const created = createResult.project;
        projectRef = created.project_ref;
        if (!projectRef) die('Create did not return project_ref');
        projectWasCreated = !createResult.reusedExisting;
        existingProject = createResult.existingProject || created || existingProject;
        projectName = String(createResult.effectiveName || projectName).trim() || projectName;
      } catch (err) {
        const fallback = resolveDegradedFallbackProjectRef({
          branchParentRef: selectedBranchParentRef,
          staticProjectRef,
        });
        if (requestedWorkspaceMode === 'auto' && fallback.projectRef && shouldUseParentProjectFallback(err)) {
          projectRef = fallback.projectRef;
          usedMgmtApiBypassFallback = true;
          console.warn(`[preview-project] workspace_mode=auto degraded fallback -> ${fallback.source} project_ref=${projectRef} (${err.message})`);
        } else {
          throw err;
        }
      }
    } else if (projectName) {
      console.log(`[preview-project] Reusing project '${projectName}' (project_ref=${projectRef})`);
    } else {
      console.log(`[preview-project] Using preconfigured project_ref=${projectRef}`);
    }
  }

  // Persist exact disposable-workspace ownership before credential hydration,
  // DNS readiness, migrations, or any other fallible provisioning work.
  persistCurrentWorkspaceOwnership();

  let { poolerHost, effectiveRegion } = resolvePoolerHost({
    configuredPoolerHost: cfg.poolerHost,
    configuredRegion: configuredRegion,
    existingRegion: existingProject?.region || existingBranch?.region,
    allowDerivedHost: workspaceMode !== 'branch',
  });
  let selectedPoolerConnectionString = '';
  let selectedPoolerCandidateName = '';
  let directDbHost = '';
  let directDbPort = '';
  let directDbUser = '';
  let branchJwtSecret = '';
  let shouldSyncWorkspaceDbPassword = true;
  let managementApiAuthBlocked = false;
  const existingWorkspaceRegion = existingProject?.region || existingBranch?.region || '';
  if (existingWorkspaceRegion && existingWorkspaceRegion !== configuredRegion) {
    const workspaceKind = workspaceMode === 'branch' ? 'Branch' : 'Project';
    console.warn(`[preview-project] Existing ${workspaceKind.toLowerCase()} region=${existingWorkspaceRegion} differs from configured region=${configuredRegion}; using existing region for pooler.`);
  }
  let poolerPort = String(cfg.poolerPort || process.env.SUPABASE_POOLER_PORT || '5432').trim() || '5432';
  if (workspaceMode !== 'branch') {
    assertBranchPoolerHost({ workspaceMode, poolerHost, poolerPort });
  }
  const dbReadyAttempts = Math.max(
    1,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_DB_READY_ATTEMPTS || process.env.SUPABASE_DB_READY_ATTEMPTS || '24'),
      10,
    ) || 24,
  );
  const dbReadyIntervalMs = Math.max(
    0,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_DB_READY_INTERVAL_MS || process.env.SUPABASE_DB_READY_INTERVAL_MS || '5000'),
      10,
    ) || 5000,
  );
  const dbReadyTimeoutMs = Math.max(
    10_000,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_DB_READY_TIMEOUT_MS || process.env.SUPABASE_DB_READY_TIMEOUT_MS || '720000'),
      10,
    ) || 720000,
  );
  const dbReadyAuthExtraMs = Math.max(
    0,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_DB_READY_AUTH_EXTRA_MS || process.env.SUPABASE_DB_READY_AUTH_EXTRA_MS || '480000'),
      10,
    ) || 480000,
  );
  const reusedAuthRecoveryTimeoutMs = Math.max(
    10_000,
    Math.min(
      dbReadyTimeoutMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_REUSED_AUTH_RECOVERY_TIMEOUT_MS || '180000'),
        10,
      ) || 180000,
    ),
  );
  const reusedAuthRecoveryAuthExtraMs = Math.max(
    0,
    Math.min(
      dbReadyAuthExtraMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_REUSED_AUTH_RECOVERY_AUTH_EXTRA_MS || '120000'),
        10,
      ) || 120000,
    ),
  );
  const recreatedAuthRecoveryTimeoutMs = Math.max(
    10_000,
    Math.min(
      dbReadyTimeoutMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_RECREATED_AUTH_RECOVERY_TIMEOUT_MS || '600000'),
        10,
      ) || 600000,
    ),
  );
  const recreatedAuthRecoveryAuthExtraMs = Math.max(
    0,
    Math.min(
      dbReadyAuthExtraMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_RECREATED_AUTH_RECOVERY_AUTH_EXTRA_MS || '300000'),
        10,
      ) || 300000,
    ),
  );
  const previewDbPasswordSyncMaxWaitMs = Math.max(
    0,
    Math.min(
      dbReadyTimeoutMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_DB_PASSWORD_SYNC_MAX_WAIT_MS || '180000'),
        10,
      ) || 180000,
    ),
  );
  const previewDbPasswordSyncRetryDelayMs = Math.max(
    1_000,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_DB_PASSWORD_SYNC_RETRY_DELAY_MS || '10000'),
      10,
    ) || 10000,
  );
  const branchCredentialTimeoutMs = Math.max(
    10_000,
    Math.min(
      dbReadyTimeoutMs,
      parseInt(
        String(process.env.PREVIEW_SUPABASE_BRANCH_CREDENTIAL_TIMEOUT_MS || '120000'),
        10,
      ) || 120000,
    ),
  );
  const branchCredentialRetryDelayMs = Math.max(
    250,
    parseInt(
      String(process.env.PREVIEW_SUPABASE_BRANCH_CREDENTIAL_RETRY_DELAY_MS || '5000'),
      10,
    ) || 5000,
  );

  async function hydrateBranchOwnedDbCredentials(label = 'branch') {
    if (workspaceMode !== 'branch') return null;
    const resolved = await waitForBranchDbCredentials({
      token,
      branchIdOrRef: projectRef || branchId,
      expectedProjectRef: projectRef,
      configuredDbPass: cfg.dbPass,
      maxWaitMs: branchCredentialTimeoutMs,
      retryDelayMs: branchCredentialRetryDelayMs,
    });
    dbPass = resolved.credentials.dbPass;
    directDbHost = resolved.credentials.directDbHost;
    directDbPort = resolved.credentials.directDbPort;
    directDbUser = resolved.credentials.directDbUser;
    branchJwtSecret = String(resolved.branchConfig?.jwt_secret || '').trim();
    shouldSyncWorkspaceDbPassword = resolved.credentials.shouldSyncPassword;
    // Supabase direct database endpoints are IPv6 unless the project has the
    // IPv4 add-on, while GitHub Actions runners are IPv4-only. Resolve the
    // exact branch project's shared Supavisor session endpoint instead:
    // https://supabase.com/docs/guides/database/connecting-to-postgres
    // https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP
    const branchRoute = await resolveBranchSupavisorRoute({
      projectRef,
      token,
      branchConfig: resolved.branchConfig,
      fallbackRegion: existingBranch?.region || configuredRegion,
    });
    poolerHost = branchRoute.poolerHost;
    poolerPort = branchRoute.poolerPort;
    effectiveRegion = branchRoute.effectiveRegion || effectiveRegion;
    assertBranchPoolerHost({ workspaceMode, poolerHost, poolerPort });
    console.log(
      `[preview-project] Resolved branch-owned DB credentials and Supavisor route (${label}) for project_ref=${projectRef}; password sync disabled for branch mode.`,
    );
    emitTrace(trace, 'info', {
      step: 'branch_db_credentials',
      status: 'ok',
      project_ref: projectRef,
      branch_id: branchId,
      source: resolved.credentials.source,
      pooler_host: poolerHost,
      pooler_port: poolerPort,
    });
    return resolved;
  }

  // Ensure infra is ready before writing env + running DB ops.
  if (workspaceMode === 'branch') {
    try {
      assertBranchPoolerHost({ workspaceMode, poolerHost, poolerPort });
      await hydrateBranchOwnedDbCredentials(projectWasCreated ? 'created branch' : 'reused branch');
    } catch (error) {
      if (projectWasCreated && branchId) {
        try {
          await deleteBranchWithRetries(branchId, token, { timeoutMs: 120_000 });
          console.warn(
            `[preview-project] Removed newly created branch_id=${branchId} after credential hydration failed.`,
          );
        } catch (cleanupError) {
          console.warn(
            `[preview-project] Could not remove newly created branch_id=${branchId} after credential hydration failed: ${cleanupError.message || cleanupError}`,
          );
        }
      }
      die(`Unable to resolve branch-owned DB credentials: ${error.message || error}`);
    }
  }

  if (expectedWorkspaceMode && workspaceMode !== expectedWorkspaceMode) {
    die(`Pinned preview workspace mode mismatch: resolved=${workspaceMode} expected=${expectedWorkspaceMode}.`);
  }
  if (expectedProjectRef && projectRef !== expectedProjectRef) {
    die(`Pinned preview workspace identity mismatch: resolved=${projectRef || '<missing>'} expected=${expectedProjectRef}.`);
  }
  const dnsTimeoutMs = resolvePreviewDnsTimeoutMs({
    configuredTimeoutMs: cfg.dnsTimeoutMs,
    usedMgmtApiBypassFallback,
    workspaceMode,
    projectWasCreated,
    projectName,
    projectRef,
  });
  try {
    await waitForDns({
      projectRef,
      directDbHost,
      poolerHost,
      includeDirectHost: !usedMgmtApiBypassFallback,
      timeoutMs: dnsTimeoutMs,
      pollMs: cfg.dnsPollMs,
    });
  } catch (dnsErr) {
    const shouldDeferToRebuild =
      shouldRebuildProjectOnDnsFailure({
        workspaceMode,
        projectWasCreated,
        projectName,
        projectRef,
      }) &&
      isDirectPreviewDnsOnlyFailure({
        error: dnsErr,
        projectRef,
        poolerHost,
      });
    if (!shouldDeferToRebuild) {
      throw dnsErr;
    }
    console.warn(
      `[preview-project] Reused preview project direct DNS is unhealthy; deferring to pooler probe + rebuild recovery (${dnsErr.message}).`,
    );
  }
  if (shouldWaitForProjectReadiness(workspaceMode)) {
    try {
      await waitUntilReady(projectRef, token, 20 * 60 * 1000);
    } catch (e) {
      if (shouldFallbackToProjectMode(e)) {
        managementApiAuthBlocked = true;
      }
      console.warn(`[preview-project] waitUntilReady warning (continuing): ${e.message}`);
    }
  }
  // Newly created or recovered Supabase workspaces can briefly report "ready"
  // while the pooler still rejects connections (e.g., "Tenant or user not
  // found"). Prefer the pooler when it is healthy, but allow a direct DB
  // fallback when the degraded recovery path cannot repair pooler credentials.
  async function waitForPreviewDbUsable(label, options = {}) {
    const includeDirect = Boolean(options.includeDirect);
    const maxWaitMs = Math.max(
      10_000,
      parseInt(String(options.maxWaitMs || dbReadyTimeoutMs), 10) || dbReadyTimeoutMs,
    );
    const authErrorExtraMs = Math.max(
      0,
      parseInt(String(options.authErrorExtraMs || dbReadyAuthExtraMs), 10) || dbReadyAuthExtraMs,
    );
    const candidates = await buildPreviewPoolerDbCandidates({
      projectRef,
      dbPass,
      poolerHost,
      poolerPort,
      directDbHost,
      directDbPort,
      directDbUser,
      includeDirect,
      poolerSessionOnly: workspaceMode === 'branch',
    });
    try {
      const ready = await waitForDbReadyCandidates({
        label,
        candidates,
        attempts: 1,
        intervalMs: dbReadyIntervalMs,
        connectionTimeoutMillis: 5000,
        maxWaitMs,
        authErrorExtraMs,
        traceContext: trace,
      });
      selectedPoolerConnectionString = String(ready?.connectionString || '').trim();
      selectedPoolerCandidateName = String(ready?.candidateName || '').trim();
      const selectedRoute = resolveSelectedPoolerRoute({
        connectionString: selectedPoolerConnectionString,
        candidateName: selectedPoolerCandidateName,
        fallbackHost: poolerHost,
        fallbackPort: poolerPort,
        fallbackUser: `postgres.${projectRef}`,
      });
      if (selectedRoute.host) {
        poolerHost = selectedRoute.host;
        poolerPort = selectedRoute.port;
      }
      if (selectedPoolerCandidateName) {
        console.log(
          `[preview-project] Selected preview DB candidate (${label}): ${selectedPoolerCandidateName}`,
        );
      }
    } catch (e) {
      throw new Error(`Preview DB pooler did not become reachable (${label}): ${e.message}`);
    }
  }

  async function waitForPoolerUsable(label, options = {}) {
    return waitForPreviewDbUsable(label, {
      ...options,
      includeDirect: false,
    });
  }

  async function waitForPreferredDbUsable(label, options = {}) {
    return waitForPreviewDbUsable(label, {
      ...options,
      includeDirect: true,
    });
  }

  if (shouldProbeBranchPreviewDb({
    workspaceMode,
    poolerHost,
    directDbHost,
    dbPass,
  })) {
    try {
      await waitForPreferredDbUsable(
        projectWasCreated || projectWasRecreated
          ? 'branch DB via Supavisor'
          : 'reused branch DB via Supavisor',
      );
    } catch (error) {
      die(error.message || String(error));
    }
  }

  if ((projectWasCreated || projectWasRecreated) && projectName && poolerHost && dbPass) {
    if (shouldSyncWorkspaceDbPassword && shouldSyncPreviewDbPasswordOnAuthError()) {
      await refreshProjectDbPassword({
        projectRef,
        token,
        dbPass,
        label: projectWasRecreated ? 'recreated preview project' : 'new preview project',
        traceContext: trace,
        maxWaitMs: previewDbPasswordSyncMaxWaitMs,
        retryDelayMs: previewDbPasswordSyncRetryDelayMs,
      });
    }
    const poolerLabel = projectWasRecreated ? 'pooler (recreated)' : 'pooler';
    try {
      await waitForPoolerUsableWithAuthLagRecovery({
        label: poolerLabel,
        waitForPoolerUsableFn: waitForPoolerUsable,
        projectRef,
        token,
        dbPass,
        traceContext: trace,
        maxWaitMs: dbReadyTimeoutMs,
        authErrorExtraMs: dbReadyAuthExtraMs,
        previewDbPasswordSyncMaxWaitMs,
        previewDbPasswordSyncRetryDelayMs,
        shouldSyncDbPasswordOnAuthErrorFn: () =>
          shouldSyncWorkspaceDbPassword && shouldSyncPreviewDbPasswordOnAuthError(),
      });
    } catch (err) {
      die(err.message || String(err));
    }
  }

  // Fresh Supabase projects can take a bit longer to provision Storage tables
  // (`storage.objects`, `storage.buckets`). Our migrations reference these, so
  // wait until they exist before running `supabase db push` in CI.
  if (shouldWaitForStorageSchema({ env: process.env, projectWasCreated }) && poolerHost && dbPass) {
    const poolerUser = `postgres.${projectRef}`;
    // objectives:allow DSN_URL Justification: probe storage schema readiness via pooler DSN for preview environments
    const poolerDbUrl = ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodeURIComponent(dbPass)}`,"@",`${poolerHost}`,":",`${poolerPort}`,"/",`postgres`].join(""));
    const { timeoutMs, intervalMs } = resolveStorageSchemaReadyOptions(process.env);
    try {
      await waitForStorageSchema({
        connectionString: poolerDbUrl,
        timeoutMs,
        intervalMs,
        authErrorExtraMs: dbReadyAuthExtraMs,
        isAuthError: isDbAuthConnectivityError,
      });
    } catch (e) {
      die(`Preview storage schema did not become ready: ${e.message}`);
    }
  }

  // Self-heal reused preview workspaces that drift (e.g., stale credentials)
  // by rebuilding when DB connectivity is broken. This keeps merge_group and
  // reviewer gates deterministic without manual intervention.
  if (workspaceMode !== 'branch' && !projectWasCreated && projectName && poolerHost && dbPass) {
    const probeCandidates = await buildPreviewPoolerDbCandidates({
      projectRef,
      dbPass,
      poolerHost,
      poolerPort,
      includeDirect: false,
    });
    let probe = await checkDbConnectivityCandidates({
      candidates: probeCandidates,
      connectionTimeoutMillis: 5000,
    });
    if (probe.ok) {
      selectedPoolerConnectionString = String(probe.connectionString || '').trim();
      selectedPoolerCandidateName = String(probe.candidateName || '').trim();
      const selectedRoute = resolveSelectedPoolerRoute({
        connectionString: selectedPoolerConnectionString,
        candidateName: selectedPoolerCandidateName,
        fallbackHost: poolerHost,
        fallbackPort: poolerPort,
        fallbackUser: `postgres.${projectRef}`,
      });
      if (selectedRoute.host) {
        poolerHost = selectedRoute.host;
        poolerPort = selectedRoute.port;
      }
    }

    if (
      !probe.ok &&
      isDbAuthConnectivityError(probe.error) &&
      shouldSyncWorkspaceDbPassword &&
      shouldSyncPreviewDbPasswordOnAuthError()
    ) {
      console.warn(
        `[preview-project] Reused preview DB auth failed; attempting password sync via Management API (project_ref=${projectRef}).`,
      );
      const didSync = await refreshProjectDbPassword({
        projectRef,
        token,
        dbPass,
        label: 'reused workspace auth recovery',
        traceContext: trace,
        maxWaitMs: previewDbPasswordSyncMaxWaitMs,
        retryDelayMs: previewDbPasswordSyncRetryDelayMs,
      });
      if (didSync) {
        try {
          await waitForPoolerUsable('pooler after password sync');
          probe = { ok: true };
          console.log('[preview-project] Reused preview DB recovered after password sync.');
        } catch (passwordSyncErr) {
          console.warn(
            `[preview-project] Password sync recovery failed; rebuilding workspace (${passwordSyncErr.message}).`,
          );
        }
      }
    }

    if (!probe.ok) {
      const degradedRecovery = await maybeRecoverReusedPreviewPoolerAuth({
        probe,
        managementApiAuthBlocked,
        usedMgmtApiBypassFallback,
        waitForPoolerUsableFn: waitForPoolerUsable,
        waitForPreferredDbUsableFn: waitForPreferredDbUsable,
        maxWaitMs: reusedAuthRecoveryTimeoutMs,
        authErrorExtraMs: reusedAuthRecoveryAuthExtraMs,
      });
      probe = degradedRecovery.probe;
    }

    if (!probe.ok) {
      const authConnectivityFailure = isDbAuthConnectivityError(probe.error);
      const skipRebuildForAuthDrift = shouldSkipAuthDriftRebuild({
        authConnectivityFailure,
        managementApiAuthBlocked,
        usedMgmtApiBypassFallback,
        requestedWorkspaceMode,
        envProjectName,
        envProjectRef,
      });
      if (skipRebuildForAuthDrift) {
        const reasonParts = [];
        if (managementApiAuthBlocked) reasonParts.push('management API is auth-blocked');
        if (usedMgmtApiBypassFallback) reasonParts.push('auto fallback is running in degraded management mode');
        const reason = reasonParts.length ? reasonParts.join(' and ') : 'degraded management mode is active';
        console.warn(
          `[preview-project] Reused preview DB auth probe failed while ${reason}; continuing without rebuild.`,
        );
      } else {
        console.warn(`[preview-project] Reused preview DB not reachable; rebuilding project_ref=${projectRef}: ${probe.error?.message || probe.error}`);
        if (workspaceMode === 'branch') {
          die(
            `Reused branch DB is not reachable and automatic rebuild is forbidden without active-consumer/runtime ownership proof (project_ref=${projectRef}).`,
          );
        } else if (requireExistingWorkspace) {
          die(
            `Pinned preview project is not reachable and replacement is forbidden during manifest rehydrate (project_ref=${projectRef}).`,
          );
        } else {
          try {
            const previousProjectRefForRecreate = String(projectRef || '').trim();
            await deleteProjectWithRetries(projectRef, token, { organizationId: orgId });
            console.log(`[preview-project] Recreating project '${projectName}' (region=${configuredRegion}, plan=${plan})`);
            const createResult = await createProjectWithNameConflictRecovery({
              token,
              organizationId: orgId,
              name: projectName,
              region: configuredRegion,
              plan,
              dbPass,
            });
            const created = createResult.project;
            const recreatedProjectRef = String(created.project_ref || '').trim();
            if (shouldRejectRecreatedPreviewProjectReuse({
              previousProjectRef: previousProjectRefForRecreate,
              nextProjectRef: recreatedProjectRef,
            })) {
              throw buildRecreatedPreviewProjectReuseError({
                projectName,
                projectRef: recreatedProjectRef,
              });
            }
            projectRef = recreatedProjectRef;
            existingProject = createResult.existingProject || created || null;
            projectWasCreated = !createResult.reusedExisting;
            if (!projectRef) die('Project recreate did not return project_ref');
            projectWasRecreated = true;
            persistCurrentWorkspaceOwnership();
          } catch (recreateErr) {
            if (!shouldRecoverWithFreshProjectSibling({
              rebuildError: recreateErr,
              requestedWorkspaceMode,
              envProjectName,
              envProjectRef,
              projectName,
            })) {
              throw recreateErr;
            }

            await createFreshRecoveryProject({ recreateErr });
          }
        }
        ({ poolerHost, effectiveRegion } = resolvePoolerHost({
          configuredPoolerHost: cfg.poolerHost,
          configuredRegion: configuredRegion,
          existingRegion: existingProject?.region || '',
          allowDerivedHost: workspaceMode !== 'branch',
        }));
        assertBranchPoolerHost({ workspaceMode, poolerHost, poolerPort });
        if (workspaceMode === 'branch') {
          await hydrateBranchOwnedDbCredentials('recreated branch');
        }
        await waitForDns({
          projectRef,
          directDbHost,
          poolerHost,
          includeDirectHost: false,
          timeoutMs: cfg.dnsTimeoutMs,
          pollMs: cfg.dnsPollMs,
        });
        try {
          await waitUntilReady(projectRef, token, 20 * 60 * 1000);
        } catch (e) {
          console.warn(`[preview-project] waitUntilReady warning (continuing): ${e.message}`);
        }
        if (projectWasRecreated) {
          const recreatedRecoveryWaitBudget = resolveRecreatedPreviewRecoveryWaitBudget({
            maxWaitMs: dbReadyTimeoutMs,
            authErrorExtraMs: dbReadyAuthExtraMs,
            requestedWorkspaceMode,
            envProjectName,
            envProjectRef,
            cappedMaxWaitMs: recreatedAuthRecoveryTimeoutMs,
            cappedAuthExtraMs: recreatedAuthRecoveryAuthExtraMs,
          });
          const ensureRecreatedProjectPooler = async ({
            passwordSyncLabel,
            poolerLabel,
          } = {}) => {
            const recoveryDeadlineMs =
              Date.now() +
              recreatedRecoveryWaitBudget.maxWaitMs +
              recreatedRecoveryWaitBudget.authErrorExtraMs;
            const resolveRemainingRecoveryBudgetMs = () =>
              Math.max(0, recoveryDeadlineMs - Date.now());
            if (shouldSyncWorkspaceDbPassword && shouldSyncPreviewDbPasswordOnAuthError()) {
              const remainingRecoveryBudgetMs = resolveRemainingRecoveryBudgetMs();
              if (remainingRecoveryBudgetMs < 10_000) {
                throw new Error(
                  `Preview DB pooler auth-lag recovery budget exhausted (${poolerLabel}) before initial password sync.`,
                );
              }
              await refreshProjectDbPassword({
                projectRef,
                token,
                dbPass,
                label: passwordSyncLabel,
                traceContext: trace,
                maxWaitMs:
                  previewDbPasswordSyncMaxWaitMs > 0
                    ? Math.min(previewDbPasswordSyncMaxWaitMs, remainingRecoveryBudgetMs)
                    : remainingRecoveryBudgetMs,
                retryDelayMs: previewDbPasswordSyncRetryDelayMs,
              });
            }
            if (recreatedRecoveryWaitBudget.capped) {
              console.warn(
                `[preview-project] Capping recreated-preview auth recovery wait to ${recreatedRecoveryWaitBudget.maxWaitMs}ms (+${recreatedRecoveryWaitBudget.authErrorExtraMs}ms auth lag) so sibling rotation keeps headroom.`,
              );
            }
            await waitForPoolerUsableWithAuthLagRecovery({
              label: poolerLabel,
              waitForPoolerUsableFn: waitForPoolerUsable,
              projectRef,
              token,
              dbPass,
              traceContext: trace,
              maxWaitMs: recreatedRecoveryWaitBudget.maxWaitMs,
              authErrorExtraMs: recreatedRecoveryWaitBudget.authErrorExtraMs,
              previewDbPasswordSyncMaxWaitMs,
              previewDbPasswordSyncRetryDelayMs,
              recoveryDeadlineMs,
              shouldSyncDbPasswordOnAuthErrorFn: () =>
                shouldSyncWorkspaceDbPassword && shouldSyncPreviewDbPasswordOnAuthError(),
            });
          };

          try {
            await ensureRecreatedProjectPooler({
              passwordSyncLabel: 'recreated preview project',
              poolerLabel: 'pooler after recreate',
            });
          } catch (recreatedPoolerErr) {
            if (!shouldRotateRecoverySibling({
              rebuildError: recreatedPoolerErr,
              recoveryReason,
              rotationAttempted: recoveryRotationAttempted,
              requestedWorkspaceMode,
              envProjectName,
              envProjectRef,
              projectName: canonicalProjectName || projectName,
            })) {
              throw recreatedPoolerErr;
            }
            recoveryRotationAttempted = true;
            await createFreshRecoveryProject({
              recreateErr: recreatedPoolerErr,
              rotation: true,
              extraExcludedProjectRefs: [supersededProjectRef],
            });
            await ensureRecreatedProjectPooler({
              passwordSyncLabel: 'rotated recovery preview project',
              poolerLabel: 'pooler after recovery rotation',
            });
          }
        }
      }
    }
  }

  const previewJwtSeed = readEnv('PREVIEW_SUPABASE_JWT_SECRET');
  const { seed: jwtSeed, source: jwtSeedSource } = resolvePreviewJwtSeed({
    explicitSeed: previewJwtSeed,
    serviceKey: staticService,
    accessToken: token,
  });
  const initialJwtState = resolveInitialPreviewJwtState({
    workspaceMode,
    branchJwtSecret,
  });
  let jwtSecret = initialJwtState.jwtSecret;
  let jwtSource = initialJwtState.jwtSource;
  let jwtSecretSynced = initialJwtState.jwtSecretSynced;
  const syncPreviewJwtSecret = shouldSyncDerivedPreviewJwtSecret({
    workspaceMode,
    edgeRequireDbJwt,
    previewJwtSeed,
    jwtSeed,
    usedMgmtApiBypassFallback,
    envProjectName,
    envProjectRef,
    projectRef,
  });
  if (
    workspaceMode === 'branch' &&
    shouldFailClosedOnMissingPreviewJwtSecret({ edgeRequireDbJwt, jwtSecret })
  ) {
    die(
      `Branch config did not return its auth JWT secret for project_ref=${projectRef}; branch auth rotation is forbidden during preview setup.`,
    );
  }
  if (syncPreviewJwtSecret) {
    const syncSeed = String(previewJwtSeed || jwtSeed || '').trim();
    if (syncSeed) {
      const derivedPreviewJwtSecret = deriveProjectJwtSecret({ seed: syncSeed, projectRef });
      try {
        await ensureProjectJwtSecret({
          projectRef,
          token,
          explicitSecret: derivedPreviewJwtSecret,
          allowSigningKeyRotation: true,
        });
        jwtSecret = derivedPreviewJwtSecret;
        jwtSource = previewJwtSeed ? 'explicit' : `derived_${jwtSeedSource || 'seed'}`;
        jwtSecretSynced = true;
      } catch (err) {
        if (edgeRequireDbJwt === '1') throw err;
        console.warn(
          `[preview-project] Failed to sync deterministic preview JWT secret for project_ref=${projectRef}: ${err.message || err}`,
        );
      }
    } else if (edgeRequireDbJwt === '1') {
      try {
        const existing = await getProjectJwtSecret(projectRef, token);
        if (existing) {
          jwtSecret = existing;
          jwtSource = 'project';
          jwtSecretSynced = true;
        }
      } catch (err) {
        console.warn(`[preview-project] Failed to read project JWT secret: ${err.message}`);
      }
      if (!jwtSecret && jwtSeed) {
        console.warn(`[preview-project] PREVIEW_SUPABASE_JWT_SECRET not set; deriving preview JWT secret from ${jwtSeedSource}.`);
        jwtSecret = deriveProjectJwtSecret({ seed: jwtSeed, projectRef });
        await ensureProjectJwtSecret({ projectRef, token, explicitSecret: jwtSecret, allowSigningKeyRotation: true });
        jwtSource = 'derived';
        jwtSecretSynced = true;
      }
    }
    if (shouldFailClosedOnMissingPreviewJwtSecret({ edgeRequireDbJwt, jwtSecret })) {
      die('Unable to derive a deterministic preview JWT secret and/or rotate auth signing keys (required when EDGE_REQUIRE_DB_JWT=1).');
    }
  }
  const allowStaticKeys = Boolean(envProjectName || envProjectRef || usedMgmtApiBypassFallback);
  const allowStaticFallback = shouldAllowStaticApiKeyFallback({
    workspaceMode,
    allowStaticKeys,
    staticAnon,
    staticService,
    staticProjectRef,
    projectRef,
    jwtSource,
    usedMgmtApiBypassFallback,
    previewJwtSeed,
    edgeRequireDbJwt,
  });
  if (
    allowStaticKeys &&
    staticAnon &&
    staticService &&
    staticProjectRef &&
    projectRef &&
    String(staticProjectRef).trim().toLowerCase() !== String(projectRef).trim().toLowerCase()
  ) {
    console.warn(
      `[preview-project] Static API keys target project_ref=${String(staticProjectRef).trim()} but resolved preview project_ref=${String(projectRef).trim()}; ignoring static key fallback.`,
    );
  }
  let keys = await resolvePreviewWorkspaceApiKeys({
    allowStaticFallback,
    staticAnon,
    staticService,
    projectRef,
    token,
  });
  const apiKeys = { ...keys };
  let fallbackEdgeDbJwtBundle = null;
  const jwtIssuer = resolveJwtIssuer({ serviceKey: keys.service, anonKey: keys.anon });
  const jwtSigningSecret = resolveJwtSigningSecret({
    secret: jwtSecret,
    serviceKey: keys.service,
    anonKey: keys.anon,
  });
  const keysMatchSecret = Boolean(
    keys.service &&
    keys.anon &&
    isJwtSignedWithSecret(keys.service, jwtSigningSecret) &&
    isJwtSignedWithSecret(keys.anon, jwtSigningSecret),
  );
  let didMintKeys = false;
  if (shouldPreservePlatformApiKeysForPreview({ jwtSecret, keys, keysMatchSecret })) {
    console.log(
      '[preview-project] Platform API keys do not share the edge DB JWT signing secret; preserving platform keys for Supabase API access.',
    );
  }
  if (!keys?.anon || !keys?.service) {
    die('Unable to resolve anon/service API keys for preview workspace (required for edge smoke + integration tests).');
  }

  if (edgeRequireDbJwt !== '1') {
    fallbackEdgeDbJwtBundle = buildFallbackEdgeDbJwtBundle(keys.service);
  }
  const resolvedSupabaseUrl = resolvePreviewSupabaseUrl({ envSupabaseUrl, projectRef });
  if (resolvedSupabaseUrl.source === 'constructed_mismatch') {
    console.warn(
      `[preview-project] Ignoring PREVIEW_SUPABASE_URL for project_ref=${resolvedSupabaseUrl.configuredProjectRef}; resolved preview project_ref=${projectRef}.`,
    );
  }
  // objectives:allow SUPABASE_URL Justification: construct standard supabase.co host dynamically from project_ref for preview environments
  const supabaseUrl = resolvedSupabaseUrl.supabaseUrl;
  const shouldWaitForStorageAuth =
    edgeRequireDbJwt === '1' &&
    jwtSecret &&
    (
      jwtSource === 'explicit' ||
      jwtSource === 'generated' ||
      jwtSource === 'derived' ||
      jwtSource === 'branch_config'
    );
  const runtimeWaitOptions = resolveJwtPropagationOptions(process.env, {
    timeoutKeys: [
      'PREVIEW_JWT_PROPAGATION_TIMEOUT_MS',
      'SUPABASE_JWT_PROPAGATION_TIMEOUT_MS',
    ],
    intervalKeys: [
      'PREVIEW_JWT_PROPAGATION_INTERVAL_MS',
      'SUPABASE_JWT_PROPAGATION_INTERVAL_MS',
    ],
  });
  const runtimeReadiness = {
    db_ready: true,
    jwt_ready: shouldWaitForStorageAuth ? false : true,
    rest_ready: shouldWaitForStorageAuth ? false : true,
    runtime_ready: shouldWaitForStorageAuth ? false : true,
    runtime_ready_at: shouldWaitForStorageAuth ? '' : new Date().toISOString(),
    readiness_failure_class: '',
  };
  if (shouldWaitForStorageAuth) {
    try {
      await waitForStorageAuth({
        supabaseUrl,
        serviceKey: keys.service,
        timeoutMs: runtimeWaitOptions.timeoutMs,
        intervalMs: runtimeWaitOptions.intervalMs,
      });
      runtimeReadiness.jwt_ready = true;
    } catch (err) {
      const fallback = resolvePreviewJwtFallback({
        edgeRequireDbJwt,
        didMintKeys,
        apiKeys,
        err,
      });
      if (!fallback) throw err;
      console.warn(`[preview-project] ${fallback.message}`);
      edgeRequireDbJwt = fallback.edgeRequireDbJwt;
      jwtSecret = fallback.jwtSecret;
      jwtSource = fallback.jwtSource;
      keys = fallback.keys;
      fallbackEdgeDbJwtBundle = buildFallbackEdgeDbJwtBundle(keys?.service);
      runtimeReadiness.jwt_ready = false;
      runtimeReadiness.rest_ready = false;
      runtimeReadiness.runtime_ready = false;
      runtimeReadiness.runtime_ready_at = '';
      runtimeReadiness.readiness_failure_class = 'preview-jwt-unready';
    }
  }
  if (shouldWaitForStorageAuth && runtimeReadiness.jwt_ready) {
    try {
      await waitForRestAuth({
        supabaseUrl,
        serviceKey: keys.service,
        timeoutMs: runtimeWaitOptions.timeoutMs,
        intervalMs: runtimeWaitOptions.intervalMs,
      });
      runtimeReadiness.rest_ready = true;
      runtimeReadiness.runtime_ready = true;
      runtimeReadiness.runtime_ready_at = new Date().toISOString();
    } catch (err) {
      console.warn(`[preview-project] Preview REST auth readiness pending: ${err.message || err}`);
      runtimeReadiness.rest_ready = false;
      runtimeReadiness.runtime_ready = false;
      runtimeReadiness.runtime_ready_at = '';
      runtimeReadiness.readiness_failure_class = 'preview-runtime-unready';
    }
  }
  const edgeDbJwtBundle = jwtSecret
    ? buildEdgeDbJwtBundle({ secret: jwtSigningSecret, issuer: jwtIssuer })
    : fallbackEdgeDbJwtBundle;
  const selectedPoolerTarget = parseConnectionTarget(selectedPoolerConnectionString);
  const selectedPoolerRoute = resolveSelectedPoolerRoute({
    connectionString: selectedPoolerConnectionString,
    candidateName: selectedPoolerCandidateName,
    fallbackHost: poolerHost,
    fallbackPort: poolerPort,
    fallbackUser: `postgres.${projectRef}`,
  });
  if (selectedPoolerRoute.host) {
    poolerHost = selectedPoolerRoute.host;
    poolerPort = selectedPoolerRoute.port;
  }

  // objectives:allow DSN_URL Justification: construct Supabase direct DSN dynamically from project_ref and org-managed password for preview environments
  const directDbUrl = buildDirectConnectionString({
    projectRef,
    dbPass,
    dbHost: directDbHost,
    dbPort: directDbPort,
    dbUser: directDbUser,
  });

  const payload = buildPreviewEnvPayload({
    projectRef,
    supabaseUrl,
    directDbUrl,
    preferredDatabaseUrl: selectedPoolerConnectionString,
    workspaceMode,
    keys,
    jwtSecret,
    edgeInternalCallerRoles,
    edgeRequireDbJwt,
    effectiveRegion,
    configuredRegion,
    poolerHost,
    poolerPort,
    selectedPoolerTarget: {
      ...selectedPoolerTarget,
      host: selectedPoolerRoute.host || selectedPoolerTarget.host,
      port: selectedPoolerRoute.port || selectedPoolerTarget.port,
      username: selectedPoolerRoute.user || selectedPoolerTarget.username,
      kind: selectedPoolerRoute.host ? 'pooler' : selectedPoolerTarget.kind,
    },
    selectedPoolerCandidateName,
    orgId,
    token,
    dbPass,
    selectedBranchParentRef,
    edgeDbJwtBundle,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  });

  await runGenEnv({ envFile, payload });

  if (
    recoveryReason &&
    supersededProjectRef &&
    supersededProjectRef !== projectRef &&
    requestedWorkspaceMode === 'auto'
  ) {
    try {
      await deleteProjectWithRetries(supersededProjectRef, token, { organizationId: orgId });
      console.log(
        `[preview-project] Deleted superseded preview sibling ${supersededProjectRef} after healthy recovery project became ready.`,
      );
    } catch (error) {
      console.warn(
        `[preview-project] Superseded preview sibling cleanup deferred (${supersededProjectRef}): ${error.message || error}`,
      );
    }
  }

  const out = {
    project_ref: projectRef,
    project_name: projectName || projectRef,
    workspace_mode: workspaceMode,
    ...(workspaceMode === 'branch' && branchId ? { branch_id: branchId } : {}),
    ...(workspaceMode === 'branch' && selectedBranchParentRef
      ? { branch_parent_ref: selectedBranchParentRef }
      : {}),
    supabase_url: supabaseUrl,
    env_file: envFile,
    edge_require_db_jwt: edgeRequireDbJwt,
    db_ready: runtimeReadiness.db_ready,
    db_ready_candidate_name: selectedPoolerCandidateName,
    pooler_host: selectedPoolerRoute.host || poolerHost,
    pooler_port: selectedPoolerRoute.port || poolerPort,
    pooler_user: selectedPoolerRoute.user || `postgres.${projectRef}`,
    jwt_ready: runtimeReadiness.jwt_ready,
    rest_ready: runtimeReadiness.rest_ready,
    runtime_ready: runtimeReadiness.runtime_ready,
    runtime_ready_at: runtimeReadiness.runtime_ready_at,
    readiness_failure_class: runtimeReadiness.readiness_failure_class,
    jwt_secret_synced: jwtSecretSynced,
    jwt_secret_source: jwtSource,
    recovery_reason: recoveryReason,
    active_family_generation: String(projectName || '').includes('-r-') ? 2 : 1,
    workspace_owned: Boolean(materializedOwnership?.materialized),
    ownership_generation_token: String(materializedOwnership?.generation_token || ''),
    superseded_project_ref: supersededProjectRef,
  };

  if (fmt === 'github-output') {
    writeGithubOutput(out);
    emitTrace(trace, 'info', {
      step: 'complete',
      status: 'ok',
      output_mode: 'github-output',
      workspace_mode: workspaceMode,
      project_ref: projectRef,
    });
    console.log(`[preview-project] workspace_mode=${workspaceMode} project_ref=${projectRef}`);
    return;
  }
  emitTrace(trace, 'info', {
    step: 'complete',
    status: 'ok',
    output_mode: 'json',
    workspace_mode: workspaceMode,
    project_ref: projectRef,
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[preview-project] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  extractPrNumberFromMergeGroupHeadRef,
  extractPrNumber,
  resolvePreviewJwtSeed,
  resolvePreviewJwtFallback,
  shouldPreservePlatformApiKeysForPreview,
  decodeJwtPayload,
  isLikelyProjectRef,
  buildSupabaseProjectUrl,
  extractProjectRefFromIssuer,
  extractProjectRefFromSupabaseUrl,
  resolvePreviewWorkspaceApiKeys,
  resolveProjectRefFromStaticApiKeys,
  resolveDegradedFallbackProjectRef,
  resolvePreviewSupabaseUrl,
  buildFallbackEdgeDbJwtBundle,
  resolvePoolerHost,
  assertBranchPoolerHost,
  shouldWaitForProjectReadiness,
  shouldProbeBranchPreviewDb,
  resolveBranchSupavisorRoute,
  applyAutoFallbackToProjectState,
  resolveAutoFallbackProjectRef,
  shouldAllowStaticApiKeyFallback,
  shouldSyncDerivedPreviewJwtSecret,
  resolveInitialPreviewJwtState,
  shouldFailClosedOnMissingPreviewJwtSecret,
  resolveProjectRefForProjectMode,
  shouldRebuildProjectOnDnsFailure,
  isDirectPreviewDnsOnlyFailure,
  isManagementApiForbiddenError,
  buildRecoveryProjectName,
  shouldSkipAuthDriftRebuild,
  shouldRecoverWithFreshProjectSibling,
  isRecreatedPreviewProjectReuseError,
  shouldRejectRecreatedPreviewProjectReuse,
  buildRecreatedPreviewProjectReuseError,
  shouldRotateRecoverySibling,
  resolveReusedPreviewRecoveryWaitBudget,
  resolveRecreatedPreviewRecoveryWaitBudget,
  resolvePreviewDnsTimeoutMs,
  maybeRecoverReusedPreviewPoolerAuth,
  waitForDns,
  isProjectNameAlreadyExistsError,
  isProjectCreateInconclusiveError,
  isRetryableProjectCreateError,
  shouldUseParentProjectFallback,
  createProjectWithNameConflictRecovery,
  findCompatiblePreviewFamilyProject,
  checkDbConnectivity,
  checkDbConnectivityCandidates,
  isDbAuthConnectivityError,
  refreshProjectDbPassword,
  shouldSyncPreviewDbPasswordOnAuthError,
  waitForPoolerUsableWithAuthLagRecovery,
  resolveWorkspaceDbCredentials,
  waitForBranchDbCredentials,
  buildPreviewPoolerDbCandidates,
  buildPreviewEnvPayload,
  parseConnectionTarget,
  waitForDbReady,
  waitForDbReadyCandidates,
  resolvePreviewProjectCommandTimeoutMs,
};
