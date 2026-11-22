import { turnstileHostnameFailure, verifyMarketingTurnstile } from "./_shared/turnstile-local-test.mjs";
import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  approveTenantSignupRequest,
  asString,
  loadTenantSignupPolicy,
  policyBool,
  readClientIp,
  sha256Hex,
  type JsonRecord,
} from "./_shared/tenant_signup.ts";

type IntakePayload = {
  email?: unknown;
  full_name?: unknown;
  organization_name?: unknown;
  organization_slug?: unknown;
  website_url?: unknown;
  phone?: unknown;
  notes?: unknown;
  locale?: unknown;
  page_url?: unknown;
  referrer?: unknown;
  marketing?: unknown;
  turnstile_token?: unknown;
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

const TENANT_SIGNUP_CORS_ALLOW_ORIGINS = readEnv("TENANT_SIGNUP_CORS_ALLOW_ORIGINS", [
  "MARKETING_CORS_ALLOW_ORIGINS",
  "LANDING_CORS_ALLOW_ORIGINS",
]);
const TENANT_SIGNUP_TURNSTILE_SECRET_KEY = readEnv("TENANT_SIGNUP_TURNSTILE_SECRET_KEY", [
  "MARKETING_TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET",
]);
const TENANT_SIGNUP_IP_HASH_SALT = readEnv("TENANT_SIGNUP_IP_HASH_SALT", [
  "MARKETING_IP_HASH_SALT",
]);
const TENANT_SIGNUP_RPC_SCHEMA =
  readEnv("TENANT_SIGNUP_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";
const LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY = "EXAMPLE_PASSWORD";
const LOCAL_TENANT_SIGNUP_IP_HASH_SALT = "local-tenant-signup";
const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const mapRpcErrorToStatus = (code: string): number => {
  switch (code) {
    case "rate_limited":
      return 429;
    case "disabled":
      return 503;
    case "turnstile_required":
    case "turnstile_invalid":
    case "invalid_email":
    case "full_name_required":
    case "organization_required":
    case "domain_not_allowed":
    case "domain_blocked":
      return 400;
    default:
      return 400;
  }
};

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: TENANT_SIGNUP_CORS_ALLOW_ORIGINS,
  localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS"),
  localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1",
  allowedMethods: "POST, OPTIONS",
});

