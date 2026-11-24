import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { authorizeApiCallerOperation, authorizeEdgeRequest } from "./auth.mjs";
import { executeBoundedEgress } from "./egress.mjs";
import { createGuardedProxyFetch } from "./proxy.mjs";
import { authorizeRendererSend, RENDERER_TOKEN_HEADER } from "./renderer-auth.mjs";
import {
  buildCompactBatchResponse,
  compactBatchJobResult,
  InvocationValidationError,
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_SIZE,
  mergeServerDispatch,
  validateInvocationPayload,
} from "./invocation.mjs";
import { readEnv, normaliseHeaders, toResponseBody } from "./_shared/mod.mjs";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface CallRequest {
  url?: string;
  renderer_credential_ref?: string;
  http_allowed_host?: string;
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
  blockPrivateNetworks: boolean;
  domainAllowlist: string[];
  domainDenylist: string[];
  allowedMethods: string[];
  maxPayloadBytes: number;
  maxTimeoutSeconds: number;
  followRedirects: boolean;
  headerAllowlist: string[];
  transportMode: "direct_trusted_host" | "guarded_proxy";
  maxRedirects: number;
  maxResponseBytes: number;
};

type DenoNetworkRuntime = {
  resolveDns?: (
    hostname: string,
    recordType: "A" | "AAAA",
    options?: { signal?: AbortSignal },
  ) => Promise<string[]>;
  createHttpClient?: (options: {
    proxy: {
      url: string;
      basicAuth?: { username: string; password: string };
    };
  }) => unknown;
};

const denoNetwork = Deno as unknown as DenoNetworkRuntime;

const textEncoder = new TextEncoder();

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const RENDERER_ENDPOINT = readEnv("LABEL_RENDERER_INVOKE_URL") ||
  `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/label-renderer`;
const LOCAL_RENDERER_ENDPOINT = readEnv("EDGE_ENVIRONMENT") === "local" && RENDERER_ENDPOINT.startsWith("http://")
  ? RENDERER_ENDPOINT
  : undefined;
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const RAW_EDGE_DB_JWT = readEnv("API_CALLER_DB_JWT", []);
const EDGE_DB_JWT = RAW_EDGE_DB_JWT && RAW_EDGE_DB_JWT.split(".").length === 3
  ? RAW_EDGE_DB_JWT
  : "";
if (RAW_EDGE_DB_JWT && !EDGE_DB_JWT) {
  console.warn("[api-caller] ignoring invalid API_CALLER_DB_JWT shape; expected JWT with 3 segments");
}
const EDGE_REQUIRE_DB_JWT = readEnv("EDGE_REQUIRE_DB_JWT", []) === "1";
const GUARDED_EGRESS_PROXY_ENV = {
  url: "API_CALLER_GUARDED_EGRESS_PROXY_URL",
  username: "API_CALLER_GUARDED_EGRESS_PROXY_USERNAME",
  password: "API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD",
};
const GUARDED_EGRESS_PROXY_URL = readEnv(GUARDED_EGRESS_PROXY_ENV.url, []);
const GUARDED_EGRESS_PROXY_USERNAME = readEnv(GUARDED_EGRESS_PROXY_ENV.username, []);
const GUARDED_EGRESS_PROXY_PASSWORD = readEnv(GUARDED_EGRESS_PROXY_ENV.password, []);
const ALLOW_DEV_DIRECT_EGRESS = Deno.env?.get("EDGE_ENVIRONMENT") === "dev" &&
  Object.values(GUARDED_EGRESS_PROXY_ENV).every((key) => Deno.env.get(key) === undefined);
let supabase = null as ReturnType<typeof createClient> | null;
if (SUPABASE_URL && SUPABASE_ANON_KEY && EDGE_DB_JWT) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: { schema: "api" },
    global: {
      headers: {
        Authorization: `Bearer ${EDGE_DB_JWT}`,
        "x-masarx-renderer-transport": "1",
      },
    },
  });
}
if (!supabase) {
  console.error(
    EDGE_REQUIRE_DB_JWT
      ? "api-caller missing API_CALLER_DB_JWT while EDGE_REQUIRE_DB_JWT=1"
      : "api-caller missing API_CALLER_DB_JWT; DB JWT is required for edge DB access",
  );
}

const parseRequest = async (req: Request): Promise<unknown> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Unsupported content type. Expected application/json.");
  }
  return (await req.json()) as CallRequest;
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

const parsePolicyStringArray = (
  policySource: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] => Object.prototype.hasOwnProperty.call(policySource, key)
  ? parseStringArray(policySource[key])
  : [...fallback];

