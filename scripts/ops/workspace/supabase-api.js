#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');

function getSupabaseMgmtUrl() {
  // objectives:allow SUPABASE_URL Justification: default management API base; override supported via env
  return (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
}

function normalizeProjectName(value) {
  return String(value || '').trim();
}

function normalizePoolerHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

function normalizeSupabasePoolerRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  if (!region || region.length > 48) return '';
  return /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region) ? region : '';
}

function buildRegionDerivedPoolerHost(value) {
  const region = normalizeSupabasePoolerRegion(value);
  if (!region) return '';
  const host = `aws-1-${region}.pooler.supabase.com`;
  return resolveSupabasePoolerRegionFromHost(host) ? host : '';
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  parsed.hash = '';
  return parsed.toString();
}

function normalizeProjectLookupName(value) {
  return normalizeProjectName(value).toLowerCase();
}

function resolveProjectRef(project) {
  if (!project || typeof project !== 'object') return '';
  return normalizeProjectName(
    project.ref ||
      project.project_ref ||
      project.projectRef ||
      project.project_id ||
      project.projectId ||
      project.id,
  );
}

function normalizeBranchName(value) {
  return String(value || '').trim();
}

function resolveBranchId(branch) {
  if (!branch || typeof branch !== 'object') return '';
  return normalizeBranchName(
    branch.id ||
      branch.branch_id ||
      branch.branchId,
  );
}

function resolveBranchProjectRef(branch) {
  if (!branch || typeof branch !== 'object') return '';
  return normalizeProjectName(
    branch.project_ref ||
      branch.projectRef ||
      branch.project?.ref ||
      branch.project?.project_ref ||
      branch.ref ||
      branch.project_id ||
      branch.projectId,
  );
}

function mapBranch(branch) {
  return {
    branch_id: resolveBranchId(branch),
    project_ref: resolveBranchProjectRef(branch),
    name: normalizeBranchName(branch?.branch_name || branch?.name),
    region: normalizeProjectName(
      branch?.region ||
      branch?.project?.region ||
      branch?.project?.cloud_region ||
      branch?.project?.db_region,
    ),
    raw: branch,
  };
}

function normalizeBranchDatabaseConfig(branch, branchIdOrRef = '') {
  const database = branch?.database && typeof branch.database === 'object'
    ? branch.database
    : {};
  const mapped = mapBranch(branch);
  const portValue =
    branch?.db_port ??
    database.port ??
    database.db_port ??
    '';
  return {
    branch_id: mapped.branch_id || normalizeBranchName(branchIdOrRef),
    project_ref: mapped.project_ref,
    name: mapped.name,
    region: mapped.region,
    status: normalizeBranchName(
      branch?.status ||
        branch?.preview_project_status ||
        branch?.project_status,
    ),
    db_host: normalizeProjectName(
      branch?.db_host ||
        database.host ||
        database.db_host,
    ),
    db_port: portValue == null ? '' : String(portValue).trim(),
    db_user: normalizeProjectName(
      branch?.db_user ||
        database.user ||
        database.username ||
        database.db_user,
    ),
    db_pass: String(
      branch?.db_pass ||
        database.password ||
        database.pass ||
        database.db_pass ||
        '',
    ).trim(),
    // Branches have an isolated auth plane. Preserve the branch-owned secret
    // when the Management API returns it so callers never fall back to the
    // parent project's JWT secret.
    jwt_secret: normalizeJwtSecret(
      branch?.jwt_secret ||
        branch?.jwt?.jwt_secret ||
        branch?.auth?.jwt_secret ||
        database.jwt_secret ||
        '',
    ),
  };
}

const TERMINAL_BRANCH_DATABASE_STATUSES = new Set([
  'INIT_FAILED',
  'REMOVED',
  'RESTORE_FAILED',
  'PAUSE_FAILED',
]);

function isCanonicalSupabaseProjectRef(value) {
  return /^[a-z]{20}$/.test(normalizeProjectName(value));
}

function isCanonicalPostgresPort(value) {
  const normalized = String(value == null ? '' : value).trim();
  const parsed = Number.parseInt(normalized, 10);
  return /^\d+$/.test(normalized) && parsed >= 1 && parsed <= 65535;
}

function isCanonicalSupabasePoolerHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || host.length > 253 || host.includes('://') || /[\s/\\]/.test(host)) {
    return false;
  }
  if (!host.endsWith('.pooler.supabase.com')) return false;
  return host.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function resolveSupabasePoolerRegionFromHost(value) {
  const host = normalizePoolerHost(value);
  if (!isCanonicalSupabasePoolerHost(host)) return '';
  const match = host.match(/^aws-\d+-(.+)\.pooler\.supabase\.com$/);
  return normalizeSupabasePoolerRegion(match?.[1] || '');
}

function isCanonicalSupabaseDatabaseHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || host.length > 253 || host.includes('://') || /[\s/\\]/.test(host)) {
    return false;
  }
  if (!host.endsWith('.supabase.co') && !host.endsWith('.supabase.com')) {
    return false;
  }
  return host.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

function branchDatabaseConfigError(code, detail = '') {
  const suffix = String(detail || '').trim();
  const error = new Error(`${code}${suffix ? `:${suffix}` : ''}`);
  error.code = code;
  return error;
}

function validateBranchDatabaseConfig(branchConfig, { expectedProjectRef = '' } = {}) {
  const normalized = normalizeBranchDatabaseConfig(branchConfig);
  normalized.status = String(normalized.status || '').trim().toUpperCase();

  if (TERMINAL_BRANCH_DATABASE_STATUSES.has(normalized.status)) {
    throw branchDatabaseConfigError(
      'branch_db_credentials_terminal_status',
      normalized.status,
    );
  }

  const required = [
    ['project_ref', normalized.project_ref],
    ['status', normalized.status],
    ['db_pass', normalized.db_pass],
    ['db_host', normalized.db_host],
    ['db_port', normalized.db_port],
    ['db_user', normalized.db_user],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw branchDatabaseConfigError('branch_db_credentials_missing', missing.join(','));
  }

  if (!isCanonicalSupabaseProjectRef(normalized.project_ref)) {
    throw branchDatabaseConfigError('branch_db_credentials_invalid', 'project_ref');
  }

  if (normalized.status !== 'ACTIVE_HEALTHY') {
    throw branchDatabaseConfigError('branch_db_credentials_not_ready', normalized.status);
  }

  const expectedRef = normalizeProjectName(expectedProjectRef);
  if (expectedRef && !isCanonicalSupabaseProjectRef(expectedRef)) {
    throw branchDatabaseConfigError('branch_db_credentials_invalid', 'expected_project_ref');
  }
  if (expectedRef && normalized.project_ref !== expectedRef) {
    throw branchDatabaseConfigError(
      'branch_db_credentials_project_ref_mismatch',
      `${normalized.project_ref}:${expectedRef}`,
    );
  }
  if (!isCanonicalSupabaseDatabaseHost(normalized.db_host)) {
    throw branchDatabaseConfigError('branch_db_credentials_invalid', 'db_host');
  }
  if (normalized.db_host.toLowerCase() !== `db.${normalized.project_ref}.supabase.co`) {
    throw branchDatabaseConfigError('branch_db_credentials_identity_mismatch', 'db_host');
  }
  if (!isCanonicalPostgresPort(normalized.db_port)) {
    throw branchDatabaseConfigError('branch_db_credentials_invalid', 'db_port');
  }
  return normalized;
}

async function http(method, path, token, body, options = {}) {
  const url = `${getSupabaseMgmtUrl()}${path}`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    err.message = `fetch failed (${method} ${path}): ${err.message}`;
    throw err;
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.message || json?.error || res.statusText;
    const err = new Error(`HTTP ${res.status} ${method} ${path}: ${msg}`);
    err.status = res.status;
    err.body = json;
    err.retryAfter = res.headers?.get?.('retry-after') || '';
    throw err;
  }
  return json;
}

function isTransientFetchError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ABORT_ERR'].includes(code)) return true;
  const name = String(err?.name || '').toLowerCase();
  if (name === 'aborterror' || name === 'timeouterror') return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    msg.includes('aborted') ||
    msg.includes('timed out')
  );
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.ceil(Number(raw) * 1000));
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - nowMs);
  return null;
}

function parseRetryDelayFromError(err, nowMs = Date.now()) {
  const headerDelay = parseRetryAfterMs(err?.retryAfter, nowMs);
  if (headerDelay != null) return headerDelay;

  const bodyMsg = String(err?.body?.message || err?.body?.error || err?.body?.details || '');
  const text = `${String(err?.message || '')} ${bodyMsg}`;
  const waitUntilMatch = text.match(/please wait until\s+([0-9]{4}-[0-9]{2}-[0-9]{2}t[0-9:.]+z?)\s+before attempting/i);
  if (waitUntilMatch) {
    return parseRetryAfterMs(waitUntilMatch[1], nowMs);
  }
  return null;
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

async function httpWithRetries(method, path, token, body, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts ?? 4));
  const intervalMs = Math.max(250, Number(opts.intervalMs ?? 1500));
  const maxRateLimitWaitMs = Math.max(
    0,
    Number(opts.maxRateLimitWaitMs ?? process.env.SUPABASE_MGMT_RATE_LIMIT_MAX_WAIT_MS ?? 5 * 60 * 1000),
  );
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await http(method, path, token, body);
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const rateLimited = status === 429;
      const transient = isTransientFetchError(err) || [502, 503, 504].includes(status) || rateLimited;
      if (!transient || attempt === attempts) throw err;
      const retryDelayMs = rateLimited ? parseRetryDelayFromError(err) : null;
      if (rateLimited && retryDelayMs != null && retryDelayMs > maxRateLimitWaitMs) throw err;
      await sleep(rateLimited && retryDelayMs != null ? retryDelayMs : intervalMs);
    }
  }
  throw lastErr;
}

function randomPassword(len = 24) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);  
}

function randomJwtSecret(bytes = 32) {
  // Generate a plain hex secret so Supabase (HS256) + local tooling agree on the
  // exact byte interpretation (no base64/hex auto-decoding ambiguity).
  // Treat this secret as sensitive; store only in gitignored env overlays.
  return crypto.randomBytes(bytes).toString('hex');
}

function base64UrlEncode(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''));
  return raw
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function resolveHs256SigningKeyBytes(secret) {
  if (!secret) return Buffer.alloc(0);
  if (Buffer.isBuffer(secret)) return secret;
  const raw = String(secret || '').trim();
  if (!raw) return Buffer.alloc(0);
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    try {
      return Buffer.from(raw, 'hex');
    } catch {
      // fall through to utf8 bytes
    }
  }
  return Buffer.from(raw, 'utf8');
}

function isProjectNameAlreadyExistsError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 400 && status !== 409) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('already exists') && text.includes('project') && text.includes('name');
}

function withProjectCreateDiagnostics(err, { organizationId, name, region, plan } = {}) {
  const status = Number(err?.status || 0);
  if (status !== 403) return err;
  const detail = String(err?.body?.message || err?.body?.error || err?.message || '').trim();
  const guidance =
    `Supabase project creation denied for organization '${organizationId}' (status 403). ` +
    `Requested project='${name}', region='${region}', plan='${plan}'. ` +
    'The token likely lacks org-level project-create entitlement (Owner/Admin required), ' +
    'or org policy/quota currently blocks new projects.';
  const wrapped = new Error(`${guidance}${detail ? ` Details: ${detail}` : ''}`);
  wrapped.status = status;
  wrapped.body = err?.body;
  wrapped.cause = err;
  return wrapped;
}

