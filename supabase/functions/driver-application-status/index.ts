import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { logStructured, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import {
  asString,
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

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: DRIVER_SIGNUP_CORS_ALLOW_ORIGINS,
  localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS"),
  localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1",
  allowedMethods: "GET, POST, OPTIONS",
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

Deno.serve(async (req: Request): Promise<Response> => {
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
    return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  }

  const { data, error } = await serviceClient.rpc("marketplace_application_status_by_token_v1", {
    p_status_token: statusToken,
  });

  const result = data && typeof data === "object" ? (data as JsonRecord) : {};
  const errObject = result.error && typeof result.error === "object"
    ? (result.error as JsonRecord)
    : {};
  const errCode = asString(errObject.code);

  if (error || result.ok !== true || !["pending", "approved", "rejected", "withdrawn"].includes(asString(result.status))) {
    const notFound = errCode === "request_not_found";
    // Never pass RPC messages/details, input tokens, or returned payloads to logs.
    const knownCodes = new Set(["42501", "42883", "42P01", "42703", "22P02", "25006", "57014",
      "PGRST202", "PGRST203", "PGRST301", "PGRST302"]);
    logStructured("error", "driver_application_status_readback_failed", {
      service: "driver-application-status",
      failure_category: error ? "rpc_error" : "result_contract",
      rpc_error_code: error && knownCodes.has(asString(error.code)) ? asString(error.code) : "unclassified",
      result_shape: data === null || data === undefined ? "absent"
        : Array.isArray(data) ? "array" : typeof data === "object" ? "object" : "scalar",
      result_ok: result.ok === true,
      status_allowed: ["pending", "approved", "rejected", "withdrawn"].includes(asString(result.status)),
      request_not_found: notFound,
    });
    return json(
      notFound ? 404 : 400,
      {
        ok: false,
        error: {
          code: notFound ? "request_not_found" : "request_failed",
        },
      },
      cors.headers,
    );
  }

  return json(
    200,
    {
      ok: true,
      status: asString(result.status),
      application_state: asString(result.application_state),
      document_review_revision: Number.isSafeInteger(result.document_review_revision) && Number(result.document_review_revision) >= 0 ? result.document_review_revision : null,
      document_return_attempt: result.document_return_attempt && typeof result.document_return_attempt === "object"
        && (result.document_return_attempt as JsonRecord).state === "reserved"
        && uuidRegex.test(asString((result.document_return_attempt as JsonRecord).retry_key)) ? {
          state: "reserved", retry_key: asString((result.document_return_attempt as JsonRecord).retry_key),
        } : null,
      participant_type_key: asString(result.participant_type_key),
      review_decision: asString(result.review_decision),
      reviewed_at: asString(result.reviewed_at),
      invite_email_sent_at: asString(result.invite_email_sent_at),
      review_reason: asString(result.review_reason),
      requested_documents: Array.isArray(result.requested_documents) ? result.requested_documents.filter(
        (type: unknown) => typeof type === "string" && type.length > 0 && type.length <= 100,
      ) : [],
      submitted_document_count: Number.isInteger(result.submitted_document_count) && Number(result.submitted_document_count) >= 0 ? result.submitted_document_count : 0,
      missing_document_count: Number.isInteger(result.missing_document_count) && Number(result.missing_document_count) >= 0 ? result.missing_document_count : 0,
      profile_handoff: result.profile_handoff && typeof result.profile_handoff === "object" ? {
        ready: (result.profile_handoff as JsonRecord).ready === true,
        fleet_handoff_ready: (result.profile_handoff as JsonRecord).fleet_handoff_ready === true,
      } : { ready: false, fleet_handoff_ready: false },
    },
    cors.headers,
  );
});
