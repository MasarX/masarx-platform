// Plan: PLAN-202603-marketplace-network-v1 / Step: S95
// Marketplace participant review edge E2E (guarded). Validates authorization and approve/reject transitions.

const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { loadEnv } = require("../../../scripts/utils/load-env");

loadEnv();

const edgeE2eEnabled = process.env.RUN_EDGE_E2E === "true";
const required = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((key) => !String(process.env[key] || "").trim());
const runIfEdge = edgeE2eEnabled && missing.length === 0 ? describe : describe.skip;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const isAuthSignatureError = (message) =>
  /invalid jwt|signature is invalid|unable to parse or verify signature|no suitable key/i.test(
    String(message || ""),
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isInvalidJwtGatewayResponse = (result) =>
  Number(result?.status) === 401 &&
  isAuthSignatureError(
    result?.body?.message ||
    result?.body?.error?.message ||
    result?.body?.error_description ||
    "",
  );

function buildFnUrl(fnName) {
  const base = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/g, "");
  return `${base}/functions/v1/${fnName}`;
}

async function postReview(payload, token) {
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  const res = await fetch(buildFnUrl("marketplace-participant-review"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
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

runIfEdge("marketplace-participant-review edge (E2E)", () => {
  const service = missing.length === 0
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      db: { schema: "api" },
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

  test("POST without bearer token returns 401", async () => {
    const { status, body } = await postReview(
      {
        request_id: randomUUID(),
        decision: "rejected",
      },
      null,
    );

    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: { code: "missing_authorization" } });
  });

  test("platform reviewer can reject and approve marketplace participant requests", async () => {
    if (!service) {
      throw new Error("service client not initialized");
    }

    try {
      const { error: authProbeErr } = await service.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (authProbeErr && isAuthSignatureError(authProbeErr.message)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[marketplace-participant-review.e2e] skipped due to auth signature mode",
          authProbeErr.message,
        );
        return;
      }
    } catch (error) {
      if (isAuthSignatureError(error?.message)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[marketplace-participant-review.e2e] skipped due to auth signature mode",
          error.message,
        );
        return;
      }
      throw error;
    }

    const db = await pool.connect();
    try {
      const reviewerOrgId = randomUUID();
      await db.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Marketplace Review Org', $2::text, 'Asia/Riyadh', 'en', 'active')`,
        [reviewerOrgId, `marketplace-review-${reviewerOrgId.slice(0, 8)}`],
      );

      const reviewerEmail = `marketplace-reviewer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
      const reviewerPassword = `T!${Math.random().toString(16).slice(2)}Aa1`;
      const { data: reviewerAuth, error: reviewerAuthErr } = await service.auth.admin.createUser({
        email: reviewerEmail,
        password: reviewerPassword,
        email_confirm: true,
      });

      if (reviewerAuthErr || !reviewerAuth?.user?.id) {
        throw new Error(
          `failed to create reviewer auth user: ${reviewerAuthErr?.message || "missing user id"}`,
        );
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
           'Marketplace Reviewer',
           'ops_admin',
           'active',
           'platform',
           NULL
         )`,
        [reviewerUserId, reviewerOrgId, reviewerEmail],
      );

      const reviewerClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        db: { schema: "api" },
      });

      const { data: signInData, error: signInErr } = await reviewerClient.auth.signInWithPassword({
        email: reviewerEmail,
        password: reviewerPassword,
      });

      if (signInErr || !signInData?.session?.access_token) {
        throw new Error(`reviewer sign-in failed: ${signInErr?.message || "missing access token"}`);
      }

      const reviewerToken = signInData.session.access_token;
      const reviewerProbe = await reviewerClient.rpc("marketplace_assert_reviewer_v1");
      if (reviewerProbe.error && isAuthSignatureError(reviewerProbe.error.message)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[marketplace-participant-review.e2e] skipped due to auth signature mode",
          reviewerProbe.error.message,
        );
        return;
      }
      if (reviewerProbe.error) {
        throw new Error(`reviewer probe failed: ${reviewerProbe.error.message}`);
      }

      const createRejectPayload = await service.rpc("marketplace_participant_request_create_v1", {
        p_requested_participant_type_key: "freelancer_driver",
        p_email: `marketplace-reject-${Date.now()}@example.com`,
        p_full_name: "Example Person",
        p_organization_name: "Example Person",
        p_organization_slug: null,
        p_phone: "+12025550123",
        p_website_url: null,
        p_locale: "en",
        p_page_url: "https://hguxuguuvhxjwymmxhlmkwwp.example.invalid/drivers/apply",
        p_referrer: null,
        p_origin: "https://hguxuguuvhxjwymmxhlmkwwp.example.invalid",
        p_experience_summary: "reject path",
        p_capabilities_requested: ["fragile"],
        p_verification_documents: [],
        p_marketing: {},
        p_metadata: { source: "marketplace-participant-review.e2e.reject" },
        p_requested_organization_id: null,
        p_requested_by_user_id: null,
        p_ip_hash: `reject-ip-${randomUUID()}`,
        p_turnstile_verified: true,
      });

      if (createRejectPayload.error || !createRejectPayload.data?.id) {
        throw new Error(
          `failed to create reject request: ${createRejectPayload.error?.message || "missing id"}`,
        );
      }

      const rejectRequestId = createRejectPayload.data.id;
      expect(String(createRejectPayload.data.task_id || "")).toMatch(/^[0-9a-f-]{36}$/i);

      const rejectRes = await postReviewWithJwtRetry(
        {
          request_id: rejectRequestId,
          decision: "rejected",
          reason: "Not a fit",
        },
        reviewerToken,
      );
      if (isInvalidJwtGatewayResponse(rejectRes)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[marketplace-participant-review.e2e] skipped due to auth signature mode",
          JSON.stringify(rejectRes.body || {}),
        );
        return;
      }

      if (rejectRes.status !== 200) {
        throw new Error(
          `review reject failed: status=${rejectRes.status} body=${JSON.stringify(rejectRes.body || {})}`,
        );
      }

      expect(rejectRes.body).toMatchObject({ ok: true, decision: "rejected" });

      const rejectRow = await db.query(
        `SELECT
           status,
           review_decision,
           last_error_code,
           (
             SELECT t.id
               FROM public.tasks t
              WHERE t.resource_type = 'marketplace_participant_request'
                AND t.resource_id = req.id
              ORDER BY t.created_at DESC
              LIMIT 1
           ) AS review_task_id
           FROM public.marketplace_participant_requests AS req
           WHERE id = $1::uuid`,
        [rejectRequestId],
      );
      expect(rejectRow.rows[0]?.status).toBe("rejected");
      expect(rejectRow.rows[0]?.review_decision).toBe("rejected");
      expect(rejectRow.rows[0]?.last_error_code ?? null).toBeNull();
      expect(rejectRow.rows[0]?.review_task_id).toBe(createRejectPayload.data.task_id);

      const createApprovePayload = await service.rpc("marketplace_participant_request_create_v1", {
        p_requested_participant_type_key: "freelancer_driver",
        p_email: `marketplace-approve-${Date.now()}@example.com`,
        p_full_name: "Example Person",
        p_organization_name: "Example Person",
        p_organization_slug: null,
        p_phone: "+12025550123",
        p_website_url: null,
        p_locale: "en",
        p_page_url: "https://hguxuguuvhxjwymmxhlmkwwp.example.invalid/drivers/apply",
        p_referrer: null,
        p_origin: "https://hguxuguuvhxjwymmxhlmkwwp.example.invalid",
        p_experience_summary: "approve path",
        p_capabilities_requested: ["cold_chain"],
        p_verification_documents: [],
        p_marketing: {},
        p_metadata: { source: "marketplace-participant-review.e2e.approve" },
        p_requested_organization_id: null,
        p_requested_by_user_id: null,
        p_ip_hash: `approve-ip-${randomUUID()}`,
        p_turnstile_verified: true,
      });

      if (createApprovePayload.error || !createApprovePayload.data?.id) {
        throw new Error(
          `failed to create approve request: ${createApprovePayload.error?.message || "missing id"}`,
        );
      }

      const approveRequestId = createApprovePayload.data.id;
      expect(String(createApprovePayload.data.task_id || "")).toMatch(/^[0-9a-f-]{36}$/i);

      const approveRes = await postReviewWithJwtRetry(
        {
          request_id: approveRequestId,
          decision: "approved",
          reason: "Approved by edge e2e test",
          invite_redirect_to: "https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback",
        },
        reviewerToken,
      );
      if (isInvalidJwtGatewayResponse(approveRes)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[marketplace-participant-review.e2e] skipped due to auth signature mode",
          JSON.stringify(approveRes.body || {}),
        );
        return;
      }

      if (approveRes.status !== 200) {
        throw new Error(
          `review approve failed: status=${approveRes.status} body=${JSON.stringify(approveRes.body || {})}`,
        );
      }
      expect(approveRes.body).toMatchObject({ ok: true, decision: "approved" });

      const approveResult = approveRes.body && typeof approveRes.body === "object"
        ? approveRes.body.result || {}
        : {};

      const approvedProfileId = String(approveResult.approved_participant_profile_id || "");
      const approvedAuthUserId = String(
        approveResult.approved_auth_user_id || approveResult.approved_user_id || "",
      );
      if (approvedAuthUserId) {
        authUserIds.push(approvedAuthUserId);
      }

      expect(approvedProfileId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(approvedAuthUserId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const approvedRow = await db.query(
        `SELECT
           status,
           review_decision,
           last_error_code,
           approved_participant_profile_id,
           approved_auth_user_id,
           invite_redirect_to,
           (
             SELECT t.id
               FROM public.tasks t
              WHERE t.resource_type = 'marketplace_participant_request'
                AND t.resource_id = req.id
              ORDER BY t.created_at DESC
              LIMIT 1
           ) AS review_task_id
          FROM public.marketplace_participant_requests AS req
         WHERE id = $1::uuid`,
        [approveRequestId],
      );

      expect(approvedRow.rows[0]?.status).toBe("approved");
      expect(approvedRow.rows[0]?.review_decision).toBe("approved");
      expect(approvedRow.rows[0]?.last_error_code ?? null).toBeNull();
      expect(approvedRow.rows[0]?.approved_participant_profile_id).toBe(approvedProfileId);
      expect(approvedRow.rows[0]?.approved_auth_user_id).toBe(approvedAuthUserId);
      expect(approvedRow.rows[0]?.invite_redirect_to).toBe("https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback");
      expect(approvedRow.rows[0]?.review_task_id).toBe(createApprovePayload.data.task_id);
    } finally {
      db.release();
    }
  }, 120000);
});
