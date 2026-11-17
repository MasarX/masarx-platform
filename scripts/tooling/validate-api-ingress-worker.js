#!/usr/bin/env node
/**
 * validate-api-ingress-worker.js
 * Hard-fail validation for the Cloudflare ingress worker config.
 *
 * Validates that wrangler.toml contains parseable REWRITE_RULES_JSON and that
 * the worker's own resolver can apply those rules deterministically.
 */
/* eslint-disable no-console */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function extractTripleQuotedVarsBySection(toml, key) {
  const lines = String(toml || '').split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*\"\"\"`);

  let currentSection = null;
  const out = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sectionMatch = String(line).match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = String(sectionMatch[1] || '').trim() || null;
      continue;
    }

    if (!keyRe.test(line)) continue;

    const openIdx = line.indexOf('"""');
    if (openIdx === -1) continue;

    let remainder = line.slice(openIdx + 3);
    let value = '';

    const closeSameLine = remainder.indexOf('"""');
    if (closeSameLine !== -1) {
      value = remainder.slice(0, closeSameLine);
    } else {
      value = remainder;
      while (i + 1 < lines.length) {
        i++;
        const nextLine = lines[i];
        const closeIdx = nextLine.indexOf('"""');
        if (closeIdx !== -1) {
          value += `\n${nextLine.slice(0, closeIdx)}`;
          break;
        }
        value += `\n${nextLine}`;
      }
    }

    out.set(currentSection || '', value);
  }

  return out;
}

function extractStringVarsBySection(toml, keys) {
  const lines = String(toml || '').split(/\r?\n/);
  const allow = new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean));
  let currentSection = null;
  const out = new Map();

  for (const line of lines) {
    const sectionMatch = String(line).match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = String(sectionMatch[1] || '').trim() || null;
      continue;
    }

    const m = String(line).match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (!m) continue;
    const key = String(m[1] || '').trim();
    if (!allow.has(key)) continue;
    const value = String(m[2] || '');

    const sectionKey = currentSection || '';
    const map = out.get(sectionKey) || new Map();
    map.set(key, value);
    out.set(sectionKey, map);
  }

  return out;
}

