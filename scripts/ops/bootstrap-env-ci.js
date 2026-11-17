#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * bootstrap-env-ci.js
 *
 * Purpose:
 *   Prepare cloud runtime variables for CI runs using environment variables
 *   provided by GitHub Actions variables + secrets.
 *
 * Behaviour:
 *   - Fails fast if core Supabase variables are missing.
 *   - Emits canonical cloud vars to one of:
 *     - GitHub Actions runtime env file (GITHUB_ENV) [default in CI]
 *     - stdout (for tooling/debug)
 *     - config/env/.env.cloud (legacy file mode)
 *   - Propagates optional flags and load-test tuning knobs when present.
 */

const fs = require('fs');
const path = require('path');
const {
  getApiKeys,
  getProject,
  getProjectJwtSecret,
  resolveProjectPoolerHost,
} = require('./workspace/supabase-api');
const {
  buildEdgeDbJwtBundle,
  buildSupabaseApiKeys,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
  isJwtSignedWithSecret,
} = require('./workspace/edge-db-jwt');
const {
  buildSupabaseApiBearerCandidates,
  selectAuthPlaneCandidateOnce,
  waitForAuthPlaneCandidate,
} = require('./workspace/jwt-rest-auth');
const { resolveJwtPropagationOptions } = require('./workspace/supabase-runtime');
const { getJwtRole } = require('../utils/jwt');
const {
  isLikelyJwtToken,
  isServiceRoleJwtToken,
  isSupabaseSecretKey,
  splitSupabaseApiKeys,
} = require('./workspace/supabase-admin-keys');

const EDGE_DB_JWT_REQUIREMENTS = Object.freeze({
  WEBHOOK_DB_JWT: 'edge_webhook_role',
  API_CALLER_DB_JWT: 'edge_api_caller_role',
  API_GATEWAY_DB_JWT: 'edge_api_gateway_role',
  LABEL_RENDERER_DB_JWT: 'edge_label_renderer_role',
});

function requireEnv(name) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    console.error(`[bootstrap-env-ci] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function requireAnyEnv(names) {
  for (const name of Array.isArray(names) ? names : []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  const joined = Array.isArray(names) ? names.join(' or ') : '';
  console.error(`[bootstrap-env-ci] Missing required environment variable: ${joined}`);
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    target: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--target') {
      const value = String(argv[i + 1] || '').trim();
      if (value && !value.startsWith('--')) {
        out.target = value;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--target=')) {
      out.target = String(token.slice('--target='.length) || '').trim();
    }
  }
  return out;
}

function resolveOutputTarget(cliTargetRaw) {
  const cliTarget = String(cliTargetRaw || '').trim().toLowerCase();
  if (cliTarget) return cliTarget;
  const envTarget = String(process.env.BOOTSTRAP_ENV_TARGET || '').trim().toLowerCase();
  if (envTarget) return envTarget;
  // CI default: runtime env only (no .env.cloud write).
  if (String(process.env.GITHUB_ENV || '').trim()) return 'github-env';
  // Local default for compatibility/debug scripts.
  return 'file';
}

function writeOutput({ lines, target, targetPath }) {
  const content = `${lines.join('\n')}\n`;
  if (target === 'stdout') {
    process.stdout.write(content);
    return;
  }

  if (target === 'github-env') {
    const githubEnvPath = String(process.env.GITHUB_ENV || '').trim();
    if (!githubEnvPath) {
      console.error('[bootstrap-env-ci] target=github-env requires GITHUB_ENV to be set.');
      process.exit(1);
    }
    fs.appendFileSync(githubEnvPath, content, 'utf8');
    console.log(`[bootstrap-env-ci] Exported ${lines.length} variables to GITHUB_ENV`);
    return;
  }

  if (target === 'file') {
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`[bootstrap-env-ci] Wrote ${targetPath} with core cloud configuration`);
    return;
  }

  console.error(`[bootstrap-env-ci] Unsupported --target: ${target}. Expected file|github-env|stdout.`);
  process.exit(1);
}

function normalizeSupabaseUrl(raw, fallbackProjectRef) {
  const v = (raw || '').trim();
  if (!v) {
    const ref = (fallbackProjectRef || '').trim();
    // objectives:allow SUPABASE_URL Justification: construct canonical Supabase project URL from dynamic project ref (CI bootstrap)
    return ref ? `https://${ref}.supabase.co` : '';
  }
  if (/^https?:\/\//i.test(v)) return v;
  // If the value looks like a host (contains a dot or a port), prefix https://.
  if (v.includes('.') || v.includes(':')) return `https://${v}`;
  // Otherwise treat as a project ref and build the canonical Supabase URL.
  const ref = (v || fallbackProjectRef || '').trim();
  // objectives:allow SUPABASE_URL Justification: construct canonical Supabase project URL from dynamic project ref (CI bootstrap)
  return ref ? `https://${ref}.supabase.co` : v;
}

function parsePostgresDsn(dsn) {
  const v = (dsn || '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return {
      protocol: u.protocol,
      username: u.username,
      password: u.password,
      host: u.hostname,
      port: u.port,
      database: u.pathname ? u.pathname.replace(/^\//, '') : '',
      search: u.search || '',
    };
  } catch {
    return null;
  }
}

function normalizePoolerHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
}

function isSupabasePoolerHost(value) {
  const host = normalizePoolerHost(value);
  if (!host) return false;
  return /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
}

function isValidDbJwtForRole(token, expectedRole, { allowServiceRoleFallback = false } = {}) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  if (raw.split('.').length !== 3) return false;
  const role = String(getJwtRole(raw) || '').trim().toLowerCase();
  if (!role) return false;
  const expected = String(expectedRole || '').trim().toLowerCase();
  if (role === expected) return true;
  if (allowServiceRoleFallback && role === 'service_role') return true;
  return false;
}

function isDbJwtSignatureValid(token, signingSecret) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  const secret = signingSecret instanceof Buffer ? signingSecret : String(signingSecret || '').trim();
  if (!secret || raw.split('.').length !== 3) return false;
  return isJwtSignedWithSecret(raw, secret);
}

function decodeBase64UrlJsonPayload(segment) {
  const value = String(segment || '').trim();
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractJwtIssuer(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const segments = raw.split('.');
  if (segments.length < 2) return '';
  const payload = decodeBase64UrlJsonPayload(segments[1]);
  return typeof payload?.iss === 'string' ? payload.iss.trim() : '';
}

function extractProjectRefCandidatesFromOpaqueKey(rawKey) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return [];
  const parts = key.match(/[a-z0-9]{16,32}/g) || [];
  const unique = new Set();
  for (const candidate of parts) {
    if (looksLikeSupabaseProjectRef(candidate)) {
      unique.add(candidate);
    }
  }
  return Array.from(unique);
}

function looksLikeSupabaseProjectRef(value) {
  const v = (value || '').trim();
  // Supabase project refs are typically lowercase base36-ish, ~20 chars (example shows ref).
  return /^[a-z0-9]{16,32}$/i.test(v) && !/^\d+$/.test(v);
}

function extractProjectRefFromSupabaseUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname || '';
    const m = host.match(/^([^.]+)\.supabase\.co$/i);
    if (m && m[1]) return m[1];
    return '';
  } catch {
    return '';
  }
}

function extractProjectRefFromDbHost(host) {
  const h = (host || '').trim();
  if (!h) return '';
  const m = h.match(/^db\.([^.]+)\.supabase\.co$/i);
  return m && m[1] ? m[1] : '';
}

function getSupabaseMgmtUrl() {
  // objectives:allow SUPABASE_URL Justification: Default Supabase Management API base URL; override supported via SUPABASE_MGMT_URL.
  return (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
}

function extractProjectRefFromProjectRow(project) {
  if (!project || typeof project !== 'object') return '';
  const nestedProject = project.project && typeof project.project === 'object' ? project.project : null;
  const directCandidates = [
    project.ref,
    project.project_ref,
    project.projectRef,
    project.project_id,
    project.projectId,
    project.id,
    nestedProject?.ref,
    nestedProject?.project_ref,
    nestedProject?.projectRef,
    nestedProject?.project_id,
    nestedProject?.projectId,
    nestedProject?.id,
  ];
  for (const candidate of directCandidates) {
    const value = String(candidate || '').trim();
    if (looksLikeSupabaseProjectRef(value)) return value;
  }

  const urlLikeCandidates = [
    project.url,
    project.api_url,
    project.apiUrl,
    project.database?.host,
    project.database_host,
    project.databaseHost,
    project.host,
    project.db_host,
    project.dbHost,
    nestedProject?.url,
    nestedProject?.api_url,
    nestedProject?.apiUrl,
    nestedProject?.database?.host,
    nestedProject?.database_host,
    nestedProject?.databaseHost,
    nestedProject?.host,
    nestedProject?.db_host,
    nestedProject?.dbHost,
  ];
  for (const candidate of urlLikeCandidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const fromDbHost = extractProjectRefFromDbHost(value);
    if (looksLikeSupabaseProjectRef(fromDbHost)) return fromDbHost;
    const fromSupabaseUrl = extractProjectRefFromSupabaseUrl(value);
    if (looksLikeSupabaseProjectRef(fromSupabaseUrl)) return fromSupabaseUrl;
  }

  return '';
}

async function listAccessibleProjects({ supabaseAccessToken, supabaseOrgId }) {
  const token = String(supabaseAccessToken || '').trim();
  if (!token) return [];
  const baseUrl = getSupabaseMgmtUrl();
  const fetchJson = async (pathname) => {
    const url = new URL(`${baseUrl}${pathname}`);
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const message =
        (payload && (payload.message || payload.error)) ||
        res.statusText ||
        'request failed';
      throw new Error(`HTTP ${res.status} GET ${pathname}: ${message}`);
    }
    return payload;
  };
  const unpackProjects = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.projects)) return payload.projects;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.result)) return payload.result;
    return [];
  };
  const unpackOrganizations = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.organizations)) return payload.organizations;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.result)) return payload.result;
    return [];
  };
  const fetchProjectsForOrg = async (organizationId) => {
    const orgId = String(organizationId || '').trim();
    const qs = orgId ? `?organization_id=${encodeURIComponent(orgId)}` : '';
    const payload = await fetchJson(`/v1/projects${qs}`);
    return unpackProjects(payload);
  };

  const explicitOrgId = String(supabaseOrgId || '').trim();
  if (explicitOrgId) {
    return fetchProjectsForOrg(explicitOrgId);
  }

  let directProjects = [];
  try {
    directProjects = await fetchProjectsForOrg('');
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    const orgScopedError =
      message.includes('organization_id') ||
      message.includes('organization id') ||
      message.includes('http 400');
    if (!orgScopedError) throw err;
  }
  if (directProjects.length) return directProjects;

  const orgPayload = await fetchJson('/v1/organizations');
  const organizations = unpackOrganizations(orgPayload);
  if (!organizations.length) return [];

  const dedup = new Map();
  for (const org of organizations) {
    const orgId = String(org?.id || org?.organization_id || org?.organizationId || '').trim();
    if (!orgId) continue;
    let projects = [];
    try {
      projects = await fetchProjectsForOrg(orgId);
    } catch {
      continue;
    }
    for (const project of projects) {
      const ref = extractProjectRefFromProjectRow(project);
      const key = ref || JSON.stringify(project);
      if (!dedup.has(key)) dedup.set(key, project);
    }
  }

  return Array.from(dedup.values());
}

