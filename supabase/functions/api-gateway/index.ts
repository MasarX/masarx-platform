import {
  buildErrorEnvelope,
  buildRpcAuthAttempts,
  deriveChildTraceparent,
  invokeSupabaseRpcWithAuthFallback,
  logStructured,
  normalizeHeaderKey,
  parseRequestBody,
  readEnv,
  resolveCorrelationId,
  resolveTraceContext,
  toResponseBody,
} from "./_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;
const SERVICE_NAME = "api-gateway";
const CORS_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "apikey",
  "x-client-info",
  "traceparent",
  "tracestate",
  "x-webhook-token",
  "x-correlation-id",
  "idempotency-key",
  "x-idempotency-key",
  "x-masarx-replay-of",
].join(",");

const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);
const LOCAL_EDGE_RUNTIME = /(^|\/\/)(kong|host\.docker\.internal|127\.0\.0\.1|localhost)(:|\/)/i.test(SUPABASE_URL);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);

const RAW_EDGE_DB_JWT = readEnv("API_GATEWAY_DB_JWT", ["EDGE_DB_JWT"]);
const EDGE_DB_JWT = RAW_EDGE_DB_JWT && RAW_EDGE_DB_JWT.split(".").length === 3
  ? RAW_EDGE_DB_JWT
  : "";
if (RAW_EDGE_DB_JWT && !EDGE_DB_JWT) {
  logStructured("warn", "edge.config.invalid_db_jwt", {
    service: SERVICE_NAME,
    env_var: "API_GATEWAY_DB_JWT",
    reason: "expected_jwt_with_three_segments",
  });
}

// Public/shared ingress is fail-closed by default. Preview/local breakglass must
// explicitly set API_GATEWAY_REQUIRE_DB_JWT=0 or EDGE_REQUIRE_DB_JWT=0 before
// the service-role fallback flag is honored.
const EDGE_REQUIRE_DB_JWT_RAW = readEnv("API_GATEWAY_REQUIRE_DB_JWT", ["EDGE_REQUIRE_DB_JWT"]);
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
    env_var: "API_GATEWAY_DB_JWT",
    require_flag: "API_GATEWAY_REQUIRE_DB_JWT",
    error: "missing_required_db_jwt",
  });
}

const stringifyBody = (body: unknown): string => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
};

const decodeBase64ToBytes = (base64: string): Uint8Array => {
  if (!base64) return new Uint8Array();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const isEdgeBase64Envelope = (body: unknown): body is { __edge_encoding: string; data: string } => {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return record.__edge_encoding === "base64" && typeof record.data === "string";
};

const normaliseRequestHeaders = (req: Request): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    normalized[normalizeHeaderKey(key)] = value;
  }
  return normalized;
};

const redactGatewayTokenPath = (value: string): string =>
  value
    .replace(/(\/api-gateway\/t\/)[^/?#]+/gi, "$1[redacted]")
    .replace(
      /(^|[?&])(token|auth_token|api_key|apikey|secret|signature|hmac|x_signature|x-signature|x-hub-signature|x-hub-signature-256|key|password|credential)=([^&#\s]*)/gi,
      "$1$2=[redacted]",
    );

const redactForwardedTokenHeaders = (headers: Record<string, string>): Record<string, string> => {
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
      redacted[key] = redactGatewayTokenPath(redacted[key]);
    }
  }
  return redacted;
};

const readGatewayTokenFromHeaders = (req: Request, url: URL): string => {
  const explicit = req.headers.get("x-webhook-token");
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  const authorization = req.headers.get("authorization");
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme && scheme.toLowerCase() === "bearer" && token && token.trim().length > 0) {
      return token.trim();
    }
  }

  const queryToken = url.searchParams.get("token");
  if (queryToken && queryToken.trim().length > 0) return queryToken.trim();

  return "";
};

