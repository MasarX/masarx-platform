import { verifyMarketingTurnstile } from "./_shared/turnstile-local-test.mjs";
import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  asString,
  loadMarketplaceCompliancePolicy,
  policyBool,
  readClientIp,
  sha256Hex,
  type JsonRecord,
} from "./_shared/marketplace_signup.ts";

type IntakePayload = {
  email?: unknown;
  full_name?: unknown;
  organization_name?: unknown;
  organization_slug?: unknown;
  entry_key?: unknown;
  organization_id?: unknown;
  requested_organization_id?: unknown;
  phone?: unknown;
  website_url?: unknown;
  locale?: unknown;
  page_url?: unknown;
  referrer?: unknown;
  experience_summary?: unknown;
  capabilities_requested?: unknown;
  verification_documents?: unknown;
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

const DRIVER_SIGNUP_CORS_ALLOW_ORIGINS = readEnv("DRIVER_SIGNUP_CORS_ALLOW_ORIGINS", [
  "MARKETING_CORS_ALLOW_ORIGINS",
  "LANDING_CORS_ALLOW_ORIGINS",
]);
const DRIVER_SIGNUP_TURNSTILE_SECRET_KEY = readEnv("DRIVER_SIGNUP_TURNSTILE_SECRET_KEY", [
  "MARKETING_TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET",
]);
const DRIVER_SIGNUP_IP_HASH_SALT = readEnv("DRIVER_SIGNUP_IP_HASH_SALT", [
  "MARKETING_IP_HASH_SALT",
]);
const DRIVER_SIGNUP_RPC_SCHEMA =
  readEnv("DRIVER_SIGNUP_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

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
    case "participant_type_required":
    case "participant_type_invalid":
      return 400;
    default:
      return 400;
  }
};

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: DRIVER_SIGNUP_CORS_ALLOW_ORIGINS,
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

  const apiKeyHeader = isJwtLike(serviceKey)
    ? (anonKey || serviceKey)
    : serviceKey;

  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
    db: {
      schema: DRIVER_SIGNUP_RPC_SCHEMA,
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
  const organizationName = asString(payload?.organization_name) || fullName || email;
  const organizationSlug = asString(payload?.organization_slug);
  const websiteUrl = asString(payload?.website_url);
  const phone = asString(payload?.phone);
  const locale = asString(payload?.locale);
  const experienceSummary = asString(payload?.experience_summary);
  const referrer = asString(payload?.referrer) || asString(req.headers.get("referer") || "");
  const turnstileToken = asString(payload?.turnstile_token);
  const capabilitiesRequested = Array.isArray(payload?.capabilities_requested)
    ? payload.capabilities_requested
    : [];
  const verificationDocuments = Array.isArray(payload?.verification_documents)
    ? payload.verification_documents
    : [];
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

  const { data: entry, error: entryError } = await serviceClient.rpc("marketplace_public_entry_resolve_v1", {
    p_entry_key: asString(payload?.entry_key),
    p_participant_type_key: "freelancer_driver",
  });
  if (entryError) return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.ok !== true
      || typeof entry.organization_id !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.organization_id)
      || typeof entry.organization_slug !== "string" || !entry.organization_slug.trim()) {
    return json(403, { ok: false, error: { code: "public_entry_not_allowed" } }, cors.headers);
  }
  if ((organizationSlug && organizationSlug !== entry.organization_slug)
      || (payload.organization_id != null && payload.organization_id !== entry.organization_id)
      || (payload.requested_organization_id != null && payload.requested_organization_id !== entry.organization_id)) {
    return json(403, { ok: false, error: { code: "public_entry_not_allowed" } }, cors.headers);
  }

  let policy: JsonRecord;
  try {
    policy = await loadMarketplaceCompliancePolicy(serviceClient, "freelancer_driver", entry.organization_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "policy_load_failed";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  if (!policyBool(policy, ["enabled"], false)) {
    return json(503, { ok: false, error: { code: "disabled" } }, cors.headers);
  }

  const turnstileRequired = policyBool(policy, ["turnstile", "required"], true);

  const clientIp = readClientIp(req);
  if (!clientIp || !DRIVER_SIGNUP_IP_HASH_SALT) {
    return json(
      500,
      { ok: false, error: { code: "server_misconfigured", message: "ip_hash_prerequisites_missing" } },
      cors.headers,
    );
  }

  const ipHash = await sha256Hex(`${DRIVER_SIGNUP_IP_HASH_SALT}:${clientIp}`);

  let turnstileVerified = false;
  let turnstileErrorCodes: unknown = null;

  if (turnstileToken) {
    try {
      const turnstileResult = await verifyMarketingTurnstile({ token: turnstileToken, secret: DRIVER_SIGNUP_TURNSTILE_SECRET_KEY, localContext: cors.localContext, requestHostname: new URL(req.url).hostname, clientIp });
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
        if (expectedHost && actualHost && expectedHost !== actualHost) {
          return json(
            400,
            {
              ok: false,
              error: {
                code: "turnstile_invalid",
                message: "turnstile_hostname_mismatch",
              },
            },
            cors.headers,
          );
        }
      }
    } catch (error) {
      return json(
        500,
        {
          ok: false,
          error: {
            code: "turnstile_validation_failed",
            message: error instanceof Error ? error.message : "turnstile_validation_failed",
          },
        },
        cors.headers,
      );
    }
  }

  if (turnstileRequired && !turnstileVerified) {
    return json(
      400,
      {
        ok: false,
        error: {
          code: "turnstile_required",
          message: Array.isArray(turnstileErrorCodes) ? turnstileErrorCodes.join(",") : undefined,
        },
      },
      cors.headers,
    );
  }

  const { data, error } = await serviceClient.rpc("marketplace_participant_request_create_v1", {
    p_requested_participant_type_key: "freelancer_driver",
    p_email: email,
    p_full_name: fullName,
    p_organization_name: organizationName,
    p_organization_slug: entry.organization_slug,
    p_phone: phone || null,
    p_website_url: websiteUrl || null,
    p_locale: locale || null,
    p_page_url: asString(payload?.page_url) || cors.origin,
    p_referrer: referrer || null,
    p_origin: cors.origin,
    p_experience_summary: experienceSummary || null,
    p_capabilities_requested: capabilitiesRequested,
    p_verification_documents: verificationDocuments,
    p_marketing: marketing,
    p_metadata: {
      source: "driver-signup-intake",
    },
    p_requested_organization_id: entry.organization_id,
    p_requested_by_user_id: null,
    p_ip_hash: ipHash,
    p_turnstile_verified: turnstileVerified,
  });

  const result = data && typeof data === "object" ? (data as JsonRecord) : {};
  const errObject = result.error && typeof result.error === "object"
    ? (result.error as JsonRecord)
    : {};
  const errCode = asString(errObject.code);

  if (error || result.ok === false) {
    const message = asString(errObject.message) || error?.message || "request_failed";
    return json(
      mapRpcErrorToStatus(errCode || "request_failed"),
      {
        ok: false,
        error: {
          code: errCode || "request_failed",
          message,
        },
      },
      cors.headers,
    );
  }

  return json(
    200,
    {
      ok: true,
      id: asString(result.id),
      status: asString(result.status) || "pending",
      deduped: Boolean(result.deduped),
      dedupe_reason: result.deduped === true &&
          ["email", "phone", "employee_or_contractor_id"].includes(asString(result.dedupe_reason))
        ? asString(result.dedupe_reason)
        : "",
      application_status_token: asString(result.application_status_token),
    },
    cors.headers,
  );
});
