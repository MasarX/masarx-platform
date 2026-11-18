import { render } from "@testing-library/react";
import { reportUiEvent } from "@masarx/ui/client";
import { UiTelemetryReporter } from "../../apps/shared/ui-telemetry";

const createEvent = (suffix: string, messageLength = 90) => ({
  type: "ui.performance",
  timestamp: "2026-02-19T00:00:00.000Z",
  message: `payload-${suffix}`.padEnd(messageLength, "x"),
});

const renderReporter = (appBasePath = "/console") =>
  render(<UiTelemetryReporter appBasePath={appBasePath} />);

const setLocationPath = (pathname: string) => {
  window.history.replaceState({}, "", pathname);
};

const setVisibility = (value: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
};

let fetchMock: jest.Mock;
let originalFetch: typeof fetch;
let originalNodeEnv: string | undefined;
let originalSendBeacon: Navigator["sendBeacon"] | undefined;
let sendBeaconMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  setLocationPath("/");
  setVisibility("visible");
  originalFetch = global.fetch;
  fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "info").mockImplementation(() => {});
  originalNodeEnv = process.env.NODE_ENV;
  originalSendBeacon = navigator.sendBeacon;
  sendBeaconMock = jest.fn().mockReturnValue(true);
  (navigator as Navigator & { sendBeacon: jest.Mock }).sendBeacon = sendBeaconMock;
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "0";
  process.env.NEXT_PUBLIC_UI_EVENT_BATCH_SIZE = "100";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "220";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalNodeEnv !== undefined) {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalSendBeacon) {
    (navigator as Navigator & { sendBeacon: Navigator["sendBeacon"] }).sendBeacon = originalSendBeacon;
  } else {
    Reflect.deleteProperty(navigator, "sendBeacon");
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("flushes oversized telemetry batches into multiple requests", () => {
  const { unmount } = renderReporter();

  reportUiEvent(createEvent("a", 120));
  reportUiEvent(createEvent("b", 120));
  reportUiEvent(createEvent("c", 120));

  jest.advanceTimersByTime(0);

  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const call of fetchMock.mock.calls) {
    const request = call[1];
    const body = request?.body;
    expect(typeof body).toBe("string");
    const payload = JSON.parse(body as string);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events).toHaveLength(1);
  }

  unmount();
});

test("flushes a compact batch in a single request", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  process.env.NEXT_PUBLIC_UI_EVENT_BATCH_SIZE = "2";
  const { unmount } = renderReporter();

  reportUiEvent(createEvent("a"));
  reportUiEvent(createEvent("b"));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0]?.[1];
  const body = request?.body;
  expect(typeof body).toBe("string");
  const payload = JSON.parse(body as string);
  expect(payload.events).toHaveLength(2);
  expect(jest.getTimerCount()).toBe(0);

  unmount();
});

test("flushes pending events during unmount", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  const { unmount } = renderReporter();

  reportUiEvent(createEvent("final"));
  unmount();

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("uses configured base path for the telemetry endpoint when active on current location", () => {
  setLocationPath("/portal/resources/shipments");
  const { unmount } = renderReporter("/portal");

  reportUiEvent(createEvent("safe-base"));
  jest.advanceTimersByTime(0);

  const fetchUrl = fetchMock.mock.calls[0]?.[0];
  expect(fetchUrl).toBe("/portal/api/ui-event");

  unmount();
});

test("uses inspectable keepalive fetch for scheduled production flushes", () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  setLocationPath("/console/resources/shipments");
  const { unmount } = renderReporter("/console");

  reportUiEvent(createEvent("fetch-correlation"));
  jest.advanceTimersByTime(0);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sendBeaconMock).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      keepalive: true,
      headers: expect.objectContaining({
        "x-request-id": expect.any(String),
      }),
    })
  );

  unmount();
});

describe.each(["hidden", "unmount"] as const)("same-origin %s telemetry transport", (closePath) => {
  test.each([
    ["/console", "/console/resources/shipments", "/console/api/ui-event"],
    ["/portal", "/portal/resources/shipments", "/portal/api/ui-event"],
    ["https://unrelated.example/console", "/console/resources/shipments", "/api/ui-event"],
    ["//unrelated.example/portal", "/portal/resources/shipments", "/api/ui-event"],
  ])("keeps active and pending-close events local for base path %s", (basePath, pathname, endpoint) => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
    setLocationPath(pathname);
    const { unmount } = renderReporter(basePath);

    reportUiEvent(createEvent("active"));
    jest.advanceTimersByTime(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl, request] = fetchMock.mock.calls[0] ?? [];
    const activeUrl = new URL(fetchUrl as string, window.location.href);
    expect(activeUrl.origin).toBe(window.location.origin);
    expect(activeUrl.pathname).toBe(endpoint);
    expect(request).toEqual(expect.objectContaining({
      method: "POST", credentials: "include", keepalive: true,
    }));
    const requestId = request.headers["x-request-id"] as string;
    expect(requestId).toEqual(expect.any(String));
    expect(requestId).not.toBe("");

    reportUiEvent(createEvent("pending-close"));
    if (closePath === "hidden") {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    } else {
      unmount();
    }

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [beaconUrl, body] = sendBeaconMock.mock.calls[0] ?? [];
    const closeUrl = new URL(beaconUrl as string, window.location.href);
    expect(closeUrl.origin).toBe(window.location.origin);
    expect(closeUrl.pathname).toBe(endpoint);
    expect(closeUrl.searchParams.get("request_id")).toBe(requestId);
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/json");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (closePath === "hidden") unmount();
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  });
});