const parseGatewayUrl = (
  req: Request,
): { token: string; upstreamPath: string; queryString: string } | { error: string; status: number } => {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch (_err) {
    return { error: "Malformed URL", status: 400 };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const gatewayIdx = parts.indexOf("api-gateway");
  if (gatewayIdx === -1) {
    return { error: "Not found", status: 404 };
  }

  const tokenFromHeaders = readGatewayTokenFromHeaders(req, url);

  let token = "";
  let pathStart = gatewayIdx + 1;

  if (parts[gatewayIdx + 1] === "t" && parts.length > gatewayIdx + 2) {
    token = decodeURIComponent(parts[gatewayIdx + 2] ?? "");
    pathStart = gatewayIdx + 3;
  } else if (tokenFromHeaders) {
    token = tokenFromHeaders;
    pathStart = gatewayIdx + 1;
  } else if (parts.length > gatewayIdx + 1) {
    token = decodeURIComponent(parts[gatewayIdx + 1] ?? "");
    pathStart = gatewayIdx + 2;
  }

  if (!token || token.trim().length === 0) {
    return { error: "Missing token", status: 401 };
  }

  const forwardedParams = new URLSearchParams(url.searchParams);
  forwardedParams.delete("token");
  const queryString = forwardedParams.toString();

  const upstreamParts = parts.slice(pathStart);
  const upstreamPath = `/${upstreamParts.join("/")}`;

  if (upstreamPath === "/" || upstreamPath === "/undefined") {
    return { error: "Missing upstream path", status: 400 };
  }

  return { token, upstreamPath, queryString };
};

const stripHopByHopResponseHeaders = (headers: Headers): Headers => {
  const forbidden = new Set([
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    if (!key) continue;
    if (forbidden.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
};

const buildResponseHeaders = (headersObject: JsonRecord): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersObject)) {
    if (!key || value === undefined || value === null) continue;
    headers.set(key, String(value));
  }
  return stripHopByHopResponseHeaders(headers);
};

const addStandardHeaders = (
  headers: HeadersInit,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null } | null,
): Headers => {
  const out = new Headers(headers);
  out.set("access-control-allow-origin", "*");
  out.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  out.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  out.set("access-control-expose-headers", "x-correlation-id,traceparent,tracestate");
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
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return fallback;
};

const invokeApiCaller = async (
  jobId: string,
  timeoutSeconds?: number | null,
  correlationId?: string | null,
  traceparent?: string | null,
  tracestate?: string | null,
): Promise<{ status: number; headers: Record<string, string>; body: unknown } | null> => {
  if (!SUPABASE_URL) return null;
  if (!INTERNAL_JWT) return null;

  const response = await fetch(`${SUPABASE_URL}/functions/v1/api-caller`, {
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

  const data = await toResponseBody(response);
  const result = (data && typeof data === "object" && "result" in data) ? (data as any).result : null;

  if (!result || typeof result !== "object") {
    return null;
  }

  const status = typeof result.status === "number" ? result.status : 502;
  const headers = (result.headers ?? {}) as Record<string, string>;
  const body = result.body ?? null;

  return { status, headers, body };
};

const progressApiGatewayWorkflow = async ({
  workflowRunId,
  apiGatewayRequestId,
  authAttempts,
  correlationId,
  requestId,
  stage,
}: {
  workflowRunId: string;
  apiGatewayRequestId?: string | null;
  authAttempts: Array<{ label: string; headers: Record<string, string> }>;
  correlationId: string;
  requestId?: string | null;
  stage: string;
}): Promise<unknown | null> => {
  if (!SUPABASE_URL || !workflowRunId || !apiGatewayRequestId || !authAttempts.length) return null;
  try {
    const result = await invokeSupabaseRpcWithAuthFallback({
      url: `${SUPABASE_URL}/rest/v1/rpc/progress_api_gateway_request_workflow_v1`,
      authAttempts,
      body: {
        p_api_gateway_request_id: apiGatewayRequestId,
        p_workflow_run_id: workflowRunId,
        p_input: {},
      },
    });
    logStructured(result.ok ? "info" : "warn", "edge.workflow.progress", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      workflow_run_id: workflowRunId,
      stage,
      rpc_status: result.response?.status ?? null,
      ok: result.ok,
    });
    return result.body ?? null;
  } catch (error) {
    logStructured("warn", "edge.workflow.progress_failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      workflow_run_id: workflowRunId,
      stage,
      error,
    });
    return null;
  }
};

