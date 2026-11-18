import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { authorizeEdgeRequest } from "./auth.mjs";
import { readEnv, normaliseHeaders, toResponseBody } from "./_shared/mod.mjs";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface CallRequest {
  url?: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_seconds?: number;
  job_id?: string;
  batch?: number;
  concurrency?: number;
}

interface CallResponse {
  status: number;
  completed: boolean;
  headers: Record<string, string>;
  body: unknown;
  latency_ms: number;
  error?: string;
}

type EgressPolicyEnvelope = {
  enforce?: boolean;
  managed_by?: string | null;
  organization_id?: string | null;
  policy?: Record<string, unknown> | null;
};

type EgressPolicy = {
  enforceHttpsOnly: boolean;
  httpAllowedHosts: string[];
  blockPrivateNetworks: boolean;
  domainAllowlist: string[];
  domainDenylist: string[];
  allowedMethods: string[];
  maxPayloadBytes: number;
  maxTimeoutSeconds: number;
  followRedirects: boolean;
  headerAllowlist: string[];
};

const textEncoder = new TextEncoder();

const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const RAW_EDGE_DB_JWT = readEnv("API_CALLER_DB_JWT", []);
const EDGE_DB_JWT = RAW_EDGE_DB_JWT && RAW_EDGE_DB_JWT.split(".").length === 3
  ? RAW_EDGE_DB_JWT
  : "";
if (RAW_EDGE_DB_JWT && !EDGE_DB_JWT) {
  console.warn("[api-caller] ignoring invalid API_CALLER_DB_JWT shape; expected JWT with 3 segments");
}
const EDGE_REQUIRE_DB_JWT = readEnv("EDGE_REQUIRE_DB_JWT", []) === "1";
let supabase = null as ReturnType<typeof createClient> | null;
if (SUPABASE_URL && SUPABASE_ANON_KEY && EDGE_DB_JWT) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: { schema: "api" },
    global: { headers: { Authorization: `Bearer ${EDGE_DB_JWT}` } },
  });
}

if (!supabase) {
  console.error(
    EDGE_REQUIRE_DB_JWT
      ? "api-caller missing API_CALLER_DB_JWT while EDGE_REQUIRE_DB_JWT=1"
      : "api-caller missing API_CALLER_DB_JWT; DB JWT is required for edge DB access",
  );
}

const parseRequest = async (req: Request): Promise<CallRequest> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Unsupported content type. Expected application/json.");
  }
  return (await req.json()) as CallRequest;
};

const encodeBase64 = (bytes: Uint8Array): string => {
  if (!bytes.length) return "";

  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(""));
};

const readUpstreamResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/xhtml") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("application/javascript");

  if (isJson || !contentType || isText) {
    return await toResponseBody(response);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  return {
    __edge_encoding: "base64",
    data: encodeBase64(buffer),
  };
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
};

const parseInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const candidate = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(candidate)) return fallback;
  const normalized = Math.floor(candidate);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
};

const parseStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
};

const defaultEgressPolicy = (): EgressPolicy => ({
  enforceHttpsOnly: true,
  httpAllowedHosts: [],
  blockPrivateNetworks: true,
  domainAllowlist: [],
  domainDenylist: [],
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  maxPayloadBytes: 262_144,
  maxTimeoutSeconds: 60,
  followRedirects: false,
  headerAllowlist: ["accept", "content-type", "authorization", "x-api-key", "api-key", "user-agent"],
});

const resolveEgressPolicy = (envelope: unknown): EgressPolicy | null => {
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as EgressPolicyEnvelope;
  if (!parseBoolean(record.enforce, false)) return null;

  const policySource = record.policy && typeof record.policy === "object" ? record.policy : {};
  const defaults = defaultEgressPolicy();

  return {
    enforceHttpsOnly: parseBoolean((policySource as any).enforce_https_only, defaults.enforceHttpsOnly),
    httpAllowedHosts: parseStringArray((policySource as any).http_allowed_hosts),
    blockPrivateNetworks: parseBoolean((policySource as any).block_private_networks, defaults.blockPrivateNetworks),
    domainAllowlist: parseStringArray((policySource as any).domain_allowlist),
    domainDenylist: parseStringArray((policySource as any).domain_denylist),
    allowedMethods: parseStringArray((policySource as any).allowed_methods).map((method) => method.toUpperCase()),
    maxPayloadBytes: parseInteger((policySource as any).max_payload_bytes, defaults.maxPayloadBytes, 1, 20_000_000),
    maxTimeoutSeconds: parseInteger((policySource as any).max_timeout_seconds, defaults.maxTimeoutSeconds, 1, 600),
    followRedirects: parseBoolean((policySource as any).follow_redirects, defaults.followRedirects),
    headerAllowlist: parseStringArray((policySource as any).header_allowlist),
  };
};

