const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const corsModulePath = path.join(repoRoot, "supabase", "functions", "_shared", "cors.mjs");
const apiGatewayPath = path.join(repoRoot, "supabase", "functions", "api-gateway", "index.ts");
const webhookReceiverPath = path.join(repoRoot, "supabase", "functions", "webhook-receiver", "index.ts");
const loopbackHostnameContract = require("../../fixtures/loopback-hostname-contract.json");

describe("public ingress transport security", () => {
  let cors;
  let apiGatewaySource;
  let webhookReceiverSource;

  beforeAll(async () => {
    cors = await import(pathToFileURL(corsModulePath).href);
    apiGatewaySource = fs.readFileSync(apiGatewayPath, "utf8").replace(/\r\n/g, "\n");
    webhookReceiverSource = fs.readFileSync(webhookReceiverPath, "utf8").replace(/\r\n/g, "\n");
  });

  test("shared CORS policy allows an exact configured hosted HTTPS origin", () => {
    const req = new Request("https://api.example.test/functions/v1/api-gateway", {
      method: "OPTIONS",
      headers: {
        origin: "https://docs.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "X-Webhook-Token, Idempotency-Key",
      },
    });
    const policy = cors.resolveCorsPolicy(req, {
      hostedAllowedOrigins: "https://docs.example.test",
      allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "x-webhook-token", "idempotency-key"],
    });
    const headers = policy.headers;

    expect(policy.allowed).toBe(true);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://docs.example.test");
    expect(headers["Access-Control-Allow-Headers"]).toContain("x-webhook-token");
    expect(headers["Access-Control-Allow-Headers"]).toContain("idempotency-key");
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(headers["Access-Control-Expose-Headers"]).toContain("x-correlation-id");
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    expect(headers.Vary).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );

    const merged = cors.applyCorsHeaders(
      {
        Vary: "Accept-Encoding, Origin",
        "Access-Control-Allow-Origin": "https://upstream.invalid",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Private-Network": "true",
      },
      headers,
    );
    expect(merged.get("vary")).toBe(
      "Accept-Encoding, Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    expect(merged.get("access-control-allow-origin")).toBe(
      "https://docs.example.test",
    );
    expect(merged.get("access-control-allow-credentials")).toBeNull();
    expect(merged.get("access-control-allow-private-network")).toBeNull();

    const wildcardVary = cors.applyCorsHeaders({ Vary: "*" }, headers);
    expect(wildcardVary.get("vary")).toBe("*");
  });

  test("shared edge policy follows the canonical loopback hostname contract", () => {
    for (const hostname of loopbackHostnameContract.accepted) {
      expect(cors.isLoopbackHostname(hostname)).toBe(true);
    }
    for (const hostname of loopbackHostnameContract.rejected) {
      expect(cors.isLoopbackHostname(hostname)).toBe(false);
    }
  });

  test("shared CORS application strips every upstream Access-Control field on denial", () => {
    const merged = cors.applyCorsHeaders(
      {
        Vary: "Accept-Encoding, Origin",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "x-upstream-secret",
        "Access-Control-Allow-Methods": "GET, POST, DELETE",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Expose-Headers": "x-upstream-secret",
        "Access-Control-Max-Age": "999999",
      },
      { Vary: "Origin" },
    );

    expect(
      Array.from(merged.keys()).filter((key) => key.startsWith("access-control-")),
    ).toEqual([]);
    expect(merged.get("vary")).toBe(
      "Accept-Encoding, Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  test("missing Origin remains server-to-server and emits no ACAO", () => {
    const policy = cors.resolveCorsPolicy(
      new Request("https://api.example.test/functions/v1/api-gateway", { method: "POST" }),
      { hostedAllowedOrigins: "https://docs.example.test", allowedMethods: ["POST", "OPTIONS"] },
    );

    expect(policy.allowed).toBe(false);
    expect(policy.isCorsRequest).toBe(false);
    expect(policy.reason).toBe("not_cors");
    expect(policy.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(policy.headers.Vary).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  test.each([
    ["unknown origin", "https://evil.example.test", "https://docs.example.test", "origin_not_allowed"],
    ["hosted HTTP config", "http://docs.example.test", "http://docs.example.test", "invalid_configuration"],
    ["wildcard config", "https://docs.example.test", "*", "invalid_configuration"],
  ])("rejects %s without reflecting ACAO", (_name, origin, hostedAllowedOrigins, reason) => {
    const policy = cors.resolveCorsPolicy(
      new Request("https://api.example.test/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
      { hostedAllowedOrigins, allowedMethods: ["POST", "OPTIONS"] },
    );

    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe(reason);
    expect(policy.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("rejects unconfigured requested methods and headers instead of reflecting them", () => {
    const methodPolicy = cors.resolveCorsPolicy(
      new Request("https://api.example.test/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: {
          origin: "https://docs.example.test",
          "access-control-request-method": "DELETE",
        },
      }),
      { hostedAllowedOrigins: "https://docs.example.test", allowedMethods: ["POST", "OPTIONS"] },
    );
    const headerPolicy = cors.resolveCorsPolicy(
      new Request("https://api.example.test/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: {
          origin: "https://docs.example.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-unconfigured-secret",
        },
      }),
      {
        hostedAllowedOrigins: "https://docs.example.test",
        allowedMethods: ["POST", "OPTIONS"],
        allowedHeaders: ["content-type"],
      },
    );

    expect(methodPolicy.reason).toBe("method_not_allowed");
    expect(headerPolicy.reason).toBe("headers_not_allowed");
    expect(headerPolicy.headers["Access-Control-Allow-Headers"]).toBeUndefined();
  });

  test("local QA requires an explicit loopback origin and a loopback request URL", () => {
    const options = {
      localAllowedOrigins: "http://127.0.0.1:3333",
      allowedMethods: ["POST", "OPTIONS"],
    };
    const local = cors.resolveCorsPolicy(
      new Request("http://127.0.0.1:54321/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:3333", "access-control-request-method": "POST" },
      }),
      options,
    );
    const hosted = cors.resolveCorsPolicy(
      new Request("https://project.supabase.co/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:3333",
          "access-control-request-method": "POST",
          "x-forwarded-host": "127.0.0.1:54321",
        },
      }),
      options,
    );

    expect(local.allowed).toBe(true);
    expect(local.headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:3333");
    expect(hosted.allowed).toBe(false);
    expect(hosted.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test.each([
    [
      "localhost subdomain with trailing dot",
      "http://console.dev.localhost.:3333",
      "http://api.dev.localhost.:54321/functions/v1/api-gateway",
    ],
    [
      "any IPv4 address in 127/8",
      "http://127.42.8.9:3333",
      "http://127.99.1.2:54321/functions/v1/api-gateway",
    ],
    [
      "IPv6 loopback",
      "http://[::1]:3333",
      "http://[::1]:54321/functions/v1/api-gateway",
    ],
    [
      "IPv4-mapped IPv6 loopback",
      "http://[::ffff:7f2a:809]:3333",
      "http://[::ffff:7f63:102]:54321/functions/v1/api-gateway",
    ],
  ])("local QA recognizes %s", (_name, origin, requestUrl) => {
    const policy = cors.resolveCorsPolicy(
      new Request(requestUrl, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
      { localAllowedOrigins: origin, allowedMethods: ["POST", "OPTIONS"] },
    );

    expect(policy.configurationValid).toBe(true);
    expect(policy.localQaAllowed).toBe(true);
    expect(policy.allowed).toBe(true);
    expect(policy.headers["Access-Control-Allow-Origin"]).toBe(origin);
  });

  test.each([
    ["localhost lookalike", "http://localhost.evil.example:3333"],
    ["non-loopback IPv4", "http://128.0.0.1:3333"],
    ["non-loopback mapped IPv6", "http://[::ffff:8000:1]:3333"],
  ])("local QA rejects %s configuration", (_name, origin) => {
    const policy = cors.resolveCorsPolicy(
      new Request("http://127.0.0.1:54321/functions/v1/api-gateway", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
      { localAllowedOrigins: origin, allowedMethods: ["POST", "OPTIONS"] },
    );

    expect(policy.configurationValid).toBe(false);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe("invalid_configuration");
  });

  test.each([
    ["api-gateway", () => apiGatewaySource],
    ["webhook-receiver", () => webhookReceiverSource],
  ])("%s applies shared CORS to preflight and every response", (_name, readSource) => {
    const source = readSource();
    expect(source).toContain(
      'import { applyCorsHeaders, resolveCorsPolicy } from "./_shared/cors.mjs";',
    );
    expect(source).toContain('if (req.method === "OPTIONS")');
    expect(source).toContain("corsHeaders");
    expect(source).toContain("if (!corsPolicy.allowed)");
    expect(source).toContain('status: 204');
    expect(source).toContain('code: "cors_request_denied"');
    expect(source).not.toContain('"access-control-allow-origin": "*"');
    expect(source).not.toContain('"access-control-allow-headers": "authorization');
  });

  test("surface policies keep hosted browser access bounded", () => {
    expect(apiGatewaySource).toContain('readEnv("API_GATEWAY_CORS_ALLOW_ORIGINS")');
    expect(apiGatewaySource).toContain("hostedAllowedOrigins: API_GATEWAY_CORS_ALLOW_ORIGINS");
    expect(webhookReceiverSource).toContain('hostedAllowedOrigins: ""');
    for (const source of [apiGatewaySource, webhookReceiverSource]) {
      expect(source).toContain('readEnv(\n  "PUBLIC_INGRESS_LOCAL_CORS_ALLOW_ORIGINS"');
      expect(source).not.toContain("Access-Control-Allow-Credentials");
    }
  });

  test("both ingress handlers use strict shared DB auth and API-schema RPC routing", () => {
    for (const source of [apiGatewaySource, webhookReceiverSource]) {
      expect(source).toContain("resolveIngressDbAuth({");
      expect(source).toContain("const rpcAuthAttempts = INGRESS_DB_AUTH.authAttempts;");
      expect(source).toContain("invokeSupabaseRpcWithAuthFallback({");
    }
  });

  test("webhook receiver returns a controlled redacted invalid-JSON response", () => {
    expect(webhookReceiverSource).toContain('code: "invalid_json_payload"');
    expect(webhookReceiverSource).toContain('"edge.request.invalid_json"');
    expect(webhookReceiverSource).toContain("path: redactIngressSecretText(req.url)");
    const marker = webhookReceiverSource.indexOf('code: "invalid_json_payload"');
    const invalidJsonBlock = webhookReceiverSource.slice(
      marker,
      webhookReceiverSource.indexOf("const rpcAuthAttempts", marker),
    );
    expect(invalidJsonBlock).not.toContain("rawBody");
    expect(invalidJsonBlock).not.toContain("raw_body");
  });

  test("both ingress handlers preserve functional headers and redact only log contexts", () => {
    expect(apiGatewaySource).toContain("const requestHeaders = normaliseRequestHeaders(req);");
    expect(apiGatewaySource).not.toContain(
      "redactIngressForwardedHeaders(normaliseRequestHeaders(req))",
    );
    expect(webhookReceiverSource).toContain("const normalizedHeaders = requestHeaders;");
    expect(webhookReceiverSource).toContain(
      "headers: redactIngressForwardedHeaders(normalizedHeaders)",
    );
  });

  test("public failures do not expose PostgREST bodies or raw exception messages", () => {
    for (const source of [apiGatewaySource, webhookReceiverSource]) {
      expect(source).not.toContain("rpc_body:");
      expect(source).not.toContain("rpc_message:");
    }
    expect(apiGatewaySource).not.toContain('{ error: "Upstream dispatch error", message }');
    expect(webhookReceiverSource).toContain('{ error: "Internal server error" }');
  });

});
