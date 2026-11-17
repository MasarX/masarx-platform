import { NextRequest } from "next/server";
import {
  addRequestIdHeader,
  getRequestIdFromHeaders,
  jsonResponseWithRequestId,
  redirectWithRequestId,
} from "../../apps/shared/request-meta";

describe("request-meta helpers", () => {
  test("getRequestIdFromHeaders uses provided x-request-id", () => {
    const request = {
      headers: {
        get: () => "test-req-123",
      },
    } as NextRequest;

    expect(getRequestIdFromHeaders(request)).toBe("test-req-123");
  });

  test("getRequestIdFromHeaders falls back to request_id query param", () => {
    const request = {
      url: "https://example.test/path?request_id=query-req-777",
      headers: {
        get: () => null,
      },
    } as NextRequest;

    expect(getRequestIdFromHeaders(request)).toBe("query-req-777");
  });

  test("getRequestIdFromHeaders supports x-correlation and x-correlation-id headers", () => {
    const requestWithLegacy = {
      headers: {
        get: (name: string) =>
          name === "x-correlation-id" ? "corr-id-header" : null,
      },
    } as NextRequest;

    const requestWithAlias = {
      headers: {
        get: (name: string) =>
          name === "x-correlation" ? "corr-header" : null,
      },
    } as NextRequest;

    expect(getRequestIdFromHeaders(requestWithLegacy)).toBe("corr-id-header");
    expect(getRequestIdFromHeaders(requestWithAlias)).toBe("corr-header");
  });

  test("getRequestIdFromHeaders generates fallback when header missing", () => {
    const request = {
      headers: {
        get: () => null,
      },
    } as NextRequest;

    expect(typeof getRequestIdFromHeaders(request)).toBe("string");
    expect(getRequestIdFromHeaders(request)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  test("addRequestIdHeader preserves request-id and existing headers", () => {
    const headers = addRequestIdHeader({ "x-feature": "enabled" }, "r-1");

    expect(headers).toMatchObject({
      "x-feature": "enabled",
      "x-request-id": "r-1",
    });
  });

  test("getRequestIdFromHeaders trims whitespace", () => {
    const request = {
      headers: {
        get: () => "  test-req-123  ",
      },
    } as NextRequest;

    expect(getRequestIdFromHeaders(request)).toBe("test-req-123");
  });

  test("addRequestIdHeader preserves request-id if provided", () => {
    const headers = addRequestIdHeader(
      { "x-feature": "enabled", "x-request-id": "old" },
      "new"
    );

    expect(headers).toMatchObject({
      "x-feature": "enabled",
      "x-request-id": "new",
    });
  });

  test("jsonResponseWithRequestId returns header with x-request-id", async () => {
    const response = jsonResponseWithRequestId({ ok: true }, 200, "r-json");
    expect(response.headers.get("x-request-id")).toBe("r-json");
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("redirectWithRequestId returns header with x-request-id", () => {
    const response = redirectWithRequestId(
      "https://example.com/console/workflows",
      "r-redirect",
      302
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("x-request-id")).toBe("r-redirect");
    expect(response.headers.get("location")).toBe(
      "https://example.com/console/workflows"
    );
  });
});
