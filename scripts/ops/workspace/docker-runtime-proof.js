#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { probeEdgeFunction, resolveBaseUrl, buildProbeUrl } = require('./docker-edge-functions-watch');
const { gitMetadataFromEnv } = require('./docker-runtime/git-metadata');
const { authSurfaceIdentitySha256, loadAuthManifestAuthority, authProofBindingFailures } = require('./docker-runtime/auth-identity');
const { resolveProofServiceSelection, runtimeProofApplicability, proofServiceSelectionMatches } = require('./runtime-service-selection');
const containerPolicy = require('../../../config/ops/runtime-container-policy.json');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const [rawKey, ...inline] = token.slice(2).split('=');
    const key = rawKey.trim();
    let value = inline.length ? inline.join('=') : null;
    if (value == null) {
      const next = argv[index + 1];
      if (next == null || String(next).startsWith('--')) value = true;
      else {
        value = String(next);
        index += 1;
      }
    }
    out[key] = value;
    out[key.replace(/-/g, '_')] = value;
  }
  return out;
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serviceUrl(serviceName, port) {
  const parsedPort = parsePositiveInteger(port, 0);
  if (!serviceName || !parsedPort) return '';
  return `http://${serviceName}:${parsedPort}`;
}

const KNOWN_RUNTIME_FAILURE_PATTERNS = [
  /Unable to resolve/i,
  /Bundling failed/i,
  /Cannot find module/i,
  /ENOENT/i,
  /Internal Server Error/i,
  /Blocked request/i,
  /not allowed/i,
  /Vite Error Overlay/i,
  /vite-error-overlay/i,
  /Next\.js.*error/i,
  /Webpack.*Error/i,
  /Metro.*error/i,
  /Expo.*error/i,
  /wrong[-\s]?backend/i,
  /missing[-\s]?backend/i,
];

function stripHtmlForVisibleText(html = '') {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\t\n\f\r /][^>]*)?>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\t\n\f\r /][^>]*)?>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript(?:[\t\n\f\r /][^>]*)?>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template(?:[\t\n\f\r /][^>]*)?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function listPatternMatches(text = '', patterns = []) {
  return patterns
    .filter((pattern) => pattern.test(String(text || '')))
    .map((pattern) => pattern.source);
}

function normalizeBrowserProofSurface(surface = {}) {
  const name = String(surface.surface || surface.name || surface.service || '').trim();
  const status = String(surface.status || surface.result || '').toLowerCase();
  const consoleErrors = Array.isArray(surface.console_errors) ? surface.console_errors : [];
  const pageErrors = Array.isArray(surface.page_errors) ? surface.page_errors : [];
  const failureTextMatches = Array.isArray(surface.failure_text_matches) ? surface.failure_text_matches : [];
  const sourceFreshness = surface.source_freshness || {};
  const sourceFreshnessOk = sourceFreshness.ok !== false && Number(sourceFreshness.stale_count || 0) === 0;
  const authSessionOk = surface.auth_session_ok === true || surface.auth_session_proven === true || surface.authenticated === true;
  return {
    ...surface,
    surface: name,
    passed_status: ['passed', 'ok', 'success'].includes(status) || surface.ok === true,
    browser_rendered: surface.browser_rendered === true || surface.rendered_non_blank === true || surface.nonblank === true,
    no_runtime_errors: sourceFreshnessOk && (
      surface.no_runtime_errors === true || (
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        failureTextMatches.length === 0 &&
        surface.has_framework_overlay !== true
      )
    ),
    source_freshness_ok: sourceFreshnessOk,
    source_freshness: sourceFreshness,
    expected_visible_state: surface.expected_visible_state === true || surface.required_text_matched === true || surface.visible_runtime === true,
    forbidden_text_absent: surface.forbidden_text_absent !== false && failureTextMatches.length === 0,
    backend_wiring_ok: surface.backend_wiring_ok === true || surface.correct_backend === true || surface.assigned_backend_used === true,
    auth_session_ok: authSessionOk,
    seed_disabled: surface.seed_disabled !== false,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    failure_text_matches: failureTextMatches,
  };
}

