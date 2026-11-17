// Plan: PLAN-202603-landing-public-tracking-page / Step: S99
// Public shipment tracking edge E2E (guarded). Validates CORS/origin enforcement and Turnstile-required posture.

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

function buildFnUrl(fnName, action = '') {
  const base = SUPABASE_URL.replace(/\/+$/g, '');
  const suffix = String(action || '').replace(/^\/+/, '');
  return suffix
    ? `${base}/functions/v1/${fnName}/${suffix}`
    : `${base}/functions/v1/${fnName}`;
}

function resolveAllowedOriginCandidate() {
  return buildAllowedOriginCandidates({
    allowlistValues: [
      process.env.PUBLIC_TRACKING_CORS_ALLOW_ORIGINS,
      process.env.TRACKING_CORS_ALLOW_ORIGINS,
      process.env.MARKETING_CORS_ALLOW_ORIGINS,
      process.env.LANDING_CORS_ALLOW_ORIGINS,
    ],
    envValues: [
      process.env.SUPABASE_URL,
      process.env.LANDING_SITE_URL,
      process.env.LANDING_APP_URL,
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
    ],
  });
}

async function postTracking({ action = 'lookup', origin, headers = {}, body = {} } = {}) {
  const res = await fetch(buildFnUrl('public-shipment-tracking', action), {
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

runIfEdge('public-shipment-tracking edge (E2E)', () => {
  test('POST without Origin returns 403 origin_required', async () => {
    const { status, body } = await postTracking({
      body: { reference: 'TRK-EDGE-001' },
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: 'origin_required' } });
  });

  test('POST with disallowed Origin returns 403 origin_not_allowed', async () => {
    const { status, body } = await postTracking({
      origin: 'https://evil.example',
      body: { reference: 'TRK-EDGE-001' },
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: 'origin_not_allowed' } });
  });

  test('POST with allowed Origin but no Turnstile returns turnstile_required when allowlisted origin is probeable', async () => {
    const { origin: allowedOrigin, attempts } = await probeAllowedOrigin(
      resolveAllowedOriginCandidate(),
      async (origin) =>
        postTracking({
          origin,
          headers: {
            'cf-connecting-ip': '203.0.113.71',
            'x-real-ip': '203.0.113.71',
            'x-forwarded-for': '203.0.113.71',
          },
          body: { reference: 'TRK-EDGE-001' },
        }),
    );
    if (!allowedOrigin) {
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 403)).toBe(true);
      return;
    }

    const { status, body } = await postTracking({
      origin: allowedOrigin,
      headers: {
        'cf-connecting-ip': '203.0.113.70',
        'x-real-ip': '203.0.113.70',
        'x-forwarded-for': '203.0.113.70',
      },
      body: {
        reference: 'TRK-EDGE-001',
      },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'turnstile_required' } });
  });

  test('POST /request with allowed Origin does not fail at the turnstile gate when a verified session token is supplied', async () => {
    const { origin: allowedOrigin, attempts } = await probeAllowedOrigin(
      resolveAllowedOriginCandidate(),
      async (origin) =>
        postTracking({
          origin,
          action: 'request',
          headers: {
            'cf-connecting-ip': '203.0.113.81',
            'x-real-ip': '203.0.113.81',
            'x-forwarded-for': '203.0.113.81',
          },
          body: {
            session_token: 'sess-edge-demo',
            request_type: 'location_change',
            payload: {
              address_text: 'Tower 4, gate B, service road',
              short_national_address: 'RAHA1234',
              map_pin: { lat: 50, lng: 50 },
            },
          },
        }),
    );
    if (!allowedOrigin) {
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 403)).toBe(true);
      return;
    }

    const { status, body } = await postTracking({
      origin: allowedOrigin,
      action: 'request',
      headers: {
        'cf-connecting-ip': '203.0.113.80',
        'x-real-ip': '203.0.113.80',
        'x-forwarded-for': '203.0.113.80',
      },
      body: {
        session_token: 'sess-edge-demo',
        request_type: 'location_change',
        payload: {
          address_text: 'Tower 4, gate B, service road',
          short_national_address: 'RAHA1234',
          map_pin: { lat: 50, lng: 50 },
        },
      },
    });

    expect(status).not.toBe(400);
    expect(body?.error?.code).not.toBe('turnstile_required');
  });
});
