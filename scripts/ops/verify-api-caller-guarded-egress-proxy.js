#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');

const CONTRACT_VERSION = 'masarx.api-caller-guarded-egress-proxy.v1';
const REQUIRED_CAPABILITIES = Object.freeze([
  'authenticated_forward_proxy',
  'dns_rebinding_protection',
  'private_network_denial',
  'redirect_revalidation',
  'fixed_egress_ip',
  'policy_denial_receipts',
]);
const MAX_RESPONSE_BYTES = 16 * 1024;

function text(value) {
  return String(value || '').trim();
}

function parseExactHttpsUrl(name, value, { originOnly = false } = {}) {
  const raw = text(value);
  if (!raw) throw new Error(`missing_config:${name}`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid_config:${name}:url`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`invalid_config:${name}:exact_https_url_required`);
  }
  if (originOnly && (raw !== parsed.origin || parsed.pathname !== '/' || parsed.search)) {
    throw new Error(`invalid_config:${name}:exact_https_origin_required`);
  }
  return parsed;
}

function normaliseIp(value) {
  return text(value).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function parseIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some((octet) => octet < 0 || octet > 255) ? null : octets;
}

// Keep this parser and the classification below equivalent to the api-caller runtime.
// Node's net.isIP recognises IPv4-mapped forms, but it does not expose their embedded
// address, so the proof uses the same explicit group representation as production.
function parseIpv6(value) {
  let input = normaliseIp(value);
  if (!input || input.includes('%')) return null;

  const ipv4Match = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    input = input.slice(0, input.length - ipv4Match[1].length) + replacement;
  }

  if (!input.includes(':')) return null;
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [
    ...left,
    ...Array.from({ length: Math.max(missing, 0) }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 ? groups : null;
}

function isPublicIpv4(value) {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(value) {
  const groups = parseIpv6(value);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5] = groups;
  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  if ((g0 & 0xfe00) === 0xfc00) return false;
  if ((g0 & 0xffc0) === 0xfe80) return false;
  if ((g0 & 0xff00) === 0xff00) return false;
  // Only globally routable 2000::/3 is accepted. This also rejects site-local,
  // translation, discard-only, and other IANA special-purpose address space.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2001 && g1 === 0x0002) return false;
  if (g0 === 0x2001 && g1 === 0x0000) return false;
  if (g0 === 0x2002) return false;
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false;
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;
  if (g0 === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) return false;
  return true;
}

function isPublicIp(value) {
  const raw = normaliseIp(value);
  if (parseIpv4(raw)) return isPublicIpv4(raw);
  if (parseIpv6(raw)) return isPublicIpv6(raw);
  return false;
}

function assertProbeHostIsNotLocal(name, parsed) {
  const hostname = normaliseIp(parsed.hostname).replace(/\.+$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (net.isIP(hostname) && !isPublicIp(hostname))
  ) {
    throw new Error(`invalid_config:${name}:local_or_private_host`);
  }
}

function assertNonPublicIpProbe(name, parsed) {
  const hostname = normaliseIp(parsed.hostname);
  if (!(parseIpv4(hostname) || parseIpv6(hostname)) || isPublicIp(hostname)) {
    throw new Error(`invalid_config:${name}:non_public_ip_literal_required`);
  }
}

function assertControlledRebindingProbe(name, parsed) {
  const hostname = normaliseIp(parsed.hostname).replace(/\.+$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || net.isIP(hostname)) {
    throw new Error(`invalid_config:${name}:controlled_dns_hostname_required`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function isAuthoritativeBasicProxyChallenge(value) {
  // RFC 9110 requires Proxy-Authenticate on 407; requiring an explicit Basic
  // realm also prevents a generic or application-generated 407 from passing.
  return /^Basic\s+realm="[^"\r\n]{1,128}"$/i.test(text(value));
}

function resolveConfig(env = process.env, laneOverride = '') {
  const lane = text(laneOverride || env.API_CALLER_GUARDED_EGRESS_PROOF_LANE);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(lane)) {
    throw new Error('invalid_config:lane');
  }
  const candidateSha = text(env.API_CALLER_GUARDED_EGRESS_PROOF_SHA).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
    throw new Error('invalid_config:API_CALLER_GUARDED_EGRESS_PROOF_SHA:full_sha_required');
  }
  const proxyUrl = parseExactHttpsUrl(
    'API_CALLER_GUARDED_EGRESS_PROXY_URL',
    env.API_CALLER_GUARDED_EGRESS_PROXY_URL,
    { originOnly: true },
  );
  assertProbeHostIsNotLocal('API_CALLER_GUARDED_EGRESS_PROXY_URL', proxyUrl);
  const healthUrl = parseExactHttpsUrl(
    'API_CALLER_GUARDED_EGRESS_PROXY_HEALTH_URL',
    env.API_CALLER_GUARDED_EGRESS_PROXY_HEALTH_URL,
  );
  if (healthUrl.origin !== proxyUrl.origin) {
    throw new Error('invalid_config:health_origin_must_match_proxy_origin');
  }
  const publicProbeUrl = parseExactHttpsUrl(
    'API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL',
    env.API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL,
  );
  assertProbeHostIsNotLocal('API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL', publicProbeUrl);
  const policyDeniedProbeUrl = parseExactHttpsUrl(
    'API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL',
    env.API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL,
    { originOnly: true },
  );
  assertNonPublicIpProbe(
    'API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL',
    policyDeniedProbeUrl,
  );
  const rebindingProbeUrl = parseExactHttpsUrl(
    'API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL',
    env.API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL,
    { originOnly: true },
  );
  assertControlledRebindingProbe(
    'API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL',
    rebindingProbeUrl,
  );
  if (rebindingProbeUrl.origin === proxyUrl.origin || rebindingProbeUrl.origin === publicProbeUrl.origin) {
    throw new Error('invalid_config:API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL:dedicated_origin_required');
  }
  const expectedPublicIp = text(env.API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP);
  if (!isPublicIp(expectedPublicIp)) {
    throw new Error('invalid_config:API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP:public_ip_required');
  }
  const username = text(env.API_CALLER_GUARDED_EGRESS_PROXY_USERNAME);
  const password = text(env.API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD);
  if (!username || username.includes(':')) {
    throw new Error('invalid_config:API_CALLER_GUARDED_EGRESS_PROXY_USERNAME');
  }
  if (!password) throw new Error('missing_config:API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD');
  const policyDeniedCode = text(env.API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE);
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(policyDeniedCode)) {
    throw new Error('invalid_config:API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE');
  }
  return {
    lane,
    candidateSha,
    proxyUrl,
    healthUrl,
    publicProbeUrl,
    policyDeniedProbeUrl,
    rebindingProbeUrl,
    expectedPublicIp,
    username,
    password,
    policyDeniedCode,
  };
}

async function readJsonResponse(response, checkId) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error(`${checkId}:response_too_large`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error(`${checkId}:response_too_large`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${checkId}:invalid_json`);
  }
}

