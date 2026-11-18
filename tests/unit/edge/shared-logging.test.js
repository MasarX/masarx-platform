const path = require("path");
const { pathToFileURL } = require("url");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const sharedModulePath = path.join(repoRoot, "supabase", "functions", "_shared", "mod.mjs");

describe("edge shared logging helpers", () => {
  let shared;

  beforeAll(async () => {
    global.Deno = {
      env: {
        get: () => "",
      },
    };
    shared = await import(pathToFileURL(sharedModulePath).href);
  });

  afterAll(() => {
    delete global.Deno;
  });

  test("resolveCorrelationId prefers x-correlation-id header", () => {
    const req = new Request("https://example.test/hook", {
      headers: {
        "x-correlation-id": "550e8400-e29b-41d4-a716-446655440000",
        "x-request-id": "9b6f82a0-5ee2-4b6f-8c38-2d4ac4d83255",
      },
    });
    expect(shared.resolveCorrelationId(req)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("resolveCorrelationId derives UUID from traceparent when correlation headers are invalid", () => {
    const req = new Request("https://example.test/hook", {
      headers: {
        "x-correlation-id": "cid-123",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    expect(shared.resolveCorrelationId(req)).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });

  test("resolveTraceContext continues inbound trace-id and generates a new span-id", () => {
    const correlationId = "550e8400-e29b-41d4-a716-446655440000";
    const req = new Request("https://example.test/hook", {
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=opaque",
      },
    });

    const trace = shared.resolveTraceContext(req, correlationId);
    expect(trace.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(String(trace.span_id)).toMatch(/^[0-9a-f]{16}$/i);
    expect(String(trace.traceparent)).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/i,
    );
    expect(trace.tracestate).toBe("vendor=opaque");
  });

  test("redactLogValue redacts sensitive keys and token-like strings", () => {
    const payload = {
      authorization: "Bearer abc.def.ghi",
      token: "very-secret-token",
      "x-webhook-token": "webhook-raw-token",
      "x-signature": "deadbeef",
      "x-hub-signature-256": "sha256=deadbeef",
      nested: {
        api_key: "secret-123",
        note: "jwt eyJabc.def.ghi",
      },
    };

    const redacted = shared.redactLogValue(payload);
    expect(redacted.authorization).toBe("[redacted]");
    expect(redacted.token).toBe("[redacted]");
    expect(redacted["x-webhook-token"]).toBe("[redacted]");
    expect(redacted["x-signature"]).toBe("[redacted]");
    expect(redacted["x-hub-signature-256"]).toBe("[redacted]");
    expect(redacted.nested.api_key).toBe("[redacted]");
    expect(redacted.nested.note).toContain("[redacted_jwt]");
  });

  test("ingress redaction removes path and query credentials without hiding validation headers", () => {
    const redactedText = shared.redactIngressSecretText(
      "https://api.example.test/functions/v1/api-gateway/t/raw-token/v1/webhook?api_key=raw-key&safe=value",
    );
    expect(redactedText).toContain("/api-gateway/t/[redacted]/v1/webhook");
    expect(redactedText).toContain("api_key=[redacted]");
    expect(redactedText).toContain("safe=value");
    expect(redactedText).not.toContain("raw-token");
    expect(redactedText).not.toContain("raw-key");

    const headers = shared.redactIngressForwardedHeaders({
      authorization: "Bearer validation-token",
      "x-signature": "validation-signature",
      "x-forwarded-url": "/api-gateway/t/path-token/v1/webhook?token=EXAMPLE_PASSWORD",
    });
    expect(headers.authorization).toBe("Bearer validation-token");
    expect(headers["x-signature"]).toBe("validation-signature");
    expect(headers["x-forwarded-url"]).toBe(
      "/api-gateway/t/[redacted]/v1/webhook?token=[redacted]",
    );
  });

  test("buildStructuredLogRecord includes classification and core fields", () => {
    const record = shared.buildStructuredLogRecord("error", "edge.request.failed", {
      service: "api-gateway",
      correlation_id: "cid-xyz",
      request_id: "req-xyz",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      error: new Error("request timeout while calling upstream"),
      operation: "workflow_intake",
    });

    expect(record.level).toBe("error");
    expect(record.event).toBe("edge.request.failed");
    expect(record.service).toBe("api-gateway");
    expect(record.correlation_id).toBe("cid-xyz");
    expect(record.request_id).toBe("req-xyz");
    expect(record.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record.span_id).toBe("00f067aa0ba902b7");
    expect(record.operation).toBe("workflow_intake");
    expect(record.error_type).toBe("timeout");
    expect(String(record.error_message)).toMatch(/timeout/i);
  });

  test("buildErrorEnvelope returns standardized fields with backward-compatible alias", () => {
    const envelope = shared.buildErrorEnvelope({
      status: 401,
      code: "edge.auth.missing_token",
      message: "Missing Authorization bearer token",
      correlationId: "550e8400-e29b-41d4-a716-446655440000",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      requestId: "req-123",
      details: { source: "webhook" },
    });

    expect(envelope).toMatchObject({
      code: "edge.auth.missing_token",
      message: "Missing Authorization bearer token",
      error: "Missing Authorization bearer token",
      status: 401,
      correlation_id: "550e8400-e29b-41d4-a716-446655440000",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      request_id: "req-123",
      details: { source: "webhook" },
    });
  });

  test("buildErrorEnvelope normalizes fallback values", () => {
    const envelope = shared.buildErrorEnvelope({
      status: NaN,
      code: "EDGE REQUEST INVALID!!",
      message: "",
      correlationId: "invalid-correlation-id",
      traceId: "",
      requestId: "",
    });

    expect(envelope.code).toBe("edge_request_invalid");
    expect(envelope.message).toBe("Request failed");
    expect(envelope.error).toBe("Request failed");
    expect(envelope.status).toBe(500);
    expect(envelope.correlation_id).toBeNull();
    expect(envelope.trace_id).toBeNull();
    expect(envelope.request_id).toBeNull();
    expect(envelope.details).toBeUndefined();
  });
});