function findBrowserProofSurface(browserProof = null, surfaceName = '') {
  if (!browserProof) return null;
  const surfaces = [];
  if (Array.isArray(browserProof.surfaces)) surfaces.push(...browserProof.surfaces);
  if (Array.isArray(browserProof.surface_proofs)) surfaces.push(...browserProof.surface_proofs);
  if (browserProof.surfaces && !Array.isArray(browserProof.surfaces)) {
    for (const [key, value] of Object.entries(browserProof.surfaces)) {
      surfaces.push({ surface: key, ...(value || {}) });
    }
  }
  if (browserProof.surface_proofs && !Array.isArray(browserProof.surface_proofs)) {
    for (const [key, value] of Object.entries(browserProof.surface_proofs)) {
      surfaces.push({ surface: key, ...(value || {}) });
    }
  }
  const normalizedName = String(surfaceName || '').trim();
  const match = surfaces
    .map(normalizeBrowserProofSurface)
    .find((surface) => surface.surface === normalizedName || surface.service === normalizedName);
  return match || null;
}

function loadBrowserProofSummary(summaryPath = '') {
  const resolved = String(summaryPath || '').trim();
  if (!resolved) return null;
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resolved), 'utf8'));
}

function loadBackendProofSummary(summaryPath = '') {
  const resolved = String(summaryPath || '').trim();
  if (!resolved) return null;
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resolved), 'utf8'));
}

function loadAuthProofSummary(summaryPath = '') {
  const resolved = String(summaryPath || '').trim();
  if (!resolved) return null;
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resolved), 'utf8'));
}