async function defaultHealthProbe(config) {
  const authorization = basicAuthorization(config.username, config.password);
  const response = await fetch(config.healthUrl.href, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json', authorization },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await readJsonResponse(response, 'health_capability') };
}

async function defaultPublicProbe(config) {
  const { ProxyAgent, request } = require('undici');
  const token = basicAuthorization(config.username, config.password);
  const dispatcher = new ProxyAgent({ uri: config.proxyUrl.origin, token });
  try {
    const response = await request(config.publicProbeUrl.href, {
      method: 'GET',
      dispatcher,
      maxRedirections: 0,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('public_probe:response_too_large');
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('public_probe:invalid_json');
    }
    return { status: response.statusCode, body };
  } finally {
    await dispatcher.close();
  }
}

async function defaultConnectProbe(
  config,
  targetUrl,
  checkId,
  { connectTls = tls.connect, timeoutMs = 15_000, authMode = 'configured' } = {},
) {
  const targetPort = Number(targetUrl.port || 443);
  const targetAuthority = `${targetUrl.hostname}:${targetPort}`;
  if (!['configured', 'missing', 'wrong'].includes(authMode)) {
    throw new Error(`${checkId}:invalid_auth_probe_mode`);
  }
  const authorization = authMode === 'missing'
    ? ''
    : authMode === 'wrong'
      ? basicAuthorization('masarx-proof-invalid', 'masarx-proof-invalid')
      : basicAuthorization(config.username, config.password);
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const proxyHost = normaliseIp(config.proxyUrl.hostname);
    const socket = connectTls({
      host: proxyHost,
      port: Number(config.proxyUrl.port || 443),
      ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }),
      rejectUnauthorized: true,
    });
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      socket.write([
        `CONNECT ${targetAuthority} HTTP/1.1`,
        `Host: ${targetAuthority}`,
        ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
        'Proxy-Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) {
        finish(new Error(`${checkId}:response_too_large`));
        return;
      }
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const lines = response.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/i.exec(lines.shift() || '');
      if (!statusMatch) {
        finish(new Error(`${checkId}:invalid_proxy_response`));
        return;
      }
      const headers = new Map();
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
      }
      const proxyAuthenticate = text(headers.get('proxy-authenticate'));
      finish(null, {
        status: Number(statusMatch[1]),
        code: text(headers.get('x-masarx-egress-denial-code')),
        ...(proxyAuthenticate ? { proxyAuthenticate } : {}),
      });
    });
    socket.once('timeout', () => finish(new Error(`${checkId}:timeout`)));
    socket.once('error', () => finish(new Error(`${checkId}:transport_error`)));
    socket.once('end', () => finish(new Error(`${checkId}:response_incomplete`)));
  });
}

