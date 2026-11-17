// Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S99
// Tenant signup intake edge E2E (guarded). Validates CORS/origin enforcement and Turnstile-required posture.

const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  buildAllowedOriginCandidates,
  probeAllowedOrigin,
} = require('../helpers/edge-origin-probe');
const { buildPublicEdgeHeaders } = require('../helpers/public-edge-auth');

loadEnv();

const edgeE2eEnabled = process.env.RUN_EDGE_E2E === 'true';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();

const runIfEdge = edgeE2eEnabled && SUPABASE_URL ? describe : describe.skip;

function buildFnUrl(fnName) {
  const base = SUPABASE_URL.replace(/\/+$/g, '');
  return `${base}/functions/v1/${fnName}`;
}

function resolveAllowedOriginCandidate() {
  return buildAllowedOriginCandidates({
    allowlistValues: [
      process.env.PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS,
      process.env.TENANT_SIGNUP_CORS_ALLOW_ORIGINS,
      process.env.MARKETING_CORS_ALLOW_ORIGINS,
      process.env.LANDING_CORS_ALLOW_ORIGINS,
    ],
    envValues: [
      process.env.SUPABASE_URL,
      process.env.LANDING_SITE_URL,
      process.env.LANDING_APP_URL,
      process.env.LANDING_DOCS_URL,
      process.env.CONSOLE_BASE_URL,
      process.env.PORTAL_BASE_URL,
      'https://localhost:3000',
      'https://localhost:5173',
    ],
    canonicalHosts: [
      'https://hguxuguuvhxjwymmxhlmkwwp.example.invalid',
      'https://grtgggvjriwqrxhykymmloov.example.invalid',
      'https://nzxmhryhtqlzoshjkyozkpup.example.invalid',
      'https://yslvnlqxjhkzismlnkrrvyvs.example.invalid',
      'https://unjijvxjrwurjgsnokovrvom.example.invalid',
      'https://hrorzpuminkttynstpljzjuu.example.invalid',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid',
      'https://yguwjnwkkqutolgwughjsloj.example.invalid',
      'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid',
      'https://vvmruwrtzllojrtomtlgvwju.example.invalid',
    ],
  });
}

async function postSignup({ origin, headers = {}, body = {} } = {}) {
  const res = await fetch(buildFnUrl('tenant-signup-intake'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...buildPublicEdgeHeaders(headers),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

runIfEdge('tenant-signup-intake edge (E2E)', () => {
  test('POST without Origin returns 403 origin_required', async () => {
    const { status, body } = await postSignup({
      body: {
        email: 'tenant-signup-edge@example.com',
        full_name: 'Example Person',
        organization_name: 'Edge Signup Org',
      },
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: 'origin_required' } });
  });

  test('POST with disallowed Origin returns 403 origin_not_allowed', async () => {
    const { status, body } = await postSignup({
      origin: 'https://evil.example',
      body: {
        email: 'tenant-signup-edge@example.com',
        full_name: 'Example Person',
        organization_name: 'Edge Signup Org',
      },
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: 'origin_not_allowed' } });
  });

  test('POST with allowed Origin but no Turnstile returns turnstile_required when allowlisted origin is probeable', async () => {
    const { origin: allowedOrigin, attempts } = await probeAllowedOrigin(
      resolveAllowedOriginCandidate(),
      async (origin) =>
        postSignup({
          origin,
          headers: {
            'cf-connecting-ip': '203.0.113.41',
            'x-real-ip': '203.0.113.41',
            'x-forwarded-for': '203.0.113.41',
          },
          body: {
            email: 'probe-invalid-email',
            full_name: '',
            organization_name: '',
          },
        }),
    );
    if (!allowedOrigin) {
      throw new Error('No allowed configured origin was positively exercised: ' + JSON.stringify(attempts));
    }

    const { status, body } = await postSignup({
      origin: allowedOrigin,
      headers: {
        'cf-connecting-ip': '203.0.113.40',
        'x-real-ip': '203.0.113.40',
        'x-forwarded-for': '203.0.113.40',
      },
      body: {
        email: 'tenant-signup-edge@example.com',
        full_name: 'Example Person',
        organization_name: 'Edge Signup Org',
        notes: 'edge e2e tenant signup validation',
      },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'turnstile_required' } });
  });
});