function expectedSurfaceChecks(env = process.env, options = {}) {
  const selected = new Set(resolveProofServiceSelection(options.containerPolicy || containerPolicy, options, env));
  const startupAdmission = String(env.DOCKER_RUNTIME_STARTUP_PROOF || '').trim() === '1';
  return [
    {
      surface: 'console-v2',
      service: 'console-v2',
      url: serviceUrl('console-v2', env.CONSOLE_PORT),
      requiredText: /MasarX|Console|<div id="root"/i,
      browserRequired: !startupAdmission,
      backendReadbackRequired: true,
      authRequired: true,
    },
    {
      surface: 'landing',
      service: 'landing',
      url: serviceUrl('landing', env.LANDING_PORT),
      requiredText: /MasarX|masarx|logistics|delivery|root/i,
      browserRequired: !startupAdmission,
      backendReadbackRequired: true,
    },
    {
      surface: 'portal',
      service: 'portal',
      url: serviceUrl('portal', env.PORTAL_PORT),
      requiredText: /MasarX|Portal|Employee|root/i,
      browserRequired: !startupAdmission,
      backendReadbackRequired: true,
      authRequired: true,
    },
    {
      surface: 'fieldops-metro',
      service: 'fieldops-metro',
      url: serviceUrl('fieldops-metro', env.FIELDOPS_E2E_PORT),
      requiredText: /Welcome back|Sign in|Fieldops/i,
      forbiddenText: /Legacy FieldOps|Mobile V1/i,
      proofLabel: 'mobile_v2_development_runtime_proof',
      browserRequired: !startupAdmission,
      backendReadbackRequired: true,
      authRequired: true,
    },
  ].filter((entry) => selected.has(entry.service));
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return {
      url,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      text_sample: text.replace(/\s+/g, ' ').trim().slice(0, 500),
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSurface(surface, options = {}) {
  if (!surface.url) return {
    surface: surface.surface, service: surface.service, url: '', ok: false,
    http_probe_ok: false, runtime_proof_ok: false, failure_reasons: ['selected_surface_port_missing'],
  };
  const result = await fetchText(surface.url, options.timeoutMs).catch((error) => ({
    url: surface.url,
    status: 0,
    ok: false,
    text_sample: '',
    text: '',
    error: error?.message || String(error),
  }));
  const visibleText = stripHtmlForVisibleText(result.text);
  const knownFailures = listPatternMatches(visibleText, [
    ...KNOWN_RUNTIME_FAILURE_PATTERNS,
    ...(surface.forbiddenText ? [surface.forbiddenText] : []),
  ]);
  const requiredOk = surface.requiredText ? surface.requiredText.test(result.text) : true;
  const forbiddenOk = knownFailures.length === 0;
  const blankHttpRender = visibleText.length < 12;
  const browserEvidence = findBrowserProofSurface(options.browserProof, surface.surface);
  const browserChecks = {
    browser_evidence_present: Boolean(browserEvidence),
    browser_rendered: Boolean(browserEvidence?.browser_rendered),
    no_runtime_errors: Boolean(browserEvidence?.no_runtime_errors),
    expected_visible_state: Boolean(browserEvidence?.expected_visible_state),
    forbidden_text_absent: Boolean(browserEvidence?.forbidden_text_absent),
    backend_wiring_ok: surface.backendReadbackRequired ? Boolean(browserEvidence?.backend_wiring_ok) : true,
    auth_session_ok: surface.authRequired ? Boolean(browserEvidence?.auth_session_ok) : true,
    seed_disabled: browserEvidence ? browserEvidence.seed_disabled !== false : true,
    source_freshness_ok: browserEvidence ? browserEvidence.source_freshness_ok !== false : true,
  };
  const browserProofOk = !surface.browserRequired || Object.values(browserChecks).every(Boolean);
  const blankHttpRenderAllowedByBrowser = surface.browserRequired &&
    browserChecks.browser_evidence_present &&
    browserChecks.browser_rendered;
  const failureReasons = [];
  if (!result.ok) failureReasons.push('http_probe_not_reachable');
  if (!requiredOk) failureReasons.push('required_runtime_text_missing');
  if (!forbiddenOk) failureReasons.push('known_runtime_failure_text_present');
  if (blankHttpRender && !blankHttpRenderAllowedByBrowser) failureReasons.push('http_probe_has_no_visible_text');
  if (surface.browserRequired && !browserChecks.browser_evidence_present) failureReasons.push('missing_browser_render_evidence');
  if (surface.browserRequired && browserChecks.browser_evidence_present && !browserChecks.browser_rendered) failureReasons.push('browser_render_not_proven');
  if (surface.browserRequired && browserChecks.browser_evidence_present && !browserChecks.no_runtime_errors) failureReasons.push('browser_runtime_errors_present');
  if (surface.browserRequired && browserChecks.browser_evidence_present && !browserChecks.source_freshness_ok) failureReasons.push('served_source_stale');
  if (surface.browserRequired && browserChecks.browser_evidence_present && !browserChecks.expected_visible_state) failureReasons.push('browser_expected_state_missing');
  if (surface.browserRequired && browserChecks.browser_evidence_present && !browserChecks.forbidden_text_absent) failureReasons.push('browser_forbidden_text_present');
  if (surface.backendReadbackRequired && browserChecks.browser_evidence_present && !browserChecks.backend_wiring_ok) failureReasons.push('assigned_backend_wiring_not_proven');
  if (surface.authRequired && browserChecks.browser_evidence_present && !browserChecks.auth_session_ok) failureReasons.push('lane_local_auth_session_not_proven');
  if (browserChecks.browser_evidence_present && !browserChecks.seed_disabled) failureReasons.push('seed_or_demo_mode_detected');
  const httpProbeOk = result.ok && requiredOk && forbiddenOk && (!blankHttpRender || blankHttpRenderAllowedByBrowser);
  const runtimeProofOk = httpProbeOk && browserProofOk;
  return {
    surface: surface.surface,
    service: surface.service,
    url: surface.url,
    http_status: result.status,
    reachable: result.ok,
    error: result.error || '',
    http_probe_ok: httpProbeOk,
    required_text_matched: requiredOk,
    forbidden_text_absent: forbiddenOk,
    known_failure_text_matches: knownFailures,
    visible_text_sample: visibleText.slice(0, 500),
    blank_http_render: blankHttpRender,
    browser_render_required: Boolean(surface.browserRequired),
    backend_readback_required: Boolean(surface.backendReadbackRequired),
    auth_required: Boolean(surface.authRequired),
    browser_proof: browserChecks,
    proof_label: surface.proofLabel || '',
    text_sample: result.text_sample,
    failure_reasons: failureReasons,
    runtime_proof_ok: runtimeProofOk,
    ok: runtimeProofOk,
  };
}

async function checkBackend(env = process.env) {
  const baseUrl = String(env.SUPABASE_INTERNAL_URL || env.SUPABASE_URL || '').replace(/\/+$/g, '');
  if (!baseUrl) {
    return {
      ok: false,
      reason: 'missing_supabase_internal_url',
    };
  }
  const health = await fetchText(`${baseUrl}/auth/v1/health`, 30000).catch((error) => ({
    status: 0,
    ok: false,
    text_sample: '',
    error: error?.message || String(error),
  }));
  return {
    url: `${baseUrl}/auth/v1/health`,
    http_status: health.status,
    reachable: Boolean(health.ok),
    ok: Boolean(health.ok),
    error: health.error || '',
  };
}

async function readMobileV2Policy(env = process.env, options = {}) {
  const identity = options.authAuthority?.identities?.find((entry) => entry.surface === 'fieldops-metro');
  const mobileAuthority = options.authAuthority && { ...options.authAuthority, identities: identity ? [identity] : [] };
  if (!identity || authProofBindingFailures(options.authProof, mobileAuthority, ['fieldops-metro']).length
    || options.authProof?.status !== 'passed') return { ok: false, reason: 'missing_manifest_bound_driver_policy_context' };
  const databaseUrl = resolveDockerDatabaseUrl(env);
  if (!databaseUrl) {
    return {
      ok: false,
      reason: 'missing_database_url',
    };
  }
  const client = new (options.ClientImpl || Client)({
    connectionString: databaseUrl,
    ssl: String(env.PGSSLMODE || '').toLowerCase() === 'require' ? { rejectUnauthorized: false } : false,
  });
  try {
    await client.connect();
    const context = await resolveMobileV2ProofContext(client, env, { ...options, authAuthority: mobileAuthority });
    if (!context.ok) return context;
    const result = await withDriverClaims(client, context, async () => client.query(
      `
        select public.resolve_mobile_shell_policy(
          'driver',
          jsonb_build_object(
            'organization_id', $1::uuid,
            'correlation_id', gen_random_uuid()
          )
        ) as policy
      `,
      [context.organization_id],
    ));
    const policy = result.rows?.[0]?.policy || {};
    const v2Enabled = Boolean(policy.v2_enabled);
    return {
      ok: v2Enabled,
      active_role: policy.active_role || 'driver',
      v2_enabled: v2Enabled,
      rollout_cohort: policy.rollout_cohort || '',
      scope_type: policy.scope_type || '',
      scope_id: policy.scope_id || null,
      version: policy.version || null,
      proof_context: {
        user_id_present: Boolean(context.user_id),
        organization_id: context.organization_id,
        source: context.source,
        identity_sha256: context.identity_sha256,
        manifest_sha256: context.manifest_sha256,
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function resolveMobileV2ProofContext(client, env = process.env, options = {}) {
  const authority = options.authAuthority;
  const proof = options.authProof;
  const identity = authority?.identities?.find((entry) => entry.surface === 'fieldops-metro');
  if (!identity || authProofBindingFailures(proof, authority, ['fieldops-metro']).length
    || proof?.status !== 'passed') {
    return { ok: false, reason: 'missing_manifest_bound_driver_policy_context' };
  }
  const explicitUserId = String(env.MOBILE_V2_PROOF_USER_ID || env.FIELDOPS_PROOF_USER_ID || '').trim();
  const explicitOrganizationId = String(env.MOBILE_V2_PROOF_ORGANIZATION_ID || env.FIELDOPS_PROOF_ORGANIZATION_ID || '').trim();
  if ((explicitUserId && explicitUserId !== identity.auth_user_id)
    || (explicitOrganizationId && explicitOrganizationId !== identity.organization_id)) {
    return { ok: false, reason: 'mobile_policy_explicit_identity_mismatch' };
  }
  const result = await client.query(`
    select id, organization_id, email, user_type
      from public.users
     where id = $1::uuid and organization_id = $2::uuid
       and lower(email) = $3 and user_type = 'driver'
       and coalesce(status, 'active') = 'active'
  `, [identity.auth_user_id, identity.organization_id, identity.email]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || !row || authSurfaceIdentitySha256({
    surface: 'fieldops-metro', auth_user_id: row.id, organization_id: row.organization_id,
    email: row.email, user_type: row.user_type,
  }) !== authSurfaceIdentitySha256(identity)) {
    return { ok: false, reason: 'manifest_driver_policy_readback_mismatch' };
  }
  return {
    ok: true, user_id: identity.auth_user_id, organization_id: identity.organization_id,
    email: identity.email, source: 'exact_auth_manifest_identity',
    identity_sha256: authSurfaceIdentitySha256(identity),
    manifest_sha256: authority.manifest_sha256,
  };
}

function buildDriverClaims(context) {
  return {
    sub: context.user_id,
    role: 'authenticated',
    aud: 'authenticated',
    email: context.email || undefined,
    organization_id: context.organization_id,
    user_type: 'driver',
    app_metadata: {
      provider: 'email',
      providers: ['email'],
    },
    user_metadata: {},
  };
}

async function withDriverClaims(client, context, callback) {
  const claims = buildDriverClaims(context);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [claims.sub]);
    await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await callback();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function resolveDockerDatabaseUrl(env = process.env) {
  const raw = String(env.DATABASE_URL || '').trim();
  if (!raw) return '';
  if (String(env.MASARX_DOCKER_RUNTIME || '').trim() !== '1') return raw;
  try {
    const parsed = new URL(raw);
    // objectives:allow LOCALHOST Justification: Docker proof translates only loopback database hosts to the container-visible host gateway.
    if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      parsed.hostname = 'rvzwwjlztwwisjthghnipgjr.example.invalid';
    }
    return parsed.toString();
  } catch (_) {
    // objectives:allow LOCALHOST Justification: malformed legacy DSNs receive the same narrow loopback-to-container host translation.
    return raw.replace('@127.0.0.1:', '@rvzwwjlztwwisjthghnipgjr.example.invalid:').replace('@localhost:', '@rvzwwjlztwwisjthghnipgjr.example.invalid:');
  }
}

async function checkEdgeFunction(env = process.env) {
  const baseUrl = resolveBaseUrl({}, env);
  if (!baseUrl) {
    return {
      ok: false,
      reason: 'missing_edge_functions_url',
    };
  }
  const functionName = String(env.EDGE_FUNCTION_HEALTH_FUNCTION || 'metrics-echo-test');
  const url = buildProbeUrl(baseUrl, functionName);
  const result = await probeEdgeFunction(url, env).catch((error) => ({
    ok: false,
    status: 0,
    url,
    error: error?.message || String(error),
  }));
  return {
    ok: Boolean(result.ok),
    url,
    http_status: result.status,
    error: result.error || '',
  };
}

function redactedEnvSummary(env = process.env) {
  return {
    workspace_id: env.WORKSPACE_NAME || '',
    runtime_driver: env.MASARX_RUNTIME_DRIVER || '',
    compose_project: env.MASARX_APP_COMPOSE_PROJECT_NAME || '',
    backend_project: env.SUPABASE_COMPOSE_PROJECT_NAME || '',
    seed_disabled: env.VITE_USE_SEED === 'false' && env.NEXT_PUBLIC_USE_SEED === 'false',
    fieldops_base_url_env_present: Boolean(env.FIELDOPS_BASE_URL),
    public_supabase_url_present: Boolean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL),
    internal_supabase_url_present: Boolean(env.SUPABASE_INTERNAL_URL),
    database_url_present: Boolean(env.DATABASE_URL),
  };
}

async function runDockerRuntimeProof(options = {}, env = process.env) {
  const startedAt = Date.now();
  const services = resolveProofServiceSelection(options.containerPolicy || containerPolicy, options, env);
  const applicability = runtimeProofApplicability(services);
  const timeoutMs = parsePositiveInteger(options.timeoutMs || options['timeout-ms'], 30000);
  const startupAdmission = String(env.DOCKER_RUNTIME_STARTUP_PROOF || '').trim() === '1';
  const browserProofSummaryPath = String(
    options.browserProofSummary ||
      options['browser-proof-summary'] ||
      env.DOCKER_RUNTIME_BROWSER_PROOF_SUMMARY ||
      '',
  ).trim();
  const browserProof = startupAdmission ? null : loadBrowserProofSummary(browserProofSummaryPath);
  const backendProofSummaryPath = String(
    options.backendProofSummary ||
      options['backend-proof-summary'] ||
      env.DOCKER_RUNTIME_BACKEND_PROOF_SUMMARY ||
      '',
  ).trim();
  const backendProof = loadBackendProofSummary(backendProofSummaryPath);
  const authProofSummaryPath = String(
    options.authProofSummary ||
      options['auth-proof-summary'] ||
      env.DOCKER_RUNTIME_AUTH_PROOF_SUMMARY ||
      '',
  ).trim();
  const authProof = applicability.auth_fixture_proof_present ? loadAuthProofSummary(authProofSummaryPath) : null;
  let authAuthority = null;
  let authIdentityFailures = [];
  if (applicability.auth_fixture_proof_present) {
    try {
      authAuthority = loadAuthManifestAuthority(
        options.authManifest || options['auth-manifest'] || env.DOCKER_RUNTIME_AUTH_MANIFEST,
        env.WORKSPACE_NAME, services,
      );
      authIdentityFailures = authProofBindingFailures(authProof, authAuthority, services);
      if (!proofServiceSelectionMatches(authProof?.services, services) || authProof?.applicability?.auth !== true) {
        authIdentityFailures.push('auth_proof_service_selection_mismatch');
      }
    } catch (_) { authIdentityFailures = ['auth_manifest_authority_unavailable']; }
  }
  const surfaces = [];
  for (const surface of expectedSurfaceChecks(env, { ...options, services })) {
    surfaces.push(await (options.checkSurfaceImpl || checkSurface)(surface, { timeoutMs, browserProof }));
  }
  const backend = await (options.checkBackendImpl || checkBackend)(env);
  const edge = applicability.edge_functions_reachable
    ? await (options.checkEdgeFunctionImpl || checkEdgeFunction)(env) : { status: 'not_required' };
  const mobilePolicy = applicability.mobile_v2_development_runtime_proof
    ? await (options.readMobileV2PolicyImpl || readMobileV2Policy)(env, { authAuthority, authProof })
    : { status: 'not_required' };
  const summary = {
    generated_at: new Date().toISOString(),
    proof: 'docker-runtime-in-container-e2e',
    services, applicability,
    proof_boundary: startupAdmission ? 'startup_runtime_admission' : 'development_runtime_proof_not_native_release',
    workspace_id: env.WORKSPACE_NAME || '',
    owner: env.MASARX_RUNTIME_OWNER || '',
    compose_project: env.MASARX_APP_COMPOSE_PROJECT_NAME || '',
    backend_project: env.SUPABASE_COMPOSE_PROJECT_NAME || '',
    runtime_driver: env.MASARX_RUNTIME_DRIVER || '',
    ...gitMetadataFromEnv(env),
    duration_ms: Date.now() - startedAt,
    env: redactedEnvSummary(env),
    browser_proof_summary_path: browserProofSummaryPath,
    browser_proof_tier: browserProof?.browser_proof_tier || browserProof?.proof_tier || '',
    backend_proof_summary_path: backendProofSummaryPath,
    backend_readback_proof: backendProof ? {
      status: backendProof.status || '',
      acceptance: backendProof.acceptance || {},
      workspace_id: backendProof.workspace_id || '',
      assigned_backend: backendProof.assigned_backend || {},
      edge_function_proofs: backendProof.edge_function_proofs ? {
        ok: backendProof.edge_function_proofs.ok === true,
        registry_loaded: backendProof.edge_function_proofs.registry_loaded === true,
        function_count: backendProof.edge_function_proofs.function_count || 0,
        functions: Array.isArray(backendProof.edge_function_proofs.functions)
          ? backendProof.edge_function_proofs.functions.map((entry) => ({
            name: entry.name || '',
            ok: entry.ok === true,
            expected_auth_mode: entry.expected_auth_mode || '',
            auth_source: entry.auth_source || '',
            unauthenticated_ok: entry.unauthenticated?.ok === true,
            authenticated_status_ok: entry.authenticated?.status_ok === true,
            authenticated_response_shape_ok: entry.authenticated?.response_shape_ok === true,
            failures: entry.failures || [],
          }))
          : [],
      } : null,
      landing_intake_readback: backendProof.landing_intake_readback ? {
        ok: backendProof.landing_intake_readback.ok === true,
        endpoint: backendProof.landing_intake_readback.endpoint || '',
        response: backendProof.landing_intake_readback.response ? {
          status: backendProof.landing_intake_readback.response.status || 0,
          response_shape_ok: backendProof.landing_intake_readback.response.response_shape_ok === true,
          id_present: backendProof.landing_intake_readback.response.id_present === true,
        } : null,
        readback: backendProof.landing_intake_readback.readback ? {
          ok: backendProof.landing_intake_readback.readback.ok === true,
          row_present: backendProof.landing_intake_readback.readback.row_present === true,
          email_matches: backendProof.landing_intake_readback.readback.email_matches === true,
          company_matches: backendProof.landing_intake_readback.readback.company_matches === true,
          marker_matches: backendProof.landing_intake_readback.readback.marker_matches === true,
        } : null,
      } : null,
      peer_isolation: backendProof.peer_isolation ? {
        tested: backendProof.peer_isolation.tested === true,
        peer_count: backendProof.peer_isolation.peer_count || 0,
        ok: backendProof.peer_isolation.ok === true,
      } : null,
    } : null,
    auth_proof_summary_path: authProofSummaryPath,
    auth_fixture_proof: authProof ? {
      status: authProof.status || '',
      acceptance: authProof.acceptance || {},
      workspace_id: authProof.workspace_id || '',
      manifest_mode: authProof.manifest_mode || '',
      run_id: authProof.run_id || '',
      manifest_sha256: authProof.manifest_sha256 || '',
      identity_failures: authIdentityFailures,
      surfaces: Array.isArray(authProof.surfaces)
        ? authProof.surfaces.map((surface) => ({
          surface: surface.surface || '',
          identity_sha256: surface.identity_sha256 || '',
          proof_label: surface.proof_label || '',
          identity_present: surface.identity_present === true,
          password_grant_ok: surface.password_grant_ok === true,
          app_user_readback_ok: surface.app_user_readback_ok === true,
          auth_session_proven: surface.auth_session_proven === true,
          backend_readback_ok: surface.backend_readback_ok === true,
        }))
        : [],
    } : { status: 'not_required', applicability: { auth: false }, surfaces: [] },
    surfaces,
    backend,
    edge_functions: edge,
    mobile_v2: {
      status: applicability.mobile_v2_development_runtime_proof ? (mobilePolicy.ok === true ? 'passed' : 'failed') : 'not_required',
      applicable: applicability.mobile_v2_development_runtime_proof,
      service_name: 'fieldops-metro',
      proof_label: 'mobile_v2_development_runtime_proof',
      development_runtime_proof_required: applicability.mobile_v2_development_runtime_proof,
      native_release_gate_satisfied: false,
      visible_runtime: surfaces.some((surface) => (
        surface.surface === 'fieldops-metro' &&
        surface.runtime_proof_ok === true
      )),
      backend_readback: mobilePolicy,
    },
  };
  summary.acceptance = {
    all_surface_http_probes_reachable: surfaces.length > 0 && surfaces.every((surface) => surface.http_probe_ok),
    all_surfaces_runtime_proven: surfaces.length > 0 && surfaces.every((surface) => surface.runtime_proof_ok),
    browser_proof_present: startupAdmission || Boolean(browserProof),
    browser_proof_or_startup_boundary_proven: startupAdmission || Boolean(browserProof),
    backend_readback_proof_present: Boolean(backendProof),
    backend_readback_proof_passed: backendProof?.status === 'passed',
    landing_intake_readback_proven: backendProof?.acceptance?.landing_intake_readback_proven === true,
    auth_fixture_proof_present: Boolean(authProof),
    auth_fixture_proof_passed: authProof?.status === 'passed',
    auth_fixture_identity_bound: authIdentityFailures.length === 0,
    backend_reachable: backend.ok === true,
    edge_functions_reachable: edge.ok === true,
    fieldops_service_canonical: summary.mobile_v2.service_name === 'fieldops-metro',
    mobile_v2_development_runtime_proof: !applicability.mobile_v2_development_runtime_proof ||
      (summary.mobile_v2.visible_runtime === true && mobilePolicy.ok === true),
    native_release_gate_not_satisfied: summary.mobile_v2.native_release_gate_satisfied === false,
    seed_disabled: summary.env.seed_disabled === true,
  };
  for (const [key, required] of Object.entries(applicability)) {
    if (!required) summary.acceptance[key] = 'not_required';
  }
  summary.status = Object.entries(applicability).every(([key, required]) =>
    summary.acceptance[key] === (required ? true : 'not_required')) ? 'passed' : 'failed';
  return summary;
}

async function main() {
  const args = parseArgs();
  const summary = await runDockerRuntimeProof(args);
  const summaryOut = String(args['summary-out'] || args.summary_out || process.env.DOCKER_RUNTIME_PROOF_SUMMARY_OUT || '').trim();
  if (summaryOut) {
    const resolved = path.resolve(process.cwd(), summaryOut);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  KNOWN_RUNTIME_FAILURE_PATTERNS,
  checkBackend,
  checkEdgeFunction,
  checkSurface,
  expectedSurfaceChecks,
  listPatternMatches,
  loadBrowserProofSummary,
  loadBackendProofSummary,
  loadAuthProofSummary,
  normalizeBrowserProofSurface,
  parseArgs,
  readMobileV2Policy,
  redactedEnvSummary,
  resolveDockerDatabaseUrl,
  resolveMobileV2ProofContext,
  runDockerRuntimeProof,
  serviceUrl,
  stripHtmlForVisibleText,
};
