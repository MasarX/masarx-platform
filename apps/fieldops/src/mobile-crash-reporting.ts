import * as Sentry from "@sentry/react-native";

import type { MobileRequestFailureContext } from "@masarx/auth/mobile";

import { normalizeDebugMessage } from "./mobile-debug";

type MobileCrashReportingInitParams = {
  dsn: string | null | undefined;
  environment?: string | null | undefined;
  release?: string | null | undefined;
  enabledInDev?: boolean;
};

type MobileCrashReportingUser = {
  id: string;
  email?: string | null;
};

let crashReportingInitialized = false;
let crashReportingEnabled = false;

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function redactSensitive(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(apikey|api_key|token|access_token|refresh_token|authorization)=([A-Za-z0-9._-]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT_REDACTED]");
}

function redactBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (!breadcrumb) return breadcrumb;
  const next: Sentry.Breadcrumb = { ...breadcrumb };
  if (typeof next.message === "string") {
    next.message = redactSensitive(next.message);
  }
  if (typeof next.category === "string" && /auth/i.test(next.category)) {
    next.data = {};
  }
  if (next.data && typeof next.data === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data as Record<string, unknown>)) {
      if (/token|secret|password|authorization/i.test(key)) continue;
      redacted[key] = typeof value === "string" ? redactSensitive(value) : value;
    }
    next.data = redacted;
  }
  return next;
}

function redactErrorEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const next: Sentry.ErrorEvent = { ...event };

  if (next.request) {
    // Never send request headers/cookies/body.
    const { url, method } = next.request;
    next.request = {
      ...(url ? { url } : {}),
      ...(method ? { method } : {}),
    };
  }

  if (typeof next.message === "string") {
    next.message = redactSensitive(next.message);
  }

  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((value) => {
        const updated = { ...value };
        if (typeof updated.value === "string") updated.value = redactSensitive(updated.value);
        if (typeof updated.type === "string") updated.type = redactSensitive(updated.type);
        return updated;
      }),
    };
  }

  return next;
}

export function initMobileCrashReporting(params: MobileCrashReportingInitParams) {
  if (crashReportingInitialized) return crashReportingEnabled;
  crashReportingInitialized = true;

  const dsn = coerceString(params.dsn);
  const enabledInDev = params.enabledInDev === true;
  const shouldEnable = Boolean(dsn) && (enabledInDev || !__DEV__);
  if (!shouldEnable || !dsn) {
    crashReportingEnabled = false;
    return false;
  }

  crashReportingEnabled = true;
  Sentry.init({
    dsn,
    environment: coerceString(params.environment) ?? undefined,
    release: coerceString(params.release) ?? undefined,
    enableNative: true,
    enableAutoSessionTracking: true,
    beforeBreadcrumb: redactBreadcrumb,
    beforeSend: (event: Sentry.ErrorEvent) => redactErrorEvent(event),
  });

  Sentry.setTag("surface", "fieldops");
  Sentry.setTag("platform", "mobile");
  return true;
}

export function isMobileCrashReportingEnabled() {
  return crashReportingEnabled;
}

export function setMobileCrashReportingUser(user: MobileCrashReportingUser | null) {
  if (!crashReportingEnabled) return;
  if (!user) {
    Sentry.setUser(null);
    return;
  }
  Sentry.setUser({
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
  });
}

export function addMobileNetworkFailureBreadcrumb(context: MobileRequestFailureContext) {
  if (!crashReportingEnabled) return;
  Sentry.addBreadcrumb({
    category: "http",
    level: "error",
    message: `${context.method} ${context.url}`,
    data: {
      status: context.status ?? null,
      statusText: context.statusText ?? null,
      correlationId: context.correlationId,
      traceparent: context.traceparent,
      ...(context.error ? { error: redactSensitive(context.error) } : {}),
    },
  });
}

export function captureMobileException(
  error: unknown,
  extra?: Record<string, unknown>,
  tags?: Record<string, string>
) {
  if (!crashReportingEnabled) return;
  const exception = error instanceof Error ? error : new Error(normalizeDebugMessage(error));
  Sentry.captureException(exception, {
    extra,
    tags,
  });
}