const resolveApiGatewayEdgeDispatchJobs = async (
  apiGatewayRequestId: string,
  authAttempts: Array<{ label: string; headers: Record<string, string> }>,
): Promise<Array<{ job_id?: string; timeout_seconds?: number | null }>> => {
  if (!SUPABASE_URL || !apiGatewayRequestId || !authAttempts.length) return [];
  const result = await invokeSupabaseRpcWithAuthFallback({
    url: `${SUPABASE_URL}/rest/v1/rpc/get_api_gateway_edge_dispatch_jobs_v1`,
    authAttempts,
    body: {
      p_api_gateway_request_id: apiGatewayRequestId,
    },
  });

  if (!result.ok || !Array.isArray(result.body)) return [];
  return result.body as Array<{ job_id?: string; timeout_seconds?: number | null }>;
};

const dispatchAcceptedAsyncJob = ({
  jobId,
  timeoutSeconds,
  correlationId,
  traceparent,
  tracestate,
  requestId,
  traceId,
  spanId,
}: {
  jobId: string;
  timeoutSeconds?: number | null;
  correlationId: string;
  traceparent?: string | null;
  tracestate?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
}): Promise<void> => {
  if (!jobId || !INTERNAL_JWT) return Promise.resolve();

  const edgeRuntime = (globalThis as any).EdgeRuntime;
  const task = invokeApiCaller(
    jobId,
    timeoutSeconds ?? null,
    correlationId,
    traceparent ?? null,
    tracestate ?? null,
  ).then((dispatchResult) => {
    logStructured(dispatchResult ? "info" : "warn", "edge.dispatch.background_completed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      trace_id: traceId ?? null,
      span_id: spanId ?? null,
      outbound_call_id: jobId,
      status: dispatchResult?.status ?? null,
      dispatched: Boolean(dispatchResult),
    });
  }).catch((error) => {
    logStructured("warn", "edge.dispatch.background_failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      trace_id: traceId ?? null,
      span_id: spanId ?? null,
      outbound_call_id: jobId,
      error,
    });
  });

  if (!LOCAL_EDGE_RUNTIME && edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(task);
    return Promise.resolve();
  }
  return task;
};

const dispatchAcceptedAsyncWorkflow = ({
  workflowRunId,
  apiGatewayRequestId,
  authAttempts,
  correlationId,
  traceparent,
  tracestate,
  requestId,
  traceId,
  spanId,
}: {
  workflowRunId: string;
  apiGatewayRequestId?: string | null;
  authAttempts: Array<{ label: string; headers: Record<string, string> }>;
  correlationId: string;
  traceparent?: string | null;
  tracestate?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
}): Promise<void> => {
  if (!workflowRunId || !INTERNAL_JWT || !authAttempts.length) return Promise.resolve();

  const edgeRuntime = (globalThis as any).EdgeRuntime;
  const task = (async () => {
    let jobs: Array<{ job_id?: string; timeout_seconds?: number | null }> = [];
    if (apiGatewayRequestId) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await progressApiGatewayWorkflow({
          workflowRunId,
          apiGatewayRequestId,
          authAttempts,
          correlationId,
          requestId,
          stage: `before_dispatch_${attempt}`,
        });
        jobs = await resolveApiGatewayEdgeDispatchJobs(apiGatewayRequestId, authAttempts);
        logStructured(jobs.length ? "info" : "warn", "edge.workflow.dispatch_jobs_resolved", {
          service: SERVICE_NAME,
          correlation_id: correlationId,
          request_id: requestId ?? null,
          workflow_run_id: workflowRunId,
          api_gateway_request_id: apiGatewayRequestId,
          attempt,
          job_count: jobs.length,
        });
        if (jobs.length) break;
      }
    }

    for (const job of jobs) {
      const jobId = typeof job?.job_id === "string" ? job.job_id : "";
      if (!jobId) continue;
      await invokeApiCaller(
        jobId,
        job?.timeout_seconds ?? null,
        correlationId,
        traceparent ?? null,
        tracestate ?? null,
      );
    }

    await progressApiGatewayWorkflow({
      workflowRunId,
      apiGatewayRequestId,
      authAttempts,
      correlationId,
      requestId,
      stage: "after_dispatch",
    });

    logStructured("info", "edge.workflow.background_completed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      trace_id: traceId ?? null,
      span_id: spanId ?? null,
      workflow_run_id: workflowRunId,
      api_gateway_request_id: apiGatewayRequestId ?? null,
    });
  })().catch((error) => {
    logStructured("warn", "edge.workflow.background_failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId ?? null,
      trace_id: traceId ?? null,
      span_id: spanId ?? null,
      workflow_run_id: workflowRunId,
      api_gateway_request_id: apiGatewayRequestId ?? null,
      error,
    });
  });

  if (!LOCAL_EDGE_RUNTIME && edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(task);
    return Promise.resolve();
  }
  return task;
};