async function createProject(opts) {
  const { token, organizationId, name, region, plan = 'free', dbPass } = opts;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to create project');
  if (!organizationId) throw new Error('SUPABASE_ORG_ID is required to create project');
  if (!name) throw new Error('name is required');
  if (!region) throw new Error('SUPABASE_REGION is required');
  const password = dbPass || randomPassword();
  const payload = { organization_id: organizationId, name, db_pass: password, region, plan };
  let proj;
  try {
    proj = await http('POST', '/v1/projects', token, payload);
  } catch (err) {
    throw withProjectCreateDiagnostics(err, { organizationId, name, region, plan });
  }
  return {
    project_ref: proj?.ref || proj?.id || proj?.project_ref,
    db_pass: password,
    region: normalizeProjectName(
      proj?.region ||
      proj?.cloud_region ||
      proj?.db_region ||
      region,
    ),
  };
}

function isBranchNameAlreadyExistsError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 400 && status !== 409) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('already exists') && text.includes('branch');
}

function isInconclusiveBranchCreateError(err) {
  const status = Number(err?.status || 0);
  return (
    isTransientFetchError(err) ||
    [408, 409, 425, 429, 500, 502, 503, 504].includes(status)
  );
}

function branchCreateOutcomeAmbiguousError({ parentProjectRef, name, cause, observedBranch } = {}) {
  const error = new Error(
    `Branch create outcome is ambiguous for parent_ref=${normalizeProjectName(parentProjectRef)} name=${normalizeBranchName(name)}`,
    { cause },
  );
  error.code = 'branch_create_outcome_ambiguous';
  if (observedBranch?.branch_id) error.observedBranchId = observedBranch.branch_id;
  if (observedBranch?.project_ref) error.observedProjectRef = observedBranch.project_ref;
  return error;
}

async function createBranch({ token, parentProjectRef, name } = {}) {
  const parent = normalizeProjectName(parentProjectRef);
  const branchName = normalizeBranchName(name);
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to create branch');
  if (!parent) {
    throw new Error(
      'SUPABASE_BRANCH_PARENT_REF (or SUPABASE_PARENT_PROJECT_REF / SUPABASE_PROJECT_ID) is required to create branch',
    );
  }
  if (!branchName) throw new Error('branch name is required');
  const payload = { branch_name: branchName };
  const created = await http('POST', `/v1/projects/${encodeURIComponent(parent)}/branches`, token, payload);
  const mapped = mapBranch(created);
  if (!mapped.project_ref) throw new Error('Branch creation did not return project_ref');
  return mapped;
}

async function listBranches({ token, parentProjectRef, requireVerifiableResponse = false, timeoutMs = 0 } = {}) {
  const parent = normalizeProjectName(parentProjectRef);
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to list branches');
  if (!parent) {
    throw new Error(
      'SUPABASE_BRANCH_PARENT_REF (or SUPABASE_PARENT_PROJECT_REF / SUPABASE_PROJECT_ID) is required to list branches',
    );
  }
  const res = await http('GET', `/v1/projects/${encodeURIComponent(parent)}/branches`, token, undefined,
    { signal: timeoutSignal(timeoutMs) });
  if (requireVerifiableResponse && !Array.isArray(res) && !Array.isArray(res?.branches)) {
    throw new Error('Supabase branch inventory is unverifiable.');
  }
  const rows = Array.isArray(res)
    ? res
    : (Array.isArray(res?.branches) ? res.branches : []);
  if (requireVerifiableResponse) {
    const ids = new Set();
    const refs = new Set();
    for (const row of rows) {
      const id = resolveBranchId(row);
      const observedParent = normalizeProjectName(row?.parent_project_ref || row?.parentProjectRef || row?.parent_ref);
      const ref = resolveBranchProjectRef(row);
      if (!id || ids.has(id) || refs.has(ref) || !isCanonicalSupabaseProjectRef(ref)
        || !normalizeBranchName(row?.branch_name || row?.name) || (observedParent && observedParent !== parent)) {
        throw new Error('Supabase branch inventory identity is unverifiable.');
      }
      ids.add(id);
      refs.add(ref);
    }
  }
  return rows.map(mapBranch);
}

async function inspectOwnedPreviewWorkspace({ token, organizationId, ownership, timeoutMs = 15000,
  listProjectsFn = listProjects, listBranchesFn = listBranches }) {
  if (!token || !organizationId || typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Preview provider observation authority or deadline is unavailable.');
  }
  const deadlineMs = Date.now() + timeoutMs;
  const remainingMs = () => {
    const remaining = Math.floor(deadlineMs - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Preview provider observation deadline exhausted.');
    return remaining;
  };
  const exact = require('./preview-ownership').buildMaterializedOwnership(ownership);
  if (!isCanonicalSupabaseProjectRef(exact.project_ref)
    || (exact.workspace_mode === 'branch' && !isCanonicalSupabaseProjectRef(exact.branch_parent_ref))) {
    throw new Error('Preview provider ownership immutable ref is invalid.');
  }
  // Keep complete same-token visibility; org filtering cannot prove immutable-ref absence.
  const projects = assertVerifiableProjectList(await listProjectsFn({ token, organizationId,
    requireVerifiableResponse: true, timeoutMs: remainingMs() }));
  remainingMs();
  const assertOrganization = row => {
    const organization = resolveProjectOrganizationIdentity(row);
    if (!organizationId || ![organization.id, organization.slug].includes(organizationId)) {
      throw new Error('Preview provider ownership organization changed.');
    }
  };
  let rows = projects;
  if (exact.workspace_mode === 'branch') {
    const parent = projects.find(row => resolveProjectRef(row) === exact.branch_parent_ref);
    if (!parent) return { absent: true };
    assertOrganization(parent);
    rows = await listBranchesFn({ token, parentProjectRef: exact.branch_parent_ref,
      requireVerifiableResponse: true, timeoutMs: remainingMs() });
    remainingMs();
    if (!Array.isArray(rows)) throw new Error('Preview provider branch absence is unverifiable.');
  }
  const matches = rows.filter(row => {
    const ref = exact.workspace_mode === 'branch' ? resolveBranchProjectRef(row) : resolveProjectRef(row);
    return ref === exact.project_ref || (exact.workspace_mode === 'branch' && resolveBranchId(row) === exact.branch_id)
      || normalizeProjectName(row.name || row.branch_name) === exact.project_name;
  });
  if (!matches.length) return { absent: true };
  if (matches.length !== 1) throw new Error('Preview provider ownership is ambiguous.');
  const row = matches[0];
  const ref = exact.workspace_mode === 'branch' ? resolveBranchProjectRef(row) : resolveProjectRef(row);
  const raw = row.raw || row;
  const createdAt = raw.created_at || raw.inserted_at || raw.createdAt || raw.insertedAt;
  const createdAtMs = typeof createdAt === 'string' && createdAt.trim() ? Date.parse(createdAt) : NaN;
  const parent = normalizeProjectName(raw.parent_project_ref || raw.parentProjectRef || raw.parent_ref);
  if (ref !== exact.project_ref || normalizeProjectName(row.name || row.branch_name) !== exact.project_name
    || !Number.isFinite(createdAtMs) || createdAtMs > Date.now()
    || (exact.workspace_mode === 'branch' && (resolveBranchId(row) !== exact.branch_id
      || (parent && parent !== exact.branch_parent_ref)))) {
    throw new Error('Preview provider immutable ownership identity changed.');
  }
  if (exact.workspace_mode === 'project') assertOrganization(row);
  return { absent: false, project_ref: ref, project_name: exact.project_name,
    branch_id: exact.branch_id, branch_parent_ref: exact.branch_parent_ref, created_at: new Date(createdAtMs).toISOString() };
}

async function findBranchByName({ token, parentProjectRef, name } = {}) {
  const parent = normalizeProjectName(parentProjectRef);
  const wanted = normalizeBranchName(name);
  if (!wanted) throw new Error('name is required to find branch by name');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to find branch by name');
  if (!parent) {
    throw new Error(
      'SUPABASE_BRANCH_PARENT_REF (or SUPABASE_PARENT_PROJECT_REF / SUPABASE_PROJECT_ID) is required to find branch by name',
    );
  }

  try {
    const direct = await http(
      'GET',
      `/v1/projects/${encodeURIComponent(parent)}/branches/${encodeURIComponent(wanted)}`,
      token,
    );
    const mapped = mapBranch(direct);
    if (mapped.project_ref) return mapped;
  } catch (err) {
    const status = Number(err?.status || 0);
    if (![400, 403, 404].includes(status)) throw err;
  }

  const list = await listBranches({ token, parentProjectRef: parent });
  return list.find((item) => normalizeBranchName(item?.name) === wanted) || null;
}

async function getBranchConfig({ token, branchIdOrRef, timeoutMs = 0 } = {}) {
  const branchRef = normalizeBranchName(branchIdOrRef);
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to get branch config');
  if (!branchRef) throw new Error('branchIdOrRef is required to get branch config');
  const branch = await http(
    'GET',
    `/v1/branches/${encodeURIComponent(branchRef)}`,
    token,
    undefined,
    {
      signal: Number(timeoutMs) > 0
        ? AbortSignal.timeout(Math.max(1, Number.parseInt(String(timeoutMs), 10) || 1))
        : undefined,
    },
  );
  return normalizeBranchDatabaseConfig(branch, branchRef);
}

async function waitForBranchDatabaseConfig({
  token,
  branchIdOrRef,
  expectedProjectRef = '',
  maxWaitMs = 120_000,
  retryDelayMs = 5_000,
  getBranchConfigFn = getBranchConfig,
  nowFn = () => Date.now(),
  sleepFn = sleep,
} = {}) {
  const branchRef = normalizeBranchName(branchIdOrRef);
  if (!branchRef) throw branchDatabaseConfigError('branch_db_credentials_ref_required');
  const parsedMaxWaitMs = Number.parseInt(String(maxWaitMs || ''), 10);
  const timeoutMs = Number.isFinite(parsedMaxWaitMs) && parsedMaxWaitMs > 0
    ? parsedMaxWaitMs
    : 120_000;
  const parsedRetryDelayMs = Number.parseInt(String(retryDelayMs || ''), 10);
  const delayMs = Number.isFinite(parsedRetryDelayMs) && parsedRetryDelayMs > 0
    ? parsedRetryDelayMs
    : 5_000;
  const startedAt = nowFn();
  let lastMessage = 'branch credential readiness window elapsed';

  while (true) {
    const elapsedBeforeRequestMs = Math.max(0, nowFn() - startedAt);
    const remainingBeforeRequestMs = timeoutMs - elapsedBeforeRequestMs;
    if (remainingBeforeRequestMs <= 0) {
      throw branchDatabaseConfigError(
        'branch_db_credentials_unavailable',
        `${branchRef}:${lastMessage}`,
      );
    }

    try {
      const branchConfig = await getBranchConfigFn({
        token,
        branchIdOrRef: branchRef,
        timeoutMs: remainingBeforeRequestMs,
      });
      const elapsedAfterRequestMs = Math.max(0, nowFn() - startedAt);
      if (elapsedAfterRequestMs >= timeoutMs) {
        throw branchDatabaseConfigError(
          'branch_db_credentials_unavailable',
          `${branchRef}:branch credential readiness window elapsed`,
        );
      }
      return validateBranchDatabaseConfig(branchConfig, { expectedProjectRef });
    } catch (error) {
      const status = Number(error?.status || error?.cause?.status || 0);
      const message = String(error?.message || error || 'unknown');
      if (status === 401 || status === 403) {
        const denied = branchDatabaseConfigError(
          'branch_db_credentials_access_denied',
          `${status}:${message}`,
        );
        denied.status = status;
        denied.cause = error;
        throw denied;
      }
      if (
        error?.code === 'branch_db_credentials_unavailable'
      ) {
        throw error;
      }
      if (error?.code === 'branch_db_credentials_terminal_status') {
        throw error;
      }
      if (
        error?.code === 'branch_db_credentials_invalid' ||
        error?.code === 'branch_db_credentials_project_ref_mismatch'
      ) {
        throw branchDatabaseConfigError(
          'branch_db_credentials_unavailable',
          `${branchRef}:${message}`,
        );
      }

      lastMessage = message;
      const retryable =
        error?.code === 'branch_db_credentials_missing' ||
        error?.code === 'branch_db_credentials_not_ready' ||
        isTransientFetchError(error) ||
        [404, 409, 423, 425, 429, 500, 502, 503, 504].includes(status);
      const elapsedMs = Math.max(0, nowFn() - startedAt);
      if (!retryable || elapsedMs >= timeoutMs) {
        throw branchDatabaseConfigError(
          'branch_db_credentials_unavailable',
          `${branchRef}:${message}`,
        );
      }
      const retryAfterMs = status === 429
        ? parseRetryDelayFromError(error, nowFn())
        : null;
      const requestedDelayMs = retryAfterMs == null ? delayMs : retryAfterMs;
      const sleepMs = Math.min(requestedDelayMs, Math.max(0, timeoutMs - elapsedMs));
      if (sleepMs <= 0) {
        throw branchDatabaseConfigError(
          'branch_db_credentials_unavailable',
          `${branchRef}:${message}`,
        );
      }
      await sleepFn(sleepMs);
    }
  }
}

async function ensureBranch({
  token,
  parentProjectRef,
  name,
  reuseExisting = true,
  requireExisting = false,
  expectedProjectRef = '',
  reconcileAttempts = 4,
  reconcileDelayMs = 1_500,
  findBranchByNameFn = findBranchByName,
  sleepFn = sleep,
} = {}) {
  const expectedRef = normalizeProjectName(expectedProjectRef);
  if (expectedRef && !isCanonicalSupabaseProjectRef(expectedRef)) {
    throw branchDatabaseConfigError('branch_expected_identity_invalid', 'project_ref');
  }
  if (expectedRef && !requireExisting) {
    throw branchDatabaseConfigError('branch_expected_identity_requires_existing');
  }
  const assertExpectedIdentity = (branch) => {
    const actualRef = resolveBranchProjectRef(branch);
    if (expectedRef && actualRef !== expectedRef) {
      const mismatch = branchDatabaseConfigError(
        'branch_expected_project_ref_mismatch',
        `${actualRef || '<missing>'}:${expectedRef}`,
      );
      mismatch.status = 409;
      throw mismatch;
    }
    return branch;
  };

  if (requireExisting) {
    if (!expectedRef) {
      throw branchDatabaseConfigError('branch_expected_identity_required', 'project_ref');
    }
    const existing = await findBranchByNameFn({ token, parentProjectRef, name });
    if (!existing?.project_ref) {
      const missing = branchDatabaseConfigError(
        'branch_expected_missing',
        `${normalizeProjectName(parentProjectRef)}:${normalizeBranchName(name)}:${expectedRef}`,
      );
      missing.status = 404;
      throw missing;
    }
    return { ...assertExpectedIdentity(existing), reused: true };
  }

  const existingBeforeCreate = await findBranchByNameFn({ token, parentProjectRef, name });
  if (existingBeforeCreate?.project_ref) {
    if (reuseExisting) {
      return { ...assertExpectedIdentity(existingBeforeCreate), reused: true };
    }
    const collision = new Error(
      `Fresh branch name already exists for parent_ref=${normalizeProjectName(parentProjectRef)} name=${normalizeBranchName(name)}`,
    );
    collision.code = 'branch_fresh_name_collision';
    throw collision;
  }
  try {
    const created = await createBranch({ token, parentProjectRef, name });
    return { ...assertExpectedIdentity(created), reused: false };
  } catch (err) {
    const nameConflict = isBranchNameAlreadyExistsError(err);
    const inconclusive = isInconclusiveBranchCreateError(err);
    if (!nameConflict && !inconclusive) throw err;

    const attempts = Math.max(1, Number.parseInt(String(reconcileAttempts || ''), 10) || 4);
    const delayMs = Math.max(0, Number.parseInt(String(reconcileDelayMs || ''), 10) || 0);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const existing = await findBranchByNameFn({ token, parentProjectRef, name });
        if (existing?.project_ref) {
          if (reuseExisting) return { ...assertExpectedIdentity(existing), reused: true };
          throw branchCreateOutcomeAmbiguousError({
            parentProjectRef,
            name,
            cause: err,
            observedBranch: existing,
          });
        }
      } catch (lookupError) {
        if (lookupError?.code === 'branch_create_outcome_ambiguous') throw lookupError;
        if (lookupError?.code === 'branch_expected_project_ref_mismatch') throw lookupError;
        const status = Number(lookupError?.status || 0);
        if (status === 401 || status === 403) {
          throw branchCreateOutcomeAmbiguousError({ parentProjectRef, name, cause: err });
        }
      }
      if (attempt < attempts && delayMs > 0) await sleepFn(delayMs);
    }

    throw branchCreateOutcomeAmbiguousError({ parentProjectRef, name, cause: err });
  }
}

