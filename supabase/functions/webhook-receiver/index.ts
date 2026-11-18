import {
  buildErrorEnvelope,
  buildRpcAuthAttempts,
  deriveChildTraceparent,
  extractToken,
  invokeSupabaseRpcWithAuthFallback,
  logStructured,
  normalizeHeaderKey,
  parseRequestBody,
  readEnv,
  resolveCorrelationId,
  resolveTraceContext,
} from "./_shared/mod.mjs";
import { buildCorsHeaders } from "./_shared/cors.mjs";

type JsonRecord = Record<string, unknown>;
const SERVICE_NAME = "webhook-receiver";

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const RAW_EDGE_DB_JWT = readEnv("WEBHOOK_DB_JWT", ["EDGE_DB_JWT"]);
// Treat non-JWT values as "not configured" to avoid runtime errors from malformed tokens.
const EDGE_DB_JWT = RAW_EDGE_DB_JWT && RAW_EDGE_DB_JWT.split(".").length === 3
  ? RAW_EDGE_DB_JWT
  : "";
if (RAW_EDGE_DB_JWT && !EDGE_DB_JWT) {
  logStructured("warn", "edge.config.invalid_db_jwt", {
    service: SERVICE_NAME,
    env_var: "WEBHOOK_DB_JWT",
    reason: "expected_jwt_with_three_segments",
  });
}
// Public/shared ingress is fail-closed by default. Preview/local breakglass must
// explicitly set WEBHOOK_REQUIRE_DB_JWT=0 or EDGE_REQUIRE_DB_JWT=0 before the
// service-role fallback flag is honored.
const EDGE_REQUIRE_DB_JWT_RAW = readEnv("WEBHOOK_REQUIRE_DB_JWT", ["EDGE_REQUIRE_DB_JWT"]);
const EDGE_REQUIRE_DB_JWT = EDGE_REQUIRE_DB_JWT_RAW === ""
  ? true
  : !/^(0|false|no)$/i.test(EDGE_REQUIRE_DB_JWT_RAW);
const EDGE_ALLOW_SERVICE_ROLE_FALLBACK =
  !EDGE_REQUIRE_DB_JWT && readEnv("EDGE_ALLOW_SERVICE_ROLE_FALLBACK") === "1";
const INTERNAL_JWT = EDGE_DB_JWT || (EDGE_ALLOW_SERVICE_ROLE_FALLBACK ? (SUPABASE_SERVICE_KEY || "") : "");

if (!SUPABASE_URL) {
  logStructured("error", "edge.config.missing_env", {
    service: SERVICE_NAME,
    env_var: "SUPABASE_URL",
    error: "missing_required_env",
  });
}

if (!EDGE_DB_JWT && EDGE_REQUIRE_DB_JWT) {
  logStructured("error", "edge.config.missing_db_jwt", {
    service: SERVICE_NAME,
    env_var: "WEBHOOK_DB_JWT",
    require_flag: "EDGE_REQUIRE_DB_JWT",
    error: "missing_required_db_jwt",
  });
}

const stringifyBody = (body: unknown): string => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
};

