import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  asString,
  loadTenantSignupPolicy,
  parseOriginAllowlist,
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
  referrer?: unknown;
  marketing?: unknown;
  turnstile_token?: unknown;
};

const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);
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
const TENANT_SIGNUP_RPC_SCHEMA = "api";
const LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY = "EXAMPLE_PASSWORD";
const LOCAL_TENANT_SIGNUP_TURNSTILE_DUMMY_TOKEN = "EXAMPLE_PASSWORD";
const LEGACY_LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY = "local-dev-turnstile-secret";
const LOCAL_TURNSTILE_TEST_HOSTNAME = "example.com";
const LOCAL_TENANT_SIGNUP_IP_HASH_SALT = "local-tenant-signup";
const LOCAL_TENANT_SIGNUP_ORIGINS = new Set([
  // objectives:allow LOCALHOST Justification: local browser QA for tenant signup requires explicit loopback origins when the hosted allowlist is unavailable.
  "http://127.0.0.1:3333", "http://localhost:3333", "http://127.0.0.1:3000", "http://localhost:3000",
]);

const isLocalHostname = (value: string): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local-runtime detection must explicitly recognize loopback hosts for workspace QA fallback handling.
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized === "rvzwwjlztwwisjthghnipgjr.example.invalid";
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

const CORS_ALLOWLIST = parseOriginAllowlist(TENANT_SIGNUP_CORS_ALLOW_ORIGINS);
const ALLOWED_ORIGINS = CORS_ALLOWLIST.origins;
const CORS_ALLOWLIST_CONFIGURED =
  ALLOWED_ORIGINS.size > 0 &&
  CORS_ALLOWLIST.invalid.length === 0;

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

type CorsResult =
  | { ok: true; origin: string; headers: HeadersInit; localContext: boolean }
  | {
      ok: false;
      origin: string;
      status: number;
      body: JsonRecord;
      headers: HeadersInit;
      localContext: boolean;
    };

const normalizeOrigin = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
};

const isLoopbackOrigin = (value: string): boolean => {
  const origin = normalizeOrigin(value);
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const buildCorsHeaders = (req: Request): CorsResult => {
  const originRaw = req.headers.get("origin")?.trim() ?? "";
  const origin = normalizeOrigin(originRaw);
  const requestLocalContext = isLocalRequest(req);
  const localContext = requestLocalContext || Boolean(origin && LOCAL_TENANT_SIGNUP_ORIGINS.has(origin));
  const dynamicLocalOriginAllowed = requestLocalContext && origin ? isLoopbackOrigin(origin) : false;
  const effectiveOrigins = CORS_ALLOWLIST_CONFIGURED
    ? ALLOWED_ORIGINS
    : (localContext ? LOCAL_TENANT_SIGNUP_ORIGINS : new Set<string>());
  const effectiveConfigured = effectiveOrigins.size > 0 || dynamicLocalOriginAllowed;

  const baseHeaders = {
    "Access-Control-Allow-Headers": "accept, content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };

  if (!effectiveConfigured) {
    return {
      ok: false,
      origin: "",
      status: 500,
      body: {
        ok: false,
        error: {
          code: "server_misconfigured",
          message: CORS_ALLOWLIST.invalid.length ? "cors_allowlist_invalid" : "cors_allowlist_missing",
        },
      },
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "null",
      },
      localContext,
    };
  }

  if (!origin) {
    return {
      ok: false,
      origin: "",
      status: 403,
      body: { ok: false, error: { code: "origin_required" } },
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "null",
      },
      localContext,
    };
  }

  if (!effectiveOrigins.has(origin) && !dynamicLocalOriginAllowed) {
    return {
      ok: false,
      origin,
      status: 403,
      body: { ok: false, error: { code: "origin_not_allowed" } },
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "null",
      },
      localContext,
    };
  }

  return {
    ok: true,
    origin,
    headers: {
      ...baseHeaders,
      "Access-Control-Allow-Origin": origin,
    },
    localContext,
  };
};

