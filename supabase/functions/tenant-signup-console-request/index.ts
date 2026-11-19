import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import { asString, sha256Hex, type JsonRecord } from "./_shared/tenant_signup.ts";

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
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

const isJwtLike = (value: string): boolean =>
  String(value || "").trim().split(".").length === 3;

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "x-client-info": "console-v2-tenant-signup-console-request",
      },
    },
    accessToken: async () => token,
  });
};

const createServiceClient = () => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }
  const apiKeyHeader = isJwtLike(serviceKey) ? (anonKey || serviceKey) : serviceKey;
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        apikey: apiKeyHeader,
        "x-client-info": "console-v2-tenant-signup-console-request",
      },
    },
  });
};

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
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

  let payload: JsonRecord;
  try {
    payload = (await parseRequestBody(req)).json as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors);
  }

  const email = asString(payload.email).toLowerCase();
  const fullName = asString(payload.full_name);
  const organizationName = asString(payload.organization_name);
  const organizationSlug = asString(payload.organization_slug);
  const websiteUrl = asString(payload.website_url);
  const phone = asString(payload.phone);
  const notes = asString(payload.notes);
  const locale = asString(payload.locale);
  const origin = asString(req.headers.get("origin") || "");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { ok: false, error: { code: "invalid_email" } }, cors);
  }
  if (!fullName) {
    return json(400, { ok: false, error: { code: "full_name_required" } }, cors);
  }
  if (!organizationName) {
    return json(400, { ok: false, error: { code: "organization_required" } }, cors);
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

  const { data: guardData, error: guardError } = await userClient.rpc("tenant_signup_assert_reviewer_v1");
  if (guardError) {
    return json(403, {
      ok: false,
      error: { code: "tenant_signup_console_request_forbidden", message: guardError.message },
    }, cors);
  }

  const guard = guardData && typeof guardData === "object" ? guardData as JsonRecord : {};
  const actorUserId = asString(guard.user_id);
  const ipHash = await sha256Hex(`console:${actorUserId}:${email}`);
  const marketing = payload.marketing && typeof payload.marketing === "object" && !Array.isArray(payload.marketing)
    ? payload.marketing as JsonRecord
    : {};

  const { data, error } = await serviceClient.rpc("tenant_signup_request_create_v1", {
    p_email: email,
    p_full_name: fullName,
    p_organization_name: organizationName,
    p_organization_slug: organizationSlug || null,
    p_website_url: websiteUrl || null,
    p_phone: phone || null,
    p_notes: notes || null,
    p_locale: locale || null,
    p_page_url: origin || null,
    p_referrer: "console-v2",
    p_origin: origin || null,
    p_marketing: {
      ...marketing,
      source: "console-v2",
      created_by_user_id: actorUserId || null,
    },
    p_ip_hash: ipHash,
    p_turnstile_verified: true,
  });
  if (error) {
    return json(500, { ok: false, error: { code: "rpc_failed", message: error.message } }, cors);
  }

  const result = data && typeof data === "object" ? data as JsonRecord : {};
  const errorObj = result.error && typeof result.error === "object" ? result.error as JsonRecord : {};
  if (result.ok === false) {
    const code = asString(errorObj.code) || "tenant_signup_request_failed";
    const status = code === "rate_limited" ? 429 : code === "domain_not_allowed" || code === "domain_blocked" ? 403 : 400;
    return json(status, result, cors);
  }

  return json(200, { ok: true, result }, cors);
});
