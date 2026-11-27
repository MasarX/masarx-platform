import { isTurnstileTestSecret, sanitizeTurnstileErrorCodes, turnstileHostnameFailure } from "./_shared/turnstile-local-test.mjs";
import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { classifyError, databaseErrorCodeForLog, logStructured, parseRequestBody, readEnv } from "./_shared/mod.mjs";

import { serveTrackingProof } from "./proof.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);

const TRACKING_CORS_ALLOW_ORIGINS = readEnv("PUBLIC_TRACKING_CORS_ALLOW_ORIGINS", [
  "TRACKING_CORS_ALLOW_ORIGINS",
  "MARKETING_CORS_ALLOW_ORIGINS",
  "LANDING_CORS_ALLOW_ORIGINS",
]);
const TRACKING_TURNSTILE_SECRET_KEY = readEnv("PUBLIC_TRACKING_TURNSTILE_SECRET_KEY", [
  "TRACKING_TURNSTILE_SECRET_KEY",
  "MARKETING_TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET",
]);
const TRACKING_IP_HASH_SALT = readEnv("PUBLIC_TRACKING_IP_HASH_SALT", [
  "TRACKING_IP_HASH_SALT",
  "MARKETING_IP_HASH_SALT",
]);
const TRACKING_RPC_SCHEMA =
  readEnv("PUBLIC_TRACKING_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";
const LOCAL_TRACKING_TURNSTILE_SECRET_KEY = "EXAMPLE_PASSWORD";
const LOCAL_TRACKING_TURNSTILE_TEST_TOKEN = "1x00000000000000000000AA";
const LEGACY_LOCAL_TRACKING_TURNSTILE_SECRET_KEY = "local-dev-turnstile-secret";
const LOCAL_TRACKING_IP_HASH_SALT = "local-public-tracking";

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;
const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

const mapRpcErrorToStatus = (code: string): number => {
  switch (code) {
    case "rate_limited":
      return 429;
    case "changes_closed":
      return 409;
    case "disabled":
      return 503;
    case "invalid_session":
      return 401;
    case "invalid_reference":
    case "invalid_request":
    case "verification_failed":
    case "turnstile_required":
    case "turnstile_invalid":
      return 400;
    default:
      return 400;
  }
};

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: TRACKING_CORS_ALLOW_ORIGINS,
  localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS"),
  localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1",
  allowedMethods: "POST, OPTIONS",
});

const readClientIp = (req: Request): string => {
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-forwarded-for"),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  for (const headerValue of candidates) {
    const first = headerValue.split(",")[0]?.trim() ?? "";
    if (first) return first;
  }

  return "";
};

const decodeHex = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const sha256Hex = async (value: string): Promise<string> => {
  const input = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return decodeHex(hash);
};

const verifyTurnstile = async (
  token: string,
  localContext: boolean,
  clientIp?: string,
): Promise<{ success: boolean; hostname: string; errorCodes: unknown; usedTestingKey: boolean }> => {
  const secret =
    TRACKING_TURNSTILE_SECRET_KEY || (localContext ? LOCAL_TRACKING_TURNSTILE_SECRET_KEY : "");
  if (!secret) {
    return { success: false, hostname: "", errorCodes: ["missing_turnstile_secret"], usedTestingKey: false };
  }
  if (localContext && secret === LOCAL_TRACKING_TURNSTILE_SECRET_KEY) {
    const success = token === LOCAL_TRACKING_TURNSTILE_TEST_TOKEN;
    return { success, hostname: "", errorCodes: success ? null : ["invalid-input-response"], usedTestingKey: true };
  }
  if (localContext && secret === LEGACY_LOCAL_TRACKING_TURNSTILE_SECRET_KEY && token === "EXAMPLE_PASSWORD") {
    return { success: true, hostname: "", errorCodes: null, usedTestingKey: true };
  }

  if (!localContext && isTurnstileTestSecret(secret)) {
    throw new Error("turnstile_testing_key_refused");
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

  const data = response.ok ? await response.json().catch(() => null) : null;
  const success = Boolean(data && typeof data === "object" && (data as any).success === true);
  const hostname = typeof data?.hostname === "string" ? data.hostname.trim() : "";
  const errorCodes = data && typeof data === "object" ? (data as any)["error-codes"] ?? null : null;
  const usedTestingKey = Boolean(
    data &&
      typeof data === "object" &&
      (data as any).metadata &&
      typeof (data as any).metadata === "object" &&
      (data as any).metadata.result_with_testing_key === true,
  );
  if (!localContext && usedTestingKey) {
    throw new Error("turnstile_testing_key_refused");
  }
  return { success, hostname, errorCodes, usedTestingKey: false };
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
      schema: TRACKING_RPC_SCHEMA,
    },
    global: {
      headers: {
        apikey: apiKeyHeader,
      },
    },
  });
};

const pathAction = (pathname: string): "lookup" | "verify" | "session" | "request" | "options" | "" => {
  const normalized = pathname.replace(/\/+$/g, "");
  if (normalized.endsWith("/lookup")) return "lookup";
  if (normalized.endsWith("/verify")) return "verify";
  if (normalized.endsWith("/session")) return "session";
  if (normalized.endsWith("/request")) return "request";
  if (normalized.endsWith("/options")) return "options";
  return "";
};