const createServiceClient = () => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_configuration");
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
      },
    },
  });
};

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    if (!cors.ok) return json(cors.status, cors.body, cors.headers);
    return new Response(null, { status: 204, headers: cors.headers });
  }

  if (!cors.ok) return json(cors.status, cors.body, cors.headers);

  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors.headers);
  }

  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json(415, { ok: false, error: { code: "unsupported_content_type" } }, cors.headers);
  }

  let payload: IntakePayload;
  try {
    payload = (await parseRequestBody(req)).json as IntakePayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors.headers);
  }

  const email = asString(payload?.email).toLowerCase();
  const fullName = asString(payload?.full_name);
  const organizationName = asString(payload?.organization_name);
  const organizationSlug = asString(payload?.organization_slug);
  const websiteUrl = asString(payload?.website_url);
  const phone = asString(payload?.phone);
  const notes = asString(payload?.notes);
  const locale = asString(payload?.locale);
  const referrer = asString(payload?.referrer) || asString(req.headers.get("referer") || "");
  const turnstileToken = asString(payload?.turnstile_token);
  const marketing = payload?.marketing && typeof payload.marketing === "object" && !Array.isArray(payload.marketing)
    ? (payload.marketing as JsonRecord)
    : {};

  let serviceClient;
  try {
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  // Local QA observation only: never log request data or alter operation results.
  const correlation = req.headers.get("x-masarx-intake-diagnostic") || "";
  const observeStages = cors.localContext && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(correlation);
  const observe = async <T>(stage: "policy" | "turnstile" | "persistence" | "auto_approve", operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const emit = (status: "started" | "resolved" | "rejected") => {
      if (!observeStages) return;
      try {
        console.info(JSON.stringify({ event: "tenant_intake_stage", correlation, stage, status,
          duration_ms: Math.max(0, Math.round(performance.now() - started)) }));
      } catch (_) { /* Observation must not change intake behavior. */ }
    };
    emit("started");
    try { const result = await operation(); emit("resolved"); return result; }
    catch (error) { emit("rejected"); throw error; }
  };

  let policy: JsonRecord;
  try {
    policy = await observe("policy", () => loadTenantSignupPolicy(serviceClient));
  } catch (error) {
    const message = error instanceof Error ? error.message : "policy_load_failed";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  if (!policyBool(policy, ["enabled"], false)) {
    return json(503, { ok: false, error: { code: "disabled" } }, cors.headers);
  }

  const turnstileRequired = policyBool(policy, ["turnstile", "required"], true);

  // objectives:allow LOCALHOST Justification: local-only fallback client IP is required when loopback QA requests omit forwarded IP headers.
  const clientIp = readClientIp(req) || (cors.localContext ? "127.0.0.1" : "");
  const effectiveIpHashSalt =
    TENANT_SIGNUP_IP_HASH_SALT || (cors.localContext ? LOCAL_TENANT_SIGNUP_IP_HASH_SALT : "");
  if (!clientIp || !effectiveIpHashSalt) {
    return json(
      500,
      { ok: false, error: { code: "server_misconfigured", message: "ip_hash_prerequisites_missing" } },
      cors.headers,
    );
  }

  const ipHash = await sha256Hex(`${effectiveIpHashSalt}:${clientIp}`);

  let turnstileVerified = false;
  const effectiveTurnstileSecret =
    TENANT_SIGNUP_TURNSTILE_SECRET_KEY ||
    (cors.localContext ? LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY : "");

  if (turnstileToken) {
    try {
      const turnstileResult = await observe("turnstile", () => verifyMarketingTurnstile({ token: turnstileToken, secret: effectiveTurnstileSecret, localContext: cors.localContext, requestHostname: new URL(req.url).hostname, clientIp }));
      if (turnstileResult.success && turnstileHostnameFailure(turnstileResult.hostname, cors.origin)) {
        return json(400, { ok: false, error: { code: "turnstile_invalid" } }, cors.headers);
      }
      turnstileVerified = turnstileResult.success;
    } catch {
      return json(502, { ok: false, error: { code: "turnstile_verify_failed" } }, cors.headers);
    }
  }

  if (turnstileRequired && !turnstileVerified) {
    return json(
      400,
      {
        ok: false,
        error: { code: "turnstile_required" },
      },
      cors.headers,
    );
  }

  const pageUrl = asString(payload?.page_url) || cors.origin;

  const rpcPayload = {
    p_email: email,
    p_full_name: fullName,
    p_organization_name: organizationName,
    p_organization_slug: organizationSlug || null,
    p_website_url: websiteUrl || null,
    p_phone: phone || null,
    p_notes: notes || null,
    p_locale: locale || null,
    p_page_url: pageUrl || null,
    p_referrer: referrer || null,
    p_origin: cors.origin || null,
    p_marketing: marketing,
    p_ip_hash: ipHash || null,
    p_turnstile_verified: turnstileVerified,
  };

  const { data: rpcData, error: rpcError } = await observe("persistence", async () => await serviceClient.rpc(
    "tenant_signup_request_create_v1",
    rpcPayload,
  ));

  if (rpcError) {
    return json(
      500,
      {
        ok: false,
        error: {
          code: "rpc_failed",
          message: rpcError.message,
        },
      },
      cors.headers,
    );
  }

  const rpcBody = (rpcData && typeof rpcData === "object" ? rpcData : {}) as JsonRecord;
  if (rpcBody.ok === false) {
    const errorObj = (rpcBody.error && typeof rpcBody.error === "object" ? rpcBody.error : {}) as JsonRecord;
    const code = asString(errorObj.code);
    return json(
      mapRpcErrorToStatus(code),
      {
        ...rpcBody,
      },
      cors.headers,
    );
  }

  const requestId = asString(rpcBody.id);
  const autoApprove = Boolean(rpcBody.auto_approve);

  let queueStatus = asString(rpcBody.status) || "under_review";
  let autoApproveResult: JsonRecord | null = null;

  if (autoApprove && requestId) {
    autoApproveResult = await observe("auto_approve", () => approveTenantSignupRequest({
      serviceClient,
      requestId,
      reviewerUserId: null,
      decisionReason: "auto_approved_by_policy",
      decisionMetadata: {
        source: "tenant-signup-intake:auto-approve",
      },
      inviteRedirectOverride: null,
    }));

    if (autoApproveResult.ok === true) {
      const maybeStatus = asString(autoApproveResult.status);
      if (maybeStatus) queueStatus = maybeStatus;
    }
  }

  return json(
    200,
    {
      ok: true,
      status: queueStatus,
      request_id: requestId || null,
      queue_status: queueStatus,
      auto_approve: autoApprove,
      auto_approve_applied: autoApprove && autoApproveResult?.ok === true,
    },
    cors.headers,
  );
});
