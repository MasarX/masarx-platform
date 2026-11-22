import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { decodeJwtPayload, logStructured, parseRequestBody, readEnv, toResponseBody } from "./_shared/mod.mjs";
import { selectRpcAuthAttempts } from "./rpc-auth.mjs";
import {
  LOCAL_MARKETING_TURNSTILE_TEST_SECRET,
  turnstileHostnameFailure,
  verifyMarketingTurnstile,
} from "./_shared/turnstile-local-test.mjs";

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
const MARKETING_DB_JWT = readEnv("MARKETING_DB_JWT");
const DB_JWT = MARKETING_DB_JWT
  ? { marketing: decodeJwtPayload(MARKETING_DB_JWT)?.role === "edge_marketing_role" ? MARKETING_DB_JWT : "" }
  : readEnv("API_GATEWAY_DB_JWT", ["EDGE_DB_JWT"]);

const TURNSTILE_SECRET_KEY = readEnv("MARKETING_TURNSTILE_SECRET_KEY", [
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SECRET",
]);

const MARKETING_CORS_ALLOW_ORIGINS = readEnv("MARKETING_CORS_ALLOW_ORIGINS", [
  "LANDING_CORS_ALLOW_ORIGINS",
]);

const MARKETING_IP_HASH_SALT = readEnv("MARKETING_IP_HASH_SALT");
const LOCAL_MARKETING_IP_HASH_SALT = "local-marketing-intake";
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
  if (typeof DB_JWT !== "string") {
    if (!DB_JWT.marketing) return [];
    const headers: Record<string, string> = { authorization: `Bearer ${DB_JWT.marketing}` };
    if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
    return [{ label: "marketing-db-jwt", headers }];
  }
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
  options: { serviceOnly?: boolean } = {},
): Promise<{ response: Response; body: unknown }> => {
  const attempts = selectRpcAuthAttempts(buildRpcAuthAttempts(), options.serviceOnly === true);
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
        "accept-profile": "api",
        "content-profile": "api",
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

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: MARKETING_CORS_ALLOW_ORIGINS,
  localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS"),
  localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1",
  allowedMethods: "GET, POST, OPTIONS",
});

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
  full_name?: unknown;
  website_url?: unknown;
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

  if ((typeof DB_JWT !== "string" && !DB_JWT.marketing) || (!MARKETING_DB_JWT && !cors.localContext)) {
    return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  }
  if (!MARKETING_DB_JWT) {
    console.warn("[marketing-lead-intake] using local database credential fallback");
  }

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
    } catch {
      logStructured("error", "marketing_lead_intake_failed", { stage: "clients_rpc" });
      return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
    }

    const rpcResponse = clientsRpc.response;
    const rpcBody = clientsRpc.body;
    if (!rpcResponse.ok) {
      logStructured("error", "marketing_lead_intake_failed", { stage: "clients_rpc" });
      return json(
        500,
        {
          ok: false,
          error: {
            code: "clients_rpc_failed",
            rpc_status: rpcResponse.status,
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
  } catch {
    logStructured("error", "marketing_lead_intake_failed", { stage: "parse_body" });
    return json(400, { ok: false, error: { code: "invalid_json" } }, cors.headers);
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
    return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  }
  const effectiveIpHashSalt =
    MARKETING_IP_HASH_SALT || (cors.localContext ? LOCAL_MARKETING_IP_HASH_SALT : "");
  if (!effectiveIpHashSalt) {
    return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  }
  const ipHash = await sha256Hex(`${effectiveIpHashSalt}:${clientIp}`);

  let turnstileVerified = false;
  const effectiveTurnstileSecret =
    TURNSTILE_SECRET_KEY || (cors.localContext ? LOCAL_MARKETING_TURNSTILE_TEST_SECRET : "");

  if (turnstileToken) {
    if (!effectiveTurnstileSecret) {
      return json(500, { ok: false, error: { code: "turnstile_secret_missing" } }, cors.headers);
    }
    try {
      const res = await verifyMarketingTurnstile({
        token: turnstileToken,
        secret: effectiveTurnstileSecret,
        localContext: cors.localContext,
        requestHostname: requestUrl.hostname,
        clientIp,
      });
      if (res.success && turnstileHostnameFailure(res.hostname, origin)) {
        return json(400, { ok: false, error: { code: "turnstile_invalid" } }, cors.headers);
      }
      turnstileVerified = res.success;
    } catch {
      return json(502, { ok: false, error: { code: "turnstile_verify_failed" } }, cors.headers);
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
      p_marketing: {
        ...marketing,
        ...(asString(payload?.full_name) ? { full_name: asString(payload.full_name) } : {}),
        ...(asString(payload?.website_url) ? { website_url: asString(payload.website_url) } : {}),
      },
      p_ip_hash: ipHash || null,
      p_turnstile_verified: turnstileVerified,
    }, { serviceOnly: true });
  } catch {
    logStructured("error", "marketing_lead_intake_failed", { stage: "intake_rpc" });
    return json(500, { ok: false, error: { code: "server_misconfigured" } }, cors.headers);
  }

  const rpcResponse = leadRpc.response;
  const rpcBody = leadRpc.body;
  if (!rpcResponse.ok || !rpcBody) {
    logStructured("error", "marketing_lead_intake_failed", { stage: "intake_rpc" });
    return json(
      500,
      {
        ok: false,
        error: {
          code: "rpc_failed",
          rpc_status: rpcResponse.status,
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
      logStructured("error", "marketing_lead_intake_failed", { stage: "intake_rpc" });
      const status = mapRpcErrorToStatus(code);
      return json(
        status,
        { ok: false, error: code ? { code } : {} },
        cors.headers,
      );
    }

    return json(200, { ...(bodyObj as JsonRecord) }, cors.headers);
  }

  return json(200, { ok: true, result: rpcBody }, cors.headers);
});