const recordIntakeAuthRejection = async ({
  authAttempts,
  token,
  status,
  failureCode,
  failureMessage,
  method,
  path,
  queryString,
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
  queryString?: string | null;
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
          service: "api_gateway",
          surface: "api_gateway",
          credential_kind: "source_token",
          token: token ?? null,
          http_status: status,
          failure_code: failureCode,
          failure_message: failureMessage ?? null,
          method,
          path: path ?? null,
          query_string: queryString ?? null,
          headers,
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
    level: "warn" | "error" = "error",
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
      headers: addStandardHeaders({ "content-type": "application/json" }, correlationId, trace),
    });
  };

  if (req.method === "OPTIONS") {
    logStructured("info", "edge.cors.preflight", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      request_id: requestId,
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      method: req.method,
    });
    return new Response(null, {
      status: 204,
      headers: addStandardHeaders({
        "access-control-max-age": "86400",
      }, correlationId, trace),
    });
  }

  const requestHeaders = redactForwardedTokenHeaders(normaliseRequestHeaders(req));
  if (!requestHeaders["x-correlation-id"]) {
    requestHeaders["x-correlation-id"] = correlationId;
  }
  requestHeaders.traceparent = trace.traceparent;
  if (trace.tracestate && !requestHeaders.tracestate) {
    requestHeaders.tracestate = trace.tracestate;
  }

  const rpcAuthAttempts = buildRpcAuthAttempts({
    dbJwt: EDGE_DB_JWT,
    secretKey: EDGE_SUPABASE_SECRET_KEY,
    serviceRoleKey: EDGE_ALLOW_SERVICE_ROLE_FALLBACK ? SUPABASE_SERVICE_KEY : "",
  });

  const parsed = parseGatewayUrl(req);
  if ("error" in parsed) {
    if (parsed.status === 401 || parsed.status === 403) {
      await recordIntakeAuthRejection({
        authAttempts: rpcAuthAttempts,
        token: null,
        status: parsed.status,
        failureCode: parsed.error.toLowerCase().replace(/\s+/g, "_"),
        failureMessage: parsed.error,
        method: req.method,
        path: req.url,
        headers: requestHeaders,
        correlationId,
        requestId,
        metadata: { edge_stage: "url_parse" },
      });
    }
    return jsonResponse(parsed.status, { error: parsed.error }, "edge.request.invalid", "warn", {
      method: req.method,
      path: req.url,
    });
  }

  const { token, upstreamPath, queryString } = parsed;

  const contentType = req.headers.get("content-type") ?? "";
  const hasJsonBody = contentType.toLowerCase().includes("application/json");

  let body: unknown = {};
  if (!["GET", "HEAD", "DELETE"].includes(req.method.toUpperCase())) {
    if (hasJsonBody) {
      try {
        const parsedBody = await parseRequestBody(req);
        body = parsedBody.json;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid JSON payload";
        return jsonResponse(400, { error: message }, "edge.request.invalid_json", "warn", {
          method: req.method,
          path: req.url,
        });
      }
    } else {
      const raw = await req.text();
      if (raw && raw.trim().length > 0) {
        return jsonResponse(
          415,
          { error: "Unsupported content type. Expected application/json." },
          "edge.request.unsupported_content_type",
          "warn",
          {
            method: req.method,
            path: req.url,
            content_type: contentType || null,
          },
        );
      }
    }
  }

  if (!rpcAuthAttempts.length) {
    return jsonResponse(
      500,
      {
        error: EDGE_REQUIRE_DB_JWT
          ? "Missing API_GATEWAY_DB_JWT while API_GATEWAY_REQUIRE_DB_JWT=1"
          : "Missing Supabase credentials (API_GATEWAY_DB_JWT or EDGE_SUPABASE_SECRET_KEY required).",
      },
      "edge.config.invalid",
      "error",
      {
        method: req.method,
        path: req.url,
      },
    );
  }

  logStructured("info", "edge.request.accepted", {
    service: SERVICE_NAME,
    correlation_id: correlationId,
    request_id: requestId,
    trace_id: trace.trace_id,
    span_id: trace.span_id,
    method: req.method,
    upstream_path: upstreamPath,
  });

  const rpcResult = await invokeSupabaseRpcWithAuthFallback({
    url: `${SUPABASE_URL}/rest/v1/rpc/workflow_intake_api_gateway_v1`,
    authAttempts: rpcAuthAttempts,
    body: {
      p_token: token,
      p_method: req.method,
      p_path: upstreamPath,
      p_query_string: queryString,
      p_headers: requestHeaders,
      p_body: body,
    },
  });

  const data = rpcResult.body;
  if (!rpcResult.ok || !data || typeof data !== "object") {
    const debug = typeof data === "string" || data === null || data === undefined ? data : JSON.stringify(data);
    return jsonResponse(
      500,
      {
        error: "Failed to process API gateway intake",
        rpc_status: rpcResult.response?.status ?? 500,
        rpc_message: rpcResult.response?.statusText ?? "Request failed",
        rpc_body: debug ?? null,
      },
      "edge.rpc.intake_failed",
      "error",
      {
        method: req.method,
        upstream_path: upstreamPath,
        rpc_status: rpcResult.response?.status ?? 500,
      },
    );
  }

  // Prefer the persisted intake correlation_id from the RPC payload when present.
  // The current contract may surface it either top-level or on the response body.
  const intakeCorrelationId = resolveResponseCorrelationId(data, correlationId);

  const action = (data as any).action as string | undefined;

  if (action === "error" || action === "accepted_async") {
    const status = typeof (data as any).status === "number" ? (data as any).status : 500;
    const headersObject = ((data as any).headers ?? {}) as JsonRecord;
    const responseHeaders = addStandardHeaders(buildResponseHeaders(headersObject), intakeCorrelationId, trace);
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }

    const bodyValue = (data as any).body ?? {};
    if (action === "error" && (status === 401 || status === 403)) {
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
          : "API gateway request was rejected during authentication.";
      await recordIntakeAuthRejection({
        authAttempts: rpcAuthAttempts,
        token,
        status,
        failureCode,
        failureMessage,
        method: req.method,
        path: upstreamPath,
        queryString,
        headers: requestHeaders,
        correlationId: intakeCorrelationId,
        requestId,
        metadata: {
          edge_stage: "workflow_intake_api_gateway_v1",
          action,
          response_action: "error",
        },
      });
    }
    if (action === "accepted_async") {
      const bodyRecord = bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)
        ? bodyValue as Record<string, unknown>
        : {};
      const jobId = typeof (data as any).outbound_call_id === "string" ? (data as any).outbound_call_id : "";
      const workflowRunId = typeof (data as any).workflow_run_id === "string"
        ? (data as any).workflow_run_id
        : typeof bodyRecord.workflow_run_id === "string"
          ? bodyRecord.workflow_run_id
          : "";
      const apiGatewayRequestId = typeof (data as any).api_gateway_request_id === "string"
        ? (data as any).api_gateway_request_id
        : typeof bodyRecord.api_gateway_request_id === "string"
          ? bodyRecord.api_gateway_request_id
        : "";
      const timeoutSeconds = typeof (data as any).timeout_seconds === "number" ? (data as any).timeout_seconds : null;
      logStructured("info", "edge.accepted_async.dispatch_selected", {
        service: SERVICE_NAME,
        correlation_id: intakeCorrelationId,
        request_id: requestId,
        workflow_run_id: workflowRunId || null,
        api_gateway_request_id: apiGatewayRequestId || null,
        outbound_call_id: jobId || null,
        dispatch_mode: workflowRunId ? "workflow" : "outbound",
      });
      if (workflowRunId) {
        await dispatchAcceptedAsyncWorkflow({
          workflowRunId,
          apiGatewayRequestId,
          authAttempts: rpcAuthAttempts,
          correlationId: intakeCorrelationId,
          traceparent: apiCallerTraceparent,
          tracestate: trace.tracestate ?? null,
          requestId,
          traceId: trace.trace_id,
          spanId: trace.span_id,
        });
      } else {
        await dispatchAcceptedAsyncJob({
          jobId,
          timeoutSeconds,
          correlationId: intakeCorrelationId,
          traceparent: apiCallerTraceparent,
          tracestate: trace.tracestate ?? null,
          requestId,
          traceId: trace.trace_id,
          spanId: trace.span_id,
        });
      }
    }
    const normalizedBody = action === "error"
      ? toErrorBody(
        status,
        typeof bodyValue === "object" && bodyValue !== null
          ? bodyValue as Record<string, unknown>
          : { message: String(bodyValue ?? "Request failed") },
        "edge.response.error",
      )
      : bodyValue;
    const responseBodyValue = normalizedBody && typeof normalizedBody === "object" && !Array.isArray(normalizedBody)
      ? { ...(normalizedBody as JsonRecord), correlation_id: intakeCorrelationId }
      : normalizedBody;
    const responseBody = stringifyBody(responseBodyValue);
    logStructured(action === "error" ? "warn" : "info", "edge.response.immediate", {
      service: SERVICE_NAME,
      correlation_id: intakeCorrelationId,
      request_id: requestId,
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      action,
      status,
      upstream_path: upstreamPath,
    });
    return new Response(responseBody, { status, headers: responseHeaders });
  }

  if (action !== "proxy") {
    return jsonResponse(500, { error: "Unsupported action", action: action ?? null }, "edge.response.unsupported_action", "error", {
      action: action ?? null,
      upstream_path: upstreamPath,
    });
  }

  const jobId = typeof (data as any).outbound_call_id === "string" ? (data as any).outbound_call_id : "";
  const timeoutSeconds = typeof (data as any).timeout_seconds === "number" ? (data as any).timeout_seconds : null;

  if (!jobId) {
    return jsonResponse(500, { error: "Missing outbound_call_id from intake" }, "edge.dispatch.missing_job_id", "error", {
      action,
      upstream_path: upstreamPath,
    });
  }

  try {
    const dispatchResult = await invokeApiCaller(
      jobId,
      timeoutSeconds,
      intakeCorrelationId,
      apiCallerTraceparent,
      trace.tracestate ?? null,
    );
    if (!dispatchResult) {
      return jsonResponse(502, { error: "Upstream dispatch failed" }, "edge.dispatch.failed", "error", {
        outbound_call_id: jobId,
      });
    }

    const responseHeaders = addStandardHeaders(
      buildResponseHeaders(dispatchResult.headers as unknown as JsonRecord),
      intakeCorrelationId,
      trace,
    );
    if (isEdgeBase64Envelope(dispatchResult.body)) {
      const bytes = decodeBase64ToBytes(dispatchResult.body.data);
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/octet-stream");
      }
      responseHeaders.delete("content-length");
      logStructured("info", "edge.dispatch.completed", {
        service: SERVICE_NAME,
        correlation_id: intakeCorrelationId,
        request_id: requestId,
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        outbound_call_id: jobId,
        status: dispatchResult.status,
        body_encoding: "base64",
      });
      return new Response(bytes, { status: dispatchResult.status, headers: responseHeaders });
    }

    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }

    logStructured("info", "edge.dispatch.completed", {
      service: SERVICE_NAME,
      correlation_id: intakeCorrelationId,
      request_id: requestId,
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      outbound_call_id: jobId,
      status: dispatchResult.status,
    });
    return new Response(stringifyBody(dispatchResult.body), { status: dispatchResult.status, headers: responseHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse(502, { error: "Upstream dispatch error", message }, "edge.dispatch.exception", "error", {
      outbound_call_id: jobId,
      error: err,
    });
  }
});