async function defaultAuthenticationProbe(
  config,
  transport = {},
) {
  // All three requests use the same controlled public target. Correct
  // credentials must establish the tunnel, while missing and wrong credentials
  // must be rejected by the live proxy itself with the authoritative 407 challenge.
  const correct = await defaultConnectProbe(
    config,
    config.publicProbeUrl,
    'proxy_auth_correct',
    { ...transport, authMode: 'configured' },
  );
  const missing = await defaultConnectProbe(
    config,
    config.publicProbeUrl,
    'proxy_auth_missing',
    { ...transport, authMode: 'missing' },
  );
  const wrong = await defaultConnectProbe(
    config,
    config.publicProbeUrl,
    'proxy_auth_wrong',
    { ...transport, authMode: 'wrong' },
  );
  return {
    correctStatus: correct.status,
    correctCode: correct.code,
    missingStatus: missing.status,
    missingChallenge: missing.proxyAuthenticate,
    wrongStatus: wrong.status,
    wrongChallenge: wrong.proxyAuthenticate,
  };
}

function defaultPolicyDeniedProbe(config) {
  return defaultConnectProbe(config, config.policyDeniedProbeUrl, 'private_policy_denial');
}

async function defaultRebindingTransitionProbe(config) {
  // The protected platform provisions a unique controlled hostname whose first
  // lookup resolves publicly and whose next lookup transitions to a non-public
  // address. Two sequential CONNECT requests prove that transition; a single
  // generic hostname denial is intentionally insufficient.
  const baseline = await defaultConnectProbe(config, config.rebindingProbeUrl, 'rebinding_public_baseline');
  const transition = await defaultConnectProbe(config, config.rebindingProbeUrl, 'rebinding_private_transition');
  return {
    baselineStatus: baseline.status,
    transitionStatus: transition.status,
    code: transition.code,
  };
}

function passed(id, evidence = {}) {
  return { id, status: 'passed', evidence };
}

function failed(id, failureClass) {
  return { id, status: 'failed', failure_class: failureClass };
}

