import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  asString,
  parseOriginAllowlist,
  type JsonRecord,
} from "./_shared/marketplace_signup.ts";

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
const DRIVER_SIGNUP_RPC_SCHEMA =
  readEnv("DRIVER_SIGNUP_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

const CORS_ALLOWLIST = parseOriginAllowlist(DRIVER_SIGNUP_CORS_ALLOW_ORIGINS);
const ALLOWED_ORIGINS = CORS_ALLOWLIST.origins;
const CORS_ALLOWLIST_CONFIGURED =
  ALLOWED_ORIGINS.size > 0 &&
  CORS_ALLOWLIST.invalid.length === 0;
const LOCAL_DRIVER_STATUS_ORIGINS = new Set([
  "http://127.0.0.1:3333",
  "http://localhost:3333",
  "http://192.0.2.10:3333",
  "http://rvzwwjlztwwisjthghnipgjr.example.invalid:3333",
]);

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const isLocalHostname = (value: string): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: native Mobile V2 Example Person needs explicit loopback detection.
  return normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "rvzwwjlztwwisjthghnipgjr.example.invalid" ||
    normalized === "192.0.2.10";
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

const isLocalOrigin = (origin: string): boolean => {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
};

type CorsResult =
  | { ok: true; origin: string; headers: HeadersInit }
  | {
      ok: false;
      origin: string;
      status: number;
      body: JsonRecord;
      headers: HeadersInit;
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

const buildCorsHeaders = (req: Request): CorsResult => {
  const originRaw = req.headers.get("origin")?.trim() ?? "";
  const origin = normalizeOrigin(originRaw);
  const requestIsLocal = isLocalRequest(req);
  const localOriginAllowed = requestIsLocal && Boolean(origin && isLocalOrigin(origin));
  const effectiveOrigins = CORS_ALLOWLIST_CONFIGURED
    ? ALLOWED_ORIGINS
    : (requestIsLocal ? LOCAL_DRIVER_STATUS_ORIGINS : new Set<string>());
  const effectiveConfigured = effectiveOrigins.size > 0;

  const baseHeaders = {
    "Access-Control-Allow-Headers": "accept, content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    };
  }

  if (!effectiveOrigins.has(origin) && !localOriginAllowed) {
    return {
      ok: false,
      origin,
      status: 403,
      body: { ok: false, error: { code: "origin_not_allowed" } },
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": "null",
      },
    };
  }

  return {
    ok: true,
    origin,
    headers: {
      ...baseHeaders,
      "Access-Control-Allow-Origin": origin,
    },
  };
};

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

async function readStatusToken(req: Request): Promise<string> {
  if (req.method === "GET") {
    const token = new URL(req.url).searchParams.get("token");
    return asString(token);
  }

  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new Error("unsupported_content_type");
  }

  const parsed = await parseRequestBody(req);
  const payload = parsed.json as Record<string, unknown> | null;
  return asString(payload?.token) || asString(payload?.status_token);
}

serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    if (!cors.ok) return json(cors.status, cors.body, cors.headers);
    return new Response(null, { status: 204, headers: cors.headers });
  }

  if (!cors.ok) return json(cors.status, cors.body, cors.headers);

  if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors.headers);
  }

  let statusToken = "";
  try {
    statusToken = await readStatusToken(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_request";
    const code = message === "unsupported_content_type" ? "unsupported_content_type" : "invalid_json";
    const status = code === "unsupported_content_type" ? 415 : 400;
    return json(status, { ok: false, error: { code, message } }, cors.headers);
  }

  if (!uuidRegex.test(statusToken)) {
    return json(400, { ok: false, error: { code: "invalid_status_token" } }, cors.headers);
  }

  let serviceClient;
  try {
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  const { data, error } = await serviceClient.rpc("driver_application_status_lookup_v1", {
    p_status_token: statusToken,
  });

  const result = data && typeof data === "object" ? (data as JsonRecord) : {};
  const errObject = result.error && typeof result.error === "object"
    ? (result.error as JsonRecord)
    : {};
  const errCode = asString(errObject.code) || asString(error?.message);

  if (error || result.ok === false) {
    const notFound = errCode === "request_not_found";
    return json(
      notFound ? 404 : 400,
      {
        ok: false,
        error: {
          code: errCode || "request_failed",
          message: asString(errObject.message) || error?.message || "request_failed",
        },
      },
      cors.headers,
    );
  }

  return json(
    200,
    {
      ok: true,
      status: asString(result.status) || "pending",
      application_state: asString(result.application_state) || "pending_review",
      participant_type_key: asString(result.participant_type_key),
      review_decision: asString(result.review_decision),
      reviewed_at: asString(result.reviewed_at),
      invite_email_sent_at: asString(result.invite_email_sent_at),
      invite_redirect_to: asString(result.invite_redirect_to),
      review_reason: asString(result.review_reason),
      requested_documents: Array.isArray(result.requested_documents) ? result.requested_documents : [],
      profile_handoff:
        result.profile_handoff && typeof result.profile_handoff === "object" && !Array.isArray(result.profile_handoff)
          ? result.profile_handoff as JsonRecord
          : {},
    },
    cors.headers,
  );
});