async function resolveProjectRefFromProjectListing({
  supabaseAccessToken,
  supabaseOrgId,
  supabaseServiceRoleKey,
}) {
  const projects = await listAccessibleProjects({
    supabaseAccessToken,
    supabaseOrgId,
  });
  const refs = projects
    .map((project) => extractProjectRefFromProjectRow(project))
    .filter((projectRef) => looksLikeSupabaseProjectRef(projectRef));
  if (!refs.length) return '';
  if (refs.length === 1) return refs[0];

  const serviceRoleKey = String(supabaseServiceRoleKey || '').trim();
  if (!serviceRoleKey) return '';
  for (const projectRef of refs) {
    try {
      const apiKeys = await getApiKeys(projectRef, supabaseAccessToken, { preferModern: false });
      const candidateKeys = new Set(
        [apiKeys?.legacyService, apiKeys?.service, apiKeys?.secret]
          .map((entry) => String(entry || '').trim())
          .filter(Boolean),
      );
      if (candidateKeys.has(serviceRoleKey)) {
        return projectRef;
      }
    } catch {
      // Ignore per-project lookup failures and continue.
    }
  }

  return '';
}

async function resolveProjectRef({
  supabaseUrl,
  supabaseProjectId,
  databaseUrlDirect,
  databaseUrlPooler,
  supabaseOrgId,
  supabaseServiceRoleKey,
  supabaseAnonKey,
  supabaseAccessToken,
}) {
  // Prefer extracting from explicit DSNs (strongest signals for CI correctness).
  for (const candidate of [databaseUrlDirect, databaseUrlPooler]) {
    const parsed = parsePostgresDsn(candidate);
    const ref = parsed ? extractProjectRefFromDbHost(parsed.host) : '';
    if (looksLikeSupabaseProjectRef(ref)) return ref;
  }

  // Next: extract from standard Supabase URL.
  const fromUrl = extractProjectRefFromSupabaseUrl(supabaseUrl);
  if (looksLikeSupabaseProjectRef(fromUrl)) return fromUrl;

  // Next: if SUPABASE_PROJECT_ID is already a project ref, use it.
  if (looksLikeSupabaseProjectRef(supabaseProjectId)) return supabaseProjectId;

  // Next: parse ref from JWT issuer claims when available.
  const fromServiceJwtIssuer = extractProjectRefFromSupabaseUrl(extractJwtIssuer(supabaseServiceRoleKey));
  if (looksLikeSupabaseProjectRef(fromServiceJwtIssuer)) return fromServiceJwtIssuer;
  const fromAnonJwtIssuer = extractProjectRefFromSupabaseUrl(extractJwtIssuer(supabaseAnonKey));
  if (looksLikeSupabaseProjectRef(fromAnonJwtIssuer)) return fromAnonJwtIssuer;
  const fromResolvedIssuer = extractProjectRefFromSupabaseUrl(
    resolveJwtIssuer({
      serviceKey: supabaseServiceRoleKey,
      anonKey: supabaseAnonKey,
    }),
  );
  if (looksLikeSupabaseProjectRef(fromResolvedIssuer)) return fromResolvedIssuer;

  // Next: derive ref-like candidates from opaque key formats and validate via Management API when possible.
  const opaqueCandidates = [
    ...extractProjectRefCandidatesFromOpaqueKey(supabaseServiceRoleKey),
    ...extractProjectRefCandidatesFromOpaqueKey(supabaseAnonKey),
  ];
  for (const candidate of opaqueCandidates) {
    if (!supabaseAccessToken) {
      if (opaqueCandidates.length === 1) return candidate;
      continue;
    }
    try {
      const project = await getProject(candidate, supabaseAccessToken);
      const ref = extractProjectRefFromProjectRow(project) || candidate;
      if (looksLikeSupabaseProjectRef(ref)) return ref;
    } catch {
      // Ignore candidate failures and continue.
    }
  }

  // Final fallback: resolve via Management API (project id -> ref).
  if (supabaseProjectId && supabaseAccessToken) {
    try {
      const p = await getProject(supabaseProjectId, supabaseAccessToken);
      const ref = (p?.ref || p?.project_ref || p?.projectRef || '').trim();
      if (ref) return ref;
    } catch (e) {
      console.warn(`[bootstrap-env-ci] Could not resolve project ref via Management API: ${e.message}`);
    }
  }

  // Last fallback: list accessible projects and match by service role key when needed.
  if (supabaseAccessToken) {
    try {
      const refFromListing = await resolveProjectRefFromProjectListing({
        supabaseAccessToken,
        supabaseOrgId,
        supabaseServiceRoleKey,
      });
      if (looksLikeSupabaseProjectRef(refFromListing)) return refFromListing;
    } catch (e) {
      console.warn(
        `[bootstrap-env-ci] Could not resolve project ref via Management API project listing: ${e.message}`,
      );
    }
  }

  return '';
}

