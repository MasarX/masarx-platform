"use client";

import * as React from "react";
import { createRequestId, setRequestId, setUiReporter } from "@masarx/ui/client";
import { resolveSafeAppBasePath, resolveSafeHref } from "../../packages/ui/src/url-guard";

const REQUEST_ID_HEADER = "x-request-id";

const resolveNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const resolveByteLength = (value: string) => {
  if (typeof TextEncoder === "undefined") {
    return value.length;
  }
  return new TextEncoder().encode(value).byteLength;
};

const createEventPayload = (events: Array<Record<string, unknown>>) => {
  return JSON.stringify({ events });
};

const splitEventBatches = (
  events: Array<Record<string, unknown>>,
  maxBytes: number
) => {
  const batches: Array<Array<Record<string, unknown>>> = [];
  if (events.length === 0 || maxBytes <= 0) return batches;

  let current: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const withEvent = current.length === 0 ? [event] : [...current, event];
    const candidatePayload = createEventPayload(withEvent);
    if (resolveByteLength(candidatePayload) <= maxBytes) {
      current = withEvent;
      continue;
    }

    if (current.length > 0) {
      batches.push(current);
      current = [event];
      const singlePayload = createEventPayload(current);
      if (resolveByteLength(singlePayload) > maxBytes) {
        batches.push(current);
        current = [];
      }
    } else {
      batches.push([event]);
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
};

const normalizeEvent = (
  event: Record<string, unknown>,
  requestId: string
) => {
  const existingMeta = event.meta;
  const meta =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as Record<string, unknown>) }
      : {};
  if (typeof meta.requestId !== "string" || meta.requestId.trim().length === 0) {
    meta.requestId = requestId;
  }
  return { ...event, meta };
};

const appendRequestIdQuery = (endpoint: string, requestId: string) => {
  try {
    const target = new URL(endpoint, window.location.origin);
    target.searchParams.set("request_id", requestId);
    const pathAndQuery = `${target.pathname}${target.search}`;
    return endpoint.startsWith("http") ? target.toString() : pathAndQuery;
  } catch {
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${separator}request_id=${encodeURIComponent(requestId)}`;
  }
};

const isBasePathActiveForLocation = (basePath: string) => {
  if (typeof window === "undefined") return true;
  const normalizedBasePath = basePath === "/" ? "" : basePath;
  if (!normalizedBasePath) return true;
  const pathname = String(window.location.pathname || "/");
  return pathname === normalizedBasePath || pathname.startsWith(`${normalizedBasePath}/`);
};

const resolveEndpoint = (appBasePath: string) => {
  const safeBasePath = resolveSafeAppBasePath(appBasePath);
  if (!safeBasePath) return "/api/ui-event";
  // Dedicated-host deployments are root-served; ignore stale prefixed base paths.
  if (!isBasePathActiveForLocation(safeBasePath)) return "/api/ui-event";
  const endpoint = resolveSafeHref(safeBasePath, "/api/ui-event");
  return endpoint ?? "/api/ui-event";
};

export function UiTelemetryReporter({ appBasePath }: { appBasePath: string }) {
  React.useEffect(() => {
    const endpoint = resolveEndpoint(appBasePath);
    const flushMs = resolveNumber(
      process.env.NEXT_PUBLIC_UI_EVENT_FLUSH_MS,
      500
    );
    const batchSize = resolveNumber(
      process.env.NEXT_PUBLIC_UI_EVENT_BATCH_SIZE,
      20
    );
    const maxBytes = resolveNumber(
      process.env.NEXT_PUBLIC_UI_EVENT_MAX_BYTES,
      48_000
    );
    const canUseBeacon =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function";
    const queue: Array<Record<string, unknown>> = [];
    const requestId = createRequestId();
    let flushHandle: number | null = null;

    setRequestId(requestId);

    const flush = (options?: { preferBeacon?: boolean }) => {
      if (flushHandle !== null) {
        window.clearTimeout(flushHandle);
        flushHandle = null;
      }
      if (queue.length === 0) return;
      const events = queue.splice(0, queue.length);
      for (const batch of splitEventBatches(events, maxBytes)) {
        const payload = createEventPayload(batch);
        const shouldUseBeacon =
          canUseBeacon && Boolean(options?.preferBeacon);
        if (shouldUseBeacon) {
          if (resolveByteLength(payload) <= maxBytes) {
            const eventPayload = new Blob([payload], { type: "application/json" });
            const beaconEndpoint = appendRequestIdQuery(endpoint, requestId);
            navigator.sendBeacon(beaconEndpoint, eventPayload);
            continue;
          }
        }
        void fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [REQUEST_ID_HEADER]: requestId,
          },
          body: payload,
          keepalive: true,
          credentials: "include",
        }).catch(() => undefined);
      }
    };

    const scheduleFlush = () => {
      if (flushHandle !== null) return;
      flushHandle = window.setTimeout(() => {
        flushHandle = null;
        flush();
      }, flushMs);
    };

    const reporter = (event: Record<string, unknown>) => {
      const normalizedEvent = normalizeEvent(event, requestId) as {
        type?: unknown;
        context?: unknown;
        requestId?: string;
      };
      queue.push(normalizedEvent);
      if (queue.length >= batchSize) {
        flush();
        return;
      }
      scheduleFlush();
      if (process.env.NODE_ENV !== "production") {
        console.info("[ui-event]", {
          type: normalizedEvent.type,
          context: normalizedEvent.context,
          requestId: normalizedEvent.requestId ?? requestId,
        });
      }
    };

    const flushOnPageExit = () => flush({ preferBeacon: true });
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushOnPageExit();
      }
    };

    setUiReporter(reporter);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", flushOnPageExit);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", flushOnPageExit);
      setUiReporter(null);
      flushOnPageExit();
      setRequestId(null);
    };
  }, [appBasePath]);

  return null;
}