test("flushes hidden-page events with sendBeacon outside production", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  const { unmount } = renderReporter("/portal");

  reportUiEvent(createEvent("hidden-state"));
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sendBeaconMock.mock.calls[0]?.[0]).toMatch(
    /^\/api\/ui-event\?request_id=/
  );

  unmount();
});

test("pagehide flushes pending events and cancels the scheduled timer", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  setLocationPath("/portal/resources/shipments");
  const { unmount } = renderReporter("/portal");

  reportUiEvent(createEvent("pagehide"));
  expect(jest.getTimerCount()).toBe(1);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(sendBeaconMock.mock.calls[0]?.[0]).toMatch(/^\/portal\/api\/ui-event\?request_id=/);
  expect(jest.getTimerCount()).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  unmount();
  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
});

test.each(["test", "production"])(
  "hidden, pagehide and unmount send the queued batch once in %s",
  (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
    const { unmount } = renderReporter();

    reportUiEvent(createEvent("exit-once"));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    unmount();

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("a restored visible page schedules only newly queued events", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  const { unmount } = renderReporter();

  reportUiEvent(createEvent("before-restore", 0));
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));

  setVisibility("visible");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  document.dispatchEvent(new Event("visibilitychange"));
  reportUiEvent(createEvent("after-restore", 0));
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(5000);

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).events).toEqual([
    expect.objectContaining({ message: createEvent("after-restore", 0).message }),
  ]);
  unmount();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("events queued during a pagehide send keep their own scheduled flush", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  const { unmount } = renderReporter();
  sendBeaconMock.mockImplementationOnce(() => {
    reportUiEvent(createEvent("during-send", 0));
    return true;
  });

  reportUiEvent(createEvent("first", 0));
  window.dispatchEvent(new Event("pagehide"));
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(5000);

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body).events).toEqual([
    expect.objectContaining({ message: createEvent("during-send", 0).message }),
  ]);
  unmount();
});

test("a failed in-flight keepalive does not consume events queued after pagehide", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  Reflect.deleteProperty(navigator, "sendBeacon");
  let rejectSend!: (reason: Error) => void;
  fetchMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSend = reject; }));
  const { unmount } = renderReporter();

  reportUiEvent(createEvent("in-flight", 0));
  window.dispatchEvent(new Event("pagehide"));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ keepalive: true }));
  reportUiEvent(createEvent("after-in-flight", 0));
  rejectSend(new Error("offline"));
  await Promise.resolve();
  jest.advanceTimersByTime(5000);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body).events)).toEqual([
    [expect.objectContaining({ message: createEvent("in-flight", 0).message })],
    [expect.objectContaining({ message: createEvent("after-in-flight", 0).message })],
  ]);
  expect(sendBeaconMock).not.toHaveBeenCalled();
  unmount();
  expect(jest.getTimerCount()).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("cleanup removes its exact lifecycle listeners and pending timer", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS = "5000";
  const addPageListener = jest.spyOn(window, "addEventListener");
  const removePageListener = jest.spyOn(window, "removeEventListener");
  const addVisibilityListener = jest.spyOn(document, "addEventListener");
  const removeVisibilityListener = jest.spyOn(document, "removeEventListener");
  const { unmount } = renderReporter();
  const pagehideHandler = addPageListener.mock.calls.find(([type]) => type === "pagehide")?.[1];
  const visibilityHandler = addVisibilityListener.mock.calls.find(([type]) => type === "visibilitychange")?.[1];
  expect(pagehideHandler).toEqual(expect.any(Function));
  expect(visibilityHandler).toEqual(expect.any(Function));

  reportUiEvent(createEvent("cleanup"));
  sendBeaconMock.mockImplementationOnce(() => {
    reportUiEvent(createEvent("during-cleanup", 0));
    return true;
  });
  unmount();
  expect(removePageListener).toHaveBeenCalledWith("pagehide", pagehideHandler);
  expect(removeVisibilityListener).toHaveBeenCalledWith("visibilitychange", visibilityHandler);
  expect(jest.getTimerCount()).toBe(0);
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pagehide"));
  jest.advanceTimersByTime(5000);
  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("falls back to the default telemetry endpoint when appBasePath is unsafe", () => {
  const { unmount } = renderReporter("javascript:alert(1)");

  reportUiEvent(createEvent("unsafe-base"));
  jest.advanceTimersByTime(0);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const fetchUrl = fetchMock.mock.calls[0]?.[0];
  expect(fetchUrl).toBe("/api/ui-event");

  unmount();
});

test("falls back to root telemetry endpoint when configured base path is not active", () => {
  setLocationPath("/resources/shipments");
  const { unmount } = renderReporter("/portal");

  reportUiEvent(createEvent("inactive-base"));
  jest.advanceTimersByTime(0);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const fetchUrl = fetchMock.mock.calls[0]?.[0];
  expect(fetchUrl).toBe("/api/ui-event");

  unmount();
});
