const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkBackend,
  checkSurface,
  expectedSurfaceChecks,
  runDockerRuntimeProof,
  redactedEnvSummary,
  resolveDockerDatabaseUrl,
  resolveMobileV2ProofContext,
  serviceUrl,
} = require('../../../scripts/ops/workspace/docker-runtime-proof');

describe('workspace docker runtime proof', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('builds Compose-service URLs from lane ports', () => {
    expect(serviceUrl('console-v2', '5186')).toBe('http://console-v2:5186');
    expect(serviceUrl('fieldops-metro', 8083)).toBe('http://fieldops-metro:8083');
    expect(serviceUrl('fieldops-metro', '')).toBe('');
  });

  test('enumerates all app surfaces with canonical FieldOps service naming', () => {
    const checks = expectedSurfaceChecks({
      CONSOLE_PORT: '5186',
      LANDING_PORT: '3339',
      PORTAL_PORT: '3019',
      FIELDOPS_E2E_PORT: '8083',
    });

    expect(checks.map((check) => check.surface)).toEqual([
      'console-v2',
      'landing',
      'portal',
      'fieldops-metro',
    ]);
    expect(checks.map((check) => check.surface)).not.toContain('fieldops-mobile-v2');
    expect(checks.find((check) => check.surface === 'fieldops-metro').proofLabel).toBe(
      'mobile_v2_development_runtime_proof',
    );
  });

  test('surface proof does not pass Mobile V2 from fetch-only copy without browser evidence', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<main>Welcome back. Sign in to start your shift. Fieldops</main>',
    }));

    await expect(checkSurface({
      surface: 'fieldops-metro',
      service: 'fieldops-metro',
      url: 'http://fieldops-metro:8083',
      requiredText: /Welcome back|Sign in|Fieldops/i,
      forbiddenText: /Legacy FieldOps|Mobile V1/i,
      proofLabel: 'mobile_v2_development_runtime_proof',
      browserRequired: true,
      backendReadbackRequired: true,
    })).resolves.toMatchObject({
      http_probe_ok: true,
      ok: false,
      proof_label: 'mobile_v2_development_runtime_proof',
      forbidden_text_absent: true,
      failure_reasons: ['missing_browser_render_evidence'],
    });
  });

  test('surface proof passes only with browser render and assigned backend evidence', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<main>Welcome back. Sign in to start your shift. Fieldops</main>',
    }));

    await expect(checkSurface({
      surface: 'fieldops-metro',
      service: 'fieldops-metro',
      url: 'http://fieldops-metro:8083',
      requiredText: /Welcome back|Sign in|Fieldops/i,
      forbiddenText: /Legacy FieldOps|Mobile V1/i,
      proofLabel: 'mobile_v2_development_runtime_proof',
      browserRequired: true,
      backendReadbackRequired: true,
    }, {
      browserProof: {
        proof_tier: 'playwright-browser-context',
        surfaces: [{
          surface: 'fieldops-metro',
          status: 'passed',
          browser_rendered: true,
          no_runtime_errors: true,
          expected_visible_state: true,
          forbidden_text_absent: true,
          backend_wiring_ok: true,
          auth_session_ok: true,
          seed_disabled: true,
        }],
      },
    })).resolves.toMatchObject({
      ok: true,
      runtime_proof_ok: true,
      browser_proof: {
        browser_evidence_present: true,
        browser_rendered: true,
        backend_wiring_ok: true,
        auth_session_ok: true,
      },
    });
  });

  test('surface proof rejects protected surfaces without lane-local auth evidence', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<main>MasarX Console Dashboard Operations</main>',
    }));

    await expect(checkSurface({
      surface: 'console-v2',
      service: 'console-v2',
      url: 'http://console-v2:5192',
      requiredText: /MasarX|Console/i,
      browserRequired: true,
      backendReadbackRequired: true,
      authRequired: true,
    }, {
      browserProof: {
        proof_tier: 'playwright-browser-context',
        surfaces: [{
          surface: 'console-v2',
          status: 'passed',
          browser_rendered: true,
          no_runtime_errors: true,
          expected_visible_state: true,
          forbidden_text_absent: true,
          backend_wiring_ok: true,
          seed_disabled: true,
        }],
      },
    })).resolves.toMatchObject({
      ok: false,
      browser_proof: {
        auth_session_ok: false,
      },
      failure_reasons: expect.arrayContaining([
        'lane_local_auth_session_not_proven',
      ]),
    });
  });

  test('surface proof rejects V1 fallback copy even with reachable HTTP', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<main>Legacy FieldOps Mobile V1 fallback</main>',
    }));

    await expect(checkSurface({
      surface: 'fieldops-metro',
      service: 'fieldops-metro',
      url: 'http://fieldops-metro:8083',
      requiredText: /Welcome back|Sign in|Fieldops/i,
      forbiddenText: /Legacy FieldOps|Mobile V1/i,
      proofLabel: 'mobile_v2_development_runtime_proof',
    })).resolves.toMatchObject({
      ok: false,
      forbidden_text_absent: false,
      known_failure_text_matches: ['Legacy FieldOps|Mobile V1'],
    });
  });

  test('surface proof rejects blocked dev-server host responses', async () => {
    global.fetch = jest.fn(async () => ({
      status: 403,
      text: async () => 'Blocked request. This host ("console-v2") is not allowed.',
    }));

    await expect(checkSurface({
      surface: 'console-v2',
      service: 'console-v2',
      url: 'http://console-v2:5192',
      requiredText: /MasarX|Console|<div id="root"/i,
      forbiddenText: /Blocked request|not allowed/i,
    })).resolves.toMatchObject({
      ok: false,
      reachable: false,
      forbidden_text_absent: false,
    });
  });

  test('surface proof rejects shell-only 200 responses as port-only readiness', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<html><body><div id="root"></div><script src="/src/main.tsx"></script></body></html>',
    }));

    await expect(checkSurface({
      surface: 'console-v2',
      service: 'console-v2',
      url: 'http://console-v2:5192',
      requiredText: /<div id="root"/i,
      browserRequired: true,
      backendReadbackRequired: true,
    })).resolves.toMatchObject({
      reachable: true,
      http_probe_ok: false,
      blank_http_render: true,
      ok: false,
      failure_reasons: expect.arrayContaining([
        'http_probe_has_no_visible_text',
        'missing_browser_render_evidence',
      ]),
    });
  });

  test('surface proof accepts JS-rendered shell only when browser evidence proves the runtime', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<!doctype html><html><head><title>Fieldops</title></head><body><div id="root"></div><script src="/index.bundle"></script></body></html>',
    }));

    await expect(checkSurface({
      surface: 'fieldops-metro',
      service: 'fieldops-metro',
      url: 'http://fieldops-metro:8083',
      requiredText: /Welcome back|Sign in|Fieldops/i,
      forbiddenText: /Legacy FieldOps|Mobile V1/i,
      proofLabel: 'mobile_v2_development_runtime_proof',
      browserRequired: true,
      backendReadbackRequired: true,
      authRequired: true,
    }, {
      browserProof: {
        proof_tier: 'playwright-browser-context',
        surfaces: [{
          surface: 'fieldops-metro',
          status: 'passed',
          browser_rendered: true,
          no_runtime_errors: true,
          expected_visible_state: true,
          forbidden_text_absent: true,
          backend_wiring_ok: true,
          auth_session_ok: true,
          seed_disabled: true,
        }],
      },
    })).resolves.toMatchObject({
      reachable: true,
      blank_http_render: true,
      http_probe_ok: true,
      ok: true,
      failure_reasons: [],
    });
  });

  test('surface proof ignores failure-like script source when visible text and browser proof are clean', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<main>Portal</main><script>const message = "Unable to resolve Expo error copy from bundled source";</script>',
    }));

    await expect(checkSurface({
      surface: 'portal',
      service: 'portal',
      url: 'http://portal:3019',
      requiredText: /Portal/i,
      browserRequired: true,
      backendReadbackRequired: true,
      authRequired: true,
    }, {
      browserProof: {
        proof_tier: 'playwright-browser-context',
        surfaces: [{
          surface: 'portal',
          status: 'passed',
          browser_rendered: true,
          no_runtime_errors: true,
          expected_visible_state: true,
          forbidden_text_absent: true,
          backend_wiring_ok: true,
          auth_session_ok: true,
          seed_disabled: true,
        }],
      },
    })).resolves.toMatchObject({
      forbidden_text_absent: true,
      known_failure_text_matches: [],
      ok: true,
      failure_reasons: [],
    });
  });

  test('surface proof records fetch failures instead of crashing proof summary', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(checkSurface({
      surface: 'portal',
      service: 'portal',
      url: 'http://portal:3019',
      requiredText: /Portal/i,
      browserRequired: true,
      backendReadbackRequired: true,
    })).resolves.toMatchObject({
      ok: false,
      reachable: false,
      http_status: 0,
      error: 'fetch failed',
      failure_reasons: expect.arrayContaining([
        'http_probe_not_reachable',
        'missing_browser_render_evidence',
      ]),
    });
  });

  test('backend proof uses the internal Supabase URL without exposing secrets', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '{"name":"GoTrue"}',
    }));

    await expect(checkBackend({ SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370' }))
      .resolves
      .toMatchObject({
        ok: true,
        url: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370/auth/v1/health',
      });
  });

  test('rewrites local database URLs for in-container backend readback', () => {
    const rewritten = resolveDockerDatabaseUrl({
      MASARX_DOCKER_RUNTIME: '1',
      DATABASE_URL: (['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'57518',"/",'postgres'].join("")),
    });
    const parsed = new URL(rewritten);

    expect(parsed.hostname).toBe('rvzwwjlztwwisjthghnipgjr.example.invalid');
    expect(parsed.port).toBe('57518');
    expect(parsed.username).toBe('postgres');
    expect(parsed.password).toBe('postgres');
  });

  test('redacted env summary records presence flags only', () => {
    expect(redactedEnvSummary({
      WORKSPACE_NAME: 'wk-proof',
      MASARX_RUNTIME_DRIVER: 'docker',
      MASARX_APP_COMPOSE_PROJECT_NAME: 'masarx-app-wk-proof',
      SUPABASE_COMPOSE_PROJECT_NAME: 'masarx-wk-proof',
      VITE_USE_SEED: 'false',
      NEXT_PUBLIC_USE_SEED: 'false',
      FIELDOPS_BASE_URL: 'http://127.0.0.1:8083',
      SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370',
      DATABASE_URL: 'postgresql://example',
    })).toEqual({
      workspace_id: 'wk-proof',
      runtime_driver: 'docker',
      compose_project: 'masarx-app-wk-proof',
      backend_project: 'masarx-wk-proof',
      seed_disabled: true,
      fieldops_base_url_env_present: true,
      public_supabase_url_present: false,
      internal_supabase_url_present: true,
      database_url_present: true,
    });
  });

  test('resolves Mobile V2 proof context from an active lane driver', async () => {
    const query = jest.fn(async () => ({
      rows: [{
        id: 'c423d58d-1bcd-4090-8923-dd56ee8301ad',
        organization_id: '11c11bb7-132a-4d9b-be3f-de77cbe41384',
        email: 'mlrznqhylvnirjwnhxhsjwgm@example.invalid',
      }],
    }));

    await expect(resolveMobileV2ProofContext({ query })).resolves.toMatchObject({
      ok: true,
      user_id: 'c423d58d-1bcd-4090-8923-dd56ee8301ad',
      organization_id: '11c11bb7-132a-4d9b-be3f-de77cbe41384',
      source: 'public.users.active_driver',
    });
    expect(query.mock.calls[0][0]).toContain("user_type = 'driver'");
  });

  test('runtime proof summary fails closed when browser proof is missing', async () => {
    global.fetch = jest.fn(async (url) => ({
      status: String(url).includes('/auth/v1/health') ? 200 : 200,
      text: async () => (
        String(url).includes('/auth/v1/health')
          ? '{"name":"GoTrue"}'
          : '<main>MasarX Console Portal logistics Welcome back Sign in Fieldops</main>'
      ),
    }));

    const summary = await runDockerRuntimeProof({
      timeoutMs: 1000,
    }, {
      WORKSPACE_NAME: 'wk-no-browser-proof',
      MASARX_RUNTIME_DRIVER: 'docker',
      MASARX_APP_COMPOSE_PROJECT_NAME: 'masarx-app-wk-no-browser-proof',
      SUPABASE_COMPOSE_PROJECT_NAME: 'masarx-wk-no-browser-proof',
      CONSOLE_PORT: '5186',
      LANDING_PORT: '3339',
      PORTAL_PORT: '3019',
      FIELDOPS_E2E_PORT: '8083',
      FIELDOPS_BASE_URL: 'http://127.0.0.1:8083',
      SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370',
      VITE_USE_SEED: 'false',
      NEXT_PUBLIC_USE_SEED: 'false',
      DATABASE_URL: '',
    });

    expect(summary.status).toBe('failed');
    expect(summary.acceptance.all_surface_http_probes_reachable).toBe(true);
    expect(summary.acceptance.all_surfaces_runtime_proven).toBe(false);
    expect(summary.acceptance.browser_proof_present).toBe(false);
    expect(summary.acceptance.backend_readback_proof_present).toBe(false);
    expect(summary.acceptance.backend_readback_proof_passed).toBe(false);
    expect(summary.acceptance.auth_fixture_proof_present).toBe(false);
    expect(summary.acceptance.auth_fixture_proof_passed).toBe(false);
    expect(summary.surfaces.every((surface) => surface.failure_reasons.includes('missing_browser_render_evidence')))
      .toBe(true);
  });

  test('runtime proof records lane-local auth fixture proof without treating it as browser login proof', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-auth-summary-'));
    const authSummaryPath = path.join(tmpDir, 'auth-proof-summary.json');
    fs.writeFileSync(authSummaryPath, `${JSON.stringify({
      status: 'passed',
      workspace_id: 'wk-auth-summary',
      manifest_mode: 'ephemeral',
      run_id: 'wk-auth-summary',
      acceptance: {
        lane_local_auth_manifest_ephemeral: true,
        required_surface_identities_present: true,
        fixture_unique_per_lane: true,
        password_grants_succeeded: true,
        app_user_backend_readback_succeeded: true,
        no_secret_values_recorded: true,
      },
      surfaces: [{
        surface: 'console-v2',
        identity_present: true,
        password_grant_ok: true,
        app_user_readback_ok: true,
        auth_session_proven: true,
        backend_readback_ok: true,
      }],
    }, null, 2)}\n`, 'utf8');
    global.fetch = jest.fn(async (url) => ({
      status: String(url).includes('/auth/v1/health') ? 200 : 200,
      text: async () => (
        String(url).includes('/auth/v1/health')
          ? '{"name":"GoTrue"}'
          : '<main>MasarX Console Dashboard Operations</main>'
      ),
    }));

    const summary = await runDockerRuntimeProof({
      timeoutMs: 1000,
      authProofSummary: authSummaryPath,
    }, {
      WORKSPACE_NAME: 'wk-auth-summary',
      MASARX_RUNTIME_DRIVER: 'docker',
      MASARX_APP_COMPOSE_PROJECT_NAME: 'masarx-app-wk-auth-summary',
      SUPABASE_COMPOSE_PROJECT_NAME: 'masarx-wk-auth-summary',
      CONSOLE_PORT: '5186',
      SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370',
      VITE_USE_SEED: 'false',
      NEXT_PUBLIC_USE_SEED: 'false',
      DATABASE_URL: '',
    });

    expect(summary.status).toBe('failed');
    expect(summary.acceptance.auth_fixture_proof_present).toBe(true);
    expect(summary.acceptance.auth_fixture_proof_passed).toBe(true);
    expect(summary.auth_fixture_proof).toMatchObject({
      status: 'passed',
      workspace_id: 'wk-auth-summary',
      manifest_mode: 'ephemeral',
    });
    expect(summary.acceptance.all_surfaces_runtime_proven).toBe(false);
    expect(summary.surfaces[0].failure_reasons).toContain('missing_browser_render_evidence');
  });
});