const isIpv4Literal = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

const toIpv4Octets = (host: string): number[] | null => {
  if (!isIpv4Literal(host)) return null;
  const octets = host.split(".").map((entry) => Number.parseInt(entry, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) return null;
  return octets;
};

const isPrivateIpv4 = (host: string): boolean => {
  const octets = toIpv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
};

const isPrivateIpv6 = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") ||
      normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
};

const isLocalHostName = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
};

const matchesDomainPattern = (host: string, pattern: string): boolean => {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    if (!suffix) return false;
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }

  return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
};

const resolveBodyForDispatch = (
  method: HttpMethod,
  body: unknown,
): { body: BodyInit | undefined; payloadBytes: number } => {
  if (["GET", "DELETE"].includes(method)) {
    return { body: undefined, payloadBytes: 0 };
  }

  if (body instanceof Uint8Array) {
    return { body, payloadBytes: body.byteLength };
  }

  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    return { body: bytes, payloadBytes: bytes.byteLength };
  }

  if (typeof body === "string") {
    return { body, payloadBytes: textEncoder.encode(body).byteLength };
  }

  const serialized = JSON.stringify(body ?? {});
  return {
    body: serialized,
    payloadBytes: textEncoder.encode(serialized).byteLength,
  };
};

const enforceEgressPolicy = (
  payload: CallRequest,
  method: HttpMethod,
  timeoutSeconds: number,
  payloadBytes: number,
  policy: EgressPolicy,
) => {
  if (!payload.url) {
    throw new Error("Missing url");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(payload.url);
  } catch (_err) {
    throw new Error(`Egress policy violation: invalid URL (${payload.url})`);
  }

  const host = parsedUrl.hostname.toLowerCase();
  const httpHostAllowed = policy.httpAllowedHosts.some((pattern) => matchesDomainPattern(host, pattern));
  if (policy.enforceHttpsOnly && parsedUrl.protocol.toLowerCase() !== "https:" && !httpHostAllowed) {
    throw new Error("Egress policy violation: only https:// targets are allowed");
  }

  if (policy.blockPrivateNetworks) {
    if (!httpHostAllowed && (isLocalHostName(host) || isPrivateIpv4(host) || isPrivateIpv6(host))) {
      throw new Error(`Egress policy violation: private or local network target blocked (${host})`);
    }
  }

  if (policy.domainDenylist.length > 0) {
    const denied = policy.domainDenylist.some((pattern) => matchesDomainPattern(host, pattern));
    if (denied) {
      throw new Error(`Egress policy violation: domain denied by policy (${host})`);
    }
  }

  if (policy.domainAllowlist.length > 0) {
    const allowed = policy.domainAllowlist.some((pattern) => matchesDomainPattern(host, pattern));
    if (!allowed) {
      throw new Error(`Egress policy violation: domain not present in allowlist (${host})`);
    }
  }

  if (policy.allowedMethods.length > 0 && !policy.allowedMethods.includes(method)) {
    throw new Error(`Egress policy violation: HTTP method ${method} is not allowed`);
  }

  if (timeoutSeconds > policy.maxTimeoutSeconds) {
    throw new Error(`Egress policy violation: timeout_seconds ${timeoutSeconds} exceeds limit ${policy.maxTimeoutSeconds}`);
  }

  if (payloadBytes > policy.maxPayloadBytes) {
    throw new Error(`Egress policy violation: payload size ${payloadBytes} exceeds limit ${policy.maxPayloadBytes}`);
  }

  if (policy.headerAllowlist.length > 0 && payload.headers) {
    for (const key of Object.keys(payload.headers)) {
      const normalized = key.trim().toLowerCase();
      if (!normalized) continue;
      if (!policy.headerAllowlist.includes(normalized)) {
        throw new Error(`Egress policy violation: header ${normalized} is not allowlisted`);
      }
    }
  }
};

