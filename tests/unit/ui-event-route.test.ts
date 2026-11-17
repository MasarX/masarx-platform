const rpc = jest.fn();
const getVerifiedAccessToken = jest.fn();
const validateTrustedBrowserRequest = jest.fn();

jest.mock("@masarx/auth", () => ({
  getVerifiedAccessToken,
  validateTrustedBrowserRequest,
}));
import {
  enrichWithRequestId,
  parseEventPayload,
  normalizeUiEvent,
  sanitizeEventMetadata,
  handleUiEventRequest,
} from "../../apps/shared/ui-event-route";
import { POST as consolePost } from "../../apps/console/app/api/ui-event/route";
import { POST as portalPost } from "../../apps/portal/app/api/ui-event/route";

describe("ui-event route handler", () => {
  beforeEach(() => {
    rpc.mockReset();
    getVerifiedAccessToken.mockReset();
    validateTrustedBrowserRequest.mockReset();
    rpc.mockResolvedValue({ error: null });
    validateTrustedBrowserRequest.mockReturnValue({ ok: true });
  });

  test("returns a response with correlation header when request-id header is provided", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const response = await handleUiEventRequest(
      "console",
      new Request("https://example.test/console/api/ui-event", {
        method: "POST",
        headers: {
          "x-request-id": "capture-req-123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: { type: "ui.click" } }),
      })
    );

    expect(getVerifiedAccessToken).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "ui_log_events_v1",
      expect.objectContaining({
        p_app: "console",
        p_events: expect.arrayContaining([
          expect.objectContaining({ type: "ui.click", requestId: "capture-req-123" }),
        ]),
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("capture-req-123");
  });

  test("uses request_id query parameter for correlation when request-id header is missing", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const response = await handleUiEventRequest(
      "console",
      new Request(
        "https://example.test/console/api/ui-event?request_id=query-req-456",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: { type: "ui.click" } }),
        }
      )
    );

    expect(rpc).toHaveBeenCalledWith(
      "ui_log_events_v1",
      expect.objectContaining({
        p_app: "console",
        p_events: expect.arrayContaining([
          expect.objectContaining({ type: "ui.click", requestId: "query-req-456" }),
        ]),
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("query-req-456");
  });

  test("returns method not allowed for non-POST requests", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const response = await handleUiEventRequest(
      "console",
      new Request("https://example.test/console/api/ui-event", {
        method: "GET",
      })
    );

    expect(response.status).toBe(405);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Method not allowed.");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("returns bad request for malformed JSON payload", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const response = await handleUiEventRequest(
      "portal",
      new Request("https://example.test/portal/api/ui-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad json",
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Invalid payload.");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("returns too many events when payload contains more events than allowed", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const events = Array.from({ length: 201 }, () => ({ type: "ui.too-many" }));

    const response = await handleUiEventRequest(
      "portal",
      new Request("https://example.test/portal/api/ui-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      })
    );

    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Too many events.");
    expect(rpc).not.toHaveBeenCalledWith("ui_log_events_v1", expect.anything());
  });

  test("propagates generated request correlation when request-id is missing", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });

    const response = await handleUiEventRequest(
      "portal",
      new Request("https://example.test/portal/api/ui-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { type: "ui.view" } }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")?.length).toBeGreaterThan(0);
  });

  test("returns unauthorized responses with correlation id header when session is absent", async () => {
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: null,
      accessToken: null,
      error: null,
    });

    const response = await handleUiEventRequest(
      "console",
      new Request("https://example.test/console/api/ui-event", {
        method: "POST",
        headers: {
          "x-request-id": "unauth-req-321",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: { type: "ui.click" } }),
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("unauth-req-321");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("rejects untrusted browser requests before auth lookup", async () => {
    validateTrustedBrowserRequest.mockReturnValueOnce({
      ok: false,
      status: 403,
      code: "cross_site_request_rejected",
      message: "Cross-site browser request rejected.",
    });

    const response = await handleUiEventRequest(
      "console",
      new Request("https://example.test/console/api/ui-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { type: "ui.click" } }),
      })
    );

    expect(response.status).toBe(403);
    expect(getVerifiedAccessToken).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    app: "console",
    post: consolePost,
  },
  {
    app: "portal",
    post: portalPost,
  },
])("ui-event surface route binding ($app)", ({ app, post }) => {
  beforeEach(() => {
    rpc.mockReset();
    getVerifiedAccessToken.mockReset();
    validateTrustedBrowserRequest.mockReset();
    rpc.mockResolvedValue({ error: null });
    validateTrustedBrowserRequest.mockReturnValue({ ok: true });
    getVerifiedAccessToken.mockResolvedValue({
      client: { rpc },
      user: { id: "user-1" },
      accessToken: "token",
      error: null,
    });
  });

  test("forwards app context to shared handler and preserves x-request-id", async () => {
    const response = await post(
      new Request(`https://example.test/${app}/api/ui-event`, {
        method: "POST",
        headers: {
          "x-request-id": "app-route-req",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: { type: "ui.click" } }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("app-route-req");
    expect(rpc).toHaveBeenCalledWith(
      "ui_log_events_v1",
      expect.objectContaining({ p_app: app })
    );
  });

  test("returns method-not-allowed for non-POST requests with app binding preserved", async () => {
    const response = await post(
      new Request(`https://example.test/${app}/api/ui-event`, {
        method: "GET",
        headers: { "x-request-id": "app-route-method-block" },
      })
    );

    expect(response.status).toBe(405);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Method not allowed.");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("ui-event route helpers", () => {
  test("parseEventPayload accepts event arrays", () => {
    expect(
      parseEventPayload([
        { type: "ui.test", message: "x" },
        { type: "ui.test2" },
      ])
    ).toEqual([
      { type: "ui.test", message: "x" },
      { type: "ui.test2" },
    ]);
  });

  test("parseEventPayload accepts wrapped object payloads", () => {
    expect(
      parseEventPayload({
        events: [{ type: "ui.test", message: "x" }],
        event: { type: "ui.shadow" },
      })
    ).toEqual([{ type: "ui.test", message: "x" }]);

    expect(parseEventPayload({ event: { type: "ui.wrap" } })).toEqual([
      { type: "ui.wrap" },
    ]);
  });

  test("normalizeUiEvent filters and trims event fields", () => {
    expect(
      normalizeUiEvent({
        type: "  ui.test  ",
        message: "  event message  ",
        context: 42,
        meta: {
          token: "should remove",
          scopeType: "scope",
        },
        requestId: "  req-123  ",
      })
    ).toEqual({
      type: "ui.test",
      timestamp: undefined,
      context: undefined,
      name: undefined,
      digest: undefined,
      message: "event message",
      meta: {
        token: "[redacted]",
        scopeType: "scope",
      },
      requestId: "req-123",
    });
  });

  test("normalizeUiEvent drops non-object events", () => {
    expect(normalizeUiEvent("bad")).toBe(null);
    expect(normalizeUiEvent(null)).toBe(null);
    expect(normalizeUiEvent(["bad"])).toBe(null);
  });

  test("parseEventPayload + normalizeUiEvent drops invalid event rows", () => {
    const parsed = parseEventPayload({
      events: [{ type: "ui.good" }, { noType: true }, "bad", { type: "   " }],
    });

    expect(parsed).toHaveLength(4);
    const normalized = parsed.map(normalizeUiEvent).filter(Boolean);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ type: "ui.good" });
  });

  test("parseEventPayload returns empty array for unsupported payloads", () => {
    expect(parseEventPayload("invalid")).toEqual([]);
    expect(parseEventPayload(null)).toEqual([]);
    expect(parseEventPayload({ event: null })).toEqual([]);
  });

  test("enrichWithRequestId injects request id into both event and meta", () => {
    const events = enrichWithRequestId(
      [{ type: "ui.test", message: "x" }, { type: "ui.test", meta: { note: "one" } }],
      "req-123"
    );

    expect(events).toEqual([
      {
        type: "ui.test",
        message: "x",
        requestId: "req-123",
        meta: { requestId: "req-123" },
      },
      {
        type: "ui.test",
        requestId: "req-123",
        meta: { note: "one", requestId: "req-123" },
      },
    ]);
  });

  test("enrichWithRequestId preserves event-provided request id when valid", () => {
    const events = enrichWithRequestId(
      [
        {
          type: "ui.test",
          requestId: "evt-456",
          meta: { requestId: "meta-000", token: "should-redact" },
        },
      ],
      "req-123"
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: "evt-456",
    });
    expect(events[0].meta).toMatchObject({
      requestId: "evt-456",
      token: "[redacted]",
    });
  });

  test("sanitizeEventMetadata redacts sensitive keys recursively and caps deep data", () => {
    const sanitized = sanitizeEventMetadata({
      token: "abc",
      nested: {
        Authorization: "Bearer abcdef",
        normal: "keep",
        child: {
          password: "topsecret",
          array: ["value", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.signature"],
        },
      },
    });

    expect(sanitized).toMatchObject({
      token: "[redacted]",
      nested: {
        Authorization: "[redacted]",
        normal: "keep",
        child: {
          password: "[redacted]",
          array: ["value", "[redacted]"],
        },
      },
    });
  });
});
