import { type NextRequest } from "next/server";
import { getVerifiedAccessToken, validateTrustedBrowserRequest } from "@masarx/auth";
import {
  getRequestIdFromHeaders,
  jsonResponseWithRequestId,
} from "./request-meta";

type UiEventPayload = Record<string, unknown> & {
  type?: string;
  requestId?: string;
  meta?: unknown;
  message?: string;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 64_000;
const DEFAULT_MAX_EVENTS_PER_REQUEST = 200;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_DEPTH_REDACT = 8;
const MAX_META_KEYS = 120;
const MAX_EVENT_STRING_LENGTH = 4_000;
const MAX_EVENT_MESSAGE_LENGTH = 8_000;
const MAX_META_STRING_LENGTH = 1_000;

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|secret|client[_-]?secret|service[_-]?role[_-]?key|supabase[_-]?(?:secret[_-]?key|service[_-]?role[_-]?key)|token|signature|private[_-]?key|access[_-]?token|refresh[_-]?token|session|id[_-]?token|auth)$/i;

const resolveLimit = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? parsed : fallback;
};

export const MAX_UI_EVENT_PAYLOAD_BYTES = resolveLimit(
  process.env.UI_EVENT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES
);

export const MAX_UI_EVENTS_PER_REQUEST = resolveLimit(
  process.env.UI_EVENT_MAX_EVENTS_PER_REQUEST,
  DEFAULT_MAX_EVENTS_PER_REQUEST
);

const normalizeRequestId = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_REQUEST_ID_LENGTH
    ? trimmed.slice(0, MAX_REQUEST_ID_LENGTH)
    : trimmed;
};

const redactEventString = (value: string) => value.replace(
  /\b([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\b/g,
  (match, partOne, partTwo, partThree) => {
    const looksLikeJwt = String(partOne).startsWith("eyJ") || (
      match.length >= 50 &&
      String(partOne).length >= 8 &&
      String(partTwo).length >= 8 &&
      String(partThree).length >= 8
    );
    return looksLikeJwt ? "[redacted]" : match;
  }
);

const trimStringValue = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = redactEventString(value.trim());
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

async function readEventBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let payloadBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      payloadBytes += value.byteLength;
      if (payloadBytes > MAX_UI_EVENT_PAYLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export const sanitizeEventMetadata = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactEventString(value).slice(0, MAX_META_STRING_LENGTH);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= MAX_DEPTH_REDACT) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEventMetadata(entry, depth + 1));
  }

  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (keys.length === 0) return {};
    const out: Record<string, unknown> = {};
    let emitted = 0;
    for (const key of keys) {
      if (emitted >= MAX_META_KEYS) {
        out._redacted = "[truncated]";
        break;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[redacted]";
        emitted += 1;
        continue;
      }
      out[key] = sanitizeEventMetadata(raw[key], depth + 1);
      emitted += 1;
    }
    return out;
  }

  return sanitizeEventMetadata(String(value), depth + 1);
};

export const normalizeUiEvent = (raw: unknown): UiEventPayload | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const type = trimStringValue(source.type, 300);
  if (!type) return null;

  const rawMeta = source.meta;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? sanitizeEventMetadata(rawMeta)
      : {};

  return {
    type,
    timestamp: trimStringValue(source.timestamp, MAX_EVENT_STRING_LENGTH),
    context: trimStringValue(source.context, MAX_EVENT_STRING_LENGTH),
    name: trimStringValue(source.name, MAX_EVENT_STRING_LENGTH),
    digest: trimStringValue(source.digest, MAX_META_STRING_LENGTH),
    message: trimStringValue(source.message, MAX_EVENT_MESSAGE_LENGTH),
    meta,
    requestId: normalizeRequestId(trimStringValue(source.requestId, MAX_REQUEST_ID_LENGTH)),
  };
};