const defaultEgressPolicy = (): EgressPolicy => ({
  enforceHttpsOnly: true,
  blockPrivateNetworks: true,
  domainAllowlist: [],
  domainDenylist: [],
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  maxPayloadBytes: 262_144,
  maxTimeoutSeconds: 60,
  followRedirects: false,
  headerAllowlist: ["accept", "content-type", "authorization", "x-api-key", "api-key", "user-agent"],
  transportMode: "guarded_proxy",
  maxRedirects: 3,
  maxResponseBytes: 1_048_576,
});

const resolveEgressPolicy = (envelope: unknown): EgressPolicy | null => {
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as EgressPolicyEnvelope;
  if (!parseBoolean(record.enforce, false)) return null;

  const policySource = record.policy && typeof record.policy === "object" ? record.policy : {};
  const defaults = defaultEgressPolicy();
  const normalizedPolicySource = policySource as Record<string, unknown>;

  const requestedTransport = String((policySource as any).transport_mode ?? "").trim().toLowerCase();
  const transportMode = String(record.managed_by ?? "").trim().toLowerCase() === "integration_plugin"
    ? "guarded_proxy"
    : requestedTransport === "direct_trusted_host"
    ? "direct_trusted_host"
    : defaults.transportMode;

  return {
    enforceHttpsOnly: parseBoolean((policySource as any).enforce_https_only, defaults.enforceHttpsOnly),
    blockPrivateNetworks: parseBoolean((policySource as any).block_private_networks, defaults.blockPrivateNetworks),
    domainAllowlist: parsePolicyStringArray(normalizedPolicySource, "domain_allowlist", defaults.domainAllowlist),
    domainDenylist: parsePolicyStringArray(normalizedPolicySource, "domain_denylist", defaults.domainDenylist),
    allowedMethods: parsePolicyStringArray(normalizedPolicySource, "allowed_methods", defaults.allowedMethods)
      .map((method) => method.toUpperCase()),
    maxPayloadBytes: parseInteger((policySource as any).max_payload_bytes, defaults.maxPayloadBytes, 1, 20_000_000),
    maxTimeoutSeconds: parseInteger((policySource as any).max_timeout_seconds, defaults.maxTimeoutSeconds, 1, 600),
    followRedirects: parseBoolean((policySource as any).follow_redirects, defaults.followRedirects),
    headerAllowlist: parsePolicyStringArray(normalizedPolicySource, "header_allowlist", defaults.headerAllowlist),
    transportMode,
    maxRedirects: parseInteger((policySource as any).max_redirects, defaults.maxRedirects, 0, 10),
    maxResponseBytes: parseInteger(
      (policySource as any).max_response_bytes,
      defaults.maxResponseBytes,
      1,
      20_000_000,
    ),
  };
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

  if (!policy.allowedMethods.includes(method)) {
    throw new Error(`Egress policy violation: HTTP method ${method} is not allowed`);
  }

  if (timeoutSeconds > policy.maxTimeoutSeconds) {
    throw new Error(`Egress policy violation: timeout_seconds ${timeoutSeconds} exceeds limit ${policy.maxTimeoutSeconds}`);
  }

  if (payloadBytes > policy.maxPayloadBytes) {
    throw new Error(`Egress policy violation: payload size ${payloadBytes} exceeds limit ${policy.maxPayloadBytes}`);
  }

  if (payload.headers) {
    for (const key of Object.keys(payload.headers)) {
      const normalized = key.trim().toLowerCase();
      if (!normalized) continue;
      if (!policy.headerAllowlist.includes(normalized)) {
        throw new Error(`Egress policy violation: header ${normalized} is not allowlisted`);
      }
    }
  }
};

const resolveDnsForEgress = async (
  hostname: string,
  recordType: "A" | "AAAA",
  options: { signal?: AbortSignal } = {},
): Promise<string[]> => {
  if (typeof denoNetwork.resolveDns !== "function") {
    throw new Error("Deno.resolveDns is unavailable");
  }
  const resolveOptions = options.signal ? { signal: options.signal } : undefined;
  if (recordType === "A") {
    return await denoNetwork.resolveDns(hostname, "A", resolveOptions);
  }
  return await denoNetwork.resolveDns(hostname, "AAAA", resolveOptions);
};

const guardedProxyFetch = createGuardedProxyFetch({
  url: GUARDED_EGRESS_PROXY_URL,
  username: GUARDED_EGRESS_PROXY_USERNAME,
  password: GUARDED_EGRESS_PROXY_PASSWORD,
  createHttpClient: denoNetwork.createHttpClient,
  fetchImpl: fetch as (url: string, init: RequestInit & { client?: unknown }) => Promise<Response>,
});