const verifyTurnstile = async (
  token: string,
  secret: string,
  clientIp?: string,
): Promise<{ success: boolean; hostname: string; errorCodes: unknown }> => {
  if (!secret) {
    return { success: false, hostname: "", errorCodes: ["missing_turnstile_secret"] };
  }
  if (secret === LEGACY_LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY && token === LOCAL_TENANT_SIGNUP_TURNSTILE_DUMMY_TOKEN) {
    return { success: true, hostname: "", errorCodes: null };
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (clientIp) body.set("remoteip", clientIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await response.json().catch(() => null);
  const success = Boolean(data && typeof data === "object" && (data as any).success === true);
  const hostname = data && typeof data === "object" ? String((data as any).hostname || "").trim() : "";
  const errorCodes = data && typeof data === "object" ? (data as any)["error-codes"] ?? null : null;
  return { success, hostname, errorCodes };
};

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

serve(async (req: Request): Promise<Response> => {
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

  let policy: JsonRecord;
  try {
    policy = await loadTenantSignupPolicy(serviceClient);
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
  let turnstileErrorCodes: unknown = null;
  const effectiveTurnstileSecret =
    TENANT_SIGNUP_TURNSTILE_SECRET_KEY ||
    (cors.localContext ? LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY : "");

  if (turnstileToken) {
    try {
      const turnstileResult = cors.localContext && turnstileToken === LOCAL_TENANT_SIGNUP_TURNSTILE_DUMMY_TOKEN
        ? { success: true, hostname: "", errorCodes: [] }
        : await verifyTurnstile(turnstileToken, effectiveTurnstileSecret, clientIp);
      turnstileVerified = turnstileResult.success;
      turnstileErrorCodes = turnstileResult.errorCodes;

      if (turnstileResult.success && turnstileResult.hostname) {
        const expectedHost = (() => {
          try {
            return new URL(cors.origin).hostname.toLowerCase();
          } catch {
            return "";
          }
        })();
        const actualHost = turnstileResult.hostname.toLowerCase();
        const localTestHostname = cors.localContext &&
          effectiveTurnstileSecret === LOCAL_TENANT_SIGNUP_TURNSTILE_SECRET_KEY &&
          actualHost === LOCAL_TURNSTILE_TEST_HOSTNAME;
        if (expectedHost && actualHost && expectedHost !== actualHost && !localTestHostname) {
          return json(
            400,
            {
              ok: false,
              error: { code: "turnstile_invalid" },
              turnstile_error_codes: turnstileErrorCodes,
            },
            cors.headers,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "turnstile_verify_failed";
      return json(502, { ok: false, error: { code: "turnstile_verify_failed", message } }, cors.headers);
    }
  }

  if (turnstileRequired && !turnstileVerified) {
    return json(
      400,
      {
        ok: false,
        error: { code: "turnstile_required" },
        turnstile_error_codes: turnstileErrorCodes,
      },
      cors.headers,
    );
  }

  const requestUrl = new URL(req.url);
  const pageUrl = asString(requestUrl.searchParams.get("page_url") || "") || asString(req.headers.get("origin") || "");

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

  const { data: rpcData, error: rpcError } = await serviceClient.rpc(
    "tenant_signup_request_create_v1",
    rpcPayload,
  );

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
        turnstile_error_codes: turnstileErrorCodes,
      },
      cors.headers,
    );
  }

  const requestId = asString(rpcBody.id);
  const deduped = Boolean(rpcBody.deduped);
  let queueStatus = asString(rpcBody.status) || "pending";

  return json(
    200,
    {
      ok: true,
      status: "under_review",
      deduped,
      request_id: requestId || null,
      tenant_signup_request_id: requestId || null,
      queue_status: queueStatus,
      approval_required: true,
      auto_approve: false,
      auto_approve_applied: false,
      turnstile_error_codes: turnstileErrorCodes,
    },
    cors.headers,
  );
});
