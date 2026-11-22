#!/usr/bin/env node
const crypto = require('crypto');
const { getProjectJwtSecret } = require('./supabase-api');

// Edge DB JWTs are used as long-lived internal caller tokens (stored in env and
// referenced by settings). Short TTLs cause cloud tests and automation paths to
// fail once tokens expire, so default to a 1-year TTL (configurable by callers).
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 365;
const DEFAULT_SECRET_BYTES = 32;
const DEFAULT_API_KEY_TTL_SECONDS = 60 * 60 * 24 * 365;

function base64UrlEncode(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return raw
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64Url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function decodeJwtIssuer(token) {
  if (!token || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return typeof payload.iss === 'string' ? payload.iss : '';
  } catch {
    return '';
  }
}

function resolveJwtIssuer({ serviceKey, anonKey, fallbackIssuer = 'supabase' } = {}) {
  return decodeJwtIssuer(serviceKey) || decodeJwtIssuer(anonKey) || fallbackIssuer;
}

function isJwtSignedWithSecret(token, secret) {
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length < 3) return false;
  const data = `${parts[0]}.${parts[1]}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest();
  return base64UrlEncode(signature) === parts[2];
}

function createSupabaseApiKey({ secret, role, nowSec, ttlSec, issuer, projectRef }) {
  if (!secret || !role) return '';
  const iss = issuer || 'supabase';
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSec) ? ttlSec : DEFAULT_API_KEY_TTL_SECONDS;
  const ref = String(projectRef || '').trim();
  const payload = {
    role,
    iss,
    iat: now,
    exp: now + ttl,
  };
  if (ref) payload.ref = ref;
  return signJwt({
    header: { alg: 'HS256', typ: 'JWT' },
    payload,
    secret,
  });
}

function buildSupabaseApiKeys({ secret, nowSec, ttlSec, issuer, projectRef } = {}) {
  if (!secret) return null;
  return {
    anon: createSupabaseApiKey({ secret, role: 'anon', nowSec, ttlSec, issuer, projectRef }),
    service: createSupabaseApiKey({
      secret,
      role: 'service_role',
      nowSec,
      ttlSec,
      issuer,
      projectRef,
    }),
  };
}

function resolveJwtSigningSecret({ secret, serviceKey, anonKey } = {}) {
  const raw = secret instanceof Buffer ? secret : String(secret || '').trim();
  if (!raw) return '';
  const token = serviceKey || anonKey || '';
  if (!token) return raw;
  if (isJwtSignedWithSecret(token, raw)) return raw;
  if (Buffer.isBuffer(raw)) return raw;

  const secretStr = String(secret || '').trim();
  const decoded = Buffer.from(secretStr, 'base64');
  if (decoded.length && isJwtSignedWithSecret(token, decoded)) return decoded;

  if (/^[0-9a-fA-F]+$/.test(secretStr) && secretStr.length % 2 === 0) {
    const decodedHex = Buffer.from(secretStr, 'hex');
    if (decodedHex.length && isJwtSignedWithSecret(token, decodedHex)) return decodedHex;
  }
  return raw;
}

function signJwt({ header, payload, secret }) {
  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerPart}.${payloadPart}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

function generateJwtSecret(bytes = DEFAULT_SECRET_BYTES) {
  return crypto.randomBytes(bytes).toString('hex');
}

function deriveProjectJwtSecret({ seed, projectRef } = {}) {
  if (!seed || !projectRef) return '';
  return crypto
    .createHmac('sha256', String(seed))
    .update(`preview:${String(projectRef).trim()}`)
    .digest('hex');
}

function createEdgeDbJwt({ secret, role, nowSec, ttlSec, issuer }) {
  if (!secret || !role) return '';
  const iss = issuer || 'supabase';
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSec) ? ttlSec : DEFAULT_TTL_SECONDS;
  const payload = {
    role,
    iss,
    sub: 'edge-function',
    aud: 'authenticated',
    iat: now,
    exp: now + ttl,
  };
  return signJwt({
    header: { alg: 'HS256', typ: 'JWT' },
    payload,
    secret,
  });
}

function buildEdgeDbJwtBundle({ secret, nowSec, ttlSec, issuer } = {}) {
  if (!secret) return null;
  return {
    webhook_db_jwt: createEdgeDbJwt({ secret, role: 'edge_webhook_role', nowSec, ttlSec, issuer }),
    api_caller_db_jwt: createEdgeDbJwt({ secret, role: 'edge_api_caller_role', nowSec, ttlSec, issuer }),
    api_gateway_db_jwt: createEdgeDbJwt({ secret, role: 'edge_api_gateway_role', nowSec, ttlSec, issuer }),
    label_renderer_db_jwt: createEdgeDbJwt({ secret, role: 'edge_label_renderer_role', nowSec, ttlSec, issuer }),
    marketing_db_jwt: createEdgeDbJwt({ secret, role: 'edge_marketing_role', nowSec, ttlSec, issuer }),
  };
}

function buildFallbackEdgeDbJwtBundle(serviceKey) {
  const key = String(serviceKey || '').trim();
  if (!key) return null;
  return {
    webhook_db_jwt: key,
    api_caller_db_jwt: key,
    api_gateway_db_jwt: key,
    label_renderer_db_jwt: key,
  };
}

async function resolveEdgeDbJwtBundle({ projectRef, token, explicitSecret, nowSec, ttlSec, issuer } = {}) {
  let secret = String(explicitSecret || '').trim();
  if (!secret && projectRef && token) {
    try {
      secret = await getProjectJwtSecret(projectRef, token);
    } catch (err) {
      console.warn(`[edge-db-jwt] Failed to fetch project JWT secret: ${err.message}`);
    }
  }
  return { secret, bundle: buildEdgeDbJwtBundle({ secret, nowSec, ttlSec, issuer }) };
}

module.exports = {
  createEdgeDbJwt,
  buildEdgeDbJwtBundle,
  buildFallbackEdgeDbJwtBundle,
  resolveEdgeDbJwtBundle,
  deriveProjectJwtSecret,
  generateJwtSecret,
  buildSupabaseApiKeys,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
  isJwtSignedWithSecret,
};
