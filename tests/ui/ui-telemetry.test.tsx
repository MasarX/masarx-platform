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

let fetchMock: jest.Mock;
let originalFetch: typeof fetch;
let consoleInfoSpy: jest.SpyInstance;
let originalNodeEnv: string | undefined;
let originalSendBeacon: Navigator["sendBeacon"] | undefined;
let sendBeaconMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  setLocationPath("/");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  originalFetch = global.fetch;
  fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
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
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (navigator as Navigator & { sendBeacon?: Navigator["sendBeacon"] }).sendBeacon;
  }
  jest.useRealTimers();
  consoleInfoSpy.mockRestore();
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

test("adds request_id to sendBeacon endpoint in production mode", () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  setLocationPath("/console/resources/shipments");
  const { unmount } = renderReporter("/console");

  reportUiEvent(createEvent("beacon-correlation"));
  jest.advanceTimersByTime(0);

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  const beaconUrl = sendBeaconMock.mock.calls[0]?.[0];
  expect(beaconUrl).toMatch(/^\/console\/api\/ui-event\?request_id=/);

  unmount();
});

test("flushes hidden-page events with sendBeacon outside production", () => {
  process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES = "5000";
  const { unmount } = renderReporter("/portal");

  reportUiEvent(createEvent("hidden-state"));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));

  expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();

  unmount();
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