function timeoutSignal(timeoutMs) {
  const parsed = Number.parseInt(String(timeoutMs || ''), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? AbortSignal.timeout(Math.max(1, parsed))
    : undefined;
}

async function getProject(projectRef, token, { timeoutMs = 0 } = {}) {
  return http('GET', `/v1/projects/${projectRef}`, token, undefined, {
    signal: timeoutSignal(timeoutMs),
  });
}

async function waitUntilReady(projectRef, token, timeoutMs = 30 * 60 * 1000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    let p;
    try {
      p = await getProject(projectRef, token);
    } catch (e) {
      // Some tenants restrict project GET even when creation succeeds. In that case,
      // rely on downstream DNS/DB checks instead of blocking here.
      if (e && (e.status === 403 || e.status === 404)) {
        console.warn(`[supabase-api] waitUntilReady: project ${projectRef} not readable (status=${e.status}); proceeding without status check.`);
        return null;
      }
      throw e;
    }
    const raw = String(p?.status || p?.project_status || '').trim();
    const status = raw.toLowerCase();
    const ready = (
      ['active', 'ready', 'online'].includes(status) ||
      status.includes('active') ||
      status.includes('healthy') ||
      status.includes('online') ||
      status.includes('ready')
    );
    if (ready) return p;
    if (status !== last) {
      console.log(`[supabase-api] waiting: project ${projectRef} status=${raw}`);
      last = status;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Timeout waiting for project ${projectRef} to be ready`);
}

function extractPoolerHostsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  let serialized = '';
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return [];
  }
  const matches = serialized.match(/[a-z0-9-]+\.pooler\.supabase\.com/gi) || [];
  const seen = new Set();
  const hosts = [];
  for (const entry of matches) {
    const host = normalizePoolerHost(entry);
    if (!resolveSupabasePoolerRegionFromHost(host) || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function selectProjectPoolerHost(hosts, { preferredRegion = '' } = {}) {
  const list = Array.isArray(hosts)
    ? hosts
      .map((entry) => normalizePoolerHost(entry))
      .filter((host) => resolveSupabasePoolerRegionFromHost(host))
    : [];
  if (list.length === 0) return '';
  const region = normalizeSupabasePoolerRegion(preferredRegion);
  if (region) {
    const withRegion = list.find((host) => host.includes(`-${region}.pooler.supabase.com`));
    if (withRegion) return withRegion;
  }
  return list[0];
}

async function resolveProjectPoolerHost({
  projectRef,
  token,
  preferredRegion = '',
  fallbackHost = '',
  allowDerivedFallback = true,
} = {}) {
  const ref = normalizeProjectName(projectRef);
  const normalizedFallback = normalizePoolerHost(fallbackHost);
  const fallback = resolveSupabasePoolerRegionFromHost(normalizedFallback) ? normalizedFallback : '';
  const preferred = normalizeSupabasePoolerRegion(preferredRegion);
  if (!ref || !token) {
    if (fallback) return fallback;
    if (preferred && allowDerivedFallback) return buildRegionDerivedPoolerHost(preferred);
    return '';
  }

  const paths = [
    `/v1/projects/${encodeURIComponent(ref)}/database`,
    `/v1/projects/${encodeURIComponent(ref)}/settings`,
    `/v1/projects/${encodeURIComponent(ref)}`,
  ];

  let discoveredRegion = preferred;
  for (const endpointPath of paths) {
    try {
      const payload = await httpWithRetries('GET', endpointPath, token, null, {
        attempts: 3,
        intervalMs: 1000,
      });
      const metadataRegion = normalizeSupabasePoolerRegion(
        payload?.region ||
          payload?.cloud_region ||
          payload?.db_region ||
          payload?.project?.region ||
          payload?.project?.cloud_region ||
          payload?.project?.db_region,
      );
      if (metadataRegion) discoveredRegion = metadataRegion;
      const hosts = extractPoolerHostsFromPayload(payload);
      const selected = selectProjectPoolerHost(hosts, {
        preferredRegion: discoveredRegion,
      });
      if (selected) return selected;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 403 || status === 404) continue;
      console.warn(`[supabase-api] resolveProjectPoolerHost ${endpointPath} failed: ${error.message}`);
    }
  }

  if (fallback) return fallback;
  if (discoveredRegion && allowDerivedFallback) return buildRegionDerivedPoolerHost(discoveredRegion);
  return '';
}

function normalizeApiKeyValue(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'redacted' || lower === 'masked' || lower === 'hidden') return '';
  if (/[\u2022*]/.test(trimmed)) return '';
  return trimmed;
}

function unwrapApiKeys(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.keys)) return payload.keys;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizeApiKeyName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeApiKeyType(value) {
  return String(value || '').trim().toLowerCase();
}

function resolvePreferModernApiKeys(opts = {}) {
  if (typeof opts?.preferModern === 'boolean') return opts.preferModern;
  if (typeof opts?.preferModern === 'string') return isTruthy(opts.preferModern);
  return isTruthy(process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS || '0');
}

function extractProjectApiKeys(keys, { preferModern } = {}) {
  const rows = unwrapApiKeys(keys).filter((row) => row && typeof row === 'object');

  const findKey = (predicate) => {
    const row = rows.find(predicate);
    return normalizeApiKeyValue(row?.api_key);
  };

  const legacyAnon =
    findKey((row) => normalizeApiKeyType(row.type) === 'legacy' && normalizeApiKeyName(row.name) === 'anon') ||
    findKey((row) => normalizeApiKeyName(row.name) === 'anon');
  const legacyService =
    findKey(
      (row) =>
        normalizeApiKeyType(row.type) === 'legacy' &&
        (normalizeApiKeyName(row.name) === 'service_role' || normalizeApiKeyName(row.name) === 'service'),
    ) ||
    findKey((row) => /service/i.test(String(row.name || '')));
  const publishable =
    findKey((row) => normalizeApiKeyType(row.type) === 'publishable') ||
    findKey((row) => normalizeApiKeyName(row.name) === 'publishable');
  const secret =
    findKey((row) => normalizeApiKeyType(row.type) === 'secret') ||
    findKey((row) => normalizeApiKeyName(row.name) === 'secret');

  const anon = preferModern ? publishable || legacyAnon : legacyAnon || publishable;
  const service = preferModern ? secret || legacyService : legacyService || secret;

  return {
    anon: anon || null,
    service: service || null,
    publishable: publishable || null,
    secret: secret || null,
    legacyAnon: legacyAnon || null,
    legacyService: legacyService || null,
  };
}

async function fetchApiKeys(projectRef, token, { reveal = false } = {}) {
  const query = reveal ? '?reveal=true' : '';
  return httpWithRetries('GET', `/v1/projects/${projectRef}/api-keys${query}`, token, null, {
    attempts: 4,
    intervalMs: 1500,
  });
}

async function getApiKeys(projectRef, token, opts = {}) {
  const preferModern = resolvePreferModernApiKeys(opts);
  let attempts;
  if (typeof opts?.reveal === 'boolean') {
    attempts = [opts.reveal];
  } else if (preferModern) {
    attempts = [true, false];
  } else {
    // Legacy callers may still need reveal=true fallback when default responses are
    // masked/redacted under org policy.
    attempts = [false, true];
  }
  attempts = [...new Set(attempts)];

  const errors = [];
  for (const reveal of attempts) {
    try {
      const keys = await fetchApiKeys(projectRef, token, { reveal });
      const extracted = extractProjectApiKeys(keys, { preferModern });
      if (extracted.anon || extracted.service || extracted.publishable || extracted.secret) {
        return extracted;
      }
      errors.push(`empty key set (reveal=${reveal ? '1' : '0'})`);
    } catch (e) {
      errors.push(e.message);
    }
  }

  // Fallback: many orgs restrict this endpoint; return null and rely on env/secrets.
  if (errors.length) {
    console.warn(`[supabase-api] Could not fetch API keys: ${errors.join(' | ')}`);
  }
  return {
    anon: null,
    service: null,
    publishable: null,
    secret: null,
    legacyAnon: null,
    legacyService: null,
  };
}

function getNestedValue(payload, path) {
  const segments = Array.isArray(path) ? path : [];
  let cursor = payload;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function normalizeAuthRedirectUrlList(value) {
  if (Array.isArray(value)) {
    const flattened = [];
    for (const entry of value) {
      const normalizedEntry = normalizeAuthRedirectUrlList(entry);
      if (normalizedEntry.length > 0) {
        flattened.push(...normalizedEntry);
      }
    }
    return Array.from(
      new Set(
        flattened
          .map((entry) => normalizeHttpUrl(entry))
          .filter(Boolean),
      ),
    );
  }
  if (value && typeof value === 'object') {
    return normalizeAuthRedirectUrlList(
      value.additional_redirect_urls
        || value.additionalRedirectUrls
        || value.uri_allow_list
        || value.uriAllowList
        || value.ADDITIONAL_REDIRECT_URLS
        || value.URI_ALLOW_LIST
        || '',
    );
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return normalizeAuthRedirectUrlList(parsed);
      }
    } catch {
      // continue with delimiter-based parsing
    }
  }
  const primaryTokens = raw
    .split(/[,\n\r;]+/)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const expandedTokens = [];
  for (const token of primaryTokens) {
    if (normalizeHttpUrl(token)) {
      expandedTokens.push(token);
      continue;
    }
    if (/\s+/.test(token)) {
      const parts = token
        .split(/\s+/)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
      expandedTokens.push(...parts);
      continue;
    }
    expandedTokens.push(token);
  }
  return Array.from(
    new Set(
      expandedTokens
        .map((entry) => normalizeHttpUrl(entry))
        .filter(Boolean),
    ),
  );
}

const DEFAULT_AUTH_CONFIG_VERIFY_ATTEMPTS = 8;
const DEFAULT_AUTH_CONFIG_VERIFY_DELAY_MS = 2000;

function resolveAuthConfigVerifyAttempts(config = {}, env = process.env) {
  const raw =
    config.verify_attempts ||
    config.verifyAttempts ||
    env.SUPABASE_AUTH_CONFIG_VERIFY_ATTEMPTS ||
    '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUTH_CONFIG_VERIFY_ATTEMPTS;
  return Math.min(parsed, 30);
}

function resolveAuthConfigVerifyDelayMs(config = {}, env = process.env) {
  const raw =
    config.verify_delay_ms ||
    config.verifyDelayMs ||
    env.SUPABASE_AUTH_CONFIG_VERIFY_DELAY_MS ||
    '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUTH_CONFIG_VERIFY_DELAY_MS;
  return Math.min(Math.max(parsed, 250), 60_000);
}

function evaluateAuthConfigWriteState({ siteUrl, redirectUrls, actual } = {}) {
  const expectedSiteUrl = normalizeHttpUrl(siteUrl);
  const expectedRedirects = normalizeAuthRedirectUrlList(redirectUrls);
  const actualSiteUrl = normalizeHttpUrl(actual?.site_url || actual?.siteUrl || actual?.SITE_URL);
  const actualRedirects = normalizeAuthRedirectUrlList(
    actual?.additional_redirect_urls ||
      actual?.additionalRedirectUrls ||
      actual?.uri_allow_list ||
      actual?.uriAllowList ||
      actual?.ADDITIONAL_REDIRECT_URLS ||
      actual?.URI_ALLOW_LIST,
  );
  const actualRedirectSet = new Set(actualRedirects);
  const missingRedirects = expectedRedirects.filter((url) => !actualRedirectSet.has(url));
  return {
    ok: expectedSiteUrl === actualSiteUrl && missingRedirects.length === 0,
    expectedSiteUrl,
    expectedRedirects,
    actualSiteUrl,
    actualRedirects,
    missingRedirects,
  };
}

function buildAuthConfigPayloadVariants({ siteUrl, redirectUrls }) {
  const normalizedSiteUrl = normalizeHttpUrl(siteUrl);
  if (!normalizedSiteUrl) return [];

  const normalizedRedirects = normalizeAuthRedirectUrlList(redirectUrls);
  const redirectCsv = normalizedRedirects.join(',');
  const redirectNl = normalizedRedirects.join('\n');
  const payloads = [];
  const valueVariants = [normalizedRedirects, redirectCsv, redirectNl];

  for (const value of valueVariants) {
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    const authShapes = [
      { site_url: normalizedSiteUrl, additional_redirect_urls: value },
      { site_url: normalizedSiteUrl, uri_allow_list: value },
      { site_url: normalizedSiteUrl, redirect_urls: value },
      { siteUrl: normalizedSiteUrl, additionalRedirectUrls: value },
      { siteUrl: normalizedSiteUrl, uriAllowList: value },
      { siteUrl: normalizedSiteUrl, redirectUrls: value },
      { SITE_URL: normalizedSiteUrl, ADDITIONAL_REDIRECT_URLS: value },
      { SITE_URL: normalizedSiteUrl, URI_ALLOW_LIST: value },
      { SITE_URL: normalizedSiteUrl, REDIRECT_URLS: value },
    ];
    for (const authShape of authShapes) {
      payloads.push(authShape);
      payloads.push({ auth: authShape });
      payloads.push({ settings: authShape });
      payloads.push({ config: authShape });
      payloads.push({ config: { auth: authShape } });
      payloads.push({ data: authShape });
      payloads.push({ data: { auth: authShape } });
      payloads.push({ data: { config: authShape } });
      payloads.push({ data: { config: { auth: authShape } } });
    }
  }

  const seen = new Set();
  return payloads.filter((payload) => {
    const key = JSON.stringify(payload);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractProjectAuthEmailUrlConfig(payload) {
  const siteCandidates = [
    ['site_url'],
    ['siteUrl'],
    ['SITE_URL'],
    ['auth', 'site_url'],
    ['auth', 'siteUrl'],
    ['auth', 'SITE_URL'],
    ['settings', 'site_url'],
    ['settings', 'siteUrl'],
    ['settings', 'SITE_URL'],
    ['config', 'site_url'],
    ['config', 'siteUrl'],
    ['config', 'SITE_URL'],
    ['config', 'auth', 'site_url'],
    ['config', 'auth', 'siteUrl'],
    ['config', 'auth', 'SITE_URL'],
    ['data', 'site_url'],
    ['data', 'siteUrl'],
    ['data', 'SITE_URL'],
    ['data', 'auth', 'site_url'],
    ['data', 'auth', 'siteUrl'],
    ['data', 'auth', 'SITE_URL'],
    ['data', 'config', 'site_url'],
    ['data', 'config', 'siteUrl'],
    ['data', 'config', 'SITE_URL'],
    ['data', 'config', 'auth', 'site_url'],
    ['data', 'config', 'auth', 'siteUrl'],
    ['data', 'config', 'auth', 'SITE_URL'],
  ];
  const redirectCandidates = [
    ['additional_redirect_urls'],
    ['additionalRedirectUrls'],
    ['ADDITIONAL_REDIRECT_URLS'],
    ['redirect_urls'],
    ['redirectUrls'],
    ['REDIRECT_URLS'],
    ['uri_allow_list'],
    ['uriAllowList'],
    ['URI_ALLOW_LIST'],
    ['auth', 'additional_redirect_urls'],
    ['auth', 'additionalRedirectUrls'],
    ['auth', 'ADDITIONAL_REDIRECT_URLS'],
    ['auth', 'redirect_urls'],
    ['auth', 'redirectUrls'],
    ['auth', 'REDIRECT_URLS'],
    ['auth', 'uri_allow_list'],
    ['auth', 'uriAllowList'],
    ['auth', 'URI_ALLOW_LIST'],
    ['settings', 'additional_redirect_urls'],
    ['settings', 'additionalRedirectUrls'],
    ['settings', 'ADDITIONAL_REDIRECT_URLS'],
    ['settings', 'redirect_urls'],
    ['settings', 'redirectUrls'],
    ['settings', 'REDIRECT_URLS'],
    ['settings', 'uri_allow_list'],
    ['settings', 'uriAllowList'],
    ['settings', 'URI_ALLOW_LIST'],
    ['config', 'additional_redirect_urls'],
    ['config', 'additionalRedirectUrls'],
    ['config', 'ADDITIONAL_REDIRECT_URLS'],
    ['config', 'redirect_urls'],
    ['config', 'redirectUrls'],
    ['config', 'REDIRECT_URLS'],
    ['config', 'uri_allow_list'],
    ['config', 'uriAllowList'],
    ['config', 'URI_ALLOW_LIST'],
    ['config', 'auth', 'additional_redirect_urls'],
    ['config', 'auth', 'additionalRedirectUrls'],
    ['config', 'auth', 'ADDITIONAL_REDIRECT_URLS'],
    ['config', 'auth', 'redirect_urls'],
    ['config', 'auth', 'redirectUrls'],
    ['config', 'auth', 'REDIRECT_URLS'],
    ['config', 'auth', 'uri_allow_list'],
    ['config', 'auth', 'uriAllowList'],
    ['config', 'auth', 'URI_ALLOW_LIST'],
    ['data', 'additional_redirect_urls'],
    ['data', 'additionalRedirectUrls'],
    ['data', 'ADDITIONAL_REDIRECT_URLS'],
    ['data', 'redirect_urls'],
    ['data', 'redirectUrls'],
    ['data', 'REDIRECT_URLS'],
    ['data', 'uri_allow_list'],
    ['data', 'uriAllowList'],
    ['data', 'URI_ALLOW_LIST'],
    ['data', 'auth', 'additional_redirect_urls'],
    ['data', 'auth', 'additionalRedirectUrls'],
    ['data', 'auth', 'ADDITIONAL_REDIRECT_URLS'],
    ['data', 'auth', 'redirect_urls'],
    ['data', 'auth', 'redirectUrls'],
    ['data', 'auth', 'REDIRECT_URLS'],
    ['data', 'auth', 'uri_allow_list'],
    ['data', 'auth', 'uriAllowList'],
    ['data', 'auth', 'URI_ALLOW_LIST'],
    ['data', 'config', 'auth', 'additional_redirect_urls'],
    ['data', 'config', 'auth', 'additionalRedirectUrls'],
    ['data', 'config', 'auth', 'ADDITIONAL_REDIRECT_URLS'],
    ['data', 'config', 'auth', 'redirect_urls'],
    ['data', 'config', 'auth', 'redirectUrls'],
    ['data', 'config', 'auth', 'REDIRECT_URLS'],
    ['data', 'config', 'auth', 'uri_allow_list'],
    ['data', 'config', 'auth', 'uriAllowList'],
    ['data', 'config', 'auth', 'URI_ALLOW_LIST'],
  ];

  let siteUrl = '';
  for (const candidate of siteCandidates) {
    const normalized = normalizeHttpUrl(getNestedValue(payload, candidate));
    if (normalized) {
      siteUrl = normalized;
      break;
    }
  }

  let additionalRedirectUrls = [];
  for (const candidate of redirectCandidates) {
    const normalized = normalizeAuthRedirectUrlList(getNestedValue(payload, candidate));
    if (normalized.length > 0) {
      additionalRedirectUrls = normalized;
      break;
    }
  }

  return {
    site_url: siteUrl,
    additional_redirect_urls: additionalRedirectUrls,
  };
}

function authConfigContainsRequiredRedirects(config = {}, { siteUrl, redirectUrls } = {}) {
  const expectedSiteUrl = normalizeHttpUrl(siteUrl);
  if (!expectedSiteUrl) return false;
  const expectedRedirects = normalizeAuthRedirectUrlList(redirectUrls);
  const extracted = extractProjectAuthEmailUrlConfig(config);
  if (extracted.site_url !== expectedSiteUrl) return false;
  const actualSet = new Set(extracted.additional_redirect_urls);
  return expectedRedirects.every((url) => actualSet.has(url));
}

function normalizeJwtSecret(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'redacted' || lower === 'masked' || lower === 'hidden') return '';
  if (/[\u2022*]/.test(trimmed)) return '';
  return trimmed;
}

function extractJwtSecret(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const pick = (value) => normalizeJwtSecret(value);
  const direct =
    pick(payload.jwt_secret) ||
    pick(payload.jwtSecret);
  if (direct) return direct;
  const nested =
    pick(payload.jwt?.secret) ||
    pick(payload.jwt?.jwt_secret) ||
    pick(payload.config?.jwt_secret) ||
    pick(payload.auth?.jwt_secret) ||
    pick(payload.settings?.jwt_secret);
  if (nested) return nested;
  if (payload.data && typeof payload.data === 'object') {
    const data = payload.data;
    return (
      pick(data.jwt_secret) ||
      pick(data.jwtSecret) ||
      pick(data.jwt?.secret) ||
      pick(data.jwt?.jwt_secret) ||
      pick(data.config?.jwt_secret) ||
      pick(data.auth?.jwt_secret) ||
      pick(data.settings?.jwt_secret)
    );
  }
  return '';
}

async function getProjectAuthConfig(projectRef, token) {
  if (!projectRef) throw new Error('projectRef is required to fetch auth config');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to fetch auth config');
  const candidates = [
    `/v1/projects/${projectRef}/config/auth`,
    `/v1/projects/${projectRef}/settings`,
    `/v1/projects/${projectRef}/config`,
    `/v1/projects/${projectRef}`,
  ];
  const errors = [];
  let fallback = {
    site_url: '',
    additional_redirect_urls: [],
    source: '',
    raw: null,
  };
  for (const endpointPath of candidates) {
    try {
      const payload = await httpWithRetries('GET', endpointPath, token, null, {
        attempts: 3,
        intervalMs: 1000,
      });
      const extracted = extractProjectAuthEmailUrlConfig(payload);
      const result = {
        ...extracted,
        source: endpointPath,
        raw: payload,
      };
      if (result.site_url || result.additional_redirect_urls.length > 0) {
        return result;
      }
      if (!fallback.source) fallback = result;
    } catch (err) {
      const status = Number(err?.status || 0);
      errors.push(`${endpointPath}: ${err.message}`);
      if (status === 403 || status === 404) continue;
    }
  }
  if (fallback.source) return fallback;
  const details = errors.length ? errors.join(' | ') : 'No eligible endpoints responded.';
  throw new Error(`Unable to fetch project auth config (${details})`);
}

async function setProjectAuthConfig(projectRef, token, config = {}) {
  if (!projectRef) throw new Error('projectRef is required to set auth config');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to set auth config');
  const siteUrl = normalizeHttpUrl(config.site_url || config.siteUrl);
  const redirectUrls = normalizeAuthRedirectUrlList(
    config.additional_redirect_urls || config.additionalRedirectUrls || config.uri_allow_list,
  );
  if (!siteUrl) throw new Error('site_url is required to set auth config');
  const payloads = buildAuthConfigPayloadVariants({
    siteUrl,
    redirectUrls,
  });
  const verifyAttempts = resolveAuthConfigVerifyAttempts(config);
  const verifyDelayMs = resolveAuthConfigVerifyDelayMs(config);
  const candidates = [
    { method: 'PATCH', path: `/v1/projects/${projectRef}/config/auth` },
    { method: 'PUT', path: `/v1/projects/${projectRef}/config/auth` },
    { method: 'PATCH', path: `/v1/projects/${projectRef}/settings` },
    { method: 'PUT', path: `/v1/projects/${projectRef}/settings` },
  ];
  const errors = [];
  for (const candidate of candidates) {
    for (const body of payloads) {
      try {
        await httpWithRetries(candidate.method, candidate.path, token, body, {
          attempts: 3,
          intervalMs: 1000,
        });
        let verification = null;
        for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
          const observed = await getProjectAuthConfig(projectRef, token);
          verification = evaluateAuthConfigWriteState({
            siteUrl,
            redirectUrls,
            actual: observed,
          });
          if (verification.ok) {
            return {
              ...extractProjectAuthEmailUrlConfig(body),
              source: `${candidate.method} ${candidate.path}`,
              observed_source: observed.source || '',
              verification_attempts: attempt,
            };
          }
          if (attempt < verifyAttempts) {
            await sleep(verifyDelayMs);
          }
        }
        errors.push(
          `${candidate.method} ${candidate.path}: write accepted but verification mismatch (actual_site_url=${
            verification?.actualSiteUrl || '<empty>'
          }, missing_redirect_urls=${
            verification?.missingRedirects?.join(',') || '<none>'
          })`,
        );
      } catch (err) {
        const status = Number(err?.status || 0);
        errors.push(`${candidate.method} ${candidate.path}: ${err.message}`);
        if (status === 403) break;
      }
    }
  }
  const details = errors.length ? errors.join(' | ') : 'No eligible endpoints responded.';
  throw new Error(`Unable to set project auth config (${details})`);
}

async function getProjectJwtSecret(projectRef, token) {
  if (!projectRef) throw new Error('projectRef is required to fetch JWT secret');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to fetch JWT secret');
  const candidates = [
    `/v1/projects/${projectRef}/settings`,
    `/v1/projects/${projectRef}/config/auth`,
    `/v1/projects/${projectRef}/config`,
    `/v1/projects/${projectRef}`,
  ];
  for (const path of candidates) {
    try {
      const res = await http('GET', path, token);
      const secret = extractJwtSecret(res);
      if (secret) return secret;
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status === 403 || status === 404) continue;
      console.warn(`[supabase-api] getProjectJwtSecret ${path} failed: ${err.message}`);
    }
  }
  return '';
}

async function setProjectJwtSecret(projectRef, token, secret) {
  if (!projectRef) throw new Error('projectRef is required to set JWT secret');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to set JWT secret');
  if (!secret) throw new Error('jwt secret is required to set JWT secret');
  let projectName = '';
  try {
    const proj = await getProject(projectRef, token);
    projectName = normalizeProjectName(proj?.name);
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status !== 403 && status !== 404) {
      console.warn(`[supabase-api] setProjectJwtSecret could not read project name: ${err.message}`);
    }
  }
  // Some Supabase tenants expose multiple config surfaces. Prefer writing to
  // `/settings` (API-facing) but also attempt `/config/auth` (auth service)
  // so projects stay consistent even when one surface is read-only/laggy.
  const primaryCandidates = [
    [
      { method: 'PATCH', path: `/v1/projects/${projectRef}/settings`, body: { jwt_secret: secret } },
      { method: 'PUT', path: `/v1/projects/${projectRef}/settings`, body: { jwt_secret: secret } },
    ],
    [
      { method: 'PATCH', path: `/v1/projects/${projectRef}/config/auth`, body: { jwt_secret: secret } },
      { method: 'PUT', path: `/v1/projects/${projectRef}/config/auth`, body: { jwt_secret: secret } },
    ],
  ];
  const fallbackCandidates = projectName
    ? [[{ method: 'PATCH', path: `/v1/projects/${projectRef}`, body: { name: projectName, jwt_secret: secret } }]]
    : [];
  const errors = [];
  const successes = [];
  outer: for (const group of primaryCandidates) {
    for (const candidate of group) {
      try {
        await httpWithRetries(candidate.method, candidate.path, token, candidate.body);
        successes.push(candidate);
        break;
      } catch (err) {
        const status = Number(err?.status || 0);
        errors.push(`${candidate.method} ${candidate.path}: ${err.message}`);
        if (status === 403) break outer;
      }
    }
  }
  if (successes.length) return successes[0];

  outerFallback: for (const group of fallbackCandidates) {
    for (const candidate of group) {
      try {
        await httpWithRetries(candidate.method, candidate.path, token, candidate.body);
        successes.push(candidate);
        break;
      } catch (err) {
        const status = Number(err?.status || 0);
        errors.push(`${candidate.method} ${candidate.path}: ${err.message}`);
        if (status === 403) break outerFallback;
      }
    }
  }
  if (successes.length) return successes[0];
  const msg = errors.length ? errors.join(' | ') : 'No eligible endpoints responded.';
  throw new Error(`Unable to set project JWT secret (${msg})`);
}

async function setProjectDatabasePassword({
  projectRef,
  token,
  password,
  maxWaitMs = 0,
  retryDelayMs = 10000,
} = {}) {
  const ref = normalizeProjectName(projectRef);
  const dbPassword = String(password || '').trim();
  if (!ref) throw new Error('projectRef is required to set DB password');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to set DB password');
  if (!dbPassword) throw new Error('db password is required to set DB password');

  const resolvedMaxWaitMs = Math.max(0, parseInt(String(maxWaitMs || '0'), 10) || 0);
  const resolvedRetryDelayMs = Math.max(250, parseInt(String(retryDelayMs || '10000'), 10) || 10000);
  const candidate = {
    method: 'PATCH',
    path: `/v1/projects/${ref}/database/password`,
    body: { password: dbPassword },
  };
  const deadline = Date.now() + resolvedMaxWaitMs;
  const errors = [];

  while (true) {
    try {
      await httpWithRetries(candidate.method, candidate.path, token, candidate.body);
      return candidate;
    } catch (err) {
      const status = Number(err?.status || 0);
      const message = String(err?.message || err || '').toLowerCase();
      errors.push(`${candidate.method} ${candidate.path}: ${err.message}`);
      const retryable =
        status !== 403 &&
        (
          [409, 423, 425, 429, 500, 502, 503, 504].includes(status) ||
          message.includes('connection terminated unexpectedly') ||
          message.includes('the database system is starting up') ||
          message.includes('failed to update password')
        );
      const remainingMs = deadline - Date.now();
      if (!(retryable && remainingMs > 0)) break;
      await sleep(Math.min(resolvedRetryDelayMs, remainingMs));
    }
  }

  const details = errors.length ? errors.join(' | ') : 'No eligible endpoints responded.';
  throw new Error(`Unable to set project DB password (${details})`);
}

async function ensureProjectJwtSecret({ projectRef, token, explicitSecret, allowSigningKeyRotation } = {}) {
  if (!projectRef) throw new Error('projectRef is required to ensure JWT secret');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to ensure JWT secret');
  const allowRotation = Boolean(allowSigningKeyRotation);
  const trimmedExplicit = String(explicitSecret || '').trim();
  if (trimmedExplicit) {
    // Management API may redact or ignore jwt_secret updates. When allowed,
    // prefer auth signing keys as the source of truth for JWT verification.
    // This is destructive (invalidates existing sessions); use workspace/preview only.
    if (allowRotation) {
      await ensureAuthSigningKeyHs256({
        projectRef,
        token,
        secret: trimmedExplicit,
      });
      return { secret: trimmedExplicit, source: 'explicit', mode: 'auth_signing_key' };
    }
    await setProjectJwtSecret(projectRef, token, trimmedExplicit);
    return { secret: trimmedExplicit, source: 'explicit', mode: 'project_config' };
  }
  const existing = await getProjectJwtSecret(projectRef, token);
  if (existing) return { secret: existing, source: 'project', mode: 'project_config' };
  const generated = randomJwtSecret();
  if (allowRotation) {
    await ensureAuthSigningKeyHs256({
      projectRef,
      token,
      secret: generated,
    });
    return { secret: generated, source: 'generated', mode: 'auth_signing_key' };
  }
  await setProjectJwtSecret(projectRef, token, generated);
  return { secret: generated, source: 'generated', mode: 'project_config' };
}

function normalizeSigningKeyStatus(value) {
  return String(value || '').trim();
}

function normalizeSigningKeyAlgorithm(value) {
  return String(value || '').trim();
}

function unwrapSigningKeysResponse(payload) {
  if (!payload) return [];
  if (Array.isArray(payload?.keys)) return payload.keys;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function listAuthSigningKeys(projectRef, token) {
  const ref = normalizeProjectName(projectRef);
  if (!ref) throw new Error('projectRef is required to list auth signing keys');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to list auth signing keys');
  const res = await httpWithRetries(
    'GET',
    `/v1/projects/${encodeURIComponent(ref)}/config/auth/signing-keys`,
    token,
    null,
    { attempts: 4, intervalMs: 1500 },
  );
  return unwrapSigningKeysResponse(res).map((row) => ({
    id: String(row?.id || '').trim(),
    status: normalizeSigningKeyStatus(row?.status),
    algorithm: normalizeSigningKeyAlgorithm(row?.algorithm),
    raw: row,
  }));
}

async function createAuthSigningKey(projectRef, token, { algorithm, privateJwk } = {}) {
  const ref = normalizeProjectName(projectRef);
  const algo = normalizeSigningKeyAlgorithm(algorithm);
  if (!ref) throw new Error('projectRef is required to create auth signing key');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to create auth signing key');
  if (!algo) throw new Error('algorithm is required to create auth signing key');
  const body = { algorithm: algo };
  if (privateJwk && typeof privateJwk === 'object') body.private_jwk = privateJwk;
  return httpWithRetries(
    'POST',
    `/v1/projects/${encodeURIComponent(ref)}/config/auth/signing-keys`,
    token,
    body,
    { attempts: 4, intervalMs: 1500 },
  );
}

async function updateAuthSigningKey(projectRef, token, keyId, { status } = {}) {
  const ref = normalizeProjectName(projectRef);
  const id = String(keyId || '').trim();
  const nextStatus = normalizeSigningKeyStatus(status);
  if (!ref) throw new Error('projectRef is required to update auth signing key');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to update auth signing key');
  if (!id) throw new Error('keyId is required to update auth signing key');
  if (!nextStatus) throw new Error('status is required to update auth signing key');
  return httpWithRetries(
    'PATCH',
    `/v1/projects/${encodeURIComponent(ref)}/config/auth/signing-keys/${encodeURIComponent(id)}`,
    token,
    { status: nextStatus },
    { attempts: 4, intervalMs: 1500 },
  );
}

function isTooManyPreviouslyUsedSigningKeysError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 422) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || err.body?.details || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('previously used') && text.includes('signing') && text.includes('revoke');
}

function isStandbySigningKeyCapacityError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 409 && status !== 422) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || err.body?.details || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return (
    text.includes('standby') &&
    text.includes('signing key') &&
    (text.includes('already has') ||
      text.includes('in standby') ||
      text.includes('failed to create new signing key in standby status') ||
      text.includes('can\'t be promoted') ||
      text.includes('change the other key\'s status') ||
      text.includes('previously_used') ||
      text.includes('in_use'))
  );
}

function parseSigningKeyStatusTransitionError(err) {
  if (!err) return { currentStatus: '', targetStatus: '' };
  const msg = String(err.message || '').trim();
  const bodyMsg = String(err.body?.message || err.body?.error || err.body?.details || '').trim();
  const text = `${msg} ${bodyMsg}`;

  let currentStatus = '';
  let targetStatus = '';

  const currentAndTargetMatch =
    text.match(/status\s+"([^"]+)"\s+and\s+can'?t be moved to\s+"([^"]+)"/i) ||
    text.match(/promoted from\s+"([^"]+)"\s+to\s+"([^"]+)"/i);
  if (currentAndTargetMatch) {
    currentStatus = String(currentAndTargetMatch[1] || '').trim().toLowerCase();
    targetStatus = String(currentAndTargetMatch[2] || '').trim().toLowerCase();
  }

  if (!targetStatus) {
    const failedToSetMatch = text.match(/set signing key status to\s+"([^"]+)"/i);
    if (failedToSetMatch) {
      targetStatus = String(failedToSetMatch[1] || '').trim().toLowerCase();
    }
  }

  return { currentStatus, targetStatus };
}

function parseSigningKeyCreatedAtMs(key) {
  const raw = key?.raw || key;
  const candidates = [
    raw?.created_at,
    raw?.createdAt,
    raw?.inserted_at,
    raw?.insertedAt,
    raw?.updated_at,
    raw?.updatedAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const t = Date.parse(String(candidate));
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function compareSigningKeysForRevocation(a, b) {
  const aTime = parseSigningKeyCreatedAtMs(a);
  const bTime = parseSigningKeyCreatedAtMs(b);
  if (aTime != null && bTime != null && aTime !== bTime) return aTime - bTime;
  if (aTime != null && bTime == null) return -1;
  if (aTime == null && bTime != null) return 1;
  const aId = String(a?.id || '').trim();
  const bId = String(b?.id || '').trim();
  return aId.localeCompare(bId);
}

function selectAuthSigningKeyToRevoke(signingKeys) {
  const list = Array.isArray(signingKeys) ? signingKeys.filter(Boolean) : [];
  const previouslyUsed = list.filter((row) => String(row?.status || '').toLowerCase() === 'previously_used' && row?.id);
  if (!previouslyUsed.length) return null;

  // Prefer revoking non-HS256 keys first to avoid invalidating HS256 legacy API keys.
  const nonHs = previouslyUsed.filter((row) => {
    const alg = String(row?.algorithm || '').trim();
    return Boolean(alg) && alg.toUpperCase() !== 'HS256';
  });
  const unknownAlg = previouslyUsed.filter((row) => !String(row?.algorithm || '').trim());
  const hs = previouslyUsed.filter((row) => String(row?.algorithm || '').trim().toUpperCase() === 'HS256');

  const ordered = (nonHs.length ? nonHs : unknownAlg.length ? unknownAlg : hs).slice().sort(compareSigningKeysForRevocation);
  return ordered[0] || null;
}

function selectAuthSigningKeysToRevoke(signingKeys, maxCount = 1) {
  const list = Array.isArray(signingKeys) ? signingKeys.filter(Boolean) : [];
  const previouslyUsed = list.filter((row) => String(row?.status || '').toLowerCase() === 'previously_used' && row?.id);
  if (!previouslyUsed.length) return [];

  const nonHs = previouslyUsed.filter((row) => {
    const alg = String(row?.algorithm || '').trim();
    return Boolean(alg) && alg.toUpperCase() !== 'HS256';
  });
  const unknownAlg = previouslyUsed.filter((row) => !String(row?.algorithm || '').trim());
  const hs = previouslyUsed.filter((row) => String(row?.algorithm || '').trim().toUpperCase() === 'HS256');

  const ordered = (nonHs.length ? nonHs : unknownAlg.length ? unknownAlg : hs).slice().sort(compareSigningKeysForRevocation);
  return ordered.slice(0, Math.max(1, Number(maxCount || 1)));
}

function selectAuthSigningKeyInStandby(signingKeys) {
  const list = Array.isArray(signingKeys) ? signingKeys.filter(Boolean) : [];
  const standby = list.filter((row) => String(row?.status || '').toLowerCase() === 'standby' && row?.id);
  if (!standby.length) return null;
  const ordered = standby.slice().sort(compareSigningKeysForRevocation);
  return ordered[0] || null;
}

function findAuthSigningKeyById(signingKeys, keyId) {
  const id = String(keyId || '').trim();
  if (!id) return null;
  const list = Array.isArray(signingKeys) ? signingKeys : [];
  return list.find((row) => String(row?.id || '').trim() === id) || null;
}

async function getAuthSigningKeyById(projectRef, token, keyId) {
  const signingKeys = await listAuthSigningKeys(projectRef, token);
  return findAuthSigningKeyById(signingKeys, keyId);
}

async function waitForAuthSigningKeyToLeaveStatuses(
  projectRef,
  token,
  keyId,
  {
    blockedStatuses = [],
    initialKey = null,
    timeoutMs = 15000,
    intervalMs = 1500,
  } = {},
) {
  const id = String(keyId || '').trim();
  if (!id) return null;
  const blocked = new Set(
    (Array.isArray(blockedStatuses) ? blockedStatuses : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!blocked.size) {
    return getAuthSigningKeyById(projectRef, token, id);
  }

  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 15000));
  const delayMs = Math.max(250, Number(intervalMs || 1500));
  let latest = initialKey && typeof initialKey === 'object' ? initialKey : null;
  let needsReadback = Boolean(latest);

  if (latest) {
    const latestStatus = String(latest?.status || '').trim().toLowerCase();
    if (!latest || (!blocked.has(latestStatus) && !needsReadback)) {
      return latest;
    }
  }

  while (Date.now() < deadline) {
    latest = await getAuthSigningKeyById(projectRef, token, id).catch(() => null);
    needsReadback = false;
    const latestStatus = String(latest?.status || '').trim().toLowerCase();
    if (!latest || !blocked.has(latestStatus)) {
      return latest;
    }
    await sleep(delayMs);
  }

  latest = await getAuthSigningKeyById(projectRef, token, id).catch(() => null);
  return latest;
}

async function recycleStandbySigningKey(projectRef, token, { excludeKeyId = '' } = {}) {
  const signingKeys = await listAuthSigningKeys(projectRef, token).catch(() => []);
  const standbyCandidate = selectAuthSigningKeyInStandby(signingKeys);
  if (!standbyCandidate?.id || String(standbyCandidate.id).trim() === String(excludeKeyId || '').trim()) {
    return null;
  }
  try {
    const updated = await updateAuthSigningKey(projectRef, token, standbyCandidate.id, { status: 'previously_used' });
    await waitForAuthSigningKeyToLeaveStatuses(projectRef, token, standbyCandidate.id, {
      blockedStatuses: ['standby'],
      initialKey: updated,
    });
  } catch (standbyErr) {
    const standbyLatest = await getAuthSigningKeyById(projectRef, token, standbyCandidate.id).catch(() => null);
    const standbyLatestStatus = String(standbyLatest?.status || '').trim().toLowerCase();
    if (standbyLatest && standbyLatestStatus === 'standby') {
      throw standbyErr;
    }
  }
  return standbyCandidate;
}

async function createAuthSigningKeyWithAutoRevoke(
  projectRef,
  token,
  { algorithm, privateJwk, maxRevokeAttempts, onRevoke, onRecycleStandby } = {},
) {
  const maxRevokes = Number.isFinite(Number(maxRevokeAttempts)) ? Number(maxRevokeAttempts) : 4;
  let lastErr;
  for (let mitigationAttempt = 0; mitigationAttempt <= maxRevokes; mitigationAttempt++) {
    try {
      return await createAuthSigningKey(projectRef, token, { algorithm, privateJwk });
    } catch (err) {
      lastErr = err;
      const tooManyPreviouslyUsed = isTooManyPreviouslyUsedSigningKeysError(err);
      const standbyConflict = isStandbySigningKeyCapacityError(err);
      const canRecover = tooManyPreviouslyUsed || standbyConflict;
      if (!canRecover || mitigationAttempt === maxRevokes) throw err;
      const signingKeys = await listAuthSigningKeys(projectRef, token);
      const revokeCandidates = standbyConflict
        ? [selectAuthSigningKeyInStandby(signingKeys)].filter(Boolean)
        : selectAuthSigningKeysToRevoke(
            signingKeys,
            Math.max(
              1,
              signingKeys.filter((row) => String(row?.status || '').trim().toLowerCase() === 'previously_used').length - 2,
            ),
          );
      if (!revokeCandidates.length) {
        await sleep(1500);
        continue;
      }
      for (const candidate of revokeCandidates) {
        const reconciled = standbyConflict ? { ...candidate, recovery: 'standby_conflict' } : candidate;
        if (typeof onRevoke === 'function') onRevoke(reconciled);
        if (standbyConflict && typeof onRecycleStandby === 'function') onRecycleStandby(candidate);
        try {
          const updated = await updateAuthSigningKey(projectRef, token, candidate.id, {
            status: standbyConflict ? 'previously_used' : 'revoked',
          });
          await waitForAuthSigningKeyToLeaveStatuses(projectRef, token, candidate.id, {
            blockedStatuses: [standbyConflict ? 'standby' : 'previously_used'],
            initialKey: updated,
          });
        } catch (updateErr) {
          const latest = await getAuthSigningKeyById(projectRef, token, candidate.id).catch(() => null);
          const latestStatus = String(latest?.status || '').trim().toLowerCase();
          const blockingStatus = standbyConflict ? 'standby' : 'previously_used';
          if (!latest || latestStatus !== blockingStatus) {
            continue;
          }
          throw updateErr;
        }
      }
      if (tooManyPreviouslyUsed) {
        const refreshedKeys = await listAuthSigningKeys(projectRef, token).catch(() => []);
        const stillBlocked = refreshedKeys.filter((row) => String(row?.status || '').trim().toLowerCase() === 'previously_used').length >= 3;
        if (stillBlocked) {
          await sleep(1500);
        }
      } else if (standbyConflict) {
        const refreshedStandby = selectAuthSigningKeyInStandby(await listAuthSigningKeys(projectRef, token).catch(() => []));
        if (refreshedStandby?.id) {
          await sleep(1500);
        }
      }
    }
  }
  throw lastErr;
}

async function promoteAuthSigningKeyToInUse(projectRef, token, key) {
  const id = String(key?.id || '').trim();
  if (!id) throw new Error('Auth signing key creation did not return an id.');

  let latest = key;
  let currentStatus = String(latest?.status || '').trim().toLowerCase();
  let lastErr = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (currentStatus === 'in_use') return latest;
    try {
      if (currentStatus === 'previously_used' || currentStatus === 'revoked') {
        latest = await updateAuthSigningKey(projectRef, token, id, { status: 'standby' });
      } else {
        latest = await updateAuthSigningKey(projectRef, token, id, { status: 'in_use' });
      }
      currentStatus = String(latest?.status || '').trim().toLowerCase();
      continue;
    } catch (err) {
      lastErr = err;
      const transitionHint = parseSigningKeyStatusTransitionError(err);
      const hintedCurrentStatus = String(transitionHint.currentStatus || '').trim().toLowerCase();
      const hintedTargetStatus = String(transitionHint.targetStatus || '').trim().toLowerCase();
      const couldBeStandbyConflict =
        currentStatus === 'previously_used' ||
        currentStatus === 'revoked' ||
        hintedTargetStatus === 'standby';
      if (couldBeStandbyConflict && (isStandbySigningKeyCapacityError(err) || hintedTargetStatus === 'standby')) {
        const standbyCandidate = await recycleStandbySigningKey(projectRef, token, { excludeKeyId: id });
        if (standbyCandidate?.id) {
          latest = await getAuthSigningKeyById(projectRef, token, id).catch(() => latest);
          currentStatus = String(latest?.status || hintedCurrentStatus || currentStatus).trim().toLowerCase();
          continue;
        }
      }
      if (hintedCurrentStatus && hintedCurrentStatus !== currentStatus) {
        latest = { ...(latest && typeof latest === 'object' ? latest : {}), id, status: hintedCurrentStatus };
        currentStatus = hintedCurrentStatus;
        continue;
      }
      const refreshed = await getAuthSigningKeyById(projectRef, token, id).catch(() => null);
      const refreshedStatus = String(refreshed?.status || '').trim().toLowerCase();
      if (refreshed && refreshedStatus && refreshedStatus !== currentStatus) {
        latest = refreshed;
        currentStatus = refreshedStatus;
        continue;
      }
      if (hintedTargetStatus) {
        await sleep(1500);
        const delayed = await getAuthSigningKeyById(projectRef, token, id).catch(() => null);
        const delayedStatus = String(delayed?.status || '').trim().toLowerCase();
        if (delayed && delayedStatus) {
          latest = delayed;
          currentStatus = delayedStatus;
          continue;
        }
      }
      throw err;
    }
  }

  if (String(latest?.status || '').trim().toLowerCase() === 'in_use') return latest;
  throw lastErr || new Error(`Failed to promote auth signing key ${id} to in_use.`);
}

async function createAuthSigningKeyInUse(
  projectRef,
  token,
  { algorithm, privateJwk, maxRevokeAttempts, onRevoke, onRecycleStandby } = {},
) {
  const created = await createAuthSigningKeyWithAutoRevoke(projectRef, token, {
    algorithm,
    privateJwk,
    maxRevokeAttempts,
    onRevoke,
    onRecycleStandby,
  });
  return promoteAuthSigningKeyToInUse(projectRef, token, created);
}

async function ensureAuthSigningKeyHs256({ projectRef, token, secret, maxRevokeAttempts } = {}) {
  const ref = normalizeProjectName(projectRef);
  if (!ref) throw new Error('projectRef is required to ensure auth signing key');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to ensure auth signing key');
  const secretBytes = resolveHs256SigningKeyBytes(secret);
  if (!secretBytes.length) throw new Error('secret is required to ensure auth signing key');
  const privateJwk = {
    kty: 'oct',
    k: base64UrlEncode(secretBytes),
    alg: 'HS256',
    use: 'sig',
  };
  await createAuthSigningKeyInUse(ref, token, {
    algorithm: 'HS256',
    privateJwk,
    maxRevokeAttempts,
  });
  return { secret: Buffer.isBuffer(secret) ? secret.toString('hex') : String(secret || '').trim(), bytes: secretBytes };
}

async function deleteProject(projectRef, token, { timeoutMs = 0 } = {}) {
  return http('DELETE', `/v1/projects/${projectRef}`, token, undefined, {
    signal: timeoutSignal(timeoutMs),
  });
}

async function deleteBranch(branchId, token, { timeoutMs = 0 } = {}) {
  const id = resolveBranchId({ id: branchId });
  if (!id) throw new Error('branchId is required to delete branch');
  return http('DELETE', `/v1/branches/${encodeURIComponent(id)}`, token, undefined, {
    signal: Number(timeoutMs) > 0
      ? AbortSignal.timeout(Math.max(1, Number.parseInt(String(timeoutMs), 10) || 1))
      : undefined,
  });
}

function sleep(ms) {
  const n = Number(ms || 0);
  if (!n || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function isNotReadyForDeletionError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 400 && status !== 409) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('not ready') && text.includes('delet');
}

function isRemovedResourceError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status === 404) return true;
  if (status !== 400) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('resource has been removed');
}

function isNotReadyForBranchDeletionError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  if (status !== 400 && status !== 409) return false;
  const msg = String(err.message || '').toLowerCase();
  const bodyMsg = String(err.body?.message || err.body?.error || '').toLowerCase();
  const text = `${msg} ${bodyMsg}`;
  return text.includes('not ready') && text.includes('delet');
}

async function deleteProjectWithRetries(projectRef, token, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 15 * 60 * 1000) || 15 * 60 * 1000;
  const intervalMs = Math.max(1, Number(opts.intervalMs ?? 15 * 1000));
  const organizationId = String(opts.organizationId || '').trim();
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : sleep;
  const deleteProjectFn = typeof opts.deleteProjectFn === 'function' ? opts.deleteProjectFn : deleteProject;
  const getProjectFn = typeof opts.getProjectFn === 'function' ? opts.getProjectFn : getProject;
  const listProjectsFn = typeof opts.listProjectsFn === 'function' ? opts.listProjectsFn : listProjects;
  const normalizedProjectRef = String(projectRef || '').trim().toLowerCase();
  if (!organizationId) {
    const error = new Error(
      `Cannot delete project ${projectRef}: organizationId is required for same-token deletion proof`,
    );
    error.status = 400;
    error.code = 'supabase_project_delete_identity_missing';
    throw error;
  }
  if (!isCanonicalSupabaseProjectRef(normalizedProjectRef)) {
    const error = new Error(
      `Cannot delete project ${projectRef}: projectRef must be a canonical 20-letter immutable Supabase project ref`,
    );
    error.status = 400;
    error.code = 'supabase_project_delete_identity_invalid';
    throw error;
  }
  const start = nowFn();
  const remainingMs = () => Math.max(0, timeoutMs - (nowFn() - start));
  const sleepWithinDeadline = async (requestedDelayMs) => {
    const remainingBeforeSleepMs = remainingMs();
    if (remainingBeforeSleepMs <= 0) return false;
    await sleepFn(Math.min(Math.max(0, Number(requestedDelayMs) || 0), remainingBeforeSleepMs));
    return remainingMs() > 0;
  };
  const retryDelayMs = (err) => {
    const status = Number(err?.status || 0);
    if (status !== 429) return intervalMs;
    const providerDelayMs = parseRetryDelayFromError(err, nowFn());
    return providerDelayMs == null ? intervalMs : providerDelayMs;
  };
  const isRetryableRequestError = (err) => {
    const status = Number(err?.status || 0);
    return isTransientFetchError(err) || [429, 500, 502, 503, 504].includes(status);
  };
  let attempt = 0;
  let deleteAccepted = false;
  while (remainingMs() > 0) {
    attempt++;
    if (!deleteAccepted) {
      if (opts.beforeDelete) await opts.beforeDelete();
      const deleteRequestBudgetMs = remainingMs();
      if (deleteRequestBudgetMs <= 0) break;
      try {
        await deleteProjectFn(projectRef, token, { timeoutMs: deleteRequestBudgetMs });
        deleteAccepted = true;
      } catch (err) {
        if (isRemovedResourceError(err)) return;
        if (
          isNotReadyForDeletionError(err) ||
          isRetryableRequestError(err)
        ) {
          if (!(await sleepWithinDeadline(retryDelayMs(err)))) break;
          continue;
        }
        err.attempt = attempt;
        throw err;
      }
    }

    const getRequestBudgetMs = remainingMs();
    if (getRequestBudgetMs <= 0) break;
    try {
      const project = await getProjectFn(projectRef, token, { timeoutMs: getRequestBudgetMs });
      const status = String(project?.status || project?.project_status || '').trim().toLowerCase();
      if (status.includes('removed') || status.includes('deleted')) return;
    } catch (err) {
      if (isRemovedResourceError(err)) return;
      const status = Number(err?.status || 0);
      if (deleteAccepted && status === 403) {
        let organizationProjects;
        try {
          const listRequestBudgetMs = remainingMs();
          if (listRequestBudgetMs <= 0) break;
          organizationProjects = await listProjectsFn({
            token,
            organizationId,
            requireVerifiableResponse: true,
            timeoutMs: listRequestBudgetMs,
          });
          organizationProjects = assertVerifiableProjectList(organizationProjects);
        } catch (listError) {
          if (
            listError?.code !== 'supabase_project_list_unverifiable' &&
            isRetryableRequestError(listError)
          ) {
            if (!(await sleepWithinDeadline(retryDelayMs(listError)))) break;
            continue;
          }
          const safeReason = listError?.code === 'supabase_project_list_unverifiable'
            ? 'unverifiable_response'
            : `status_${Number(listError?.status || 0) || 'unknown'}`;
          const confirmationError = new Error(
            `Cannot confirm project ${projectRef} deletion after accepted DELETE: ` +
              `complete same-token project visibility is unavailable or unverifiable (${safeReason})`,
          );
          confirmationError.status = Number(listError?.status || 0) || 403;
          confirmationError.attempt = attempt;
          confirmationError.cause = listError;
          throw confirmationError;
        }

        const projectStillVisible = organizationProjects.some((project) =>
          resolveProjectRef(project).toLowerCase() === normalizedProjectRef,
        );
        if (!projectStillVisible) return;
      } else if (isRetryableRequestError(err)) {
        if (!(await sleepWithinDeadline(retryDelayMs(err)))) break;
        continue;
      } else {
        err.attempt = attempt;
        throw err;
      }
    }

    if (!(await sleepWithinDeadline(intervalMs))) break;
  }
  const e = new Error(`Timeout confirming project ${projectRef} deletion after ${attempt} attempts`);
  e.status = 408;
  throw e;
}

async function deleteBranchWithRetries(branchId, token, opts = {}) {
  const id = resolveBranchId({ id: branchId });
  if (!id) throw new Error('branchId is required to delete branch');
  const timeoutMs = Number(opts.timeoutMs ?? 10 * 60 * 1000) || 10 * 60 * 1000;
  const intervalMs = Math.max(1, Number(opts.intervalMs ?? 10 * 1000));
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : sleep;
  const deleteBranchFn = typeof opts.deleteBranchFn === 'function' ? opts.deleteBranchFn : deleteBranch;
  const start = nowFn();
  let attempt = 0;
  while (nowFn() - start < timeoutMs) {
    if (opts.beforeDelete) await opts.beforeDelete();
    const remainingBeforeRequestMs = Math.max(0, timeoutMs - (nowFn() - start));
    if (remainingBeforeRequestMs <= 0) break;
    attempt++;
    try {
      await deleteBranchFn(id, token, { timeoutMs: remainingBeforeRequestMs });
      return;
    } catch (err) {
      if (err && Number(err.status || 0) === 404) return; // already deleted
      if (isRemovedResourceError(err)) return;
      const status = Number(err?.status || 0);
      if (
        isNotReadyForBranchDeletionError(err) ||
        isTransientFetchError(err) ||
        [429, 500, 502, 503, 504].includes(status)
      ) {
        const remainingBeforeSleepMs = Math.max(0, timeoutMs - (nowFn() - start));
        if (remainingBeforeSleepMs <= 0) break;
        await sleepFn(Math.min(intervalMs, remainingBeforeSleepMs));
        continue;
      }
      err.attempt = attempt;
      throw err;
    }
  }
  const e = new Error(`Timeout deleting branch ${id} after ${attempt} attempts`);
  e.status = 408;
  throw e;
}

function unverifiableProjectListError(detail) {
  const error = new Error(`Supabase project list response is not verifiable: ${detail}`);
  error.status = 502;
  error.code = 'supabase_project_list_unverifiable';
  return error;
}

function resolveProjectOrganizationIdentity(project) {
  return {
    id: normalizeProjectName(project?.organization_id || project?.organizationId),
    slug: normalizeProjectName(project?.organization_slug || project?.organizationSlug),
  };
}

function assertVerifiableProjectList(projects) {
  if (!Array.isArray(projects)) {
    throw unverifiableProjectListError('expected the documented top-level project array');
  }
  const seenRefs = new Set();
  projects.forEach((project, index) => {
    const ref = resolveProjectRef(project).toLowerCase();
    if (!isCanonicalSupabaseProjectRef(ref)) {
      throw unverifiableProjectListError(`row ${index} lacks a canonical 20-letter immutable project ref`);
    }
    if (seenRefs.has(ref)) {
      throw unverifiableProjectListError(`row ${index} duplicates immutable project ref ${ref}`);
    }
    seenRefs.add(ref);
    const organization = resolveProjectOrganizationIdentity(project);
    if (!organization.id && !organization.slug) {
      throw unverifiableProjectListError(
        `row ${index} lacks organization identity`,
      );
    }
  });
  return projects;
}

function filterProjectsByOrganization(projects, organizationId) {
  const expected = normalizeProjectName(organizationId);
  if (!expected) throw new Error('SUPABASE_ORG_ID is required to filter projects');
  return projects.filter((project, index) => {
    const organization = resolveProjectOrganizationIdentity(project);
    if (!organization.id && !organization.slug) {
      throw unverifiableProjectListError(`row ${index} lacks organization identity`);
    }
    return organization.id === expected || organization.slug === expected;
  });
}

async function listProjects({
  token,
  organizationId,
  requireVerifiableResponse = false,
  timeoutMs = 0,
} = {}) {
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to list projects');
  if (!organizationId) throw new Error('SUPABASE_ORG_ID is required to list projects');
  const res = await http('GET', '/v1/projects', token, undefined, {
    signal: timeoutSignal(timeoutMs),
  });
  if (requireVerifiableResponse) return assertVerifiableProjectList(res);
  const projects = Array.isArray(res)
    ? res
    : (Array.isArray(res?.projects) ? res.projects : []);
  return filterProjectsByOrganization(projects, organizationId);
}

async function assertOrganizationAccess({ token, organizationId } = {}) {
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required to validate organization access');
  if (!organizationId) throw new Error('SUPABASE_ORG_ID is required to validate organization access');
  try {
    await listProjects({ token, organizationId });
    return { ok: true };
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status === 401 || status === 403 || status === 404) {
      const detail = String(err?.body?.message || err?.body?.error || err?.message || '').trim();
      throw new Error(
        `Supabase organization access preflight failed for SUPABASE_ORG_ID=${organizationId} (status ${status}). ` +
          'Verify SUPABASE_ACCESS_TOKEN has access to that organization.' +
          (detail ? ` Details: ${detail}` : ''),
      );
    }
    throw err;
  }
}

async function findProjectByName({ token, organizationId, name } = {}) {
  const wanted = normalizeProjectLookupName(name);
  if (!wanted) throw new Error('name is required to find project by name');
  const projects = await listProjects({ token, organizationId });
  const existing =
    projects.find((p) => normalizeProjectLookupName(p?.name) === wanted) || null;
  if (!existing) return null;
  return {
    project_ref: resolveProjectRef(existing),
    name: normalizeProjectName(existing?.name),
    region: normalizeProjectName(existing?.region || existing?.cloud_region || existing?.db_region),
    raw: existing,
  };
}

async function ensureProject(opts) {
  const reuseExisting = Boolean(opts?.reuseExisting);
  try {
    const created = await createProject(opts);
    return { ...created, reused: false };
  } catch (err) {
    if (!reuseExisting) throw err;

    const token = opts?.token;
    const organizationId = opts?.organizationId;
    const name = opts?.name;
    const dbPass = normalizeProjectName(opts?.dbPass);
    const status = Number(err?.status || 0);
    const canAttemptReuse = isProjectNameAlreadyExistsError(err) || status === 403;
    if (!canAttemptReuse) throw err;

    let existing = null;
    try {
      existing = await findProjectByName({ token, organizationId, name });
    } catch (lookupErr) {
      if (status === 403) {
        throw withProjectCreateDiagnostics(err, opts || {});
      }
      throw lookupErr;
    }
    const projectRef = normalizeProjectName(existing?.project_ref);
    if (!projectRef) {
      if (status === 403) throw withProjectCreateDiagnostics(err, opts || {});
      throw err;
    }
    if (!dbPass) {
      throw new Error(
        `Supabase project '${normalizeProjectName(name)}' already exists (ref=${projectRef}) but dbPass was not provided; set SUPABASE_DB_PASSWORD (or pass dbPass) to reuse.`,
      );
    }
    return {
      project_ref: projectRef,
      db_pass: dbPass,
      region: existing?.region || opts?.region,
      reused: true,
      reused_without_create_permission: status === 403,
    };
  }
}

module.exports = {
  inspectOwnedPreviewWorkspace,
  createProject,
  createBranch,
  ensureBranch,
  isInconclusiveBranchCreateError,
  ensureProject,
  getProject,
  extractPoolerHostsFromPayload,
  resolveProjectPoolerHost,
  listProjects,
  assertOrganizationAccess,
  buildAuthConfigPayloadVariants,
  evaluateAuthConfigWriteState,
  resolveAuthConfigVerifyAttempts,
  resolveAuthConfigVerifyDelayMs,
  extractProjectAuthEmailUrlConfig,
  authConfigContainsRequiredRedirects,
  listBranches,
  findBranchByName,
  getBranchConfig,
  isCanonicalSupabaseDatabaseHost,
  isCanonicalPostgresPort,
  isCanonicalSupabasePoolerHost,
  normalizeSupabasePoolerRegion,
  resolveSupabasePoolerRegionFromHost,
  isCanonicalSupabaseProjectRef,
  validateBranchDatabaseConfig,
  waitForBranchDatabaseConfig,
  findProjectByName,
  resolveBranchId,
  resolveBranchProjectRef,
  deleteBranch,
  deleteBranchWithRetries,
  waitUntilReady,
  getApiKeys,
  getProjectAuthConfig,
  setProjectAuthConfig,
  getProjectJwtSecret,
  setProjectJwtSecret,
  setProjectDatabasePassword,
  ensureProjectJwtSecret,
  listAuthSigningKeys,
  createAuthSigningKey,
  createAuthSigningKeyWithAutoRevoke,
  createAuthSigningKeyInUse,
  selectAuthSigningKeyToRevoke,
  selectAuthSigningKeyInStandby,
  isTooManyPreviouslyUsedSigningKeysError,
  isStandbySigningKeyCapacityError,
  ensureAuthSigningKeyHs256,
  updateAuthSigningKey,
  deleteProject,
  deleteProjectWithRetries,
  randomJwtSecret,
};
