import type { Page, Request, Response } from "@playwright/test";

jest.mock("@playwright/test", () => ({ expect: { poll: jest.fn() } }));

import { captureViewSaveDiagnostics, type UiEventPayload } from "../../e2e/utils/ui-events";

function harness() {
  const listeners = new Map<string, Set<(value: never) => unknown>>();
  const page = {
    on(event: string, listener: (value: never) => unknown) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: (value: never) => unknown) {
      listeners.get(event)?.delete(listener);
    },
  } as unknown as Page;
  const events: UiEventPayload[] = [];
  const requestEvents: UiEventPayload[] = [];
  const emit = async (event: string, value: unknown) => {
    await Promise.all(Array.from(listeners.get(event) ?? [], (listener) => listener(value as never)));
  };
  const rpc = (options: {
    status?: number; body?: unknown; length?: string | null;
    url?: string; method?: string; bodyError?: boolean;
  } = {}) => {
    const body = options.body ?? {};
    const response = {
      request: () => request,
      status: () => options.status ?? 200,
      headerValue: jest.fn(async () => options.length === undefined ? String(JSON.stringify(body).length) : options.length),
      json: jest.fn(async () => {
        if (options.bodyError) throw new Error("https://private.invalid/?token=secret");
        return body;
      }),
    } as unknown as Response;
    const request = {
      method: () => options.method ?? "POST",
      url: () => options.url ?? "https://private.invalid/rest/v1/rpc/request_settings_change_v1?token=secret",
      response: async () => response,
      postData: jest.fn(() => { throw new Error("Request bodies must not be read"); }),
      failure: jest.fn(() => { throw new Error("Raw failure text must not be read"); }),
    } as unknown as Request;
    return { request, response };
  };
  return { page, events, requestEvents, emit, rpc, listeners };
}

describe("saved-view failure diagnostics", () => {
  let output: jest.SpyInstance;
  beforeEach(() => { output = jest.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => { output.mockRestore(); });
  const diagnostic = () => JSON.parse(output.mock.calls[0][1]);

  it("keeps the success path silent and removes all owned listeners", async () => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "private-resource");
    const { request, response } = h.rpc();
    await h.emit("request", request);
    await h.emit("response", response);
    await h.emit("requestfinished", request);
    observer.stop();
    expect(output).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(Array.from(h.listeners.values()).every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("retains rejected RPC and error-event shape while excluding private data", async () => {
    const h = harness();
    const secret = "private@example.invalid +12025550123 entered-view-label bearer-secret";
    h.events.push({ type: "ui.table.view.save", context: "old-event" });
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, secret);
    const { request, response } = h.rpc({ status: 403, body: { code: "42501", message: secret, details: secret, hint: secret } });
    await h.emit("request", request);
    await h.emit("response", response);
    await h.emit("requestfinished", request);
    h.requestEvents.push({ type: "ui.table.view.save.error", context: secret, timestamp: secret, name: secret, digest: secret, meta: { secret } });
    const original = new Error(secret);
    expect(() => observer.fail(original)).toThrow(original);
    expect(output).toHaveBeenCalledTimes(1);
    expect(diagnostic()).toEqual({
      schema_version: 1, click_completed: true, rpc_started: 1, rpc_pending: 0,
      rpc: [{ status: 403, finished: true, failed: false, error_code: "42501", error_code_redacted: false, error_detail_unavailable: false }],
      events: [{ source: "request", type: "ui.table.view.save.error", context_present: true, context_matches: true, timestamp_present: true }],
      truncated: false,
    });
    const serialized = JSON.stringify(output.mock.calls);
    for (const privateText of [secret, "private.invalid", "token=secret", "message", "details", "hint", "old-event"]) {
      expect(serialized).not.toContain(privateText);
    }
    expect(request.postData).not.toHaveBeenCalled();
    expect(request.failure).not.toHaveBeenCalled();
  });

  it("distinguishes pending, failed and completed RPCs and mismatched event context", async () => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "selected-private-resource");
    const pending = h.rpc();
    const failed = h.rpc();
    const completed = h.rpc();
    for (const item of [pending, failed, completed]) await h.emit("request", item.request);
    await h.emit("requestfailed", failed.request);
    await h.emit("response", completed.response);
    await h.emit("requestfinished", completed.request);
    h.events.push({ type: "ui.table.view.save", context: "different-private-resource", timestamp: "private-time" });
    const failure = { private: "original non-Error rejection" };
    try { observer.fail(failure); } catch (error) { expect(error).toBe(failure); }
    expect(diagnostic().rpc_pending).toBe(1);
    expect(diagnostic().rpc.map((entry: { finished: boolean; failed: boolean }) => [entry.finished, entry.failed]))
      .toEqual([[false, false], [false, true], [true, false]]);
    expect(diagnostic().events[0]).toMatchObject({ context_present: true, context_matches: false });
    expect(JSON.stringify(output.mock.calls)).not.toContain("private");
  });

  it.each([null, "", "invalid", "16385"])("does not read an unbounded error body (%p)", async (length) => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "resource");
    const { request, response } = h.rpc({ status: 400, length });
    await h.emit("request", request);
    await h.emit("response", response);
    await h.emit("requestfinished", request);
    expect(() => observer.fail(null)).toThrow();
    expect(response.json).not.toHaveBeenCalled();
    expect(diagnostic().rpc[0].error_detail_unavailable).toBe(true);
  });

  it.each(["https://private.invalid/?token=secret", { toString: () => "42501" }])("redacts arbitrary error codes", async (code) => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "resource");
    const { request, response } = h.rpc({ status: 400, body: { code } });
    await h.emit("request", request);
    await h.emit("response", response);
    await h.emit("requestfinished", request);
    try { observer.fail(null); } catch { /* Original null rejection. */ }
    expect(diagnostic().rpc[0]).toMatchObject({ error_code: null, error_code_redacted: true });
    expect(JSON.stringify(output.mock.calls)).not.toContain("secret");
  });

  it("bounds RPC/event entries and ignores other methods or endpoints", async () => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "resource");
    for (const options of [{ method: "GET" }, { url: "https://private.invalid/rest/v1/rpc/other" }, { url: "invalid" }]) {
      await h.emit("request", h.rpc(options).request);
    }
    for (let i = 0; i < 20; i += 1) {
      await h.emit("request", h.rpc().request);
      h.events.push({ type: "ui.table.view.save", context: "private-context" });
    }
    try { observer.fail(undefined); } catch { /* Original undefined rejection. */ }
    expect(diagnostic().rpc_started).toBe(16);
    expect(diagnostic().rpc).toHaveLength(16);
    expect(diagnostic().events).toHaveLength(16);
    expect(diagnostic().truncated).toBe(true);
    expect(JSON.stringify(output.mock.calls)).not.toContain("private");
    expect(JSON.stringify(output.mock.calls).length).toBeLessThan(6_000);
  });

  it("keeps the original failure when response parsing or diagnostic output fails", async () => {
    const h = harness();
    const observer = captureViewSaveDiagnostics(h.page, h.events, h.requestEvents, "resource");
    const { request, response } = h.rpc({ status: 400, bodyError: true });
    await h.emit("request", request);
    await h.emit("response", response);
    await h.emit("requestfinished", request);
    const original = new Error("original required assertion");
    output.mockImplementation(() => { throw new Error("private diagnostic failure"); });
    expect(() => observer.fail(original)).toThrow(original);
    expect(Array.from(h.listeners.values()).every((listeners) => listeners.size === 0)).toBe(true);
  });
});