const runFetch = async (
  payload: CallRequest,
  egressEnvelope?: EgressPolicyEnvelope | null,
  localRendererEndpoint?: string,
): Promise<CallResponse> => {
  if (!payload.url) throw new Error("Missing url");
  const method = (payload.method ?? "POST").toUpperCase() as HttpMethod;
  const supportedMethods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!supportedMethods.includes(method)) {
    throw new Error(`Egress policy violation: unsupported HTTP method ${method}`);
  }
  const timeoutSeconds = Math.max(payload.timeout_seconds ?? 30, 1);
  const timeoutMs = timeoutSeconds * 1000;
  const requestBody = resolveBodyForDispatch(method, payload.body);
  const egressPolicy = resolveEgressPolicy(egressEnvelope ?? null);

  if (!egressPolicy) {
    throw new Error("Egress policy violation: effective policy is missing or disabled");
  }
  enforceEgressPolicy(payload, method, timeoutSeconds, requestBody.payloadBytes, egressPolicy);

  return await executeBoundedEgress({
    url: payload.url,
    method,
    headers: payload.headers,
    body: requestBody.body,
    timeoutMs,
    policy: egressPolicy,
    httpAllowedHost: payload.http_allowed_host,
    localRendererEndpoint,
    resolveDns: resolveDnsForEgress,
    allowDevDirectEgress: ALLOW_DEV_DIRECT_EGRESS,
    guardedFetch: GUARDED_EGRESS_PROXY_URL || GUARDED_EGRESS_PROXY_USERNAME || GUARDED_EGRESS_PROXY_PASSWORD
      ? guardedProxyFetch
      : undefined,
  }) as CallResponse;
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
  return clampInt(raw, MAX_BATCH_CONCURRENCY, 1, MAX_BATCH_CONCURRENCY);
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

const renewClaimedLease = async (
  client: ReturnType<typeof createClient>,
  jobId: string,
  leaseToken: string,
) => {
  const { error } = await client.rpc("renew_claimed_edge_job_lease_v1", {
    p_job_id: jobId,
    p_lease_token: leaseToken,
  });
  if (error) {
    throw new Error(
      `renew_claimed_edge_job_lease_v1 failed for job ${jobId}: ${error.message}`,
    );
  }
};

const executeClaimedJob = async (
  jobId: string,
  dispatch: CallRequest,
  leaseToken: string,
  override?: CallRequest,
): Promise<{ job_id: string; result: CallResponse; success: boolean }> => {
  const client = ensureSupabase();
  const mergedDispatch = mergeServerDispatch(dispatch, override) as CallRequest;

  let callResult: CallResponse;
  let dispatchError: string | undefined;
  const isRenderer = typeof dispatch.renderer_credential_ref === "string";

  try {
    const egressEnvelope = isRenderer
      ? {
        enforce: true,
        policy: {
          transport_mode: "guarded_proxy",
          enforce_https_only: true,
          block_private_networks: true,
          domain_allowlist: [new URL(RENDERER_ENDPOINT).hostname],
          allowed_methods: ["POST"],
          header_allowlist: ["authorization", "content-type", RENDERER_TOKEN_HEADER],
          follow_redirects: false,
        },
      }
      : await resolveJobEgressPolicy(client, jobId);
    await renewClaimedLease(client, jobId, leaseToken);
    const sendDispatch = isRenderer
      ? await authorizeRendererSend(
        mergedDispatch,
        RENDERER_ENDPOINT,
        readEnv("LABEL_RENDERER_SIGNING_KEY"),
        readEnv("LABEL_RENDERER_GATEWAY_JWT"),
        LOCAL_RENDERER_ENDPOINT !== undefined,
      )
      : mergedDispatch;
    callResult = await runFetch(sendDispatch, egressEnvelope, isRenderer ? LOCAL_RENDERER_ENDPOINT : undefined);
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

  if (isRenderer && (callResult.status === 401 || callResult.status === 403)) {
    callResult = { ...callResult, error: "renderer_gateway_rejected" };
    console.error("[api-caller] renderer_gateway_rejected");
  }

  // Refresh again after the bounded network operation so even a near-600-second
  // call has a full ownership window for compare-and-swap finalization.
  await renewClaimedLease(client, jobId, leaseToken);

  const isSuccess = callResult.status >= 200 && callResult.status < 300;

  if (isSuccess) {
    const { error: successError } = await client.rpc("mark_claimed_edge_job_success_v1", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_status_code: callResult.status,
      p_headers: callResult.headers,
      p_body: callResult.body,
      p_latency_ms: callResult.latency_ms,
    });
    if (successError) {
      throw new Error(
        `mark_claimed_edge_job_success_v1 failed for job ${jobId}: ${successError.message}`,
      );
    }
  } else {
    const { error: failureError } = await client.rpc("mark_claimed_edge_job_failure_v1", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_status_code: callResult.status,
      p_headers: callResult.headers,
      p_body: callResult.body,
      p_error: dispatchError ?? callResult.error ?? `HTTP ${callResult.status}`,
      p_latency_ms: callResult.latency_ms,
    });
    if (failureError) {
      throw new Error(
        `mark_claimed_edge_job_failure_v1 failed for job ${jobId}: ${failureError.message}`,
      );
    }
  }

  return { job_id: jobId, result: callResult, success: isSuccess };
};

