jest.mock('../../../scripts/ops/workspace/with-full-preview-stack', () => ({
  ensureVercelAutomationBypassSecret: jest.fn(),
  upsertEnvFileVariable: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
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

  test('normalizeLandingProofEndpoint strips query strings and trailing slashes', () => {
    expect(normalizeLandingProofEndpoint('/__landing-contact/?debug=1')).toBe('/__landing-contact');
    expect(normalizeLandingProofEndpoint('https://EXAMPLE.com/functions/v1/tenant-signup-intake/?debug=1')).toBe(
      'https://example.com/functions/v1/tenant-signup-intake',
    );
  });

  test('assertLandingEndpointSeparation allows separated landing proof endpoints', () => {
    expect(
      assertLandingEndpointSeparation({
        contactEndpoint: '/__landing-contact',
        siteUrl: 'http://127.0.0.1:3333',
        tenantSignupEndpoint: '/__tenant-signup',
      }),
    ).toEqual({
      contactEndpoint: '/__landing-contact',
      tenantSignupEndpoint: '/__tenant-signup',
    });
  });

  test('assertLandingEndpointSeparation allows canonical intake endpoints', () => {
    expect(
      assertLandingEndpointSeparation({
        contactEndpoint: '/functions/v1/marketing-lead-intake',
        tenantSignupEndpoint: '/functions/v1/tenant-signup-intake',
      }),
    ).toEqual({
      contactEndpoint: '/functions/v1/marketing-lead-intake',
      tenantSignupEndpoint: '/functions/v1/tenant-signup-intake',
    });
  });

  test('assertLandingEndpointSeparation rejects Example Person mocks for non-local landing URLs', () => {
    expect(() =>
      assertLandingEndpointSeparation({
        contactEndpoint: '/__landing-contact',
        siteUrl: 'https://example.com',
        tenantSignupEndpoint: '/__tenant-signup',
      }),
    ).toThrow(/LANDING_CONTACT_ENDPOINT must point to the marketing-lead-intake intake endpoint/);
  });

  test('assertLandingEndpointSeparation fails closed when contact would hit tenant signup intake', () => {
    expect(() =>
      assertLandingEndpointSeparation({
        contactEndpoint: 'https://example.com/functions/v1/tenant-signup-intake',
        tenantSignupEndpoint: 'https://example.com/functions/v1/tenant-signup-intake',
      }),
    ).toThrow(/LANDING_CONTACT_ENDPOINT must point to the marketing-lead-intake intake endpoint/);
  });

  test('assertLandingEndpointSeparation fails closed when tenant signup would hit marketing lead intake', () => {
    expect(() =>
      assertLandingEndpointSeparation({
        contactEndpoint: 'https://example.com/functions/v1/marketing-lead-intake',
        tenantSignupEndpoint: 'https://example.com/functions/v1/marketing-lead-intake',
      }),
    ).toThrow(/LANDING_TENANT_SIGNUP_ENDPOINT must point to the tenant-signup-intake intake endpoint/);
  });

  test('assertLandingEndpointSeparation fails closed when tenant signup would hit contact intake', () => {
    expect(() =>
      assertLandingEndpointSeparation({
        contactEndpoint: '/__landing-contact?source=contact',
        siteUrl: 'http://127.0.0.1:3333',
        tenantSignupEndpoint: '/__landing-contact/',
      }),
    ).toThrow(/LANDING_TENANT_SIGNUP_ENDPOINT must point to the tenant-signup-intake intake endpoint/);
  });

  test('assertLandingEndpointSeparation fails closed when tenant signup proof endpoint is missing', () => {
    expect(() =>
      assertLandingEndpointSeparation({
        contactEndpoint: '/__landing-contact',
        tenantSignupEndpoint: '',
      }),
    ).toThrow(/LANDING_TENANT_SIGNUP_ENDPOINT is required for release landing proof/);
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

  test('release landing proof requires separated contact and tenant signup endpoints', () => {
    const body = readWorkflow('release-verify-main.yml');

    expect(body).toContain('LANDING_TENANT_SIGNUP_ENDPOINT: ${{ vars.LANDING_TENANT_SIGNUP_ENDPOINT || \'\' }}');
    expect(body).toMatch(
      /preview_required_surfaces="\$\{\{ steps\.preview_surfaces\.outputs\.csv \}\}"[\s\S]*release-verify-preview\.js --mode assert-landing-endpoint-separation[\s\S]*node scripts\/ops\/preview\/orchestrate\.js/,
    );
    expect(body).toMatch(
      /LANDING_CONTACT_ENDPOINT: "\/__[^\n]*landing-contact"[\s\S]*LANDING_TENANT_SIGNUP_ENDPOINT: "\/__tenant-signup"[\s\S]*release-verify-preview\.js --mode assert-landing-endpoint-separation[\s\S]*node scripts\/frontend\/build-landing\.js --out dist\/landing-release-ci-full/,
    );
    expect(body).not.toContain('LANDING_TENANT_SIGNUP_ENDPOINT: "/__landing-contact"');
  });
});
