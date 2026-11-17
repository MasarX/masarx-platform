jest.mock('../../../scripts/ops/workspace/with-full-preview-stack', () => ({
  ensureVercelAutomationBypassSecret: jest.fn(),
  upsertEnvFileVariable: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const {
  assertLandingEndpointSeparation,
  buildPreviewManifestShellExports,
  ensureProtectedPreviewBypass,
  isProtectedPreviewHost,
  normalizeLandingProofEndpoint,
  resolvePreviewIdentityIdFromEvent,
  serializeShellExports,
} = require('../../../scripts/ops/ci/release-verify-preview');
const {
  ensureVercelAutomationBypassSecret,
  upsertEnvFileVariable,
} = require('../../../scripts/ops/workspace/with-full-preview-stack');

function readWorkflow(name) {
  return fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', name), 'utf8');
}

describe('release-verify-preview helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolvePreviewIdentityIdFromEvent prefers pull request number', () => {
    expect(resolvePreviewIdentityIdFromEvent({ pull_request: { number: 1842 } })).toBe('1842');
  });

  test('resolvePreviewIdentityIdFromEvent derives PR number from merge-group head ref', () => {
    expect(
      resolvePreviewIdentityIdFromEvent({
        merge_group: {
          head_ref: 'gh-readonly-queue/main/pr-1842-0123456789abcdef',
        },
      }),
    ).toBe('1842');
  });

  test('resolvePreviewIdentityIdFromEvent prefers a single merge-group PR entry', () => {
    expect(
      resolvePreviewIdentityIdFromEvent({
        merge_group: {
          pull_requests: [{ number: 2042 }],
          head_ref: 'gh-readonly-queue/main/pr-9999-deadbeef',
        },
      }),
    ).toBe('2042');
  });

  test('resolvePreviewIdentityIdFromEvent fails closed for multi-PR merge groups', () => {
    expect(
      resolvePreviewIdentityIdFromEvent({
        merge_group: {
          pull_requests: [{ number: 2042 }, { number: 2043 }],
          head_ref: 'gh-readonly-queue/main/pr-2042-deadbeef',
        },
      }),
    ).toBe('');
  });

  test('buildPreviewManifestShellExports maps db and hosted urls into shell exports', () => {
    const exportsMap = buildPreviewManifestShellExports({
      surfaces: {
        db: {
          env_file: '.tmp/preview.env',
          project_ref: 'proj_ref',
          project_name: 'preview-project',
          supabase_url: 'https://preview.supabase.co',
        },
        console: {
          url: 'https://console-preview.vercel.app',
        },
        portal: {
          deployment_url: 'https://portal-preview.vercel.app',
        },
        landing: {
          host: 'landing-preview.pages.dev',
        },
        docs: {
          base_url: 'https://docs-preview.pages.dev',
        },
      },
    });

    expect(exportsMap).toEqual({
      PREVIEW_ENV_FILE: '.tmp/preview.env',
      PREVIEW_PROJECT_REF: 'proj_ref',
      PREVIEW_PROJECT_NAME: 'preview-project',
      PREVIEW_SUPABASE_URL: 'https://preview.supabase.co',
      PREVIEW_CONSOLE_URL: 'https://console-preview.vercel.app',
      PREVIEW_PORTAL_URL: 'https://portal-preview.vercel.app',
      PREVIEW_LANDING_URL: 'https://landing-preview.pages.dev',
      PREVIEW_DOCS_URL: 'https://docs-preview.pages.dev',
    });
  });

  test('serializeShellExports quotes values for shell sourcing', () => {
    expect(serializeShellExports({ PREVIEW_CONSOLE_URL: 'https://console-preview.vercel.app' })).toBe(
      'PREVIEW_CONSOLE_URL="https://console-preview.vercel.app"',
    );
  });

  test('isProtectedPreviewHost matches Vercel preview urls only', () => {
    expect(isProtectedPreviewHost('https://console-preview.vercel.app')).toBe(true);
    expect(isProtectedPreviewHost('https://unjijvxjrwurjgsnokovrvom.example.invalid')).toBe(false);
    expect(isProtectedPreviewHost('')).toBe(false);
  });

  test('normalizes endpoint query, fragment, casing and trailing slash aliases', () => {
    expect(normalizeLandingProofEndpoint('/__tenant-signup///?x=1#contact')).toBe('/__tenant-signup');
    expect(normalizeLandingProofEndpoint('https://EXAMPLE.com:443/functions/v1/marketing-lead-intake/?x=1'))
      .toBe('https://example.com/functions/v1/marketing-lead-intake');
  });

  test.each([
    ['https://example.com', '/functions/v1/marketing-lead-intake', '/functions/v1/tenant-signup-intake'],
    ['http://127.0.0.1:3333', '/__landing-contact/?source=test', '/__tenant-signup/'],
    ['http://landing-ci.localhost:3333', '/__landing-contact', '/__tenant-signup'],
    ['http://[::1]:3333', 'http://[::1]:3333/__landing-contact', '/__tenant-signup'],
  ])('allows distinct role-bound endpoints on %s', (siteUrl, contactEndpoint, tenantSignupEndpoint) => {
    expect(assertLandingEndpointSeparation({ siteUrl, contactEndpoint, tenantSignupEndpoint })).toEqual({
      contactEndpoint: normalizeLandingProofEndpoint(contactEndpoint),
      tenantSignupEndpoint: normalizeLandingProofEndpoint(tenantSignupEndpoint),
    });
  });

  test.each([
    ['', '/functions/v1/tenant-signup-intake'],
    ['/functions/v1/marketing-lead-intake', ''],
    ['/functions/v1/marketing-lead-intake/?x=1', '/functions/v1/marketing-lead-intake/'],
    ['/functions/v1/tenant-signup-intake', '/functions/v1/marketing-lead-intake'],
    ['/__landing-contact?x=1', '/__landing-contact///#alias'],
    ['/__tenant-signup', '/__landing-contact'],
    ['/api/contact', '/functions/v1/tenant-signup-intake'],
  ])('rejects missing, reused or crossed roles: %s -> %s', (contactEndpoint, tenantSignupEndpoint) => {
    expect(() => assertLandingEndpointSeparation({ siteUrl: 'http://localhost:3333', contactEndpoint, tenantSignupEndpoint }))
      .toThrow(/ENDPOINT/);
  });

  test.each(['', 'https://landing.example.com', 'https://localhost.example.com', 'file://localhost/'])
    ('rejects local mocks for a nonlocal site: %s', (siteUrl) => {
      expect(() => assertLandingEndpointSeparation({ siteUrl, contactEndpoint: '/__landing-contact', tenantSignupEndpoint: '/__tenant-signup' }))
        .toThrow(/LANDING_CONTACT_ENDPOINT/);
    });

  test.each(['//example.com/__landing-contact', '/\\example.com/__landing-contact', 'javascript:marketing-lead-intake', (['https',":","/","/",'user',":",'password',"@",'example.com',"/",'marketing-lead-intake'].join(""))])
    ('rejects an invalid endpoint before proof: %s', (contactEndpoint) => {
      expect(() => assertLandingEndpointSeparation({ siteUrl: 'http://localhost', contactEndpoint, tenantSignupEndpoint: '/__tenant-signup' })).toThrow();
    });

  test('rejects a remote mock URL even when the landing site is local', () => {
    expect(() => assertLandingEndpointSeparation({ siteUrl: 'http://localhost', contactEndpoint: 'https://remote.example.com/__landing-contact', tenantSignupEndpoint: '/__tenant-signup' }))
      .toThrow(/LANDING_CONTACT_ENDPOINT/);
  });

  test('the actual release guard CLI accepts distinct endpoints and rejects a reused alias', () => {
    const script = path.join(process.cwd(), 'scripts/ops/ci/release-verify-preview.js');
    const env = { ...process.env, LANDING_SITE_URL: 'http://localhost:3333', LANDING_CONTACT_ENDPOINT: '/__landing-contact', LANDING_TENANT_SIGNUP_ENDPOINT: '/__tenant-signup' };
    const valid = spawnSync(process.execPath, [script, '--mode', 'assert-landing-endpoint-separation'], { env, encoding: 'utf8' });
    expect(valid.status).toBe(0);
    const reused = spawnSync(process.execPath, [script, '--mode', 'assert-landing-endpoint-separation'], { env: { ...env, LANDING_TENANT_SIGNUP_ENDPOINT: '/__landing-contact/?source=alias' }, encoding: 'utf8' });
    expect(reused.status).not.toBe(0);
    expect(reused.stderr).toContain('LANDING_TENANT_SIGNUP_ENDPOINT');
  });

  test('ensureProtectedPreviewBypass skips when no protected preview host is present', async () => {
    const env = {
      CONSOLE_URL: 'https://unjijvxjrwurjgsnokovrvom.example.invalid',
      PORTAL_URL: 'https://hrorzpuminkttynstpljzjuu.example.invalid',
    };

    const result = await ensureProtectedPreviewBypass({ env });

    expect(result).toEqual({
      configured: false,
      skipped: true,
      reason: 'no_protected_hosts',
    });
    expect(ensureVercelAutomationBypassSecret).not.toHaveBeenCalled();
  });

  test('ensureProtectedPreviewBypass writes github env and preview env file when bypass is configured', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-verify-preview-'));
    const githubEnvPath = path.join(tempDir, 'github.env');
    const env = {
      CONSOLE_URL: 'https://console-preview.vercel.app',
      PORTAL_URL: 'https://hrorzpuminkttynstpljzjuu.example.invalid',
      PREVIEW_ENV_FILE: path.join(tempDir, 'preview.env'),
      GITHUB_ENV: githubEnvPath,
      VERCEL_AUTOMATION_BYPASS_SECRET: 'existing-secret',
    };
    ensureVercelAutomationBypassSecret.mockResolvedValue({ configured: true, source: 'env' });

    const result = await ensureProtectedPreviewBypass({ env });

    expect(result).toEqual({
      configured: true,
      skipped: false,
      source: 'env',
    });
    expect(fs.readFileSync(githubEnvPath, 'utf8')).toContain('VERCEL_AUTOMATION_BYPASS_SECRET=existing-secret');
    expect(upsertEnvFileVariable).toHaveBeenCalledWith({
      envPath: env.PREVIEW_ENV_FILE,
      key: 'VERCEL_AUTOMATION_BYPASS_SECRET',
      value: 'existing-secret',
    });
  });

  test('ensureProtectedPreviewBypass fails closed when protected hosts need bypass but no secret is available', async () => {
    const env = {
      CONSOLE_URL: 'https://console-preview.vercel.app',
    };
    ensureVercelAutomationBypassSecret.mockResolvedValue({
      configured: false,
      reason: 'missing_vercel_config',
    });

    await expect(ensureProtectedPreviewBypass({ env })).rejects.toThrow(
      /Protected Vercel preview hosts require automation bypass configuration/,
    );
  });
});

