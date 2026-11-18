const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

  test('startup admission makes browser evidence deferred while retaining exact service HTTP proof', () => {
    const checks = expectedSurfaceChecks({
      DOCKER_RUNTIME_DEPENDENCY_SERVICES: 'landing,fieldops-metro',
      DOCKER_RUNTIME_STARTUP_PROOF: '1', LANDING_PORT: '3339', FIELDOPS_E2E_PORT: '8083',
    });
    expect(checks.map((entry) => entry.service)).toEqual(['landing', 'fieldops-metro']);
    expect(checks.every((entry) => entry.browserRequired === false)).toBe(true);
    expect(checks.every((entry) => entry.backendReadbackRequired === true)).toBe(true);
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

  test('surface proof fails when browser proof reports stale served source', async () => {
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
          status: 'failed',
          browser_rendered: true,
          no_runtime_errors: true,
          expected_visible_state: true,
          forbidden_text_absent: true,
          backend_wiring_ok: true,
          auth_session_ok: true,
          seed_disabled: true,
          source_freshness: {
            ok: false,
            stale_count: 1,
            stale_sources: [{
              url: 'http://127.0.0.1:5192/src/lib/hosted-redirect.ts',
              high_signal_missing_tokens_sample: ['DEFAULT_HOSTED_CONSOLE_ORIGIN'],
            }],
          },
        }],
      },
    })).resolves.toMatchObject({
      ok: false,
      browser_proof: {
        browser_evidence_present: true,
        no_runtime_errors: false,
        source_freshness_ok: false,
      },
      failure_reasons: expect.arrayContaining([
        'browser_runtime_errors_present',
        'served_source_stale',
      ]),
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


  function authFixture(root, services) {
    const workspace = 'wk-selection';
    const { resolveSurfaceIdentities, authSurfaceIdentitySha256 } =
      require('../../../scripts/ops/workspace/docker-runtime/auth-identity');
    const manifest = { mode: 'ephemeral', run_id: workspace,
      organization: { id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830' },
      users: [
        { email: 'ops+wk-selection@example.invalid', user_type: 'ops_admin', auth_user_id: '22222222-2222-4222-8222-222222222222' },
        { email: 'driver+wk-selection@example.invalid', user_type: 'driver', auth_user_id: '33333333-3333-4333-8333-333333333333' },
      ],
    };
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
    const identities = resolveSurfaceIdentities(manifest).filter((entry) => services.includes(entry.surface));
    const authority = { manifest_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), identities };
    const auth = { status: 'passed', services, applicability: { auth: true }, workspace_id: workspace,
      manifest_mode: 'ephemeral', run_id: workspace, manifest_sha256: authority.manifest_sha256,
      surfaces: identities.map((identity) => ({
        surface: identity.surface, identity_sha256: authSurfaceIdentitySha256(identity),
        identity_present: true, password_grant_ok: true, app_user_readback_ok: true,
        auth_session_proven: true, backend_readback_ok: true,
      })),
    };
    const authManifest = path.join(root, 'manifest.json');
    const authProofSummary = path.join(root, 'auth-proof.json');
    const backendProofSummary = path.join(root, 'backend-proof.json');
    fs.writeFileSync(authManifest, bytes);
    fs.writeFileSync(authProofSummary, JSON.stringify(auth));
    fs.writeFileSync(backendProofSummary, JSON.stringify({ status: 'passed', acceptance: { landing_intake_readback_proven: true } }));
    return { authority, auth, authManifest, authProofSummary, backendProofSummary };
  }

  test.each([null, [null], [[]], [1], true, {}])('rejects malformed proof service selection %j', (services) => {
    expect(() => expectedSurfaceChecks({}, { services })).toThrow(/selection/);
  });

  test.each(['console-v2', 'fieldops-metro'])('retains exact selected %s scope without port inference', async (service) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-selection-'));
    const fixture = authFixture(root, [service]);
    const mobilePolicy = jest.fn(async () => ({ ok: true }));
    global.fetch = jest.fn(async () => ({ status: 200, text: async () => '<main>MasarX Console</main>' }));
    try {
      const summary = await runDockerRuntimeProof({
        ...fixture, services: [service], checkBackendImpl: async () => ({ ok: true }),
        readMobileV2PolicyImpl: mobilePolicy,
      }, { WORKSPACE_NAME: 'wk-selection', DOCKER_RUNTIME_STARTUP_PROOF: '1',
        CONSOLE_PORT: '5186', VITE_USE_SEED: 'false', NEXT_PUBLIC_USE_SEED: 'false' });
      expect(summary.services).toEqual([service]);
      expect(summary.surfaces).toHaveLength(1);
      if (service === 'console-v2') {
        expect(summary.status).toBe('passed');
        expect(mobilePolicy).not.toHaveBeenCalled();
        expect(summary.mobile_v2).toMatchObject({ status: 'not_required', applicable: false });
        expect(summary.acceptance.mobile_v2_development_runtime_proof).toBe('not_required');
        expect(summary.auth_fixture_proof.manifest_sha256).toBe(fixture.auth.manifest_sha256);
        expect(summary.auth_fixture_proof.surfaces[0].identity_sha256).toBe(fixture.auth.surfaces[0].identity_sha256);
      } else {
        expect(summary.status).toBe('failed');
        expect(summary.surfaces[0].failure_reasons).toContain('selected_surface_port_missing');
        expect(mobilePolicy).toHaveBeenCalledTimes(1);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test.each(['exact', 'wrong user', 'missing authority', 'conflicting env'])(
    'mobile policy context uses only manifest driver: %s', async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-context-'));
      const fixture = authFixture(root, ['fieldops-metro']);
      const identity = fixture.authority.identities[0];
      const query = jest.fn(async () => ({ rows: [{
        id: mode === 'wrong user' ? 'foreign' : identity.auth_user_id,
        organization_id: identity.organization_id, email: identity.email, user_type: 'driver',
      }] }));
      try {
        const result = await resolveMobileV2ProofContext({ query },
          mode === 'conflicting env' ? { MOBILE_V2_PROOF_USER_ID: 'foreign' } : {},
          { authAuthority: mode === 'missing authority' ? null : fixture.authority, authProof: fixture.auth });
        expect(result.ok).toBe(mode === 'exact');
        if (mode === 'missing authority' || mode === 'conflicting env') expect(query).not.toHaveBeenCalled();
        else {
          expect(query).toHaveBeenCalledTimes(1);
          expect(query.mock.calls[0][0]).toContain('where id = $1::uuid and organization_id = $2::uuid');
          expect(query.mock.calls[0][0]).not.toMatch(/limit 1|order by/i);
          expect(query.mock.calls[0][1]).toEqual([identity.auth_user_id, identity.organization_id, identity.email]);
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  );

  test('missing manifest identity never opens a mobile DB connection', async () => {
    const ClientImpl = jest.fn();
    const { readMobileV2Policy } = require('../../../scripts/ops/workspace/docker-runtime-proof');
    await expect(readMobileV2Policy({ DATABASE_URL: 'postgresql://must-not-connect' }, { ClientImpl }))
      .resolves.toMatchObject({ ok: false, reason: 'missing_manifest_bound_driver_policy_context' });
    expect(ClientImpl).not.toHaveBeenCalled();
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
      DOCKER_RUNTIME_DEPENDENCY_SERVICES: 'console-v2,landing,portal,fieldops-metro',
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

  test.each([
    ['missing', null],
    ['malformed', '{not-json'],
    ['stale', JSON.stringify({
      generated_at: '2020-01-01T00:00:00.000Z',
      status: 'failed',
      browser_proof_tier: 'stale-browser-proof-must-not-be-consumed',
    })],
  ])('startup proof ignores %s deferred browser evidence', async (_label, browserContents) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-startup-browser-'));
    try {
      const browserPath = path.join(tmpDir, 'browser-proof-summary.json');
      const backendPath = path.join(tmpDir, 'backend-proof-summary.json');
      const authPath = path.join(tmpDir, 'auth-proof-summary.json');
      if (browserContents !== null) fs.writeFileSync(browserPath, browserContents, 'utf8');
      fs.writeFileSync(backendPath, '{"status":"passed"}\n', 'utf8');
      fs.writeFileSync(authPath, '{"status":"passed"}\n', 'utf8');
      global.fetch = jest.fn(async () => ({ status: 200, text: async () => '<main>MasarX logistics</main>' }));

      await expect(runDockerRuntimeProof({
        timeoutMs: 1000,
        browserProofSummary: browserPath,
        backendProofSummary: backendPath,
        authProofSummary: authPath,
      }, {
        DOCKER_RUNTIME_STARTUP_PROOF: '1',
        WORKSPACE_NAME: 'wk-startup-browser-deferred',
        LANDING_PORT: '3339',
        SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370',
        VITE_USE_SEED: 'false',
        NEXT_PUBLIC_USE_SEED: 'false',
        DATABASE_URL: '',
      })).resolves.toMatchObject({
        browser_proof_tier: '',
        acceptance: {
          browser_proof_present: true,
          browser_proof_or_startup_boundary_proven: true,
          backend_readback_proof_present: true,
          auth_fixture_proof_present: true,
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['backend', 'backendProofSummary'],
    ['auth', 'authProofSummary'],
  ])('startup proof still fails closed on malformed %s evidence', async (_label, optionName) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-startup-required-'));
    try {
      const malformedPath = path.join(tmpDir, `${optionName}.json`);
      fs.writeFileSync(malformedPath, '{not-json', 'utf8');
      await expect(runDockerRuntimeProof({ [optionName]: malformedPath }, {
        DOCKER_RUNTIME_STARTUP_PROOF: '1',
      })).rejects.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['backend', 'backend_readback_proof_present'],
    ['auth', 'auth_fixture_proof_present'],
  ])('startup proof still fails closed when required %s evidence is missing', async (_label, acceptanceKey) => {
    global.fetch = jest.fn(async () => ({ status: 200, text: async () => '<main>MasarX logistics</main>' }));
    const summary = await runDockerRuntimeProof({}, {
      DOCKER_RUNTIME_STARTUP_PROOF: '1',
      LANDING_PORT: '3339',
      SUPABASE_INTERNAL_URL: 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:57370',
      VITE_USE_SEED: 'false',
      NEXT_PUBLIC_USE_SEED: 'false',
      DATABASE_URL: '',
    });
    expect(summary.status).toBe('failed');
    expect(summary.acceptance[acceptanceKey]).toBe(false);
  });

  test.each([
    ['missing', null],
    ['malformed', '{not-json'],
  ])('non-startup proof fails closed on %s browser evidence', async (_label, browserContents) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-browser-required-'));
    try {
      const browserPath = path.join(tmpDir, 'browser-proof-summary.json');
      if (browserContents !== null) fs.writeFileSync(browserPath, browserContents, 'utf8');
      await expect(runDockerRuntimeProof({ browserProofSummary: browserPath }, {})).rejects.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('non-startup proof consumes valid browser evidence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-browser-valid-'));
    try {
      const browserPath = path.join(tmpDir, 'browser-proof-summary.json');
      fs.writeFileSync(browserPath, '{"browser_proof_tier":"playwright-browser-context","surfaces":[]}\n', 'utf8');
      await expect(runDockerRuntimeProof({ browserProofSummary: browserPath }, {})).resolves.toMatchObject({
        browser_proof_tier: 'playwright-browser-context',
        acceptance: { browser_proof_present: true },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  test('console-only runtime proof does not require Mobile V2 development proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-only-proof-'));
    const services = ['console-v2'];
    const fixture = authFixture(root, services);
    const browserProofSummary = path.join(root, 'browser-proof.json');
    fs.writeFileSync(browserProofSummary, JSON.stringify({
      status: 'passed',
      surfaces: [{
        surface: 'console-v2',
        status: 'passed',
        browser_rendered: true,
        no_runtime_errors: true,
        expected_visible_state: true,
        forbidden_text_absent: true,
        backend_wiring_ok: true,
        auth_session_ok: true,
        seed_disabled: true,
        source_freshness: { ok: true, stale_count: 0 },
      }],
    }), 'utf8');
    const readMobileV2PolicyImpl = jest.fn();
    global.fetch = jest.fn(async () => ({ status: 200, text: async () => '<main>MasarX Console</main>' }));

    try {
      const summary = await runDockerRuntimeProof({
        ...fixture,
        services,
        browserProofSummary,
        checkBackendImpl: async () => ({ ok: true }),
        readMobileV2PolicyImpl,
      }, {
        WORKSPACE_NAME: 'wk-selection',
        CONSOLE_PORT: '5187',
        VITE_USE_SEED: 'false',
        NEXT_PUBLIC_USE_SEED: 'false',
      });

      expect(summary.status).toBe('passed');
      expect(summary.surfaces.map((surface) => surface.surface)).toEqual(services);
      expect(summary.mobile_v2).toMatchObject({
        status: 'not_required',
        development_runtime_proof_required: false,
        visible_runtime: false,
        backend_readback: { status: 'not_required' },
      });
      expect(summary.acceptance.mobile_v2_development_runtime_proof).toBe('not_required');
      expect(summary.acceptance.all_surfaces_runtime_proven).toBe(true);
      expect(readMobileV2PolicyImpl).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