const runFetch = async (
  payload: CallRequest,
  egressEnvelope?: EgressPolicyEnvelope | null,
): Promise<CallResponse> => {
  if (!payload.url) throw new Error("Missing url");
  const method = (payload.method ?? "POST").toUpperCase() as HttpMethod;
  const timeoutSeconds = Math.max(payload.timeout_seconds ?? 30, 1);
  const timeoutMs = timeoutSeconds * 1000;
  const requestBody = resolveBodyForDispatch(method, payload.body);
  const egressPolicy = resolveEgressPolicy(egressEnvelope ?? null);

  if (egressPolicy) {
    enforceEgressPolicy(payload, method, timeoutSeconds, requestBody.payloadBytes, egressPolicy);
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  const start = performance.now();
  let response: Response | null = null;
  try {
    response = await fetch(payload.url, {
      method,
      headers: payload.headers,
      body: requestBody.body,
      redirect: egressPolicy?.followRedirects ? "follow" : "manual",
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const latencyMs = Math.round(performance.now() - start);

  if (!response) {
    throw new Error("Fetch failed without a response");
  }

  return {
    status: response.status,
    completed: true,
    headers: normaliseHeaders(response.headers),
    body: await readUpstreamResponseBody(response),
    latency_ms: latencyMs,
  };
};

const ensureSupabase = () => {
  if (!supabase) {
    throw new Error(
      "Supabase client not initialised. Provide SUPABASE_URL, SUPABASE_ANON_KEY, and API_CALLER_DB_JWT.",
    );
  }
  return supabase;
};

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const num = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.floor(num);
  if (intVal < min) return min;
  if (intVal > max) return max;
  return intVal;
};

const getJobConcurrencyDefault = () => {
  const raw = readEnv("API_CALLER_JOB_CONCURRENCY", [
    "API_CALLER_CONCURRENCY",
    "EDGE_API_CALLER_CONCURRENCY",
  ]);
  return clampInt(raw, 5, 1, 25);
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await handler(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
};

const mergeDispatch = (spec: any, override?: CallRequest): CallRequest => {
  const mergedHeaders = {
    ...(spec?.headers ?? {}),
    ...(override?.headers ?? {}),
  };

  return {
    url: override?.url ?? spec?.url,
    method: ((override?.method ?? spec?.method ?? "POST") as HttpMethod),
    headers: Object.keys(mergedHeaders).length ? mergedHeaders : undefined,
    body: override?.body ?? spec?.body ?? {},
    timeout_seconds: override?.timeout_seconds ?? spec?.timeout_seconds ?? 30,
  };
};

const logApiCall = async (
  client: ReturnType<typeof createClient>,
  jobId: string,
  requestPayload: CallRequest,
  responsePayload: CallResponse,
  errorMessage?: string | null,
) => {
  await client.rpc("log_api_call_event", {
    p_job_id: jobId,
    p_request: {
      url: requestPayload.url ?? null,
      method: requestPayload.method ?? "POST",
      headers: requestPayload.headers ?? {},
      body: requestPayload.body ?? {},
      timeout_seconds: requestPayload.timeout_seconds ?? 30,
    },
    p_response: {
      headers: responsePayload.headers ?? {},
      body: responsePayload.body ?? null,
    },
    p_status: responsePayload.status,
    p_latency_ms: responsePayload.latency_ms,
    p_error: errorMessage ?? responsePayload.error ?? null,
  });
};

const resolveJobEgressPolicy = async (
  client: ReturnType<typeof createClient>,
  jobId: string,
): Promise<EgressPolicyEnvelope | null> => {
  const { data, error } = await client.rpc("resolve_effective_outbound_egress_policy_v1", {
    p_job_id: jobId,
  });

  if (error) {
    throw new Error(`resolve_effective_outbound_egress_policy_v1 failed: ${error.message}`);
  }

  if (!data || typeof data !== "object") {
    return null;
  }

  return data as EgressPolicyEnvelope;
};

const resolveJobEdgeTimeoutSeconds = async (
  client: ReturnType<typeof createClient>,
  jobId: string,
): Promise<number | null> => {
  const { data, error } = await client.rpc("get_outbound_edge_dispatch_timeout_v1", {
    p_job_id: jobId,
  });

  if (error) {
    console.warn(`[api-caller] get_outbound_edge_dispatch_timeout_v1 failed for ${jobId}: ${error.message}`);
    return null;
  }

  const timeoutSeconds = typeof data === "number" ? data : Number.parseInt(String(data ?? ""), 10);
  return Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : null;
};

const executeClaimedJob = async (
  jobId: string,
  dispatch: CallRequest,
  override?: CallRequest,
): Promise<{ job_id: string; result: CallResponse; success: boolean }> => {
  const client = ensureSupabase();
  const edgeTimeoutSeconds = override?.timeout_seconds === undefined
    ? await resolveJobEdgeTimeoutSeconds(client, jobId)
    : null;
  const effectiveOverride = edgeTimeoutSeconds
    ? { ...(override ?? {}), timeout_seconds: edgeTimeoutSeconds }
    : override;
  const mergedDispatch = mergeDispatch(dispatch, effectiveOverride);
  const egressEnvelope = await resolveJobEgressPolicy(client, jobId);

  let callResult: CallResponse;
  let dispatchError: string | undefined;

  try {
    callResult = await runFetch(mergedDispatch, egressEnvelope);
  } catch (err) {
    dispatchError = err instanceof Error ? err.message : "Unknown error";
    callResult = {
      status: 0,
      completed: false,
      headers: {},
      body: null,
      latency_ms: 0,
      error: dispatchError,
    };
  }

  const isSuccess = callResult.status >= 200 && callResult.status < 300;

  if (isSuccess) {
    await client.rpc("mark_outbound_call_success", {
      p_job_id: jobId,
      p_status_code: callResult.status,
      p_headers: callResult.headers,
      p_body: callResult.body,
      p_latency_ms: callResult.latency_ms,
    });
  } else {
    await client.rpc("mark_outbound_call_failure", {
      p_job_id: jobId,
      p_status_code: callResult.status,
      p_headers: callResult.headers,
      p_body: callResult.body,
      p_error: dispatchError ?? callResult.error ?? `HTTP ${callResult.status}`,
    });
  }

  await logApiCall(client, jobId, mergedDispatch, callResult, dispatchError);

  return { job_id: jobId, result: callResult, success: isSuccess };
};

const markCallSpecResolutionFailure = async (
  client: ReturnType<typeof ensureSupabase>,
  jobId: string,
  message: string,
): Promise<{ job_id: string; result: CallResponse; success: boolean }> => {
  const callResult: CallResponse = {
    status: 424,
    completed: false,
    headers: {},
    body: {
      error: message,
      reason: "call_spec_resolution_failed",
    },
    latency_ms: 0,
    error: message,
  };

  await client.rpc("mark_outbound_call_failure", {
    p_job_id: jobId,
    p_status_code: callResult.status,
    p_headers: callResult.headers,
    p_body: callResult.body,
    p_error: message,
  });

  return { job_id: jobId, result: callResult, success: false };
};

const executeJob = async (jobId: string, override?: CallRequest) => {
  const client = ensureSupabase();

  const { error: claimError } = await client.rpc("mark_outbound_call_in_progress", { p_job_id: jobId });
  if (claimError) {
    // If we cannot claim the job, treat it as a no-op to avoid duplicate sends.
    return {
      job_id: jobId,
      result: {
        status: 409,
        completed: false,
        headers: {},
        body: { error: claimError.message, reason: "job_not_claimable" },
        latency_ms: 0,
        error: claimError.message,
      },
      success: false,
    };
  }

  const { data: spec, error: specError } = await client.rpc("get_job_call_spec", {
    p_job_id: jobId,
  });
  if (specError || !spec) {
    return await markCallSpecResolutionFailure(
      client,
      jobId,
      `Failed to resolve call spec for job ${jobId}: ${specError?.message ?? "no data returned"}`,
    );
  }

  return await executeClaimedJob(jobId, spec as CallRequest, override);
};

const processBatch = async (batch: number, concurrency: number) => {
  const client = ensureSupabase();
  const { data, error } = await client.rpc("claim_pending_edge_jobs", {
    p_batch: batch,
  });
  if (error) {
    throw new Error(`claim_pending_edge_jobs failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return { jobs: [] };
  }

  const jobs = data as Array<{ job_id: string; dispatch: CallRequest }>;
  const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
    try {
      return await executeClaimedJob(job.job_id, job.dispatch);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        job_id: job.job_id,
        success: false,
        result: {
          status: 500,
          completed: false,
          headers: {},
          body: { error: message, reason: "api_caller_execute_failed" },
          latency_ms: 0,
          error: message,
        },
      };
    }
  });

  return { jobs: results };
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const auth = authorizeEdgeRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.message }), {
        status: auth.status,
        headers: { "content-type": "application/json" },
      });
    }

    const payload = await parseRequest(req);

    if (payload.batch && payload.batch > 0) {
      const concurrency = clampInt(payload.concurrency, getJobConcurrencyDefault(), 1, 25);
      const batchResult = await processBatch(Math.max(payload.batch, 1), concurrency);
      return new Response(JSON.stringify(batchResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (payload.job_id) {
      const dispatchResult = await executeJob(payload.job_id, payload);
      return new Response(JSON.stringify(dispatchResult), {
        status: dispatchResult.success ? 200 : 502,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      error: "Missing job_id or batch. Edge function processes queued jobs only.",
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const response: CallResponse = {
      status: 500,
      completed: false,
      headers: {},
      body: null,
      latency_ms: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
