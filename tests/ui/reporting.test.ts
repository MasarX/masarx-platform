import {
  buildScopeMeta,
  reportClientError,
  reportUiEvent,
  resolveScopeDigest,
  setUiReporter,
  setRequestId,
} from "../../packages/ui/src/reporting";

afterEach(() => {
  setUiReporter(null);
  setRequestId(null);
});

test("buildScopeMeta returns undefined for empty input", () => {
  expect(buildScopeMeta(null)).toBeUndefined();
  expect(buildScopeMeta({})).toBeUndefined();
});

test("buildScopeMeta trims and filters scope values", () => {
  const meta = buildScopeMeta({
    settingsResolutionId: "  res-1 ",
    scopeType: " tenant ",
    scopeId: " scope-123 ",
    scopeValue: "org-a",
  });
  expect(meta).toEqual({
    settingsResolutionId: "res-1",
    scopeType: "tenant",
    scopeId: "scope-123",
    scopeValue: "org-a",
  });
});

test("resolveScopeDigest uses settings resolution id", () => {
  expect(resolveScopeDigest(null)).toBeUndefined();
  expect(resolveScopeDigest({ settingsResolutionId: "  res-99 " })).toBe(
    "res-99"
  );
});

test("reportUiEvent uses active reporter", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportUiEvent({
    type: "ui.test",
    timestamp: "2026-01-15T00:00:00.000Z",
    name: "sample",
  });
  expect(reporter).toHaveBeenCalledTimes(1);
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ui.test", name: "sample" })
  );
});

test("reportUiEvent uses active request-id context", () => {
  const reporter = jest.fn();
  setRequestId("req-123");
  setUiReporter(reporter);
  reportUiEvent({
    type: "ui.test",
    timestamp: "2026-01-15T00:00:00.000Z",
    name: "sample",
  });
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "req-123",
      meta: expect.objectContaining({ requestId: "req-123" }),
    })
  );
});

test("reportClientError emits structured ui.error event", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportClientError(new Error("boom"), { context: "unit-test", digest: "r1" });
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.error",
      context: "unit-test",
      digest: "r1",
      message: "boom",
    })
  );
});

test("reportClientError accepts explicit request id", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportClientError(new Error("boom"), {
    context: "unit-test",
    digest: "r1",
    requestId: "req-321",
  });
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.error",
      requestId: "req-321",
      meta: expect.objectContaining({ requestId: "req-321" }),
    })
  );
});

test("reportClientError redacts sensitive strings", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportClientError(
    new Error("token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"),
    { context: "unit-test", digest: "r2" }
  );
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.error",
      context: "unit-test",
      digest: "r2",
      message: expect.stringContaining("[redacted]"),
    })
  );
});

test("reportClientError retains sanitized technical diagnosis rather than the presentation fallback", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportClientError(new Error("Backend statement timeout; token=synthetic-short"));
  expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
    message: "Backend statement timeout; token=[redacted]",
  }));
});

test("reportClientError redacts every cookie in a header while retaining diagnosis", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  reportClientError(new Error("Backend statement timeout\nCookie: session=synthetic-first; sid=synthetic-second"));
  expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
    message: "Backend statement timeout\nCookie: [redacted]",
  }));
  expect(JSON.stringify(reporter.mock.calls)).not.toContain("synthetic-");
});

test("reportUiEvent logs safe metadata in non-production mode", () => {
  const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  reportUiEvent({
    type: "ui.error",
    timestamp: "2026-01-15T00:00:00.000Z",
    context: "unit-test",
    name: "sample",
    message: "token=top-secret",
    meta: { requestId: "existing", token: "secret" },
    requestId: "explicit",
  });

  expect(infoSpy).toHaveBeenCalledTimes(1);
  const payload = infoSpy.mock.calls[0]?.[1];
  expect(payload).toMatchObject({
    type: "ui.error",
    context: "unit-test",
    name: "sample",
    requestId: "explicit",
  });
  expect(payload).not.toHaveProperty("message");
  expect(payload).not.toHaveProperty("meta");
  expect(JSON.stringify(payload)).not.toContain("top-secret");
  expect(JSON.stringify(payload)).not.toContain("secret");
  infoSpy.mockRestore();
});

test("reportUiEvent redacts sensitive metadata before active reporter receives it", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  setRequestId("req-active");
  reportUiEvent({
    type: "ui.test",
    timestamp: "2026-01-15T00:00:00.000Z",
    context: "security",
    name: "token-flow",
    message: "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    meta: {
      token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      scopeType: "tenant",
      scopeId: "tenant-1",
      api_key: "abc123",
      details: {
        refresh_token: "refresh_secret",
      },
    },
    digest: "r-secure",
  });

  expect(reporter).toHaveBeenCalledTimes(1);
  const payload = reporter.mock.calls[0]?.[0];
  expect(payload).toMatchObject({
    type: "ui.test",
    requestId: "req-active",
    meta: expect.objectContaining({
      requestId: "req-active",
      scopeType: "tenant",
      scopeId: "tenant-1",
    }),
  });
  expect(payload.meta).toEqual(
    expect.objectContaining({
      token: "[redacted]",
      api_key: "[redacted]",
    })
  );
  expect(payload.message).toEqual(expect.stringContaining("[redacted]"));
  expect(JSON.stringify(payload)).not.toContain(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
  );
});

test("reportUiEvent preserves canonical UUID metadata while redacting secrets", () => {
  const reporter = jest.fn();
  const uuid = "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c";
  setUiReporter(reporter);
  setRequestId(uuid);

  reportUiEvent({
    type: "ui.test",
    timestamp: "2026-01-15T00:00:00.000Z",
    name: "uuid-flow",
    digest: uuid,
    meta: {
      settingsResolutionId: uuid,
      scopeId: uuid,
      token: uuid,
    },
  });

  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      digest: uuid,
      requestId: uuid,
      meta: expect.objectContaining({
        requestId: uuid,
        settingsResolutionId: uuid,
        scopeId: uuid,
        token: "[redacted]",
      }),
    }),
  );
});