describe('release verify preview workflow contracts', () => {
  test('guards hosted preview endpoints only when landing is selected and uses implemented distinct local mocks', () => {
    const body = readWorkflow('release-verify-main.yml');
    expect(body).toContain("LANDING_TENANT_SIGNUP_ENDPOINT: ${{ vars.LANDING_TENANT_SIGNUP_ENDPOINT || '' }}");
    expect(body).toContain('case ",${preview_required_surfaces}," in');
    expect(body).toContain('*,landing,*) node scripts/ops/ci/release-verify-preview.js --mode assert-landing-endpoint-separation ;;');
    const build = body.slice(body.indexOf('    - name: Build landing (preview)'), body.indexOf('    - name: Start landing E2E server (local preview artifact)'));
    expect(build).toContain('LANDING_CONTACT_ENDPOINT: "/__landing-contact"');
    expect(build).toContain('LANDING_TENANT_SIGNUP_ENDPOINT: "/__tenant-signup"');
    expect(build.indexOf('--mode assert-landing-endpoint-separation')).toBeLessThan(build.indexOf('node scripts/frontend/build-landing.js'));
    expect(body).toContain('LANDING_ENABLE_INTAKE_MOCKS=1');
    expect(body).toContain('LANDING_SITE_URL=http://127.0.0.1:3333');
  });

  test('preview provision generates runtime readiness evidence before staging the internal bundle', () => {
    const body = readWorkflow('release-verify-main.yml');
    const jobStart = body.indexOf('  release_verify_preview_provision:');
    const jobEnd = body.indexOf('\n  release_verify_preview_core:', jobStart);

    expect(jobStart).toBeGreaterThan(-1);
    expect(jobEnd).toBeGreaterThan(jobStart);

    const provisionJob = body.slice(jobStart, jobEnd);
    const precheckIndex = provisionJob.indexOf('\n    - name: Preview runtime precheck');
    const evidenceIndex = provisionJob.indexOf('\n    - name: Preview evidence contract');
    const stageIndex = provisionJob.indexOf('\n    - name: Stage internal preview artifact bundle');

    expect(precheckIndex).toBeGreaterThan(-1);
    expect(evidenceIndex).toBeGreaterThan(precheckIndex);
    expect(stageIndex).toBeGreaterThan(precheckIndex);
    expect(provisionJob).toContain('node scripts/ops/preview/runtime-precheck.js \\');
    expect(provisionJob).toContain('--report ".tmp/preview-runtime-ready.json" \\');
    expect(provisionJob).toContain('--probe-auth \\');
    expect(provisionJob).toContain('cp ".tmp/preview-runtime-ready.json" "${{ steps.preview_meta.outputs.artifact_runtime }}"');
  });
});