function parseJsonOrThrow(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (err) {
    const message = err && err.message ? err.message : String(err || 'Unknown error');
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

async function main() {
  const repoRoot = process.cwd();
  const wranglerPath = path.join(repoRoot, 'tooling', 'apps', 'api-ingress-worker', 'wrangler.toml');
  if (!fs.existsSync(wranglerPath)) {
    throw new Error(`Missing wrangler.toml at ${wranglerPath}`);
  }

  const wranglerToml = fs.readFileSync(wranglerPath, 'utf8');
  const rewriteRulesBySection = extractTripleQuotedVarsBySection(wranglerToml, 'REWRITE_RULES_JSON');
  const stringVarsBySection = extractStringVarsBySection(wranglerToml, [        
    'ALLOW_QUERY_TOKEN',
    'CORS_ALLOW_ORIGIN',
    'CORS_ALLOW_ORIGINS',
    'CORS_EXPOSE_HEADERS',
    'CORS_ALLOW_CREDENTIALS',
  ]);

  const canonicalSection = 'vars';
  const canonicalRewriteRulesRaw = rewriteRulesBySection.get(canonicalSection);
  if (!canonicalRewriteRulesRaw || !String(canonicalRewriteRulesRaw).trim()) {
    throw new Error(`wrangler.toml missing REWRITE_RULES_JSON triple-quoted value under [${canonicalSection}].`);
  }

  const canonicalRewriteRules = parseJsonOrThrow(
    canonicalRewriteRulesRaw,
    `REWRITE_RULES_JSON under [${canonicalSection}]`
  );
  if (!Array.isArray(canonicalRewriteRules)) {
    throw new Error(`REWRITE_RULES_JSON under [${canonicalSection}] must be a JSON array.`);
  }

  const canonicalStrings = stringVarsBySection.get(canonicalSection) || new Map();
  const canonicalAllowQueryToken = canonicalStrings.get('ALLOW_QUERY_TOKEN') || '';
  if (canonicalAllowQueryToken !== '0' && canonicalAllowQueryToken !== '1') {
    throw new Error(
      `ALLOW_QUERY_TOKEN under [${canonicalSection}] must be "0" or "1" (got: ${JSON.stringify(canonicalAllowQueryToken)}).`
    );
  }

  const canonicalExpose = canonicalStrings.get('CORS_EXPOSE_HEADERS') || '';
  if (!canonicalExpose) {
    throw new Error(`wrangler.toml missing CORS_EXPOSE_HEADERS under [${canonicalSection}].`);
  }
  if (canonicalAllowQueryToken === '1') {
    const parts = canonicalExpose
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    for (const required of ['deprecation', 'x-masarx-deprecated-auth']) {
      if (!parts.includes(required)) {
        throw new Error(
          `CORS_EXPOSE_HEADERS under [${canonicalSection}] must include '${required}' when ALLOW_QUERY_TOKEN=1.`
        );
      }
    }
  }
  const canonicalCorsAllow =
    canonicalStrings.get('CORS_ALLOW_ORIGINS') || canonicalStrings.get('CORS_ALLOW_ORIGIN') || '';
  if (!canonicalCorsAllow) {
    throw new Error(`wrangler.toml missing CORS_ALLOW_ORIGIN under [${canonicalSection}].`);
  }
  if (canonicalCorsAllow.trim() === '*') {
    throw new Error(
      `CORS_ALLOW_ORIGIN under [${canonicalSection}] must not be '*' for an authenticated public API. Use an allowlist.`
    );
  }
  const canonicalCorsList = canonicalCorsAllow
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const uniqueCanonicalCorsList = Array.from(new Set(canonicalCorsList));
  if (uniqueCanonicalCorsList.length !== canonicalCorsList.length) {
    throw new Error(`CORS_ALLOW_ORIGIN under [${canonicalSection}] must not contain duplicates.`);
  }
  if (uniqueCanonicalCorsList.length !== 1 || uniqueCanonicalCorsList[0] !== 'https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid') {
    throw new Error(
      `CORS_ALLOW_ORIGIN under [${canonicalSection}] must be exactly https://rzyxrumpgwjnwngjrgkiqkkt.example.invalid (canonical public docs origin).`
    );
  }

  // Wrangler does not propagate [vars] into named environments on deploy; require explicit parity.
  for (const envName of ['dev', 'stg']) {
    const section = `env.${envName}.vars`;
    const envRaw = rewriteRulesBySection.get(section);
    if (!envRaw || !String(envRaw).trim()) {
      throw new Error(`wrangler.toml missing REWRITE_RULES_JSON triple-quoted value under [${section}].`);
    }
    const envParsed = parseJsonOrThrow(envRaw, `REWRITE_RULES_JSON under [${section}]`);
    if (!Array.isArray(envParsed)) {
      throw new Error(`REWRITE_RULES_JSON under [${section}] must be a JSON array.`);
    }
    try {
      assert.deepStrictEqual(envParsed, canonicalRewriteRules);
    } catch {
      throw new Error(`REWRITE_RULES_JSON under [${section}] must exactly match [${canonicalSection}].`);
    }

    const envStrings = stringVarsBySection.get(section) || new Map();
    const envAllowQueryToken = envStrings.get('ALLOW_QUERY_TOKEN') || '';
    if (envAllowQueryToken !== canonicalAllowQueryToken) {
      throw new Error(
        `ALLOW_QUERY_TOKEN under [${section}] must exactly match [${canonicalSection}].`
      );
    }
    const envCorsAllow =
      envStrings.get('CORS_ALLOW_ORIGINS') || envStrings.get('CORS_ALLOW_ORIGIN') || '';
    if (!envCorsAllow) {
      throw new Error(`wrangler.toml missing CORS_ALLOW_ORIGIN under [${section}].`);
    }
    if (envCorsAllow !== canonicalCorsAllow) {
      throw new Error(`CORS_ALLOW_ORIGIN under [${section}] must exactly match [${canonicalSection}].`);
    }

    const canonicalExpose = canonicalStrings.get('CORS_EXPOSE_HEADERS') || '';
    const envExpose = envStrings.get('CORS_EXPOSE_HEADERS') || '';
    if (canonicalExpose && !envExpose) {
      throw new Error(`wrangler.toml missing CORS_EXPOSE_HEADERS under [${section}].`);
    }
    if (canonicalExpose && envExpose !== canonicalExpose) {
      throw new Error(`CORS_EXPOSE_HEADERS under [${section}] must exactly match [${canonicalSection}].`);
    }
  }

  const workerModulePath = path.join(
    repoRoot,
    'tooling',
    'apps',
    'api-ingress-worker',
    'src',
    'index.mjs'
  );
  const mod = await import(pathToFileURL(workerModulePath).href);
  if (typeof mod.resolveIngress !== 'function') {
    throw new Error('api-ingress-worker does not export resolveIngress(request, env).');
  }

  const env = {
    UPSTREAM_ORIGIN: 'https://upstream.example',
    REWRITE_RULES_JSON: canonicalRewriteRulesRaw,
  };

  const req = new Request('https://vomhkplympywspxymnstltsw.example.invalid/v1/webhook', {
    method: 'GET',
    headers: { 'x-webhook-token': 'token' },
  });

  const { response, upstreamRequest } = mod.resolveIngress(req, env);
  if (response) {
    const body = await response.text();
    throw new Error(`Worker returned ${response.status} for a valid config test request: ${body}`);
  }
  const upstreamUrl = String(upstreamRequest && upstreamRequest.url ? upstreamRequest.url : '');
  if (!upstreamUrl.includes('/functions/v1/webhook-receiver')) {
    throw new Error(`Unexpected rewrite result for /v1/webhook: ${upstreamUrl}`);
  }

  console.log('[ingress-worker] OK - config parses and rewrites correctly.');
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err || 'Unknown error');
  console.error('[ingress-worker] FAILED:', message);
  process.exit(1);
});