export const enrichWithRequestId = (
  events: UiEventPayload[],
  requestId: string
) => {
  return events.map((event) => {
    const existingMeta = event.meta;
    const sanitizedMeta = existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? sanitizeEventMetadata({ ...(existingMeta as Record<string, unknown>) })
      : undefined;
    const baseMeta: Record<string, unknown> =
      sanitizedMeta && typeof sanitizedMeta === "object" && !Array.isArray(sanitizedMeta)
        ? (sanitizedMeta as Record<string, unknown>)
        : {};

    const baseMetaRequestId = baseMeta.requestId;

    const normalizedRequestId =
      normalizeRequestId(event.requestId) ??
      normalizeRequestId(typeof baseMetaRequestId === "string" ? baseMetaRequestId : undefined) ??
      requestId;

    baseMeta.requestId = normalizedRequestId;
    return {
      ...event,
      requestId: normalizedRequestId,
      meta: baseMeta,
    };
  });
};

export const parseEventPayload = (raw: unknown): UiEventPayload[] => {
  if (Array.isArray(raw)) return raw as UiEventPayload[];
  if (raw && typeof raw === "object") {
    const body = raw as { event?: UiEventPayload; events?: UiEventPayload[] };
    if (Array.isArray(body.events)) return body.events;
    if (body.event && typeof body.event === "object") return [body.event];
  }
  return [];
};

export async function handleUiEventRequest(
  app: "console" | "portal",
  request: NextRequest
) {
  const requestId = getRequestIdFromHeaders(request);
  const contentLengthHeader = Number.parseInt(
    request.headers.get("content-length") || "0",
    10
  );
  const hasDeclaredPayloadLimit = Number.isFinite(contentLengthHeader) && contentLengthHeader > 0;

  if (request.method !== "POST") {
    return jsonResponseWithRequestId(
      { error: "Method not allowed.", requestId },
      405,
      requestId
    );
  }

  const trustedRequest = validateTrustedBrowserRequest(request, { requireJson: true });
  if (!trustedRequest.ok) {
    return jsonResponseWithRequestId(
      { error: trustedRequest.message, code: trustedRequest.code, requestId },
      trustedRequest.status,
      requestId
    );
  }

  const { client: supabase, accessToken, error: sessionError } =
    await getVerifiedAccessToken({ allowCookieSet: false });
  if (sessionError || !accessToken) {
    return jsonResponseWithRequestId(
      { error: "Unauthorized.", requestId },
      401,
      requestId
    );
  }

  let parsed: unknown = null;
  try {
    const text = hasDeclaredPayloadLimit && contentLengthHeader > MAX_UI_EVENT_PAYLOAD_BYTES
      ? null
      : await readEventBody(request);
    if (text === null) {
      return jsonResponseWithRequestId(
        { error: "Request payload too large.", requestId },
        413,
        requestId
      );
    }
    parsed = text ? JSON.parse(text) : null;
  } catch (_error) {
    return jsonResponseWithRequestId(
      { error: "Invalid payload.", requestId },
      400,
      requestId
    );
  }

  const events = enrichWithRequestId(
    parseEventPayload(parsed)
      .map(normalizeUiEvent)
      .filter((event): event is UiEventPayload => event !== null),
    requestId
  ).filter(
    (event) => typeof event?.type === "string" && event.type.trim().length > 0
  );

  if (events.length > MAX_UI_EVENTS_PER_REQUEST) {
    return jsonResponseWithRequestId(
      { error: "Too many events.", requestId },
      413,
      requestId
    );
  }

  if (events.length === 0) {
    return jsonResponseWithRequestId(
      { error: "No events provided.", requestId },
      400,
      requestId
    );
  }

  const { error: rpcError } = await supabase.rpc("ui_log_events_v1", {
    p_events: events,
    p_app: app,
  });
  if (rpcError) {
    return jsonResponseWithRequestId(
      { error: "Failed to record events.", requestId },
      500,
      requestId
    );
  }

  return jsonResponseWithRequestId(
    { ok: true, count: events.length, requestId },
    200,
    requestId
  );
}
