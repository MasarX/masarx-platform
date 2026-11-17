import { expect, type Page } from "@playwright/test";

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
