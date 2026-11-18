// Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S99
// Tenant signup review edge E2E (guarded). Validates authorization and approve/reject transitions.

const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const edgeE2eEnabled = process.env.RUN_EDGE_E2E === 'true';
const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((key) => !String(process.env[key] || '').trim());
const runIfEdge = edgeE2eEnabled && missing.length === 0 ? describe : describe.skip;
const inviteRedirectTo =
  String(process.env.TENANT_SIGNUP_REVIEW_E2E_INVITE_REDIRECT_TO || '').trim() ||
  'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const isAuthSignatureError = (message) =>
  /invalid jwt|signature is invalid|unable to parse or verify signature|no suitable key/i.test(
    String(message || ''),
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isInvalidJwtGatewayResponse = (result) =>
  Number(result?.status) === 401 &&
  isAuthSignatureError(
    result?.body?.message ||
    result?.body?.error?.message ||
    result?.body?.error_description ||
    '',
  );

function buildFnUrl(fnName) {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/g, '');
  return `${base}/functions/v1/${fnName}`;
}

async function postReview(payload, token) {
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const res = await fetch(buildFnUrl('tenant-signup-review'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(anonKey ? { apikey: anonKey } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postReviewWithJwtRetry(payload, token, options = {}) {
  const attempts = Number(options.attempts || 6);
  const baseDelayMs = Number(options.baseDelayMs || 350);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await postReview(payload, token);
    if (!isInvalidJwtGatewayResponse(last)) return last;
    if (attempt < attempts) {
      await sleep(baseDelayMs * attempt);
    }
  }
  return last;
}

runIfEdge('tenant-signup-review edge (E2E)', () => {
  const service = missing.length === 0
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      db: { schema: 'api' },
    })
    : null;

  let authUserIds = [];

  afterAll(async () => {
    if (!service) {
      await pool.end().catch(() => {});
      return;
    }

    for (const userId of authUserIds) {
      await service.auth.admin.deleteUser(userId).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  test('POST without a bearer token returns 401', async () => {
    const { status, body } = await postReview(
      {
        request_id: randomUUID(),
        decision: 'rejected',
      },
      null,
    );

    expect(status).toBe(401);
    const legacyShape = body?.ok === false && body?.error?.code === 'missing_authorization';
    const currentShape = body?.code === 401 && /authorization/i.test(String(body?.message || ''));
    const gatewayShape = /auth header is not 'bearer \{token\}'/i.test(
      String(body?.msg || body?.message || ''),
    );
    expect(legacyShape || currentShape || gatewayShape).toBe(true);
  });

  test('POST with a signed-in non-reviewer returns 403', async () => {
    const email = 'signup-non-reviewer-' + randomUUID() + '@example.com';
    const password = randomUUID() + '!Aa1';
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    expect(created.user?.id).toBeTruthy();
    authUserIds.push(created.user.id);

    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();
    expect(signedIn.session?.access_token).toBeTruthy();

    const { status, body } = await postReview({
      request_id: randomUUID(),
      decision: 'rejected',
    }, signedIn.session.access_token);
    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, error: { code: 'reviewer_forbidden' } });
  });

  test('platform reviewer can reject and approve tenant signup requests', async () => {
    if (!service) {
      throw new Error('service client not initialized');
    }

    try {
      const { error: authProbeErr } = await service.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (authProbeErr && isAuthSignatureError(authProbeErr.message)) {
        // eslint-disable-next-line no-console
        console.warn('[tenant-signup-review.e2e] skipped due to auth signature mode', authProbeErr.message);
        return;
      }
    } catch (error) {
      if (isAuthSignatureError(error?.message)) {
        // eslint-disable-next-line no-console
        console.warn('[tenant-signup-review.e2e] skipped due to auth signature mode', error.message);
        return;
      }
      throw error;
    }

    const db = await pool.connect();
    try {
      const reviewerOrgId = randomUUID();
      await db.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Tenant Signup Reviewer Org', $2::text, 'Asia/Riyadh', 'en', 'active')`,
        [reviewerOrgId, `tenant-review-${reviewerOrgId.slice(0, 8)}`],
      );

      const reviewerEmail = `tenant-reviewer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
      const reviewerPassword = `T!${Math.random().toString(16).slice(2)}Aa1`;
      const { data: reviewerAuth, error: reviewerAuthErr } = await service.auth.admin.createUser({
        email: reviewerEmail,
        password: reviewerPassword,
        email_confirm: true,
      });

      if (reviewerAuthErr || !reviewerAuth?.user?.id) {
        throw new Error(`failed to create reviewer auth user: ${reviewerAuthErr?.message || 'missing user id'}`);
      }

      const reviewerUserId = reviewerAuth.user.id;
      authUserIds.push(reviewerUserId);

      await db.query(
        `INSERT INTO users (
           id,
           organization_id,
           email,
           full_name,
           user_type,
           status,
           access_scope_type,
           access_scope_id
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::text,
           'Tenant Signup Reviewer',
           'ops_admin',
           'active',
           'platform',
           NULL
         )`,
        [reviewerUserId, reviewerOrgId, reviewerEmail],
      );

      const reviewerClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        db: { schema: 'api' },
      });

      const { data: signInData, error: signInErr } = await reviewerClient.auth.signInWithPassword({
        email: reviewerEmail,
        password: reviewerPassword,
      });

      if (signInErr || !signInData?.session?.access_token) {
        throw new Error(`reviewer sign-in failed: ${signInErr?.message || 'missing access token'}`);
      }

      const reviewerToken = signInData.session.access_token;
      const reviewerProbe = await reviewerClient.rpc('tenant_signup_assert_reviewer_v1');
      if (reviewerProbe.error && isAuthSignatureError(reviewerProbe.error.message)) {
        // eslint-disable-next-line no-console
        console.warn('[tenant-signup-review.e2e] skipped due to auth signature mode', reviewerProbe.error.message);
        return;
      }
      if (reviewerProbe.error) {
        throw new Error(`reviewer probe failed: ${reviewerProbe.error.message}`);
      }

      const createRejectPayload = await service.rpc('tenant_signup_request_create_v1', {
        p_email: `tenant-reject-${Date.now()}@example.com`,
        p_full_name: 'Example Person',
        p_organization_name: 'Reject Request Org',
        p_organization_slug: null,
        p_website_url: null,
        p_phone: null,
        p_notes: 'reject path',
        p_locale: 'en',
        p_page_url: 'https://example.com/signup',
        p_referrer: null,
        p_origin: 'https://example.com',
        p_marketing: {},
        p_ip_hash: `reject-ip-${randomUUID()}`,
        p_turnstile_verified: true,
      });

      if (createRejectPayload.error || !createRejectPayload.data?.id) {
        throw new Error(`failed to create reject request: ${createRejectPayload.error?.message || 'missing id'}`);
      }

      const rejectRequestId = createRejectPayload.data.id;

      const rejectRes = await postReviewWithJwtRetry(
        {
          request_id: rejectRequestId,
          decision: 'rejected',
          reason: 'Not a fit',
        },
        reviewerToken,
      );
      if (isInvalidJwtGatewayResponse(rejectRes)) {
        // eslint-disable-next-line no-console
        console.warn('[tenant-signup-review.e2e] skipped due to auth signature mode', JSON.stringify(rejectRes.body || {}));
        return;
      }

      if (rejectRes.status !== 200) {
        throw new Error(
          `review reject failed: status=${rejectRes.status} body=${JSON.stringify(rejectRes.body || {})}`,
        );
      }
      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body).toMatchObject({ ok: true, decision: 'rejected' });

      const rejectRow = await db.query(
        'SELECT status, review_decision FROM public.tenant_signup_requests WHERE id = $1::uuid',
        [rejectRequestId],
      );
      expect(rejectRow.rows[0]?.status).toBe('rejected');
      expect(rejectRow.rows[0]?.review_decision).toBe('rejected');

      const createApprovePayload = await service.rpc('tenant_signup_request_create_v1', {
        p_email: `tenant-approve-${Date.now()}@example.com`,
        p_full_name: 'Example Person',
        p_organization_name: 'Approve Request Org',
        p_organization_slug: null,
        p_website_url: null,
        p_phone: null,
        p_notes: 'approve path',
        p_locale: 'en',
        p_page_url: 'https://example.com/signup',
        p_referrer: null,
        p_origin: 'https://example.com',
        p_marketing: {},
        p_ip_hash: `approve-ip-${randomUUID()}`,
        p_turnstile_verified: true,
      });

      if (createApprovePayload.error || !createApprovePayload.data?.id) {
        throw new Error(`failed to create approve request: ${createApprovePayload.error?.message || 'missing id'}`);
      }

      const approveRequestId = createApprovePayload.data.id;

      const approveRes = await postReviewWithJwtRetry(
        {
          request_id: approveRequestId,
          decision: 'approved',
          reason: 'Approved by edge e2e test',
          invite_redirect_to: inviteRedirectTo,
        },
        reviewerToken,
      );
      if (isInvalidJwtGatewayResponse(approveRes)) {
        // eslint-disable-next-line no-console
        console.warn('[tenant-signup-review.e2e] skipped due to auth signature mode', JSON.stringify(approveRes.body || {}));
        return;
      }

      if (approveRes.status !== 200) {
        throw new Error(
          `review approve failed: status=${approveRes.status} body=${JSON.stringify(approveRes.body || {})}`,
        );
      }
      expect(approveRes.status).toBe(200);
      expect(approveRes.body).toMatchObject({ ok: true, decision: 'approved' });

      const approveResult = approveRes.body && typeof approveRes.body === 'object'
        ? approveRes.body.result || {}
        : {};

      const approvedOrgId = String(approveResult.organization_id || '');
      const approvedUserId = String(approveResult.user_id || '');
      if (approvedUserId) {
        authUserIds.push(approvedUserId);
      }

      expect(approvedOrgId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(approvedUserId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const approvedRow = await db.query(
        `SELECT
           status,
           review_decision,
           last_error_code,
           approved_organization_id,
           approved_user_id,
           approved_auth_user_id,
           invite_redirect_to
           FROM public.tenant_signup_requests
          WHERE id = $1::uuid`,
        [approveRequestId],
      );

      expect(approvedRow.rows[0]?.status).toBe('approved');
      expect(approvedRow.rows[0]?.review_decision).toBe('approved');
      expect(approvedRow.rows[0]?.last_error_code ?? null).toBeNull();
      expect(approvedRow.rows[0]?.approved_organization_id).toBe(approvedOrgId);
      expect(approvedRow.rows[0]?.approved_user_id).toBe(approvedUserId);
      expect(approvedRow.rows[0]?.approved_auth_user_id).toBe(approvedUserId);
      expect(approvedRow.rows[0]?.invite_redirect_to).toBe(inviteRedirectTo);

      const approvedUser = await db.query(
        `SELECT organization_id, status, access_scope_type, access_scope_id
           FROM public.users
          WHERE id = $1::uuid`,
        [approvedUserId],
      );
      expect(approvedUser.rows[0]?.organization_id).toBe(approvedOrgId);
      expect(approvedUser.rows[0]?.status).toBe('active');
      expect(approvedUser.rows[0]?.access_scope_type).toBe('tenant');
      expect(approvedUser.rows[0]?.access_scope_id ?? null).toBeNull();

      const approvedRoleAssignment = await db.query(
        `SELECT metadata->>'source' AS source, metadata->>'request_id' AS request_id
           FROM public.rbac_user_role_assignments
          WHERE organization_id = $1::uuid
            AND user_id = $2::uuid
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [approvedOrgId, approvedUserId],
      );
      expect(approvedRoleAssignment.rows[0]?.source).toBe('tenant_signup_review_apply_v1');
      expect(approvedRoleAssignment.rows[0]?.request_id).toBe(approveRequestId);

      const workflowBindingPolicy = await db.query(
        `SELECT settings_id, settings_version_id, scope_type, scope_id
           FROM public.resolve_settings_row('workflow_binding_policy', 'tenant', $1::uuid)
          LIMIT 1`,
        [approvedOrgId],
      );
      expect(workflowBindingPolicy.rows[0]?.scope_type).toBe('tenant');
      expect(workflowBindingPolicy.rows[0]?.scope_id).toBe(approvedOrgId);
      expect(workflowBindingPolicy.rows[0]?.settings_id).toBeTruthy();
      expect(workflowBindingPolicy.rows[0]?.settings_version_id).toBeTruthy();

      const onboardingReadiness = await db.query(
        `SELECT public.integration_plugin_baseline_readiness_v1('tenant', $1::uuid) AS readiness`,
        [approvedOrgId],
      );
      const readiness =
        onboardingReadiness.rows[0]?.readiness &&
        typeof onboardingReadiness.rows[0].readiness === 'object'
          ? onboardingReadiness.rows[0].readiness
          : {};
      const readinessItems = Array.isArray(readiness.items) ? readiness.items : [];

      expect(readiness).toMatchObject({
        status: 'ready',
        pending_credentials_total: 1,
      });
      expect(readinessItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            plugin_key: 'baseline.provider_webhook_handoff',
            status: 'pending_credentials',
            task_id: expect.any(String),
          }),
        ]),
      );
    } finally {
      db.release();
    }
  }, 120000);
});
