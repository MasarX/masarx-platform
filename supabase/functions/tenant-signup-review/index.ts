import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  approveTenantSignupRequest,
  asString,
  loadTenantSignupPolicy,
  normalizeInviteRedirectUrl,
  normalizeOrigin,
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
const EDGE_DB_JWT = readEnv("TENANT_SIGNUP_REVIEW_DB_JWT", ["EDGE_DB_JWT"]);
const TENANT_SIGNUP_RPC_SCHEMA = "api";
const WORKSPACE_LOCAL_AUTH_REDIRECT_ORIGINS = readEnv("WORKSPACE_LOCAL_AUTH_REDIRECT_ORIGINS");
const WORKSPACE_CONSOLE_BASE_URL = readEnv("WORKSPACE_CONSOLE_BASE_URL", [
  "CONSOLE_BASE_URL",
  "VITE_CONSOLE_BASE_URL",
]);

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin")?.trim() || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-max-age": "600",
    vary: "Origin",
  };
};

const json = (status: number, body: JsonRecord, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
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

const isLocalHostname = (value: string): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local approval proof may use the workspace loopback edge runtime only.
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "rvzwwjlztwwisjthghnipgjr.example.invalid" ||
    normalized === "kong"
  );
};

const isLocalRequest = (req: Request): boolean => {
  const hostHeader = String(req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
    .trim()
    .split(":")[0]
    .toLowerCase();
  if (isLocalHostname(hostHeader)) return true;
  try {
    return isLocalHostname(new URL(req.url).hostname);
  } catch {
    return false;
  }
};

const parseLocalInviteRedirectOrigins = (): string[] =>
  Array.from(new Set(
    [
      ...String(WORKSPACE_LOCAL_AUTH_REDIRECT_ORIGINS || "").split(","),
      WORKSPACE_CONSOLE_BASE_URL,
    ]
      .map((value) => normalizeOrigin(String(value || "").trim()))
      .filter((origin) => {
        if (!origin) return false;
        try {
          return isLocalHostname(new URL(origin).hostname);
        } catch {
          return false;
        }
      }),
  ));

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

  // Supabase JWT keys should pair with anon apikey; secret keys must self-identify as apikey.
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
        ...(isJwtLike(serviceKey) ? { Authorization: `Bearer ${serviceKey}` } : {}),
      },
    },
  });
};

const createReviewDbClient = () => {
  const dbJwt = asString(EDGE_DB_JWT);
  if (!SUPABASE_URL || !dbJwt || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: {
      schema: TENANT_SIGNUP_RPC_SCHEMA,
    },
    global: {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${dbJwt}`,
        "x-client-info": "console-v2-tenant-signup-review",
      },
    },
    accessToken: async () => dbJwt,
  });
};

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors);
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowWebhookHeader: false,
    allowQueryParam: false,
  });

  if (!token) {
    return json(401, { ok: false, error: { code: "missing_authorization" } }, cors);
  }

  let payload: ReviewPayload;
  try {
    payload = (await parseRequestBody(req)).json as ReviewPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors);
  }

  const requestId = asString(payload?.request_id);
  const decision = normalizeDecision(asString(payload?.decision));
  const reason = asString(payload?.reason);
  const inviteRedirectInput = asString(payload?.invite_redirect_to);
  const localInviteRedirectOrigins = parseLocalInviteRedirectOrigins();
  const allowLocalInviteRedirect =
    isLocalRequest(req) && localInviteRedirectOrigins.length > 0;
  const inviteRedirectTo = inviteRedirectInput
    ? normalizeInviteRedirectUrl(inviteRedirectInput, {
        allowLocalInviteRedirect,
        localInviteRedirectOrigins,
      })
    : "";
  const metadata = payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? (payload.metadata as JsonRecord)
    : {};

  if (!uuidRegex.test(requestId)) {
    return json(400, { ok: false, error: { code: "invalid_request_id" } }, cors);
  }

  if (!decision) {
    return json(400, { ok: false, error: { code: "invalid_decision" } }, cors);
  }

  if (inviteRedirectInput && !inviteRedirectTo) {
    return json(400, {
      ok: false,
      error: {
        code: "invalid_invite_redirect_to",
        message: "invite_redirect_to must be a hosted non-localhost http/https URL.",
      },
    }, cors);
  }

  let userClient;
  let serviceClient;
  try {
    userClient = createUserClient(token);
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors);
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
    }, cors);
  }

  const reviewer = reviewerData && typeof reviewerData === "object"
    ? (reviewerData as JsonRecord)
    : {};
  const reviewerUserId = asString(reviewer.user_id) || null;

  if (decision === "approved") {
    const reviewClient = createReviewDbClient() || serviceClient;
    const approveResult = await approveTenantSignupRequest({
      serviceClient,
      reviewClient,
      requestId,
      reviewerUserId,
      decisionReason: reason || null,
      decisionMetadata: {
        ...metadata,
        reviewed_via: "tenant-signup-review",
      },
      inviteRedirectOverride: inviteRedirectTo || null,
      allowLocalInviteRedirect,
      localInviteRedirectOrigins,
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
      }, cors);
    }

    return json(200, {
      ok: true,
      decision: "approved",
      tenant_signup_request_id: requestId,
      request_id: requestId,
      id: approveResult.id ?? requestId,
      status: approveResult.status ?? "approved",
      organization_id: approveResult.organization_id ?? null,
      approved_organization_id: approveResult.organization_id ?? null,
      user_id: approveResult.user_id ?? null,
      approved_user_id: approveResult.user_id ?? null,
      invite_redirect_to: approveResult.invite_redirect_to ?? inviteRedirectTo ?? null,
      result: approveResult,
    }, cors);
  }

  // Rejection flow: policy exposes requester_rejected_email toggle; current behavior is fail-safe
  // and keeps explicit metadata for downstream notification handlers.
  let rejectionEmailRequested = false;
  const reviewClient = createReviewDbClient() || serviceClient;
  try {
    const policy = await loadTenantSignupPolicy(serviceClient);
    const requested = policy.notifications;
    if (requested && typeof requested === "object" && !Array.isArray(requested)) {
      rejectionEmailRequested = Boolean((requested as JsonRecord).requester_rejected_email);
    }
  } catch {
    rejectionEmailRequested = false;
  }

  const { data: rejectData, error: rejectError } = await reviewClient.rpc(
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
    }, cors);
  }

  const rejectResult = rejectData && typeof rejectData === "object" ? rejectData as JsonRecord : {};
  const actualStatus = typeof rejectResult.status === "string" && rejectResult.status
    ? rejectResult.status
    : "rejected";
  const actualDecision = actualStatus === "approved" || actualStatus === "rejected"
    ? actualStatus
    : "rejected";

  return json(200, {
    ok: true,
    decision: actualDecision,
    tenant_signup_request_id: requestId,
    request_id: requestId,
    id: rejectResult.id ?? requestId,
    status: actualStatus,
    review_decision: actualDecision,
    already_processed: rejectResult.already_processed === true,
    approved_organization_id: rejectResult.approved_organization_id ?? null,
    approved_user_id: rejectResult.approved_user_id ?? null,
    result: rejectResult,
  }, cors);
});
