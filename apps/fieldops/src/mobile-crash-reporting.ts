import * as Sentry from "@sentry/react-native";

import type { MobileRequestFailureContext } from "@masarx/auth/mobile";
import { redactOutboxErrorText } from "@masarx/mobile-core";

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

function redactDiagnosticValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactOutboxErrorText(value);
  if (value instanceof Error) return normalizeDebugMessage(value);
  if (!value || typeof value !== "object") return value;
  // Match Sentry's normalization depth so raw nested console arguments cannot bypass the hook.
  if (depth === 0) return Array.isArray(value) ? "[Array]" : "[Object]";
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, depth - 1));
  return redactDiagnosticData(value as Record<string, unknown>, depth - 1);
}

function redactDiagnosticData(data: Record<string, unknown>, depth = 2): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => !/token|secret|password|authorization/i.test(key))
      .map(([key, value]) => [key, redactDiagnosticValue(value, depth)])
  );
}

function redactBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  if (!breadcrumb) return breadcrumb;
  const next: Sentry.Breadcrumb = { ...breadcrumb };
  if (typeof next.message === "string") {
    next.message = redactOutboxErrorText(next.message);
  }
  if (typeof next.category === "string" && /auth/i.test(next.category)) {
    next.data = {};
  }
  if (next.data && typeof next.data === "object") {
    next.data = redactDiagnosticData(next.data);
  }
  return next;
}

function redactErrorEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const next: Sentry.ErrorEvent = { ...event };

  if (next.request) {
    // Never send request headers/cookies/body.
    const { url, method } = next.request;
    next.request = {
      ...(url ? { url: redactOutboxErrorText(url) } : {}),
      ...(method ? { method: redactOutboxErrorText(method) } : {}),
    };
  }

  if (typeof next.message === "string") {
    next.message = redactOutboxErrorText(next.message);
  }

  if (next.breadcrumbs) next.breadcrumbs = next.breadcrumbs.map(redactBreadcrumb);
  if (next.extra) next.extra = redactDiagnosticData(next.extra);

  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((value) => {
        const updated = { ...value };
        if (typeof updated.value === "string") updated.value = redactOutboxErrorText(updated.value);
        if (typeof updated.type === "string") updated.type = redactOutboxErrorText(updated.type);
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
    beforeSend: redactErrorEvent,
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
      ...(context.error ? { error: redactOutboxErrorText(context.error) } : {}),
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