async function executeProof(config, dependencies = {}) {
  const now = dependencies.now || (() => new Date().toISOString());
  const healthProbe = dependencies.healthProbe || defaultHealthProbe;
  const publicProbe = dependencies.publicProbe || defaultPublicProbe;
  const policyDeniedProbe = dependencies.policyDeniedProbe || defaultPolicyDeniedProbe;
  const rebindingTransitionProbe = dependencies.rebindingTransitionProbe || defaultRebindingTransitionProbe;
  const authenticationProbe = dependencies.authenticationProbe || defaultAuthenticationProbe;
  const startedAt = now();
  const checks = [];

  // objectives:allow LOCALHOST Justification: The security verifier must exercise canonical loopback denial vectors.
  const localTargets = ['127.0.0.1', '192.0.2.10', '192.0.2.10', '::1', 'fc00::1'];
  const allBlockedBeforeTransport = localTargets.every((ip) => !isPublicIp(ip));
  checks.push(allBlockedBeforeTransport
    ? passed('local_private_denial_before_transport', { transport_attempted: false, vector_count: localTargets.length })
    : failed('local_private_denial_before_transport', 'private_classifier_failed'));

  const [healthResult, publicResult, denialResult, rebindingResult, authenticationResult] = await Promise.allSettled([
    healthProbe(config),
    publicProbe(config),
    policyDeniedProbe(config),
    rebindingTransitionProbe(config),
    authenticationProbe(config),
  ]);

  if (healthResult.status === 'fulfilled') {
    const { status, body } = healthResult.value || {};
    const capabilityOk = status === 200 && body?.status === 'ok' &&
      body?.contract_version === CONTRACT_VERSION &&
      REQUIRED_CAPABILITIES.every((name) => body?.capabilities?.[name] === true);
    checks.push(capabilityOk
      ? passed('authenticated_health_capability', { http_status: 200, capability_count: REQUIRED_CAPABILITIES.length })
      : failed('authenticated_health_capability', 'health_contract_mismatch'));
  } else {
    checks.push(failed('authenticated_health_capability', 'health_transport_failed'));
  }

  if (publicResult.status === 'fulfilled') {
    const { status, body } = publicResult.value || {};
    const observedIp = text(body?.egress_ip);
    checks.push(status === 200 && observedIp === config.expectedPublicIp
      ? passed('fixed_public_egress_probe', { http_status: 200, observed_egress_ip_sha256: sha256(observedIp) })
      : failed('fixed_public_egress_probe', 'public_probe_contract_mismatch'));
  } else {
    checks.push(failed('fixed_public_egress_probe', 'public_probe_transport_failed'));
  }

  if (denialResult.status === 'fulfilled') {
    const { status, code } = denialResult.value || {};
    checks.push(status === 403 && text(code) === config.policyDeniedCode
      ? passed('live_private_target_proxy_denial', { http_status: 403, denial_code_sha256: sha256(config.policyDeniedCode) })
      : failed('live_private_target_proxy_denial', 'policy_denial_contract_mismatch'));
  } else {
    checks.push(failed('live_private_target_proxy_denial', 'policy_denial_transport_failed'));
  }

  if (rebindingResult.status === 'fulfilled') {
    const { baselineStatus, transitionStatus, code } = rebindingResult.value || {};
    checks.push(baselineStatus === 200 && transitionStatus === 403 && text(code) === config.policyDeniedCode
      ? passed('live_dns_rebinding_proxy_denial', {
        baseline_http_status: 200,
        transition_http_status: 403,
        denial_code_sha256: sha256(config.policyDeniedCode),
      })
      : failed('live_dns_rebinding_proxy_denial', 'rebinding_denial_contract_mismatch'));
  } else {
    checks.push(failed('live_dns_rebinding_proxy_denial', 'rebinding_denial_transport_failed'));
  }

  if (authenticationResult.status === 'fulfilled') {
    const {
      correctStatus,
      correctCode,
      missingStatus,
      missingChallenge,
      wrongStatus,
      wrongChallenge,
    } = authenticationResult.value || {};
    const missingChallengeOk = isAuthoritativeBasicProxyChallenge(missingChallenge);
    const wrongChallengeOk = isAuthoritativeBasicProxyChallenge(wrongChallenge);
    const authenticationOk = correctStatus === 200 && !text(correctCode) &&
      missingStatus === 407 && missingChallengeOk &&
      wrongStatus === 407 && wrongChallengeOk;
    checks.push(authenticationOk
      ? passed('live_proxy_authentication_contract', {
        authenticated_http_status: 200,
        missing_credentials_http_status: 407,
        wrong_credentials_http_status: 407,
        missing_challenge_sha256: sha256(missingChallenge),
        wrong_challenge_sha256: sha256(wrongChallenge),
      })
      : failed('live_proxy_authentication_contract', 'proxy_authentication_contract_mismatch'));
  } else {
    checks.push(failed('live_proxy_authentication_contract', 'proxy_authentication_transport_failed'));
  }

  const failedChecks = checks.filter((check) => check.status !== 'passed');
  const receipt = {
    schema_version: CONTRACT_VERSION,
    authority: 'unsigned_component_only',
    requires_external_signature: true,
    status: failedChecks.length ? 'failed' : 'passed',
    lane: config.lane,
    candidate_sha: config.candidateSha,
    started_at: startedAt,
    completed_at: now(),
    proxy_origin_sha256: sha256(config.proxyUrl.origin),
    public_probe_origin_sha256: sha256(config.publicProbeUrl.origin),
    denied_probe_origin_sha256: sha256(config.policyDeniedProbeUrl.origin),
    rebinding_probe_origin_sha256: sha256(config.rebindingProbeUrl.origin),
    expected_public_ip_sha256: sha256(config.expectedPublicIp),
    denial_code_sha256: sha256(config.policyDeniedCode),
    check_count: checks.length,
    failure_count: failedChecks.length,
    checks,
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  return receipt;
}

function writeReceipt(receipt, receiptPath) {
  const target = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return target;
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? text(args[index + 1]) : '';
}

async function main() {
  const args = process.argv.slice(2);
  const lane = readArg(args, '--lane');
  const receiptPath = readArg(args, '--receipt') || path.join('tmp', `api-caller-guarded-egress-proxy-proof-${lane || 'unknown'}.json`);
  let receipt;
  try {
    const config = resolveConfig(process.env, lane);
    receipt = await executeProof(config);
  } catch (error) {
    receipt = {
      schema_version: CONTRACT_VERSION,
      authority: 'unsigned_component_only',
      requires_external_signature: true,
      status: 'failed',
      lane: lane || 'unknown',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      check_count: 0,
      failure_count: 1,
      checks: [failed('configuration', /^missing_config:/.test(error.message) ? 'missing_config' : 'invalid_config')],
    };
    receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  }
  const target = writeReceipt(receipt, receiptPath);
  console.log(`[guarded-egress-proxy-proof] status=${receipt.status} lane=${receipt.lane} receipt=${target}`);
  if (receipt.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    console.error('[guarded-egress-proxy-proof] unexpected_failure');
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT_VERSION,
  REQUIRED_CAPABILITIES,
  executeProof,
  defaultConnectProbe,
  defaultAuthenticationProbe,
  defaultRebindingTransitionProbe,
  isAuthoritativeBasicProxyChallenge,
  isPublicIp,
  parseExactHttpsUrl,
  resolveConfig,
  writeReceipt,
};
