import { parseRequestBody, readEnv, toResponseBody } from "./_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;
type LandingClientRow = {
  client_id?: unknown;
  display_name?: unknown;
  logo_url?: unknown;
  sort_order?: unknown;
  source?: unknown;
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
const RAW_DB_JWT = readEnv("MARKETING_DB_JWT", ["API_GATEWAY_DB_JWT", "EDGE_DB_JWT"]);
const DB_JWT = RAW_DB_JWT && RAW_DB_JWT.split(".").length === 3 ? RAW_DB_JWT : "";
if (RAW_DB_JWT && !DB_JWT) {
  console.warn(
    "[marketing-lead-intake] ignoring invalid MARKETING_DB_JWT shape; expected JWT with 3 segments",
  );
}

const TURNSTILE_SECRET_KEY = readEnv("MARKETING_TURNSTILE_SECRET_KEY", [
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET",
]);

const MARKETING_CORS_ALLOW_ORIGINS = readEnv("MARKETING_CORS_ALLOW_ORIGINS", [
  "LANDING_CORS_ALLOW_ORIGINS",
]);

const MARKETING_IP_HASH_SALT = readEnv("MARKETING_IP_HASH_SALT");
const LOCAL_MARKETING_TURNSTILE_SECRET_KEY = "EXAMPLE_PASSWORD";
const LOCAL_MARKETING_IP_HASH_SALT = "local-marketing-intake";
const LOCAL_MARKETING_ORIGINS = new Set([
  // objectives:allow LOCALHOST Justification: local browser QA for the marketing intake facade requires explicit loopback origins when no shared allowlist is configured.
  "http://127.0.0.1:3333", "http://localhost:3333", "http://127.0.0.1:3000", "http://localhost:3000",
]);

const isLocalHostname = (value: string): boolean => {
  const normalized = String(value || "").trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local-runtime detection must explicitly recognize loopback hosts for fail-closed dev fallback behavior.
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "rvzwwjlztwwisjthghnipgjr.example.invalid";
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

const parseOriginAllowlist = (
  raw: string,
): { origins: Set<string>; invalid: string[] } => {
  const invalid: string[] = [];
  const origins = new Set<string>();
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const normalized = normalizeOrigin(part);
    if (!normalized) invalid.push(part);
    else origins.add(normalized);
  }

  return { origins, invalid };
};

const CORS_ALLOW_ORIGINS_RAW = String(MARKETING_CORS_ALLOW_ORIGINS || "").trim();
const CORS_ALLOWLIST = parseOriginAllowlist(CORS_ALLOW_ORIGINS_RAW);
const ALLOWED_ORIGINS = CORS_ALLOWLIST.origins;
const CORS_ALLOWLIST_CONFIGURED =
  CORS_ALLOW_ORIGINS_RAW.length > 0 &&
  ALLOWED_ORIGINS.size > 0 &&
  CORS_ALLOWLIST.invalid.length === 0;

if (!SUPABASE_URL) console.error("[marketing-lead-intake] Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) console.error("[marketing-lead-intake] Missing SUPABASE_ANON_KEY");

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const extractRpcMessage = (body: unknown): string => {
  if (!body) return "";
  if (typeof body === "string") return body.trim();
  if (typeof body === "object") {
    const candidate = body as Record<string, unknown>;
    const message = candidate.message ?? candidate.error_description ?? candidate.error ?? "";
    return asString(message);
  }
  return "";
};

const isRetryableAuthError = (status: number, body: unknown): boolean => {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  const message = extractRpcMessage(body).toLowerCase();
  if (!message) return false;
  return (
    message.includes("no suitable key") ||
    message.includes("wrong key type") ||
    message.includes("no api key") ||
    message.includes("invalid signature") ||
    message.includes("jwt")
  );
};

type RpcAttempt = {
  label: string;
  headers: Record<string, string>;
};

const buildRpcAuthAttempts = (): RpcAttempt[] => {
  const attempts: RpcAttempt[] = [];
  const dedupe = new Set<string>();
  const dbJwt = isJwtLike(DB_JWT) ? DB_JWT : "";
  const serviceJwt = isJwtLike(SUPABASE_SERVICE_KEY) ? SUPABASE_SERVICE_KEY : "";
  const anonKey = asString(SUPABASE_ANON_KEY);
  const apiKeyCandidates = [anonKey, asString(EDGE_SUPABASE_SECRET_KEY), asString(SUPABASE_SERVICE_KEY)]
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
  const serviceKeysForApiKey = [asString(EDGE_SUPABASE_SECRET_KEY), asString(SUPABASE_SERVICE_KEY)]
    .filter((value, index, arr) => value && arr.indexOf(value) === index);

  const addAttempt = (label: string, headers: Record<string, string>) => {
    const signature = `${label}:${Object.entries(headers).sort().map(([k, v]) => `${k}=${v}`).join(";")}`;
    if (dedupe.has(signature)) return;
    dedupe.add(signature);
    attempts.push({ label, headers });
  };

  if (dbJwt) {
    addAttempt("db-jwt", {
      authorization: `Bearer ${dbJwt}`,
    });
    for (const apiKey of apiKeyCandidates) {
      addAttempt(`db-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {
        authorization: `Bearer ${dbJwt}`,
        apikey: apiKey,
      });
    }
  }

  if (serviceJwt) {
    addAttempt("service-jwt", {
      authorization: `Bearer ${serviceJwt}`,
    });
    for (const apiKey of apiKeyCandidates) {
      addAttempt(`service-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {
        authorization: `Bearer ${serviceJwt}`,
        apikey: apiKey,
      });
    }
  }

  for (const key of serviceKeysForApiKey) {
    if (isJwtLike(key)) continue;
    addAttempt("service-secret-bearer+apikey", {
      authorization: `Bearer ${key}`,
      apikey: key,
    });
    addAttempt("service-apikey", { apikey: key });
  }

  return attempts;
};

const invokeRpcWithAuthFallback = async (
  rpcName: string,
  payload: JsonRecord,
): Promise<{ response: Response; body: unknown }> => {
  const attempts = buildRpcAuthAttempts();
  if (!attempts.length) {
    throw new Error("missing_supabase_credentials");
  }

  let lastResponse: Response | null = null;
  let lastBody: unknown = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "tx=commit",
        ...attempt.headers,
      },
      body: JSON.stringify(payload),
    });
    const body = await toResponseBody(response);
    lastResponse = response;
    lastBody = body;

    if (response.ok) {
      return { response, body };
    }

    const hasMoreAttempts = index < attempts.length - 1;
    if (hasMoreAttempts && isRetryableAuthError(response.status, body)) {
      continue;
    }

    return { response, body };
  }

  return { response: lastResponse as Response, body: lastBody };
};

