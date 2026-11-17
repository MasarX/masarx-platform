import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { parseRequestBody, readEnv } from "./_shared/mod.mjs";

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
  const usedTestingKey = Boolean(
    data &&
      typeof data === "object" &&
      (data as any).metadata &&
      typeof (data as any).metadata === "object" &&
      (data as any).metadata.result_with_testing_key === true,
  );
  return { success, hostname, errorCodes, usedTestingKey };
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

const pathAction = (pathname: string): "lookup" | "verify" | "session" | "request" | "" => {
  const normalized = pathname.replace(/\/+$/g, "");
  if (normalized.endsWith("/lookup")) return "lookup";
  if (normalized.endsWith("/verify")) return "verify";
  if (normalized.endsWith("/session")) return "session";
  if (normalized.endsWith("/request")) return "request";
  return "";
};

const routeRequiresTurnstile = (action: string) => action === "lookup" || action === "verify";
const TRACKING_RPC_BY_ACTION: Record<string, string> = {
  lookup: "public_tracking_lookup_v1",
  verify: "public_tracking_verify_v1",
  session: "public_tracking_session_v1",
  request: "public_tracking_submit_request_v2",
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

  const action = pathAction(new URL(req.url).pathname);
  if (!action) {
    return json(404, { ok: false, error: { code: "not_found" } }, cors.headers);
  }

  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json(415, { ok: false, error: { code: "unsupported_content_type" } }, cors.headers);
  }

  let payload: JsonRecord;
  try {
    payload = (await parseRequestBody(req)).json as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors.headers);
  }

  let serviceClient;
  try {
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  const effectiveIpHashSalt =
    TRACKING_IP_HASH_SALT || (cors.localContext ? LOCAL_TRACKING_IP_HASH_SALT : "");
  // objectives:allow LOCALHOST Justification: local-only fallback client IP is required when loopback QA requests omit forwarded IP headers.
  const clientIp = readClientIp(req) || (cors.localContext ? "127.0.0.1" : "");
  if (!clientIp || !effectiveIpHashSalt) {
    return json(
      500,
      { ok: false, error: { code: "server_misconfigured", message: "ip_hash_prerequisites_missing" } },
      cors.headers,
    );
  }

  const ipHash = await sha256Hex(`${effectiveIpHashSalt}:${clientIp}`);
  const turnstileToken = asString(payload.turnstile_token);
  let turnstileVerified = false;
  let turnstileErrorCodes: unknown = null;

  if (routeRequiresTurnstile(action)) {
    if (!turnstileToken) {
      return json(400, { ok: false, error: { code: "turnstile_required" } }, cors.headers);
    }

    try {
      const turnstileResult = await verifyTurnstile(turnstileToken, cors.localContext, clientIp);
      turnstileVerified = turnstileResult.success;
      turnstileErrorCodes = turnstileResult.errorCodes;

      if (turnstileResult.success && turnstileResult.hostname && !turnstileResult.usedTestingKey) {
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

    if (!turnstileVerified) {
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
    return json(
      500,
      {
        ok: false,
        error: {
          code: "rpc_failed",
          message: rpcError.message,
          rpc: rpcName,
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

  return json(
    200,
    {
      ...rpcBody,
      turnstile_error_codes: turnstileErrorCodes,
    },
    cors.headers,
  );
});