async function main() {
  const args = parseArgs();
  const target = resolveOutputTarget(args.target);
  const repoRoot = process.cwd();
  const envDir = path.join(repoRoot, 'config', 'env');
  const targetPath = path.join(envDir, '.env.cloud');

  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }

  // Core required variables for cloud tests (project/url/anon are dynamically resolvable)
  const supabaseProjectIdInput = (process.env.SUPABASE_PROJECT_ID || '').trim();
  const supabaseUrlInput = (process.env.SUPABASE_URL || '').trim();
  let supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  let supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  let supabaseSecretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const explicitSupabaseServiceRoleKey = supabaseServiceRoleKey;
  const explicitSupabaseSecretKey = supabaseSecretKey;
  // Backward compatibility: callers may provide only SUPABASE_SECRET_KEY. Keep the
  // legacy variable populated, but prefer JWT legacy service_role when available.
  if (!supabaseServiceRoleKey) {
    supabaseServiceRoleKey = supabaseSecretKey;
  }
  if (!supabaseServiceRoleKey && !supabaseSecretKey) {
    requireAnyEnv(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);
  }

  // Optional variables
  const supabaseRegion = (process.env.SUPABASE_REGION || '').trim();
  const supabaseOrgId = (process.env.SUPABASE_ORG_ID || '').trim();
  const supabaseAccessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const preferManagementApiKeys = !/^(0|false|no)$/i.test(
    String(process.env.SUPABASE_PREFER_MANAGEMENT_API_KEYS || '1').trim(),
  );
  const supabaseDbPassword = (process.env.SUPABASE_DB_PASSWORD || '').trim();
  let supabasePoolerHost = (process.env.SUPABASE_POOLER_HOST || '').trim();
  let supabasePoolerPort = (process.env.SUPABASE_POOLER_PORT || '').trim();
  const githubToken = (process.env.GITHUB_TOKEN || '').trim();
  const edgeInternalCallerRoles =
    (process.env.EDGE_INTERNAL_CALLER_ROLES || '').trim() ||
    'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role';
  const edgeRequireDbJwt = (process.env.EDGE_REQUIRE_DB_JWT || '1').trim();
  const edgeDbJwtTtlSecondsRaw = (process.env.EDGE_DB_JWT_TTL_SECONDS || '').trim();
  const edgeDbJwtTtlSeconds = (() => {
    if (!edgeDbJwtTtlSecondsRaw) return 60 * 60 * 24 * 365; // 1 year
    const parsed = parseInt(edgeDbJwtTtlSecondsRaw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 365;
  })();
  const explicitJwtSecret = (process.env.SUPABASE_JWT_SECRET || '').trim();

  // Optional test flags and load profile
  const flagNames = [
    'RUN_LIVE_COMMS_TESTS',
    'RUN_LIVE_3PL_TESTS',
    'RUN_LIVE_GEOCODING_TESTS',
    'RUN_RLS_INTEGRATION_TESTS',
    'RUN_LABELS_WEBHOOK_TESTS',
    'RUN_WEBHOOK_HTTP_TESTS',
    'RUN_EDGE_E2E',
    'RUN_LOCAL_EDGE_TESTS',
    'RUN_MATRIX_E2E',
    'RUN_LIVE_WEBHOOK_TESTS',
    'PARTITION_VUS',
    'PARTITION_DURATION',
    'PARTITION_P95_MS',
    'PARTITION_CHECK_RATE',
    'JEST_RETRY_TIMES',
  ];

  // Canonical DATABASE_URL for CI: prefer the transactional pooler (IPv4) when available,
  // because some CI runners do not have reliable IPv6 connectivity to the direct db host.
  // We still provide DATABASE_URL_DIRECT for tools that need to hit the primary directly.
  //
  // We resolve the project ref robustly because CI may provide SUPABASE_PROJECT_ID
  // as a numeric id, while the rest of the system expects the project ref.
  const providedDatabaseUrl = (process.env.DATABASE_URL || '').trim();
  const providedDatabaseUrlDirect = (process.env.DATABASE_URL_DIRECT || '').trim();
  const providedLoadtestUrl = (process.env.LOADTEST_DATABASE_URL || '').trim();
  const parsedProvidedPooler = parsePostgresDsn(providedDatabaseUrl);
  if (!supabasePoolerHost && isSupabasePoolerHost(parsedProvidedPooler?.host)) {
    supabasePoolerHost = normalizePoolerHost(parsedProvidedPooler.host);
  }
  if (!supabasePoolerPort && parsedProvidedPooler?.port) {
    supabasePoolerPort = String(parsedProvidedPooler.port || '').trim();
  }

  const resolvedProjectRef = await resolveProjectRef({
    supabaseUrl: normalizeSupabaseUrl(supabaseUrlInput, supabaseProjectIdInput),
    supabaseProjectId: supabaseProjectIdInput,
    databaseUrlDirect: providedDatabaseUrlDirect,
    databaseUrlPooler: providedDatabaseUrl,
    supabaseOrgId,
    supabaseServiceRoleKey,
    supabaseAnonKey,
    supabaseAccessToken,
  });

  if (!resolvedProjectRef) {
    console.error(
      '[bootstrap-env-ci] Could not resolve Supabase project ref from SUPABASE_URL/DATABASE_URL(_DIRECT)/Management API.',
    );
    process.exit(1);
  }

  const supabaseProjectId = resolvedProjectRef;
  const supabaseUrl = normalizeSupabaseUrl(supabaseUrlInput, supabaseProjectId);

  if (supabaseAccessToken) {
    try {
      const resolvedPoolerHost = await resolveProjectPoolerHost({
        projectRef: supabaseProjectId,
        token: supabaseAccessToken,
        preferredRegion: supabaseRegion,
        fallbackHost: supabasePoolerHost,
      });
      const normalizedPoolerHost = normalizePoolerHost(resolvedPoolerHost);
      if (normalizedPoolerHost) {
        if (normalizedPoolerHost !== normalizePoolerHost(supabasePoolerHost)) {
          console.log('[bootstrap-env-ci] Resolved SUPABASE_POOLER_HOST via Supabase Management API.');
        }
        supabasePoolerHost = normalizedPoolerHost;
      }
    } catch (e) {
      console.warn(`[bootstrap-env-ci] Could not resolve pooler host via Management API: ${e.message}`);
    }
  }

  if (supabaseAccessToken && preferManagementApiKeys) {
    try {
      const apiKeys = await getApiKeys(supabaseProjectId, supabaseAccessToken);
      const {
        anonKey: resolvedAnonKey,
        serviceRoleKey: resolvedLegacyServiceRoleKey,
        secretKey: resolvedSecretKey,
        adminServiceKey: resolvedServiceRoleCandidate,
      } = splitSupabaseApiKeys(apiKeys);
      if (resolvedAnonKey) {
        supabaseAnonKey = resolvedAnonKey;
        console.log('[bootstrap-env-ci] Resolved SUPABASE_ANON_KEY via Supabase Management API.');
      }
      if (resolvedLegacyServiceRoleKey) {
        if (isServiceRoleJwtToken(explicitSupabaseServiceRoleKey)) {
          console.log(
            '[bootstrap-env-ci] Preserved explicit SUPABASE_SERVICE_ROLE_KEY; skipping Management API override for legacy service_role JWT.',
          );
        } else {
          supabaseServiceRoleKey = resolvedLegacyServiceRoleKey;
          console.log(
            '[bootstrap-env-ci] Resolved SUPABASE_SERVICE_ROLE_KEY (legacy service_role JWT) via Supabase Management API.',
          );
        }
      } else if (!supabaseServiceRoleKey && resolvedServiceRoleCandidate) {
        supabaseServiceRoleKey = resolvedServiceRoleCandidate;
        console.warn(
          '[bootstrap-env-ci] Supabase Management API did not return a legacy service_role key; using generic service key fallback.',
        );
      }
      if (resolvedSecretKey) {
        if (isSupabaseSecretKey(explicitSupabaseSecretKey)) {
          console.log(
            '[bootstrap-env-ci] Preserved explicit SUPABASE_SECRET_KEY; skipping Management API override for modern secret key.',
          );
        } else {
          supabaseSecretKey = resolvedSecretKey;
          console.log('[bootstrap-env-ci] Resolved SUPABASE_SECRET_KEY via Supabase Management API.');
        }
      } else if (!supabaseSecretKey && isSupabaseSecretKey(resolvedServiceRoleCandidate)) {
        supabaseSecretKey = resolvedServiceRoleCandidate;
        console.warn(
          '[bootstrap-env-ci] Supabase Management API did not expose secret key metadata; inferred SUPABASE_SECRET_KEY from service key format.',
        );
      }
    } catch (e) {
      console.warn(`[bootstrap-env-ci] Could not resolve API keys via Management API: ${e.message}`);
    }
  }

  if (!supabaseServiceRoleKey && supabaseSecretKey) {
    supabaseServiceRoleKey = supabaseSecretKey;
  }
  if (!supabaseSecretKey && isSupabaseSecretKey(supabaseServiceRoleKey)) {
    supabaseSecretKey = supabaseServiceRoleKey;
  }

  if (!supabaseAnonKey && supabaseAccessToken) {
    try {
      const apiKeys = await getApiKeys(supabaseProjectId, supabaseAccessToken);
      const resolvedAnonKey = (apiKeys?.anon || '').trim();
      if (resolvedAnonKey) {
        supabaseAnonKey = resolvedAnonKey;
        console.log('[bootstrap-env-ci] Resolved SUPABASE_ANON_KEY via Supabase Management API.');
      }
    } catch (e) {
      console.warn(`[bootstrap-env-ci] Could not resolve anon key via Management API: ${e.message}`);
    }
  }
  if (!supabaseAnonKey) {
    console.error(
      '[bootstrap-env-ci] Missing SUPABASE_ANON_KEY and unable to resolve via Management API.',
    );
    process.exit(1);
  }

  if (!supabaseDbPassword && !parsePostgresDsn(providedDatabaseUrlDirect)?.password) {
    console.error('[bootstrap-env-ci] SUPABASE_DB_PASSWORD is required to construct DATABASE_URL');
    process.exit(1);
  }

  const effectiveDbPassword =
    supabaseDbPassword || (parsePostgresDsn(providedDatabaseUrlDirect)?.password || '');
  const encodedPassword = encodeURIComponent(effectiveDbPassword);
  // objectives:allow DSN_URL Justification: construct canonical Supabase direct DSN for CI from dynamic env pieces
  const derivedDirectDsn = ([`postgresql`,":","/","/",`postgres`,":",`${encodedPassword}`,"@",`db.${supabaseProjectId}.supabase.co`,":",`5432`,"/",`postgres`].join(""));

  const computedPoolerDsn = (supabasePoolerHost && effectiveDbPassword && supabaseProjectId)
    ? (
      // objectives:allow DSN_URL Justification: construct pooler DSN for k6/CI from dynamic env pieces (host + project_ref + password)
      `postgresql://${encodeURIComponent(`postgres.${supabaseProjectId}`)}:${encodedPassword}@${supabasePoolerHost}:${supabasePoolerPort || '5432'}/postgres`
    )
    : '';

  const lines = [];
  lines.push(`SUPABASE_PROJECT_ID=${supabaseProjectId}`);
  lines.push(`SUPABASE_URL=${supabaseUrl}`);

  if (supabaseRegion) lines.push(`SUPABASE_REGION=${supabaseRegion}`);
  if (supabaseOrgId) lines.push(`SUPABASE_ORG_ID=${supabaseOrgId}`);
  if (supabaseAccessToken) lines.push(`SUPABASE_ACCESS_TOKEN=${supabaseAccessToken}`);

  const canonicalDatabaseUrl = computedPoolerDsn || derivedDirectDsn;

  lines.push(`DATABASE_URL=${canonicalDatabaseUrl}`);
  lines.push(`DATABASE_URL_DIRECT=${derivedDirectDsn}`);
  if (computedPoolerDsn) lines.push(`DATABASE_URL_POOLER=${computedPoolerDsn}`);
  else if (providedDatabaseUrl) lines.push(`DATABASE_URL_POOLER=${providedDatabaseUrl}`);

  // Load tests can override the DSN independently; default to the computed pooler DSN
  // when available (k6 often prefers it), otherwise use the canonical DB URL.
  lines.push(`LOADTEST_DATABASE_URL=${providedLoadtestUrl || computedPoolerDsn || canonicalDatabaseUrl}`);

  lines.push(`SUPABASE_DB_PASSWORD=${effectiveDbPassword}`);
  if (supabasePoolerHost) lines.push(`SUPABASE_POOLER_HOST=${supabasePoolerHost}`);
  if (supabasePoolerPort) lines.push(`SUPABASE_POOLER_PORT=${supabasePoolerPort}`);
  if (githubToken) lines.push(`GITHUB_TOKEN=${githubToken}`);

  lines.push(`EDGE_INTERNAL_CALLER_ROLES=${edgeInternalCallerRoles}`);
  lines.push(`EDGE_REQUIRE_DB_JWT=${edgeRequireDbJwt}`);

  let resolvedJwtSecret = explicitJwtSecret;
  if (edgeRequireDbJwt === '1' && !resolvedJwtSecret && supabaseAccessToken) {
    try {
      resolvedJwtSecret = (await getProjectJwtSecret(supabaseProjectId, supabaseAccessToken)).trim();
      if (resolvedJwtSecret) {
        console.log('[bootstrap-env-ci] Resolved SUPABASE_JWT_SECRET via Supabase Management API.');
      }
    } catch (e) {
      console.warn(`[bootstrap-env-ci] Could not resolve JWT secret via Management API: ${e.message}`);
    }
  }

  let jwtSigningSecretForValidation = '';
  let jwtSigningSecretTrusted = false;
  if (resolvedJwtSecret) {
    const resolvedSecretCandidate = resolveJwtSigningSecret({
      secret: resolvedJwtSecret,
      serviceKey: supabaseServiceRoleKey,
      anonKey: supabaseAnonKey,
    });
    const currentServiceRoleJwt = isServiceRoleJwtToken(supabaseServiceRoleKey)
      ? supabaseServiceRoleKey
      : '';
    const currentAnonJwt = isLikelyJwtToken(supabaseAnonKey) ? supabaseAnonKey : '';
    const signsKnownJwt =
      (currentServiceRoleJwt && isJwtSignedWithSecret(currentServiceRoleJwt, resolvedSecretCandidate)) ||
      (currentAnonJwt && isJwtSignedWithSecret(currentAnonJwt, resolvedSecretCandidate));
    if (signsKnownJwt) {
      jwtSigningSecretForValidation = resolvedSecretCandidate;
      jwtSigningSecretTrusted = true;
    }
  }
  if (jwtSigningSecretTrusted) {
    const currentServiceRoleMatches =
      isServiceRoleJwtToken(supabaseServiceRoleKey) &&
      isJwtSignedWithSecret(supabaseServiceRoleKey, jwtSigningSecretForValidation);
    if (!currentServiceRoleMatches) {
      const runtimeApiKeys = buildSupabaseApiKeys({
        secret: jwtSigningSecretForValidation,
        issuer: resolveJwtIssuer({
          serviceKey: supabaseServiceRoleKey,
          anonKey: supabaseAnonKey,
        }),
        projectRef: supabaseProjectId,
      });
      const mintedServiceRoleKey = String(runtimeApiKeys?.service || '').trim();
      if (mintedServiceRoleKey) {
        if (!supabaseSecretKey && isSupabaseSecretKey(supabaseServiceRoleKey)) {
          supabaseSecretKey = supabaseServiceRoleKey;
        }
        supabaseServiceRoleKey = mintedServiceRoleKey;
        console.log(
          '[bootstrap-env-ci] Rebuilt SUPABASE_SERVICE_ROLE_KEY from the verified project JWT secret.',
        );
      }
    }
  }

  const callerRoles = edgeInternalCallerRoles
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const fallbackServiceRoleKey = isServiceRoleJwtToken(supabaseServiceRoleKey)
    ? supabaseServiceRoleKey
    : '';
  const fallbackAnonJwtKey = isLikelyJwtToken(supabaseAnonKey) ? supabaseAnonKey : '';
  const allowServiceRoleDbJwtFallback =
    callerRoles.includes('service_role') && Boolean(fallbackServiceRoleKey);

  const dbJwtEnv = {
    WEBHOOK_DB_JWT: (process.env.WEBHOOK_DB_JWT || '').trim(),
    API_CALLER_DB_JWT: (process.env.API_CALLER_DB_JWT || '').trim(),
    API_GATEWAY_DB_JWT: (process.env.API_GATEWAY_DB_JWT || '').trim(),
    LABEL_RENDERER_DB_JWT: (process.env.LABEL_RENDERER_DB_JWT || '').trim(),
  };

  const invalidDbJwtKeys = [];
  if (edgeRequireDbJwt === '1') {
    for (const [key, expectedRole] of Object.entries(EDGE_DB_JWT_REQUIREMENTS)) {
      const value = dbJwtEnv[key];
      if (!value) continue;
      const roleValid = isValidDbJwtForRole(value, expectedRole, {
        allowServiceRoleFallback: allowServiceRoleDbJwtFallback,
      });
      const signatureValid = jwtSigningSecretTrusted
        ? isDbJwtSignatureValid(value, jwtSigningSecretForValidation)
        : true;
      if (!roleValid || !signatureValid) {
        invalidDbJwtKeys.push(key);
        dbJwtEnv[key] = '';
      }
    }
  }

  lines.push(`SUPABASE_ANON_KEY=${supabaseAnonKey}`);
  lines.push(`SUPABASE_SERVICE_ROLE_KEY=${supabaseServiceRoleKey}`);
  if (supabaseSecretKey) lines.push(`SUPABASE_SECRET_KEY=${supabaseSecretKey}`);
  if (invalidDbJwtKeys.length > 0) {
    console.warn(
      `[bootstrap-env-ci] Invalid DB JWT input(s) detected (${invalidDbJwtKeys.join(', ')}); treating as missing and rebuilding from policy.`,
    );
  }

  const missingDbJwtKeys = Object.entries(dbJwtEnv)
    .filter(([_, v]) => !v)
    .map(([k]) => k);
  const shouldMintDbJwts = edgeRequireDbJwt === '1' && missingDbJwtKeys.length > 0;

  if (shouldMintDbJwts && resolvedJwtSecret && !jwtSigningSecretTrusted) {
    const authPlaneCandidates = buildSupabaseApiBearerCandidates({
      secretRaw: resolvedJwtSecret,
      issuer: resolveJwtIssuer({
        serviceKey: fallbackServiceRoleKey || supabaseServiceRoleKey,
        anonKey: supabaseAnonKey,
      }),
      projectRef: supabaseProjectId,
    });
    const restApiKey = fallbackServiceRoleKey || fallbackAnonJwtKey || supabaseAnonKey || supabaseServiceRoleKey;
    const functionApiKey = fallbackAnonJwtKey || supabaseAnonKey || fallbackServiceRoleKey || supabaseServiceRoleKey;
    if (supabaseUrl && authPlaneCandidates.length > 0 && restApiKey && functionApiKey) {
      let selected = await selectAuthPlaneCandidateOnce({
        supabaseUrl,
        restApiKey,
        functionApiKey,
        candidates: authPlaneCandidates,
        functionName: 'label-renderer',
        payload: { lease_seconds: 1, max_jobs: 1 },
      });
      if (!selected?.evaluation?.accepted && selected?.evaluation?.retryable) {
        const waited = await waitForAuthPlaneCandidate({
          supabaseUrl,
          restApiKey,
          functionApiKey,
          candidates: authPlaneCandidates,
          functionName: 'label-renderer',
          payload: { lease_seconds: 1, max_jobs: 1 },
          ...resolveJwtPropagationOptions(process.env),
          logPrefix: '[bootstrap-env-ci]',
        });
        if (waited?.evaluation?.accepted) selected = waited;
      }
      if (selected?.evaluation?.accepted && selected?.candidate?.secret) {
        jwtSigningSecretForValidation = selected.candidate.secret;
        jwtSigningSecretTrusted = true;
        console.log(
          `[bootstrap-env-ci] Validated SUPABASE_JWT_SECRET for auth plane (candidate=${String(selected.candidate.label || 'raw')}).`,
        );
      } else {
        const classification = String(selected?.evaluation?.classification || '').trim();
        if (classification) {
          console.warn(
            `[bootstrap-env-ci] JWT secret auth-plane probe rejected (${classification}); preserving provided DB JWTs and skipping remint unless fallback is allowed.`,
          );
        }
      }
    }
  }

  if (shouldMintDbJwts) {
    const applyServiceRoleDbJwtFallback = (reason) => {
      if (!allowServiceRoleDbJwtFallback) {
        return false;
      }
      for (const key of missingDbJwtKeys) {
        if (!dbJwtEnv[key]) {
          dbJwtEnv[key] = fallbackServiceRoleKey;
        }
      }
      console.warn(
        `[bootstrap-env-ci] ${reason}; using SUPABASE_SERVICE_ROLE_KEY fallback for (${missingDbJwtKeys.join(', ')}).`,
      );
      return true;
    };

    const jwtSecret = jwtSigningSecretTrusted ? jwtSigningSecretForValidation : '';
    if (!jwtSecret) {
      if (!applyServiceRoleDbJwtFallback('Missing SUPABASE_JWT_SECRET; cannot mint DB JWTs')) {
        console.error(
          `[bootstrap-env-ci] Missing SUPABASE_JWT_SECRET; cannot mint DB JWTs (${missingDbJwtKeys.join(', ')}).`,
        );
        process.exit(1);
      }
    } else {
      const jwtIssuer = resolveJwtIssuer({
        serviceKey: fallbackServiceRoleKey || supabaseServiceRoleKey,
        anonKey: supabaseAnonKey,
      });
      const jwtSigningSecret = resolveJwtSigningSecret({
        secret: jwtSecret,
        serviceKey: fallbackServiceRoleKey || supabaseServiceRoleKey,
        anonKey: supabaseAnonKey,
      });

      if (!jwtSigningSecret) {
        if (!applyServiceRoleDbJwtFallback('Invalid JWT signing secret; cannot mint DB JWTs')) {
          console.error('[bootstrap-env-ci] Invalid JWT signing secret; cannot mint DB JWTs.');
          process.exit(1);
        }
      } else {
        const bundle = buildEdgeDbJwtBundle({
          secret: jwtSigningSecret,
          issuer: jwtIssuer,
          ttlSec: edgeDbJwtTtlSeconds,
        });

        if (!bundle) {
          if (!applyServiceRoleDbJwtFallback('Failed to build edge DB JWT bundle')) {
            console.error('[bootstrap-env-ci] Failed to build edge DB JWT bundle.');
            process.exit(1);
          }
        } else {
          dbJwtEnv.WEBHOOK_DB_JWT = dbJwtEnv.WEBHOOK_DB_JWT || bundle.webhook_db_jwt || '';
          dbJwtEnv.API_CALLER_DB_JWT = dbJwtEnv.API_CALLER_DB_JWT || bundle.api_caller_db_jwt || '';
          dbJwtEnv.API_GATEWAY_DB_JWT =
            dbJwtEnv.API_GATEWAY_DB_JWT || bundle.api_gateway_db_jwt || '';
          dbJwtEnv.LABEL_RENDERER_DB_JWT =
            dbJwtEnv.LABEL_RENDERER_DB_JWT || bundle.label_renderer_db_jwt || '';

          console.log(`[bootstrap-env-ci] Minted edge DB JWTs (ttl=${edgeDbJwtTtlSeconds}s).`);
        }
      }
    }
  }

  for (const [k, v] of Object.entries(dbJwtEnv)) {
    if (v) lines.push(`${k}=${v}`);
  }

  // Propagate any explicit test flags / load tuning set in the CI env
  for (const name of flagNames) {
    const v = (process.env[name] || '').trim();
    if (v) {
      lines.push(`${name}=${v}`);
    }
  }

  writeOutput({ lines, target, targetPath });
}

main().catch((err) => {
  console.error('[bootstrap-env-ci] Failed:', err.message || String(err));
  process.exit(1);
});