const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const mapRpcErrorToStatus = (code: string): number => {
  switch (code) {
    case "rate_limited":
      return 429;
    case "disabled":
      return 503;
    case "server_misconfigured":
      return 500;
    case "turnstile_required":
    case "invalid_email":
    case "email_required":
    case "company_required":
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

const buildCorsHeaders = (req: Request): CorsResult => {
  const originRaw = req.headers.get("origin")?.trim() ?? "";
  const origin = normalizeOrigin(originRaw);
  const localContext =
    isLocalRequest(req) ||
    Boolean(origin && LOCAL_MARKETING_ORIGINS.has(origin));
  const effectiveOrigins = CORS_ALLOWLIST_CONFIGURED
    ? ALLOWED_ORIGINS
    : (localContext ? LOCAL_MARKETING_ORIGINS : new Set<string>());
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

  if (!effectiveOrigins.has(origin)) {
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

const decodeHex = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const sha256Hex = async (value: string): Promise<string> => {
  const input = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return decodeHex(hash);
};

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

const verifyTurnstile = async (
  token: string,
  secret: string,
  clientIp?: string,
): Promise<{ success: boolean; hostname: string; errorCodes: unknown }> => {
  if (!secret) {
    return { success: false, hostname: "", errorCodes: ["missing_turnstile_secret"] };
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

const asOptionalUrl = (value: unknown): string | null => {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return null;
  }
  return null;
};

const mapLandingClients = (rows: unknown): Array<{ name: string; logo_url: string | null }> => {
  if (!Array.isArray(rows)) return [];
  const out: Array<{ name: string; logo_url: string | null }> = [];
  for (const row of rows as LandingClientRow[]) {
    const name = asString(row?.display_name);
    if (!name) continue;
    out.push({
      name,
      logo_url: asOptionalUrl(row?.logo_url),
    });
  }
  return out;
};

type IntakePayload = {
  email?: unknown;
  company?: unknown;
  organization_name?: unknown;
  organizationName?: unknown;
  volume?: unknown;
  role?: unknown;
  notes?: unknown;
  locale?: unknown;
  page_url?: unknown;
  referrer?: unknown;
  marketing?: unknown;
  turnstile_token?: unknown;
};

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);
  const requestUrl = new URL(req.url);
  const isClientsFeedRequest = requestUrl.pathname.endsWith("/clients");

  if (req.method === "OPTIONS") {
    if (!cors.ok) return json(cors.status, cors.body, cors.headers);
    return new Response(null, { status: 204, headers: cors.headers });
  }

  if (!cors.ok) return json(cors.status, cors.body, cors.headers);

  if (isClientsFeedRequest) {
    if (req.method !== "GET") {
      return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors.headers);
    }

    const locale = asString(requestUrl.searchParams.get("locale") ?? requestUrl.searchParams.get("lang"));
    let clientsRpc;
    try {
      clientsRpc = await invokeRpcWithAuthFallback("marketing_landing_clients_list_v1", {
        p_locale: locale || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
    }

    const rpcResponse = clientsRpc.response;
    const rpcBody = clientsRpc.body;
    if (!rpcResponse.ok) {
      const message = extractRpcMessage(rpcBody) || null;
      return json(
        500,
        {
          ok: false,
          error: {
            code: "clients_rpc_failed",
            rpc_status: rpcResponse.status,
            rpc_message: message ?? rpcResponse.statusText,
          },
        },
        cors.headers,
      );
    }

    const clients = mapLandingClients(rpcBody);
    return json(200, { ok: true, clients }, cors.headers);
  }

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
  } catch (e) {
    return json(400, { ok: false, error: { code: "invalid_json", message: e.message } }, cors.headers);
  }

  const email = asString(payload?.email);
  // Backward-compatible alias support for legacy landing payloads.
  const company = asString(payload?.company) || asString(payload?.organization_name) || asString(payload?.organizationName);
  const volume = asString(payload?.volume);
  const role = asString(payload?.role);
  const notes = asString(payload?.notes);
  const locale = asString(payload?.locale);
  const pageUrl = asString(payload?.page_url);
  const referrer = asString(payload?.referrer);
  const marketing = (payload?.marketing && typeof payload.marketing === "object" && !Array.isArray(payload.marketing))
    ? (payload.marketing as Record<string, unknown>)
    : {};
  const turnstileToken = asString(payload?.turnstile_token);

  if (!email) return json(400, { ok: false, error: { code: "email_required" } }, cors.headers);
  if (!company) return json(400, { ok: false, error: { code: "company_required" } }, cors.headers);

  const origin = cors.origin;
  // objectives:allow LOCALHOST Justification: local-only fallback client IP is required when Docker loopback strips forwarded IP headers during isolated QA.
  const clientIp = readClientIp(req) || (cors.localContext ? "127.0.0.1" : "");
  if (!clientIp) {
    return json(500, { ok: false, error: { code: "server_misconfigured", message: "client_ip_missing" } }, cors.headers);
  }
  const effectiveIpHashSalt =
    MARKETING_IP_HASH_SALT || (cors.localContext ? LOCAL_MARKETING_IP_HASH_SALT : "");
  if (!effectiveIpHashSalt) {
    return json(500, { ok: false, error: { code: "server_misconfigured", message: "ip_hash_salt_missing" } }, cors.headers);
  }
  const ipHash = await sha256Hex(`${effectiveIpHashSalt}:${clientIp}`);

  let turnstileVerified = false;
  let turnstileHostname = "";
  let turnstileErrorCodes: unknown = null;
  const effectiveTurnstileSecret =
    TURNSTILE_SECRET_KEY || (cors.localContext ? LOCAL_MARKETING_TURNSTILE_SECRET_KEY : "");

  if (turnstileToken) {
    if (!effectiveTurnstileSecret) {
      return json(500, { ok: false, error: { code: "turnstile_secret_missing" } }, cors.headers);
    }
    try {
      const res = await verifyTurnstile(turnstileToken, effectiveTurnstileSecret, clientIp);
      turnstileVerified = res.success;
      turnstileHostname = res.hostname;
      turnstileErrorCodes = res.errorCodes;
      if (turnstileVerified && turnstileHostname) {
        const expectedHost = (() => {
          try {
            return new URL(origin).hostname.toLowerCase();
          } catch {
            return "";
          }
        })();
        const actualHost = turnstileHostname.toLowerCase();
        if (expectedHost && actualHost && expectedHost !== actualHost) {
          return json(
            400,
            { ok: false, error: { code: "turnstile_invalid" }, turnstile_error_codes: turnstileErrorCodes },
            cors.headers,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json(502, { ok: false, error: { code: "turnstile_verify_failed", message } }, cors.headers);
    }
  }

  let leadRpc;
  try {
    // Lead intake creates internal follow-up tasks and must execute with service-capable auth.
    leadRpc = await invokeRpcWithAuthFallback("marketing_lead_request_create_v1", {
      p_email: email,
      p_company: company,
      p_volume: volume || null,
      p_role: role || null,
      p_notes: notes || null,
      p_locale: locale || null,
      p_page_url: pageUrl || null,
      p_referrer: referrer || null,
      p_origin: origin || null,
      p_marketing: marketing,
      p_ip_hash: ipHash || null,
      p_turnstile_verified: turnstileVerified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors.headers);
  }

  const rpcResponse = leadRpc.response;
  const rpcBody = leadRpc.body;
  if (!rpcResponse.ok || !rpcBody) {
    const message = extractRpcMessage(rpcBody) || null;
    return json(
      500,
      {
        ok: false,
        error: {
          code: "rpc_failed",
          rpc_status: rpcResponse.status,
          rpc_message: message ?? rpcResponse.statusText,
          turnstile_error_codes: turnstileErrorCodes,
        },
      },
      cors.headers,
    );
  }

  if (typeof rpcBody === "object" && rpcBody !== null) {
    const bodyObj = rpcBody as JsonRecord;
    const ok = bodyObj.ok;
    if (ok === false) {
      const err = bodyObj.error;
      const code = err && typeof err === "object" && "code" in err ? asString((err as any).code) : "";
      const status = mapRpcErrorToStatus(code);
      return json(
        status,
        { ...(bodyObj as JsonRecord), turnstile_error_codes: turnstileErrorCodes },
        cors.headers,
      );
    }

    return json(200, { ...(bodyObj as JsonRecord), turnstile_error_codes: turnstileErrorCodes }, cors.headers);
  }

  return json(200, { ok: true, result: rpcBody, turnstile_error_codes: turnstileErrorCodes }, cors.headers);
});