const routeRequiresTurnstile = (action: string) => action === "lookup" || action === "verify";
const TRACKING_RPC_BY_ACTION: Record<string, string> = {
  lookup: "public_tracking_lookup_v1",
  verify: "public_tracking_verify_v1",
  session: "public_tracking_session_v1",
  request: "public_tracking_submit_request_v2",
  options: "public_tracking_delivery_options_v1",
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

  const requestUrl = new URL(req.url);
  const action = pathAction(requestUrl.pathname);
  const isProof = /\/proof(?:\/file)?\/*$/.test(requestUrl.pathname);
  if (!action && !isProof) {
    return json(404, { ok: false, error: { code: "not_found" } }, cors.headers);
  }

  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json(415, { ok: false, error: { code: "unsupported_content_type" } }, cors.headers);
  }

  // objectives:allow LOCALHOST Justification: local-only fallback client IP is required when loopback QA requests omit forwarded IP headers.
  const clientIp = readClientIp(req) || (cors.localContext ? "127.0.0.1" : "");
  const sensitiveLogValues = [
    TRACKING_TURNSTILE_SECRET_KEY,
    LOCAL_TRACKING_TURNSTILE_SECRET_KEY,
    EDGE_SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_KEY,
  ];

  const redactLogText = (detail: unknown) => {
    let text = asString(detail);
    for (const value of sensitiveLogValues) {
      if (!value) continue;
      const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
      const jsonEncoded = JSON.stringify(value).slice(1, -1);
      for (const sensitive of [value, formEncoded, jsonEncoded]) {
        text = text.replaceAll(sensitive, "[redacted]");
      }
    }
    return text;
  };

  const reportInternalError = (status: number, code: string, detail: unknown, fields: JsonRecord = {}) => {
    const message = typeof detail === "object" && detail !== null && "message" in detail
      ? detail.message
      : detail;
    logStructured("error", "public_shipment_tracking_failed", {
      ...fields,
      service: "public-shipment-tracking",
      code,
      message: redactLogText(message) || code,
    });
    return json(status, { ok: false, error: { code } }, cors.headers);
  };

  const rejectTurnstile = (code: string, errorCodes: unknown) => {
    logStructured("warn", "public_shipment_tracking_turnstile_rejected", {
      service: "public-shipment-tracking",
      code,
      message: code,
      turnstile_error_codes: sanitizeTurnstileErrorCodes(errorCodes)?.map(redactLogText) ?? null,
    });
    return json(400, { ok: false, error: { code } }, cors.headers);
  };

  let payload: JsonRecord;
  try {
    payload = (await parseRequestBody(req)).json as JsonRecord;
  } catch {
    // Parser errors can quote the undecoded request body.
    return reportInternalError(400, "invalid_json", "Invalid JSON payload");
  }

  const turnstileToken = asString(payload.turnstile_token);
  if (clientIp) sensitiveLogValues.push(clientIp);
  sensitiveLogValues.push(
    ...[turnstileToken, asString(payload.session_token)].filter((value) => value.length >= 8),
  );

  let serviceClient;
  try {
    serviceClient = createServiceClient();
  } catch (error) {
    return reportInternalError(500, "server_misconfigured", error);
  }

  const effectiveIpHashSalt =
    TRACKING_IP_HASH_SALT || (cors.localContext ? LOCAL_TRACKING_IP_HASH_SALT : "");
  if (!clientIp || !effectiveIpHashSalt) {
    return reportInternalError(500, "server_misconfigured", "ip_hash_prerequisites_missing");
  }

  const ipHash = await sha256Hex(`${effectiveIpHashSalt}:${clientIp}`);
  if (isProof) {
    return serveTrackingProof(serviceClient, { ...payload, ip_hash: ipHash }, requestUrl, cors.headers, effectiveIpHashSalt);
  }

  let turnstileVerified = false;

  if (routeRequiresTurnstile(action)) {
    if (!turnstileToken) {
      return json(400, { ok: false, error: { code: "turnstile_required" } }, cors.headers);
    }

    try {
      const turnstileResult = await verifyTurnstile(turnstileToken, cors.localContext, clientIp);
      turnstileVerified = turnstileResult.success;

      // Only the exact local shortcuts can return usedTestingKey after CORS admission.
      if (turnstileResult.success && !turnstileResult.usedTestingKey &&
          turnstileHostnameFailure(turnstileResult.hostname, cors.origin)) {
        return rejectTurnstile("turnstile_invalid", turnstileResult.errorCodes);
      }
      if (!turnstileVerified) return rejectTurnstile("turnstile_required", turnstileResult.errorCodes);
    } catch (error) {
      return reportInternalError(502, "turnstile_verify_failed", error);
    }
  }

  const rpcName = TRACKING_RPC_BY_ACTION[action];
  if (!rpcName) {
    return json(404, { ok: false, error: { code: "not_found" } }, cors.headers);
  }
  const rpcPayload = {
    p_input: {
      ...payload,
      ip_hash: ipHash,
      origin: cors.origin || null,
      turnstile_verified: routeRequiresTurnstile(action) ? turnstileVerified : null,
    },
  };

  const { data: rpcData, error: rpcError } = await serviceClient.rpc(rpcName, rpcPayload);
  if (rpcError) {
    return reportInternalError(500, "rpc_failed", "rpc_failed", {
      rpc: rpcName,
      rpc_error_code: databaseErrorCodeForLog(rpcError.code) ?? "unclassified",
      error_type: classifyError(rpcError),
    });
  }

  const rpcBody = (rpcData && typeof rpcData === "object" ? rpcData : {}) as JsonRecord;
  if (rpcBody.ok === false) {
    const errorObj = (rpcBody.error && typeof rpcBody.error === "object" ? rpcBody.error : {}) as JsonRecord;
    const code = asString(errorObj.code);
    return json(
      mapRpcErrorToStatus(code),
      {
        ...rpcBody,
        turnstile_error_codes: null,
      },
      cors.headers,
    );
  }

  return json(
    200,
    {
      ...rpcBody,
      turnstile_error_codes: null,
    },
    cors.headers,
  );
});
