import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  approveMarketplaceParticipantRequest,
  asString,
  loadMarketplaceCompliancePolicy,
  type JsonRecord,
} from "./_shared/marketplace_signup.ts";

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
const MARKETPLACE_RPC_SCHEMA =
  readEnv("MARKETPLACE_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

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

const normalizeDecision = (value: string): "approved" | "rejected" | "request_additional_docs" | "" => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approved";
  if (normalized === "reject" || normalized === "rejected") return "rejected";
  if (
    normalized === "request_additional_docs" ||
    normalized === "request-docs" ||
    normalized === "request_docs" ||
    normalized === "additional_docs"
  ) return "request_additional_docs";
  return "";
};

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: {
      schema: MARKETPLACE_RPC_SCHEMA,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
};

const createServiceClient = () => {
  const serviceKey = asString(SUPABASE_SERVICE_KEY) || asString(EDGE_SUPABASE_SECRET_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }

  const apiKeyHeader = serviceKey;

  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
    db: {
      schema: MARKETPLACE_RPC_SCHEMA,
    },
    global: {
      headers: {
        apikey: apiKeyHeader,
        ...(isJwtLike(serviceKey) ? { Authorization: `Bearer ${serviceKey}` } : {}),
      },
    },
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
  const inviteRedirectTo = asString(payload?.invite_redirect_to);
  const metadata = payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? (payload.metadata as JsonRecord)
    : {};

  if (!uuidRegex.test(requestId)) {
    return json(400, { ok: false, error: { code: "invalid_request_id" } }, cors);
  }

  if (!decision) {
    return json(400, { ok: false, error: { code: "invalid_decision" } }, cors);
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
    "marketplace_assert_reviewer_v1",
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
    const approveResult = await approveMarketplaceParticipantRequest({
      serviceClient,
      requestId,
      reviewerUserId,
      decisionReason: reason || null,
      decisionMetadata: {
        ...metadata,
        reason: reason || null,
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
      }, cors);
    }

    return json(200, {
      ok: true,
      decision: "approved",
      result: approveResult,
    }, cors);
  }

  if (decision === "request_additional_docs") {
    let approvalMode = "required";
    try {
      const policy = await loadMarketplaceCompliancePolicy(serviceClient, "freelancer_driver", null);
      approvalMode = asString(policy.approval_mode) || "required";
    } catch {
      approvalMode = "required";
    }

    const { data: requestDocsData, error: requestDocsError } = await serviceClient.rpc(
      "marketplace_participant_request_review_apply_v1",
      {
        p_request_id: requestId,
        p_decision: "request_additional_docs",
        p_reviewer_user_id: reviewerUserId,
        p_invited_auth_user_id: null,
        p_invite_email_sent: false,
        p_invite_redirect_to: null,
        p_approved_organization_id: null,
        p_approved_user_id: null,
        p_decision_metadata: {
          ...metadata,
          reason: reason || asString(metadata.note) || null,
          reviewed_via: "marketplace-participant-review",
          approval_mode: approvalMode,
          request_additional_docs: true,
        },
      },
    );

    if (requestDocsError) {
      return json(400, {
        ok: false,
        error: {
          code: "request_additional_docs_failed",
          message: requestDocsError.message,
        },
      }, cors);
    }

    return json(200, {
      ok: true,
      decision: "request_additional_docs",
      result: requestDocsData && typeof requestDocsData === "object" ? (requestDocsData as JsonRecord) : {},
    }, cors);
  }

  let approvalMode = "required";
  try {
    const policy = await loadMarketplaceCompliancePolicy(serviceClient, "freelancer_driver", null);
    approvalMode = asString(policy.approval_mode) || "required";
  } catch {
    approvalMode = "required";
  }

  const { data: rejectData, error: rejectError } = await serviceClient.rpc(
    "marketplace_participant_request_review_apply_v1",
    {
      p_request_id: requestId,
      p_decision: "rejected",
      p_reviewer_user_id: reviewerUserId,
      p_invited_auth_user_id: null,
      p_invite_email_sent: false,
      p_invite_redirect_to: null,
      p_approved_organization_id: null,
      p_approved_user_id: null,
      p_decision_metadata: {
        ...metadata,
        reason: reason || null,
        reviewed_via: "marketplace-participant-review",
        approval_mode: approvalMode,
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

  return json(200, {
    ok: true,
    decision: "rejected",
    result: rejectData && typeof rejectData === "object" ? (rejectData as JsonRecord) : {},
  }, cors);
});
