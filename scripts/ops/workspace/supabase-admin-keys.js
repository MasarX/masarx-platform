#!/usr/bin/env node

const { getJwtRole } = require('../../utils/jwt');

function normalizeApiKeyCandidate(value) {
  return String(value || '').trim();
}

function isLikelyJwtToken(value) {
  return normalizeApiKeyCandidate(value).split('.').length === 3;
}

function isSupabaseSecretKey(value) {
  return /^sb_secret_/i.test(normalizeApiKeyCandidate(value));
}

function isServiceRoleJwtToken(value) {
  const token = normalizeApiKeyCandidate(value);
  if (!isLikelyJwtToken(token)) return false;
  const role = String(getJwtRole(token) || '').trim().toLowerCase();
  return role === 'service_role';
}

function selectLegacyServiceRoleKeyFromApiKeys(apiKeys) {
  const legacyService = normalizeApiKeyCandidate(apiKeys?.legacyService);
  if (isServiceRoleJwtToken(legacyService)) return legacyService;
  const service = normalizeApiKeyCandidate(apiKeys?.service);
  if (isServiceRoleJwtToken(service)) return service;
  return '';
}

function selectSecretAdminKeyFromApiKeys(apiKeys) {
  const secret = normalizeApiKeyCandidate(apiKeys?.secret);
  if (isSupabaseSecretKey(secret)) return secret;
  const service = normalizeApiKeyCandidate(apiKeys?.service);
  if (isSupabaseSecretKey(service)) return service;
  return '';
}

function selectAdminServiceKeyFromApiKeys(apiKeys, opts = {}) {
  const preferSecret = Boolean(opts?.preferSecret);
  const legacyJwt = selectLegacyServiceRoleKeyFromApiKeys(apiKeys);
  const secret = selectSecretAdminKeyFromApiKeys(apiKeys);
  const service = normalizeApiKeyCandidate(apiKeys?.service);

  if (preferSecret) {
    if (secret) return secret;
    if (service && !isLikelyJwtToken(service)) return service;
    if (legacyJwt) return legacyJwt;
    return service;
  }

  if (legacyJwt) return legacyJwt;
  if (secret) return secret;
  return service;
}

function splitSupabaseApiKeys(apiKeys) {
  return {
    anonKey: normalizeApiKeyCandidate(apiKeys?.publishable || apiKeys?.anon || apiKeys?.legacyAnon),
    serviceRoleKey: selectLegacyServiceRoleKeyFromApiKeys(apiKeys),
    secretKey: selectSecretAdminKeyFromApiKeys(apiKeys),
    adminServiceKey: selectAdminServiceKeyFromApiKeys(apiKeys),
  };
}

module.exports = {
  isLikelyJwtToken,
  isServiceRoleJwtToken,
  isSupabaseSecretKey,
  normalizeApiKeyCandidate,
  selectAdminServiceKeyFromApiKeys,
  selectLegacyServiceRoleKeyFromApiKeys,
  selectSecretAdminKeyFromApiKeys,
  splitSupabaseApiKeys,
};
