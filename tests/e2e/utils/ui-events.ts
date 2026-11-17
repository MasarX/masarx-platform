import { expect, type Page, type Request, type Response } from "@playwright/test";

export type UiEventPayload = {
  type?: string;
  timestamp?: string;
  context?: string;
  name?: string;
  digest?: string;
  meta?: Record<string, unknown>;
};

export function captureUiEvents(page: Page) {
  const events: UiEventPayload[] = [];
  page.on("console", async (msg) => {
    if (msg.type() !== "info") return;
    const args = msg.args();
    if (args.length < 2) return;
    const label = await args[0].jsonValue().catch(() => null);
    if (label !== "[ui-event]") return;
    const payload = await args[1].jsonValue().catch(() => null);
    if (payload && typeof payload === "object") {
      events.push(payload as UiEventPayload);
    }
  });
  return events;
}

export function captureUiEventRequests(page: Page) {
  const events: UiEventPayload[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = request.url();
    if (!url.includes("/api/ui-event")) return;
    const body = request.postData();
    if (!body) return;
    try {
      const parsed = JSON.parse(body) as {
        events?: UiEventPayload[];
        event?: UiEventPayload;
      };
      if (Array.isArray(parsed?.events)) {
        events.push(...parsed.events);
        return;
      }
      if (parsed?.event) {
        events.push(parsed.event);
      }
    } catch (_error) {
      return;
    }
  });
  return events;
}

export async function waitForUiEvent(
  events: UiEventPayload[] | UiEventPayload[][],
  predicate: (event: UiEventPayload) => boolean,
  options: { timeout?: number; required?: boolean } = {}
) {
  const buckets =
    Array.isArray(events) &&
    events.length > 0 &&
    Array.isArray(events[0])
      ? (events as UiEventPayload[][])
      : ([events] as UiEventPayload[][]);
  const findMatch = () => {
    for (const bucket of buckets) {
      const event = bucket.find(predicate);
      if (event) return event;
    }
    return null;
  };
  const timeout = options.timeout ?? 5_000;
  const required = options.required ?? true;
  if (required) {
    await expect.poll(findMatch, { timeout }).not.toBeNull();
    return findMatch();
  }

  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const match = findMatch();
    if (match) return match;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return null;
}

// Only bounded enums, numbers and booleans leave this observer. Never emit RPC
// URLs, payloads, error messages, view names or resource/user identifiers.
export function captureViewSaveDiagnostics(
  page: Page,
  events: UiEventPayload[],
  requestEvents: UiEventPayload[],
  resourceKey: string
) {
  const limit = 16;
  const errorCodes = new Set([
    "22023", "22P02", "23502", "23503", "23505", "42501", "P0001",
    "PGRST202", "PGRST301", "PGRST302", "PGRST303",
  ]);
  const offsets = [events.length, requestEvents.length];
  const requests = new Map<Request, {
    status: number | null;
    finished: boolean;
    failed: boolean;
    error_code: string | null;
    error_code_redacted: boolean;
    error_detail_unavailable: boolean;
  }>();
  let truncated = false;
  let stopped = false;
  const onRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    try {
      if (new URL(request.url()).pathname !== "/rest/v1/rpc/request_settings_change_v1") return;
    } catch {
      return;
    }
    if (requests.size === limit) {
      truncated = true;
      return;
    }
    requests.set(request, {
      status: null, finished: false, failed: false, error_code: null,
      error_code_redacted: false, error_detail_unavailable: false,
    });
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    const status = response.status();
    if (entry && Number.isInteger(status) && status >= 100 && status <= 599) {
      entry.status = status;
    }
  };
  const onFinished = async (request: Request) => {
    const entry = requests.get(request);
    if (!entry) return;
    entry.finished = true;
    if (entry.status === null || entry.status < 400) return;
    entry.error_detail_unavailable = true;
    try {
      const response = await request.response();
      const length = Number(await response?.headerValue("content-length"));
      // Do not read unknown-size or large private response bodies for diagnostics.
      if (!response || !Number.isInteger(length) || length <= 0 || length > 16_384) return;
      const body: unknown = await response.json();
      if (stopped) return;
      const code = body && typeof body === "object" && "code" in body
        ? (body as { code?: unknown }).code : undefined;
      entry.error_code = typeof code === "string" && errorCodes.has(code) ? code : null;
      entry.error_code_redacted = code !== undefined && entry.error_code === null;
      entry.error_detail_unavailable = false;
    } catch {
      // Raw transport/parser errors can contain private URLs or payloads.
    }
  };
  const onFailed = (request: Request) => {
    const entry = requests.get(request);
    if (entry) entry.failed = true;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  const stop = () => {
    stopped = true;
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
  return {
    stop,
    fail(error: unknown): never {
      try {
        const safeEvents: Array<{
          source: "console" | "request";
          type: "ui.table.view.save" | "ui.table.view.save.error";
          context_present: boolean;
          context_matches: boolean;
          timestamp_present: boolean;
        }> = [];
        [events, requestEvents].forEach((bucket, index) => {
          for (let i = offsets[index]; i < bucket.length; i += 1) {
            const event = bucket[i];
            if (event.type !== "ui.table.view.save" && event.type !== "ui.table.view.save.error") continue;
            if (safeEvents.length === limit) { truncated = true; break; }
            safeEvents.push({
              source: index === 0 ? "console" : "request",
              type: event.type,
              context_present: typeof event.context === "string" && event.context.length > 0,
              context_matches: event.context === resourceKey,
              timestamp_present: typeof event.timestamp === "string" && event.timestamp.length > 0,
            });
          }
        });
        const rpc = Array.from(requests.values());
        console.info("[view-save-diagnostic]", JSON.stringify({
          schema_version: 1,
          click_completed: true,
          rpc_started: rpc.length,
          rpc_pending: rpc.filter((entry) => !entry.finished && !entry.failed).length,
          rpc,
          events: safeEvents,
          truncated,
        }));
      } catch {
        // Diagnostics must never replace the original required assertion failure.
      } finally {
        stop();
      }
      throw error;
    },
  };
}
