#!/usr/bin/env node
/**
 * assert-cloud-env.js
 * Fails fast when cloud environment variables are missing or point to non-cloud endpoints.
 * This enforces "live cloud tests only" (no localhost, no mocks) for gating.
 */
/* eslint-disable no-console */
const { loadEnv } = require('../utils/load-env');
const { getJwtRole } = require('../utils/jwt');
const { resolveConfig: resolveGuardedEgressProxyProofConfig } = require('./verify-api-caller-guarded-egress-proxy');

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function isPreviewEnv(env) {
  if (!env || typeof env !== 'object') return false;
  if (isTruthy(env.PREVIEW_MODE) || isTruthy(env.CI_PREVIEW) || isTruthy(env.VERIFY_PREVIEW)) {
    return true;
  }
  for (const key of [
    'PREVIEW_SUPABASE_ACCESS_TOKEN',
    'PREVIEW_SUPABASE_ORG_ID',
    'PREVIEW_PROJECT_NAME',
    'PREVIEW_PROJECT_REF',
  ]) {
    if (String(env[key] || '').trim()) return true;
  }
  return false;
}

function requireEnv(env, name) {
  const v = (env[name] || '').trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function assertDbJwt(env, name, expectedRole) {
  const token = (env[name] || '').trim();
  if (!token) throw new Error(`Missing required environment variable: ${name}`);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error(`${name} must be a JWT with 3 segments`);
  const role = getJwtRole(token).toLowerCase();
  if (!role) throw new Error(`${name} missing role claim`);
  if (role === expectedRole.toLowerCase()) return;
  if (role !== expectedRole.toLowerCase()) {
    throw new Error(`${name} must have role=${expectedRole}; got role=${role}`);
  }
}

function parsePgHost(dsn) {
  // objectives:allow DSN_URL Justification: needed to parse DATABASE_URL and enforce cloud-only hostnames
  // Use URL semantics for URL-style DSNs and fall back to libpq-style
  // key/value parsing (e.g., host=... dbname=...) or bare postgres DSNs
  // (user:pass@host:port/dbname) when needed.
  if (!dsn) return '';
  const v = String(dsn).trim();

  // URL-style DSN: <scheme>://user:pass@host:port/db?params
  try {
    const rewritten = v.replace(/^[a-z]+:\/\/?/i, (m) =>
      m.toLowerCase().startsWith('http') ? m : 'http://'
    );
    const u = new URL(rewritten);
    if (u.hostname) return u.hostname;
  } catch {
    // fall through to non-URL parsing
  }

  // libpq-style: host=... port=... dbname=...
  const hostMatch = v.match(/\bhost=([^ \t\r\n]+)/i);
  if (hostMatch && hostMatch[1]) {
    // Strip surrounding quotes if present.
    return hostMatch[1].replace(/^['"]|['"]$/g, '');
  }

  const hostaddrMatch = v.match(/\bhostaddr=([^ \t\r\n]+)/i);
  if (hostaddrMatch && hostaddrMatch[1]) {
    return hostaddrMatch[1].replace(/^['"]|['"]$/g, '');
  }

  // Bare postgres DSN without a scheme but with userinfo:
  //   user:pass@host:port/dbname?params
  // or just:
  //   host:port/dbname
  try {
    let rest = v;
    const atIdx = rest.indexOf('@');
    if (atIdx >= 0) {
      rest = rest.slice(atIdx + 1);
    }
    const slashIdx = rest.indexOf('/');
    const hostPort = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const hostOnly = hostPort.split(':')[0];
    if (hostOnly) {
      return hostOnly.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // fall through to empty return
  }

  return '';
}

function isSupabaseHost(host) {
  return /\.supabase\.(co|com)$/i.test(String(host || '').trim());
}

function isIpLiteralHost(host) {
  const normalized = String(host || '').trim();
  if (!normalized) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  return normalized.includes(':');
}

function normalizeHostLike(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) {
    try {
      return String(new URL(raw).hostname || '').trim().toLowerCase();
    } catch {
      return '';
    }
  }
  return raw.split(/[/?#]/)[0].split(':')[0].trim().toLowerCase();
}

function parseProjectRefFromDbHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  const match = normalized.match(/^db\.([^.]+)\.supabase\.(co|com)$/i);
  return match && match[1] ? match[1] : '';
}

function parseProjectRefFromSupabaseHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  const match = normalized.match(/^([^.]+)\.supabase\.(co|com)$/i);
  return match && match[1] ? match[1] : '';
}

function looksLikeSupabaseProjectRef(value) {
  return /^[a-z0-9]{16,32}$/i.test(String(value || '').trim());
}

function parseJwtPayload(token) {
  const raw = String(token || '').trim();
  const segments = raw.split('.');
  if (segments.length < 2) return null;
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseProjectRefFromIssuer(issuer) {
  const raw = String(issuer || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return parseProjectRefFromSupabaseHost(u.hostname);
  } catch {
    return '';
  }
}

function parseProjectRefFromJwtClaims(token) {
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload !== 'object') return '';
  const directRef = String(payload.ref || '').trim().toLowerCase();
  if (looksLikeSupabaseProjectRef(directRef)) return directRef;
  const fromIssuer = parseProjectRefFromIssuer(payload.iss || payload.issuer);
  if (looksLikeSupabaseProjectRef(fromIssuer)) return fromIssuer;
  return '';
}

function parseAllowedCustomSupabaseHosts(value) {
  return String(value || '')
    .split(/[,\n;]/)
    .map((entry) => normalizeHostLike(entry))
    .filter(Boolean);
}

function isDbSmokeHostFallbackSelected(env) {
  const selected = String(env?.DB_SMOKE_SELECTED_DSN_NAME || '').trim();
  return /(?:\+ipv4host|\+hostaddr)$/i.test(selected);
}

function isSelectedDbHostFallback(env, dbUrl) {
  const explicitSelections = [
    String(env?.DATABASE_URL_SELECTED_DSN_NAME || '').trim(),
    String(env?.DB_SMOKE_SELECTED_DSN_NAME || '').trim(),
  ].filter(Boolean);
  if (explicitSelections.some((selected) => /(?:\+ipv4host|\+hostaddr)$/i.test(selected))) {
    return true;
  }
  return /\bhostaddr=\d{1,3}(?:\.\d{1,3}){3}\b/i.test(String(dbUrl || '').trim());
}

function validateCloudEnv({ env } = {}) {
  const processEnv = env || process.env;
  const dbUrl = requireEnv(processEnv, 'DATABASE_URL');

  const preview = isPreviewEnv(processEnv);

  const edgeRequireDbJwtRaw = String(processEnv.EDGE_REQUIRE_DB_JWT || '').trim();
  const edgeRequireDbJwt = edgeRequireDbJwtRaw || (preview ? '0' : '');
  if (!preview && edgeRequireDbJwt !== '1') {
    throw new Error(
      `EDGE_REQUIRE_DB_JWT must be set to 1 for cloud gating (got: ${edgeRequireDbJwtRaw || '(empty)'})`,
    );
  }
  if (preview && edgeRequireDbJwt !== '0' && edgeRequireDbJwt !== '1') {
    throw new Error(
      `EDGE_REQUIRE_DB_JWT must be 0 or 1 for preview environments (got: ${edgeRequireDbJwtRaw || '(empty)'})`,
    );
  }

  // SUPABASE_URL is commonly used in integration/edge tests
  const supaUrl = String(processEnv.SUPABASE_URL || '').trim();
  const supaAccessToken = String(processEnv.SUPABASE_ACCESS_TOKEN || '').trim();

  const internalRoles = String(processEnv.EDGE_INTERNAL_CALLER_ROLES || '').trim();
  if (!internalRoles) {
    throw new Error('Missing required environment variable: EDGE_INTERNAL_CALLER_ROLES');
  }
  const parsedInternalRoles = internalRoles
    .split(',')
    .map((role) => String(role || '').trim().toLowerCase())
    .filter(Boolean);
  const forbiddenRoles = parsedInternalRoles.filter((role) => role === 'anon' || role === 'authenticated');
  if (forbiddenRoles.length) {
    throw new Error(
      `EDGE_INTERNAL_CALLER_ROLES must not include anon/authenticated (found: ${forbiddenRoles.join(', ')})`,
    );
  }

  const host = parsePgHost(dbUrl);
  if (!host) throw new Error('Could not parse DATABASE_URL host');

  // objectives:allow LOCALHOST Justification: guard rejects localhost/127.0.0.1 to enforce cloud usage
  // Disallow local endpoints for gating
  const localHosts = ['localhost', '127.0.0.1'];
  if (localHosts.includes(host) || /\.local$/i.test(host)) {
    throw new Error(`DATABASE_URL must point to cloud; got host=${host}`);
  }

  const canonicalFallbackHosts = [
    parsePgHost(String(processEnv.DATABASE_URL_DIRECT || '')),
    parsePgHost(String(processEnv.DATABASE_URL_POOLER || '')),
  ].filter(Boolean);
  const hasCanonicalSupabaseFallback = canonicalFallbackHosts.some((candidateHost) =>
    isSupabaseHost(candidateHost),
  );
  const dbSmokeFallbackSelected = isDbSmokeHostFallbackSelected(processEnv);
  const selectedDbHostFallback = isSelectedDbHostFallback(processEnv, dbUrl);

  // Enforce Supabase cloud endpoints for this repository.
  // Allow temporary db-smoke hostaddr/ipv4 fallback only when canonical direct/pooler DSN
  // still resolves to a Supabase host, preserving fail-closed source validation.
  // Preview/project env overlays can also persist the selected fallback candidate explicitly
  // via DATABASE_URL_SELECTED_DSN_NAME when the canonical direct/pooler DSNs remain intact.
  if (!isSupabaseHost(host)) {
    if (!((dbSmokeFallbackSelected || selectedDbHostFallback) && hasCanonicalSupabaseFallback)) {
      throw new Error(`DATABASE_URL host must end with .supabase.co or .supabase.com; got ${host}`);
    }
  }

  if (supaUrl) {
    try {
      const u = new URL(supaUrl);
      const supaHost = String(u.hostname || '').trim().toLowerCase();
      const dbProjectRef = parseProjectRefFromDbHost(host);
      const directDbHost = parsePgHost(String(processEnv.DATABASE_URL_DIRECT || ''));
      const poolerDbHost = parsePgHost(String(processEnv.DATABASE_URL_POOLER || ''));
      const directProjectRef = parseProjectRefFromDbHost(directDbHost);
      const poolerProjectRef = parseProjectRefFromDbHost(poolerDbHost);
      const envProjectRef = String(processEnv.SUPABASE_PROJECT_ID || '').trim().toLowerCase();
      const anonProjectRef = parseProjectRefFromJwtClaims(processEnv.SUPABASE_ANON_KEY || '');
      const expectedProjectRef = looksLikeSupabaseProjectRef(envProjectRef)
        ? envProjectRef
        : (dbProjectRef || directProjectRef || poolerProjectRef || anonProjectRef);

      if (!isSupabaseHost(supaHost)) {
        const allowedHosts = new Set(
          parseAllowedCustomSupabaseHosts(processEnv.SUPABASE_ALLOWED_CUSTOM_DOMAINS),
        );
        if (!allowedHosts.has(supaHost)) {
          throw new Error(
            `SUPABASE_URL custom host ${supaHost} is not allowed; set SUPABASE_ALLOWED_CUSTOM_DOMAINS to include it`,
          );
        }
        if (!looksLikeSupabaseProjectRef(envProjectRef)) {
          throw new Error(
            'SUPABASE_PROJECT_ID must be set to the project ref when SUPABASE_URL uses a custom domain',
          );
        }
      }

      if (looksLikeSupabaseProjectRef(expectedProjectRef)) {
        const directCandidates = [dbProjectRef, directProjectRef, poolerProjectRef, anonProjectRef]
          .filter((value) => looksLikeSupabaseProjectRef(value));
        const mismatch = directCandidates.find((value) => value !== expectedProjectRef);
        if (mismatch) {
          throw new Error(
            `Project mismatch: expected ${expectedProjectRef} but found ${mismatch} from DB/JWT sources`,
          );
        }

        const urlProjectRef = parseProjectRefFromSupabaseHost(supaHost);
        if (urlProjectRef && urlProjectRef !== expectedProjectRef) {
          throw new Error(
            `Project mismatch between SUPABASE_URL (${urlProjectRef}) and expected project (${expectedProjectRef})`,
          );
        }
      }
    } catch (e) {
      throw new Error(`SUPABASE_URL is not a valid URL: ${e.message}`);
    }
  }

  // If running in CI (GitHub), assert common secrets presence
  const isCI = String(processEnv.GITHUB_ACTIONS || '').toLowerCase() === 'true';
  if (isCI) {
    const missing = [];
    // These are commonly used across integration and edge tests; presence avoids falling back to mocks.
    for (const k of ['SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN']) {
      if (!processEnv[k] || String(processEnv[k]).trim() === '') missing.push(k);
    }
    if (missing.length) {
      throw new Error(`Missing required cloud secrets in CI: ${missing.join(', ')}`);
    }
  }

  if (isTruthy(processEnv.LABEL_RENDERER_DB_JWT_ALLOW_SERVICE_ROLE_FALLBACK)) {
    throw new Error(
      'LABEL_RENDERER_DB_JWT_ALLOW_SERVICE_ROLE_FALLBACK is not supported; strict label-renderer DB JWT role enforcement is mandatory.',
    );
  }

  // Enforce least-privilege DB JWTs for edge RPC access with exact role matching.
  if (edgeRequireDbJwt === '1') {
    assertDbJwt(processEnv, 'API_GATEWAY_DB_JWT', 'edge_api_gateway_role');
    assertDbJwt(processEnv, 'WEBHOOK_DB_JWT', 'edge_webhook_role');
    assertDbJwt(processEnv, 'API_CALLER_DB_JWT', 'edge_api_caller_role');
    assertDbJwt(processEnv, 'LABEL_RENDERER_DB_JWT', 'edge_label_renderer_role');
  }

  if (isTruthy(processEnv.API_CALLER_GUARDED_EGRESS_PROOF_REQUIRED)) {
    resolveGuardedEgressProxyProofConfig(
      processEnv,
      processEnv.API_CALLER_GUARDED_EGRESS_PROOF_LANE,
    );
  }

  return {
    preview,
    edgeRequireDbJwt,
    supaAccessTokenPresent: Boolean(supaAccessToken),
  };
}

function main() {
  loadEnv();
  try {
    const res = validateCloudEnv({ env: process.env });
    if (res.preview && res.edgeRequireDbJwt !== '1') {
      console.log(
        `[assert-cloud-env] Preview environment detected; EDGE_REQUIRE_DB_JWT=${res.edgeRequireDbJwt} (edge DB JWT assertions skipped)`,
      );
    }
    console.log('[assert-cloud-env] Cloud environment validated');
  } catch (err) {
    console.error(`[assert-cloud-env] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  isPreviewEnv,
  isTruthy,
  parsePgHost,
  parseProjectRefFromDbHost,
  parseProjectRefFromSupabaseHost,
  parseProjectRefFromJwtClaims,
  parseAllowedCustomSupabaseHosts,
  isSelectedDbHostFallback,
  validateCloudEnv,
};