const executeJob = async (jobId: string, override?: CallRequest) => {
  const client = ensureSupabase();

  const { data, error: claimError } = await client.rpc("claim_edge_job_by_id_v1", {
    p_job_id: jobId,
  });
  if (claimError) {
    const expectedNonclaimable =
      claimError.code === "P0001" &&
      /^claim_edge_job_by_id_v1: outbound call [0-9a-f-]+ is not claimable$/i.test(
        String(claimError.message || ""),
      );
    if (!expectedNonclaimable) {
      throw new Error(
        `claim_edge_job_by_id_v1 failed: ${String(claimError.code || "unknown")}`,
      );
    }
    return {
      job_id: jobId,
      result: {
        status: 409,
        completed: false,
        headers: {},
        body: { reason: "job_not_claimable" },
        latency_ms: 0,
        error: "job_not_claimable",
      },
      success: false,
    };
  }

  const claim = (data as Array<{ job_id: string; lease_token: string }> | null)?.[0];
  if (!claim?.job_id || claim.job_id !== jobId || !claim.lease_token) {
    throw new Error(`claim_edge_job_by_id_v1 returned an invalid ownership envelope for job ${jobId}`);
  }

  return await executeClaimedJobById(jobId, claim.lease_token, override);
};

const executeClaimedJobById = async (
  jobId: string,
  leaseToken: string,
  override?: CallRequest,
) => {
  const client = ensureSupabase();
  const { data: spec, error: specError } = await client.rpc("get_claimed_edge_job_call_spec_v1", {
    p_job_id: jobId,
    p_lease_token: leaseToken,
  });
  if (specError) {
    throw new Error(
      `get_claimed_edge_job_call_spec_v1 failed for job ${jobId}: ${specError.message}`,
    );
  }
  if (!spec) {
    return {
      job_id: jobId,
      success: false,
      result: {
        status: 0,
        completed: false,
        latency_ms: 0,
        error: "job_spec_invalid",
      },
    };
  }
  return await executeClaimedJob(jobId, spec as CallRequest, leaseToken, override);
};

const processBatch = async (batch: number, concurrency: number) => {
  const client = ensureSupabase();
  if (concurrency !== 1) {
    throw new InvocationValidationError("Batch execution concurrency must remain one", 500);
  }

  const results = [];
  for (let index = 0; index < Math.min(batch, MAX_BATCH_SIZE); index += 1) {
    // Claim only when the sole worker is ready to execute. This prevents a later
    // job's lease clock from running while earlier network calls are in flight.
    const { data, error } = await client.rpc("claim_pending_edge_job_ids_v1", {
      p_batch: 1,
    });
    if (error) {
      throw new Error(`claim_pending_edge_job_ids_v1 failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    const job = (data as Array<{ job_id: string; lease_token: string }>)[0];
    if (!job?.job_id || !job?.lease_token) {
      throw new Error("claim_pending_edge_job_ids_v1 returned an invalid ownership envelope");
    }
    try {
      results.push(compactBatchJobResult(
        await executeClaimedJobById(job.job_id, job.lease_token),
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push(compactBatchJobResult({
        job_id: job.job_id,
        success: false,
        result: {
          status: 500,
          completed: false,
          latency_ms: 0,
          error: message,
        },
      }));
    }
  }

  return buildCompactBatchResponse(results);
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const auth = await authorizeEdgeRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.message }), {
        status: auth.status,
        headers: { "content-type": "application/json" },
      });
    }

    const invocation = validateInvocationPayload(await parseRequest(req));
    const operationAuth = authorizeApiCallerOperation(auth, invocation.operation);
    if (!operationAuth.ok) {
      return new Response(JSON.stringify({ error: operationAuth.message }), {
        status: operationAuth.status,
        headers: { "content-type": "application/json" },
      });
    }
    const payload = invocation.payload as CallRequest;

    if (invocation.operation === "batch" && payload.batch) {
      const concurrency = clampInt(
        payload.concurrency,
        getJobConcurrencyDefault(),
        1,
        MAX_BATCH_CONCURRENCY,
      );
      const batchResult = await processBatch(Math.min(payload.batch, MAX_BATCH_SIZE), concurrency);
      return new Response(JSON.stringify(batchResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (invocation.operation === "job" && payload.job_id) {
      const dispatchResult = await executeJob(payload.job_id, payload);
      return new Response(JSON.stringify(dispatchResult), {
        status: dispatchResult.success ? 200 : 502,
        headers: { "content-type": "application/json" },
      });
    }

    throw new InvocationValidationError("Missing job_id or batch");
  } catch (err) {
    if (err instanceof InvocationValidationError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { "content-type": "application/json" },
      });
    }
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
