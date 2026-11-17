#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { resolveDeployEnvironmentName } = require('../../utils/production-mutation-guard');

const VALID_ENVIRONMENTS = ['dev', 'stg', 'prod'];
const DEFAULT_POLICY_DIR = path.join('config', 'ops');

function normalizeEnvironmentName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'dev' || raw.endsWith('-dev')) return 'dev';
  if (raw === 'stg' || raw === 'staging' || raw.endsWith('-stg') || raw.endsWith('-staging')) return 'stg';
  if (raw === 'prod' || raw === 'production' || raw.endsWith('-prod')) return 'prod';
  return '';
}

function resolveEnvironment(args = {}, env = process.env) {
  const explicit = normalizeEnvironmentName(args.environment || args.env);
  if (explicit) return explicit;
  const fromDeploy = normalizeEnvironmentName(resolveDeployEnvironmentName(env));
  if (fromDeploy) return fromDeploy;
  throw new Error(
    '[auth-email-url] Unable to resolve environment. Provide --environment <dev|stg|prod> or set DEPLOY_ENV.',
  );
}

function resolvePolicyPath(environment, policyArg) {
  const explicit = String(policyArg || '').trim();
  if (explicit) return path.resolve(process.cwd(), explicit);
  return path.resolve(
    process.cwd(),
    DEFAULT_POLICY_DIR,
    `auth-email-url-policy.${environment}.json`,
  );
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readPolicyConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
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

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBannedHosts(rawHosts = []) {
  return Array.from(
    new Set(
      (Array.isArray(rawHosts) ? rawHosts : [])
        .map((entry) => normalizeHost(entry))
        .filter(Boolean),
    ),
  );
}

function isBannedHost(hostname, bannedHosts = []) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  return normalizeBannedHosts(bannedHosts).some((rule) => {
    if (!rule) return false;
    if (rule.startsWith('.')) {
      return host.endsWith(rule);
    }
    return host === rule;
  });
}

function normalizeRedirectUrls(values = []) {
  if (Array.isArray(values)) {
    const flattened = [];
    for (const entry of values) {
      const normalizedEntry = normalizeRedirectUrls(entry);
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
  if (values && typeof values === 'object') {
    return normalizeRedirectUrls(
      values.additional_redirect_urls
        || values.additionalRedirectUrls
        || values.uri_allow_list
        || values.uriAllowList
        || values.ADDITIONAL_REDIRECT_URLS
        || values.URI_ALLOW_LIST
        || '',
    );
  }
  const raw = String(values || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return normalizeRedirectUrls(parsed);
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

function normalizePolicy(policy = {}, expectedEnvironment = '') {
  const environment = normalizeEnvironmentName(policy.environment || expectedEnvironment);
  const siteUrl = normalizeHttpUrl(policy.site_url || policy.siteUrl);
  const additionalRedirectUrls = normalizeRedirectUrls(
    policy.additional_redirect_urls || policy.additionalRedirectUrls,
  );
  const bannedHosts = normalizeBannedHosts(policy.banned_redirect_hosts || policy.bannedRedirectHosts);
  const issues = [];

  if (!environment || !VALID_ENVIRONMENTS.includes(environment)) {
    issues.push(`Policy has unsupported environment "${String(policy.environment || '').trim()}".`);
  }
  if (expectedEnvironment && environment && environment !== expectedEnvironment) {
    issues.push(`Policy environment "${environment}" does not match target "${expectedEnvironment}".`);
  }
  if (!siteUrl) {
    issues.push('Policy site_url must be a valid http/https URL.');
  }
  if (additionalRedirectUrls.length === 0) {
    issues.push('Policy additional_redirect_urls must include at least one URL.');
  }
  if (siteUrl && !additionalRedirectUrls.includes(siteUrl)) {
    issues.push('Policy additional_redirect_urls must include site_url.');
  }
  if (bannedHosts.length === 0) {
    issues.push('Policy banned_redirect_hosts must include localhost bans.');
  }

  return {
    environment,
    site_url: siteUrl,
    additional_redirect_urls: additionalRedirectUrls,
    banned_redirect_hosts: bannedHosts,
    issues,
  };
}

function normalizeActualConfig(config = {}) {
  return {
    site_url: normalizeHttpUrl(config.site_url || config.siteUrl || config.SITE_URL),
    additional_redirect_urls: normalizeRedirectUrls(
      config.additional_redirect_urls
      || config.additionalRedirectUrls
      || config.uri_allow_list
      || config.uriAllowList
      || config.ADDITIONAL_REDIRECT_URLS
      || config.URI_ALLOW_LIST,
    ),
    source: String(config.source || '').trim(),
  };
}

function evaluateAuthEmailUrlConfig({ policy, actual, expectedEnvironment = '' }) {
  const normalizedPolicy = normalizePolicy(
    policy,
    normalizeEnvironmentName(expectedEnvironment || policy.environment),
  );
  const normalizedActual = normalizeActualConfig(actual);
  const issues = [...normalizedPolicy.issues];
  const warnings = [];

  const bannedHosts = normalizedPolicy.banned_redirect_hosts;
  const actualSite = normalizedActual.site_url;
  const actualRedirects = normalizedActual.additional_redirect_urls;

  if (!actualSite) {
    issues.push('Project auth site_url is empty.');
  } else {
    let parsed;
    try {
      parsed = new URL(actualSite);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      issues.push('Project auth site_url is invalid.');
    } else if (isBannedHost(parsed.hostname, bannedHosts)) {
      issues.push(`Project auth site_url host is banned: ${parsed.hostname}`);
    }
  }

  for (const url of actualRedirects) {
    try {
      const parsed = new URL(url);
      if (isBannedHost(parsed.hostname, bannedHosts)) {
        issues.push(`Project auth additional redirect host is banned: ${parsed.hostname}`);
      }
    } catch {
      issues.push(`Project auth additional redirect URL is invalid: ${url}`);
    }
  }

  if (normalizedPolicy.site_url && actualSite !== normalizedPolicy.site_url) {
    issues.push(`Project auth site_url mismatch. expected=${normalizedPolicy.site_url} actual=${actualSite || '<empty>'}`);
  }

  for (const required of normalizedPolicy.additional_redirect_urls) {
    if (!actualRedirects.includes(required)) {
      issues.push(`Missing required auth redirect URL: ${required}`);
    }
  }

  if (actualRedirects.length > normalizedPolicy.additional_redirect_urls.length) {
    warnings.push('Project auth config includes extra additional redirect URLs outside policy.');
  }

  return {
    policy: normalizedPolicy,
    actual: normalizedActual,
    issues,
    warnings,
    ok: issues.length === 0,
  };
}

module.exports = {
  VALID_ENVIRONMENTS,
  normalizeEnvironmentName,
  resolveEnvironment,
  resolvePolicyPath,
  normalizeHttpUrl,
  normalizeHost,
  normalizeBannedHosts,
  isBannedHost,
  normalizeRedirectUrls,
  normalizePolicy,
  normalizeActualConfig,
  evaluateAuthEmailUrlConfig,
  readPolicyConfig,
  writeJson,
};
