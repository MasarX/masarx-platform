import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  approveTenantSignupRequest,
  asString,
  loadTenantSignupPolicy,
  normalizeHostedRedirectUrl,
  type JsonRecord,
} from "./_shared/tenant_signup.ts";

type ReviewPayload = {
  request_id?: unknown;
  decision?: unknown;
  reason?: unknown;
  invite_redirect_to?: unknown;
  metadata?: unknown;
};

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);
const TENANT_SIGNUP_RPC_SCHEMA =
  readEnv("TENANT_SIGNUP_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

const json = (status: number, body: JsonRecord) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const normalizeDecision = (value: string): "approved" | "rejected" | "" => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approved";
  if (normalized === "reject" || normalized === "rejected") return "rejected";
  return "";
};

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: {
      schema: TENANT_SIGNUP_RPC_SCHEMA,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
};

const createServiceClient = () => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }

  // JWT service keys pair with anon apikey; secret keys must be used as apikey.
  const apiKeyHeader = isJwtLike(serviceKey)
    ? (anonKey || serviceKey)
    : serviceKey;

  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
    db: {
      schema: TENANT_SIGNUP_RPC_SCHEMA,
    },
    global: {
      headers: {
        apikey: apiKeyHeader,
      },
    },
  });
};

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } });
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowWebhookHeader: false,
    allowQueryParam: false,
  });

  if (!token) {
    return json(401, { ok: false, error: { code: "missing_authorization" } });
  }

  let payload: ReviewPayload;
  try {
    payload = (await parseRequestBody(req)).json as ReviewPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } });
  }

  const requestId = asString(payload?.request_id);
  const decision = normalizeDecision(asString(payload?.decision));
  const reason = asString(payload?.reason);
  const inviteRedirectInput = asString(payload?.invite_redirect_to);
  const inviteRedirectTo = inviteRedirectInput
    ? normalizeHostedRedirectUrl(inviteRedirectInput)
    : "";
  const metadata = payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? (payload.metadata as JsonRecord)
    : {};

  if (!uuidRegex.test(requestId)) {
    return json(400, { ok: false, error: { code: "invalid_request_id" } });
  }

  if (!decision) {
    return json(400, { ok: false, error: { code: "invalid_decision" } });
  }

  if (inviteRedirectInput && !inviteRedirectTo) {
    return json(400, {
      ok: false,
      error: {
        code: "invalid_invite_redirect_to",
        message: "invite_redirect_to must be a hosted non-localhost http/https URL.",
      },
    });
  }

  let userClient;
  let serviceClient;
  try {
    userClient = createUserClient(token);
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } });
  }

  const { data: reviewerData, error: reviewerError } = await userClient.rpc(
    "tenant_signup_assert_reviewer_v1",
  );

  if (reviewerError) {
    return json(403, {
      ok: false,
      error: {
        code: "reviewer_forbidden",
        message: reviewerError.message,
      },
    });
  }

  const reviewer = reviewerData && typeof reviewerData === "object"
    ? (reviewerData as JsonRecord)
    : {};
  const reviewerUserId = asString(reviewer.user_id) || null;

  if (decision === "approved") {
    const approveResult = await approveTenantSignupRequest({
      serviceClient,
      requestId,
      reviewerUserId,
      decisionReason: reason || null,
      decisionMetadata: {
        ...metadata,
        reviewed_via: "tenant-signup-review",
      },
      inviteRedirectOverride: inviteRedirectTo || null,
    });

    if (approveResult.ok === false) {
      const err = approveResult.error && typeof approveResult.error === "object"
        ? (approveResult.error as JsonRecord)
        : {};
      const code = asString(err.code) || "approval_failed";
      return json(400, {
        ok: false,
        error: {
          code,
          message: asString(err.message) || "approval_failed",
        },
      });
    }

    return json(200, {
      ok: true,
      decision: "approved",
      result: approveResult,
    });
  }

  // Rejection flow: policy exposes requester_rejected_email toggle; current behavior is fail-safe
  // and keeps explicit metadata for downstream notification handlers.
  let rejectionEmailRequested = false;
  try {
    const policy = await loadTenantSignupPolicy(serviceClient);
    const requested = policy.notifications;
    if (requested && typeof requested === "object" && !Array.isArray(requested)) {
      rejectionEmailRequested = Boolean((requested as JsonRecord).requester_rejected_email);
    }
  } catch {
    rejectionEmailRequested = false;
  }

  const { data: rejectData, error: rejectError } = await serviceClient.rpc(
    "tenant_signup_review_apply_v1",
    {
      p_request_id: requestId,
      p_decision: "rejected",
      p_reviewer_user_id: reviewerUserId,
      p_decision_reason: reason || null,
      p_invited_auth_user_id: null,
      p_invite_email_sent: false,
      p_invite_redirect_to: null,
      p_decision_metadata: {
        ...metadata,
        reviewed_via: "tenant-signup-review",
        requester_rejected_email_requested: rejectionEmailRequested,
        requester_rejected_email_sent: false,
      },
    },
  );

  if (rejectError) {
    return json(400, {
      ok: false,
      error: {
        code: "rejection_failed",
        message: rejectError.message,
      },
    });
  }

  return json(200, {
    ok: true,
    decision: "rejected",
    result: rejectData && typeof rejectData === "object" ? rejectData : {},
  });
});