const redactIntakeSecretText = (value: string): string =>
  value
    .replace(/(\/api-gateway\/t\/)[^/?#\s]+/gi, "$1[redacted]")
    .replace(
      /(^|[?&])(token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential)=([^&#\s]*)/gi,
      "$1$2=[redacted]",
    );

const redactForwardedSecretHeaders = (headers: Record<string, string>): Record<string, string> => {
  const redacted = { ...headers };
  for (const key of [
    "x-forwarded-path",
    "x-forwarded-url",
    "x-original-uri",
    "x-rewrite-url",
    "x-envoy-original-path",
    "referer",
  ]) {
    if (redacted[key]) {
      redacted[key] = redactIntakeSecretText(redacted[key]);
    }
  }
  return redacted;
};

const addStandardHeaders = (
  headers: HeadersInit,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null } | null,
  corsHeaders: HeadersInit = {},
): Headers => {
  const out = new Headers(corsHeaders);
  for (const [key, value] of new Headers(headers).entries()) {
    out.set(key, value);
  }
  out.set("x-correlation-id", correlationId);
  if (trace?.traceparent) out.set("traceparent", trace.traceparent);
  if (trace?.tracestate) out.set("tracestate", trace.tracestate);
  return out;
};

const resolveResponseCorrelationId = (data: unknown, fallback: string): string => {
  if (!data || typeof data !== "object") {
    return fallback;
  }

  const record = data as Record<string, unknown>;
  const candidates: unknown[] = [record.correlation_id];
  const body = record.body;
  if (body && typeof body === "object") {
    const bodyRecord = body as Record<string, unknown>;
    candidates.push(bodyRecord.correlation_id);
    const webhook = bodyRecord.webhook;
    if (webhook && typeof webhook === "object") {
      candidates.push((webhook as Record<string, unknown>).correlation_id);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return fallback;
};

const resolveEdgeDispatchJobs = async (
  webhookId: string,
  rpcAuthAttempts: Array<{ label: string; headers: Record<string, string> }>,
): Promise<Array<{ job_id?: string; timeout_seconds?: number | null }>> => {
  if (!SUPABASE_URL) return [];
  if (!rpcAuthAttempts.length) return [];
  const result = await invokeSupabaseRpcWithAuthFallback({
    url: `${SUPABASE_URL}/rest/v1/rpc/get_webhook_edge_dispatch_jobs`,
    body: { p_webhook_id: webhookId },
    authAttempts: rpcAuthAttempts,
  });
  if (!result.ok || !result.body) return [];
  return Array.isArray(result.body) ? result.body : [];
};

const invokeApiCaller = async (
  jobId: string,
  timeoutSeconds?: number | null,
  correlationId?: string | null,
  traceparent?: string | null,
  tracestate?: string | null,
  traceId?: string | null,
  spanId?: string | null,
): Promise<void> => {
  if (!SUPABASE_URL) return;
  if (!INTERNAL_JWT) return;

  try {
    await fetch(`${SUPABASE_URL}/functions/v1/api-caller`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${INTERNAL_JWT}`,
        ...(correlationId ? { "x-correlation-id": correlationId } : {}),
        ...(traceparent ? { traceparent } : {}),
        ...(tracestate ? { tracestate } : {}),
      },
      body: JSON.stringify({
        job_id: jobId,
        ...(typeof timeoutSeconds === "number" ? { timeout_seconds: timeoutSeconds } : {}),
      }),
    });
  } catch (error) {
    logStructured("warn", "edge.dispatch.invoke_failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId ?? null,
      trace_id: traceId ?? null,
      span_id: spanId ?? null,
      outbound_call_id: jobId,
      error,
    });
  }
};

const recordIntakeAuthRejection = async ({
  authAttempts,
  token,
  status,
  failureCode,
  failureMessage,
  method,
  path,
  headers,
  correlationId,
  requestId,
  metadata,
}: {
  authAttempts: Array<{ label: string; headers: Record<string, string> }>;
  token?: string | null;
  status: number;
  failureCode: string;
  failureMessage?: string | null;
  method: string;
  path?: string | null;
  headers: Record<string, string>;
  correlationId: string;
  requestId?: string | null;
  metadata?: JsonRecord;
}): Promise<void> => {
  if (!SUPABASE_URL || !authAttempts.length) return;
  try {
    await invokeSupabaseRpcWithAuthFallback({
      url: `${SUPABASE_URL}/rest/v1/rpc/record_intake_auth_rejection_v1`,
      authAttempts,
      body: {
        p_args: {
          service: "webhook_receiver",
          surface: "webhook_receiver",
          credential_kind: "source_token",
          token: token ?? null,
          http_status: status,
          failure_code: failureCode,
          failure_message: failureMessage ?? null,
          method,
          path: path ? redactIntakeSecretText(path) : null,
          headers: redactForwardedSecretHeaders(headers),
          correlation_id: correlationId,
          request_id: requestId ?? null,
          metadata: metadata ?? {},
        },
      },
    });
  } catch (error) {
    logStructured("warn", "edge.auth_rejection_record_failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      status,
      failure_code: failureCode,
      error,
    });
  }
};

Deno.serve(async (req: Request): Promise<Response> => {
  const correlationId = resolveCorrelationId(req);
  const corsHeaders = buildCorsHeaders(req);
  const requestId =
    req.headers.get("x-request-id")?.trim() ||
    req.headers.get("idempotency-key")?.trim() ||
    req.headers.get("x-idempotency-key")?.trim() ||
    null;
  const trace = resolveTraceContext(req, correlationId);
  const apiCallerTraceparent = deriveChildTraceparent(trace.traceparent) || trace.traceparent;
  const toErrorBody = (
    status: number,
    body: Record<string, unknown>,
    event: string,
  ): Record<string, unknown> => {
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if ([
        "code",
        "message",
        "error",
        "status",
        "correlation_id",
        "trace_id",
        "request_id",
      ].includes(key)) {
        continue;
      }
      details[key] = value;
    }
    const message =
      typeof body.message === "string" && body.message.trim().length > 0
        ? body.message
        : typeof body.error === "string" && body.error.trim().length > 0
          ? body.error
          : status >= 500
            ? "Internal server error"
            : "Request failed";
    return buildErrorEnvelope({
      status,
      code: typeof body.code === "string" ? body.code : event,
      message,
      correlationId,
      traceId: trace.trace_id,
      requestId,
      details: Object.keys(details).length > 0 ? details : undefined,
      legacyError: typeof body.error === "string" ? body.error : undefined,
    });
  };
  const jsonResponse = (
    status: number,
    body: Record<string, unknown>,
    event: string,
    level: "warn" | "error" | "info" = "error",
    context: Record<string, unknown> = {},
  ): Response => {
    const isErrorResponse = status >= 400 || Object.prototype.hasOwnProperty.call(body, "error");
    const responseBody = isErrorResponse ? toErrorBody(status, body, event) : body;
    logStructured(level, event, {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId,
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      status,
      ...context,
      ...(isErrorResponse
        ? {
          error: responseBody.error,
          error_code: responseBody.code,
        }
        : {}),
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: addStandardHeaders({ "content-type": "application/json" }, correlationId, trace, corsHeaders),
    });
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: addStandardHeaders({}, correlationId, trace, corsHeaders),
    });
  }

  const smokeAllow = Deno.env.get("EDGE_SMOKE_ALLOW");
  const smokeHeader = req.headers.get("x-smoke-test");
  if (smokeAllow === "1" && smokeHeader === "edge-allow") {
    return jsonResponse(202, { status: "accepted_smoke" }, "edge.smoke.accepted", "info");
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, "edge.request.method_not_allowed", "warn", {
      method: req.method,
    });
  }

  const requestStart = performance.now();

  try {
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of req.headers.entries()) {
      normalizedHeaders[normalizeHeaderKey(key)] = value;
    }
    if (!normalizedHeaders["x-correlation-id"]) {
      normalizedHeaders["x-correlation-id"] = correlationId;
    }
    normalizedHeaders.traceparent = trace.traceparent;
    if (trace.tracestate && !normalizedHeaders.tracestate) {
      normalizedHeaders.tracestate = trace.tracestate;
    }

    const rpcAuthAttempts = buildRpcAuthAttempts({
      dbJwt: EDGE_DB_JWT,
      secretKey: EDGE_SUPABASE_SECRET_KEY,
      serviceRoleKey: EDGE_ALLOW_SERVICE_ROLE_FALLBACK ? SUPABASE_SERVICE_KEY : "",
    });

    const token = extractToken(req);
    if (!token || token.trim() === "") {
      await recordIntakeAuthRejection({
        authAttempts: rpcAuthAttempts,
        token: null,
        status: 401,
        failureCode: "missing_token",
        failureMessage: "Missing Authorization bearer token",
        method: req.method,
        path: req.url,
        headers: normalizedHeaders,
        correlationId,
        requestId,
        metadata: { edge_stage: "extract_token" },
      });
      return jsonResponse(401, { error: "Missing Authorization bearer token" }, "edge.auth.missing_token", "warn");
    }

    let rawBody = "";
    let payload: JsonRecord = {};
    try {
      const parsedBody = await parseRequestBody(req);
      rawBody = parsedBody.raw;
      payload = parsedBody.json as JsonRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON payload";
      if (!message.startsWith("Invalid JSON payload")) {
        throw error;
      }
      return jsonResponse(
        400,
        {
          error: "Invalid JSON payload",
          code: "invalid_json_payload",
        },
        "edge.request.invalid_json",
        "warn",
        {
          error,
          path: redactIntakeSecretText(req.url),
          headers: redactForwardedSecretHeaders(normalizedHeaders),
        },
      );
    }

    if (!rpcAuthAttempts.length) {
      return jsonResponse(
        500,
        { error: "Server configuration missing credentials" },
        "edge.config.missing_credentials",
        "error",
        {
          env_var: EDGE_REQUIRE_DB_JWT
            ? "WEBHOOK_DB_JWT"
            : "WEBHOOK_DB_JWT|EDGE_SUPABASE_SECRET_KEY",
        },
      );
    }

    const rpcResult = await invokeSupabaseRpcWithAuthFallback({
      url: `${SUPABASE_URL}/rest/v1/rpc/workflow_intake_webhook`,
      body: {
        p_token: token,
        p_headers: normalizedHeaders,
        p_raw_body: rawBody,
        p_payload: payload,
      },
      authAttempts: rpcAuthAttempts,
    });

    if (!rpcResult.ok || !rpcResult.body) {
      const data = rpcResult.body;
      const message = typeof data === "object" && data !== null && "message" in data ? (data as any).message : null;
      const debug = typeof data === "string" || data === null || data === undefined ? data : JSON.stringify(data);
      return jsonResponse(
        500,
        {
          error: "Failed to process webhook intake",
          rpc_status: rpcResult.response?.status ?? 500,
          rpc_message: message ?? rpcResult.response?.statusText ?? "Request failed",
          rpc_body: debug ?? null,
        },
        "edge.rpc.intake_failed",
        "error",
        {
          rpc_status: rpcResult.response?.status ?? 500,
          rpc_message: message ?? rpcResult.response?.statusText ?? "Request failed",
        },
      );
    }

    // Prefer the persisted intake correlation_id from the RPC payload when present.
    // The core contract now exposes it top-level, with body/webhook fallbacks for older rows.
    const data = rpcResult.body as any;
    let responseCorrelationId = resolveResponseCorrelationId(data, correlationId);

    const status = typeof data?.status === "number" ? data.status : 500;
    const headersObject = (data?.headers ?? {}) as JsonRecord;
    const responseHeaders = new Headers(corsHeaders);
    for (const [key, value] of Object.entries(headersObject)) {
      if (key && value !== undefined && value !== null) {
        responseHeaders.set(key, String(value));
      }
    }

    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }
    responseHeaders.set("x-correlation-id", responseCorrelationId);
    responseHeaders.set("traceparent", trace.traceparent);
    if (trace.tracestate) responseHeaders.set("tracestate", trace.tracestate);

    const bodyValue = data?.body ?? {};
    if (status === 401 || status === 403) {
      const bodyRecord = bodyValue && typeof bodyValue === "object"
        ? bodyValue as Record<string, unknown>
        : {};
      const failureCode = typeof bodyRecord.code === "string" && bodyRecord.code.trim().length > 0
        ? bodyRecord.code
        : typeof bodyRecord.error === "string" && bodyRecord.error.trim().length > 0
          ? bodyRecord.error
          : "unauthorized";
      const failureMessage = typeof bodyRecord.message === "string" && bodyRecord.message.trim().length > 0
        ? bodyRecord.message
        : typeof bodyRecord.error === "string" && bodyRecord.error.trim().length > 0
          ? bodyRecord.error
          : "Webhook request was rejected during authentication.";
      await recordIntakeAuthRejection({
        authAttempts: rpcAuthAttempts,
        token,
        status,
        failureCode,
        failureMessage,
        method: req.method,
        path: req.url,
        headers: normalizedHeaders,
        correlationId: responseCorrelationId,
        requestId,
        metadata: {
          edge_stage: "workflow_intake_webhook",
          response_outcome: data?.response_outcome ?? null,
          response_reason: data?.response_reason ?? null,
        },
      });
    }
    const normalizedBody = status >= 400
      ? toErrorBody(
        status,
        typeof bodyValue === "object" && bodyValue !== null
          ? bodyValue as Record<string, unknown>
          : { message: String(bodyValue ?? "Request failed") },
        "edge.response.error",
      )
      : bodyValue;
    const responseBodyValue = normalizedBody && typeof normalizedBody === "object" && !Array.isArray(normalizedBody)
      ? { ...(normalizedBody as JsonRecord), correlation_id: responseCorrelationId }
      : normalizedBody;
    const responseBody = stringifyBody(responseBodyValue);

    // Post-intake low-latency edge dispatch (policy-driven via DB rows).
    // This is best-effort and MUST NOT block the provider webhook ack.
    if (INTERNAL_JWT && typeof data?.webhook_id === "string" && data.webhook_id.length > 0) {
      const webhookId = data.webhook_id;
      const edgeRuntime = (globalThis as any).EdgeRuntime;
      const task = (async () => {
        const jobs = await resolveEdgeDispatchJobs(webhookId, rpcAuthAttempts);
        for (const job of jobs) {
          const jobId = typeof job?.job_id === "string" ? job.job_id : "";
          if (!jobId) continue;
          await invokeApiCaller(
            jobId,
            job?.timeout_seconds ?? null,
            responseCorrelationId,
            apiCallerTraceparent,
            trace.tracestate ?? null,
            trace.trace_id,
            trace.span_id,
          );
        }
      })();

      if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
        edgeRuntime.waitUntil(task);
      } else {
        task.catch((err) => {
          logStructured("warn", "edge.dispatch.background_failed", {
            service: SERVICE_NAME,
            correlation_id: responseCorrelationId,
            request_id: requestId,
            trace_id: trace.trace_id,
            span_id: trace.span_id,
            error: err,
          });
        });
      }
    }

    // Latency captured for logs/observability (decision log inside RPC).
    const processingTimeMs = Math.round(performance.now() - requestStart);
    if (data?.response_outcome) {
      logStructured("info", "webhook_http_response", {
        service: SERVICE_NAME,
        correlation_id: responseCorrelationId,
        request_id: requestId,
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        response_outcome: data.response_outcome,
        response_mode: data.response_mode ?? null,
        response_reason: data.response_reason ?? null,
        response_status: status,
        webhook_id: data.webhook_id ?? null,
        workflow_run_id: data.workflow_run_id ?? null,
        followup_workflow_run_id: data.followup_workflow_run_id ?? null,
        processing_time_ms: processingTimeMs,
      });
    }

    return new Response(responseBody, {
      status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return jsonResponse(500, { error: message }, "edge.request.exception", "error", {
      error,
    });
  }
});
