"use client";
import { sanitizeUiError } from "./utils";
import { isUuidValue } from "./resource-utils";

type RequestId = string;

type NormalizedRequestId = string;

type UiEventMeta = Record<string, string | number | boolean | null>;

export type UiEvent = {
  type: string;
  timestamp: string;
  message?: string;
  context?: string;
  name?: string;
  digest?: string;
  meta?: UiEventMeta;
  requestId?: RequestId;
};
export type UiScopeMetaInput = {
  settingsResolutionId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  scopeValue?: unknown;
};

type UiReporter = (event: UiEvent) => void;

let activeReporter: UiReporter | null = null;
let activeRequestId: NormalizedRequestId | null = null;

const REQUEST_ID_MAX_LENGTH = 128;

const SENSITIVE_META_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "api-secret",
  "cookie",
  "password",
  "refresh_token",
  "secret",
  "session",
  "set-cookie",
  "signin_token",
  "state",
  "token",
]);

const isSensitiveMetaKey = (key: string) =>
  SENSITIVE_META_KEYS.has(key.toLowerCase()) || key.toLowerCase().includes("token");

const sanitizeMetaValue = (value: unknown): string | number | boolean | null => {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return isUuidValue(value) ? value : sanitizeUiError(value) ?? value;
  }
  return "[redacted]";
};

const sanitizeMeta = (meta: UiEventMeta | undefined) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta;
  }
  const safeMeta: UiEventMeta = {};
  Object.keys(meta).forEach((key) => {
    const value = meta[key];
    const lower = key.toLowerCase();
    safeMeta[key] = isSensitiveMetaKey(lower)
      ? "[redacted]"
      : sanitizeMetaValue(value);
  });
  return safeMeta;
};

const sanitizeEventPayload = (event: UiEvent) => {
  const safeMessage = event.message
    ? sanitizeUiError(event.message) ?? event.message
    : event.message;
  const safeMeta = sanitizeMeta(event.meta);
  return {
    ...event,
    message: safeMessage,
    meta: safeMeta,
  };
};

const normalizeRequestId = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  return trimmed.length > REQUEST_ID_MAX_LENGTH
    ? trimmed.slice(0, REQUEST_ID_MAX_LENGTH)
    : trimmed;
};

const resolveRequestId = (event: UiEvent) => {
  const direct = normalizeRequestId(event.requestId);
  if (direct) return direct;

  const metaRequestId = normalizeRequestId(
    typeof event.meta?.requestId === "string" ? event.meta.requestId : null
  );
  if (metaRequestId) return metaRequestId;

  return activeRequestId;
};

export function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ui-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function setRequestId(requestId: string | null | undefined): void {
  activeRequestId = normalizeRequestId(requestId);
}

function withRequestId(event: UiEvent) {
  const requestId = resolveRequestId(event);
  const normalizedMeta: UiEventMeta =
    event.meta && typeof event.meta === "object" && !Array.isArray(event.meta)
      ? { ...event.meta }
      : {};

  if (requestId) {
    if (typeof normalizedMeta.requestId !== "string") {
      normalizedMeta.requestId = requestId;
    }
    return {
      ...event,
      requestId,
      meta: normalizedMeta,
    };
  }

  if (event.meta === undefined && Object.keys(normalizedMeta).length === 0) {
    return {
      ...event,
      meta: event.meta,
      requestId: undefined,
    };
  }

  return {
    ...event,
    meta: event.meta,
    requestId: undefined,
  };
}

export function buildScopeMeta(input?: UiScopeMetaInput | null) {
  const meta: Record<string, string | number | boolean | null> = {};
  const settingsResolutionId = input?.settingsResolutionId?.trim() || "";
  const scopeType = input?.scopeType?.trim() || "";
  const scopeId = input?.scopeId?.trim() || "";
  if (settingsResolutionId) meta.settingsResolutionId = settingsResolutionId;
  if (scopeType) meta.scopeType = scopeType;
  if (scopeId) meta.scopeId = scopeId;
  if (
    typeof input?.scopeValue === "string" ||
    typeof input?.scopeValue === "number" ||
    typeof input?.scopeValue === "boolean"
  ) {
    meta.scopeValue = input.scopeValue;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function resolveScopeDigest(input?: UiScopeMetaInput | null) {
  const settingsResolutionId = input?.settingsResolutionId?.trim() || "";
  return settingsResolutionId ? settingsResolutionId : undefined;
}

/**
 * Register a UI event reporter (for example an in-app logger or telemetry sink).
 */
export function setUiReporter(reporter?: UiReporter | null) {
  activeReporter = reporter ?? null;
}

/**
 * Emit a UI telemetry event using the active reporter (if any).
 */
export function reportUiEvent(event: UiEvent) {
  const normalized = sanitizeEventPayload(withRequestId(event));
  if (activeReporter) {
    activeReporter(normalized);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.info("[ui-event]", {
      type: normalized.type,
      context: normalized.context,
      name: normalized.name,
      requestId: normalized.requestId,
      digest: normalized.digest,
    });
  }
}

/**
 * Report a client error in a safe, structured form.
 */
export function reportClientError(
  error: Error,
  options?: { context?: string; digest?: string; requestId?: string }
) {
  const safeMessage = sanitizeUiError(error.message) ?? "Unexpected error";
  reportUiEvent({
    type: "ui.error",
    timestamp: new Date().toISOString(),
    name: error.name,
    message: safeMessage,
    context: options?.context,
    digest: options?.digest,
    requestId: options?.requestId,
  });
}
