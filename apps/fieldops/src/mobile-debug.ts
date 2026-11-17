import { bufferMobileTelemetryEvent } from "./mobile-telemetry";

const MOBILE_DEBUG_FAILURE_EVENT = "mobile.debug_failure";

type MobileGlobalErrorUtils = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean, details?: unknown) => void) => void;
};

type MobileUnhandledRejectionEvent = {
  reason?: unknown;
  promise?: unknown;
  preventDefault?: () => void;
};

type MobileCrashHandlerDisposer = () => void;
type MobileUnhandledRejectionDisposer = () => void;

export type MobileDebugFailure = {
  event: string;
  context: string;
  message: string;
  timestamp: string;
  namespace: string;
};

export type MobileCrashContext = {
  isFatal?: boolean;
  details?: unknown;
};

function redactSensitive(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(apikey|api_key|token|access_token|refresh_token|authorization)=([A-Za-z0-9._-]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT_REDACTED]");
}

export function normalizeDebugMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitive(`${error.message}${error.stack ? `\n${error.stack}` : ""}`);
  }
  if (error && typeof error === "object") {
    try {
      return redactSensitive(JSON.stringify(error));
    } catch {
      return redactSensitive(String(error));
    }
  }
  return redactSensitive(String(error));
}

export function buildDebugFailurePayload(
  context: string,
  error: unknown,
  namespace: string
): MobileDebugFailure {
  return {
    event: MOBILE_DEBUG_FAILURE_EVENT,
    namespace,
    context,
    message: normalizeDebugMessage(error),
    timestamp: new Date().toISOString(),
  };
}

export function logDebugFailure(context: string, error: unknown, namespace = "fieldops") {
  const payload = buildDebugFailurePayload(context, error, namespace);
  if (__DEV__) {
    console.warn(`[${namespace}]`, payload);
  }

  void bufferMobileTelemetryEvent({
    event_type: payload.event,
    captured_at: payload.timestamp,
    metadata: {
      namespace: payload.namespace,
      context: payload.context,
      message: payload.message,
    },
  });
}

export function installGlobalCrashHandler(
  callback: (error: unknown, context: MobileCrashContext) => void
): MobileCrashHandlerDisposer | null {
  const errorUtils = (globalThis as { ErrorUtils?: MobileGlobalErrorUtils }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler || !errorUtils.getGlobalHandler) {
    return null;
  }

  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal, details) => {
    callback(error, { isFatal, details });
    if (previous) {
      previous(error as Error, isFatal as boolean);
    }
  });

  return () => {
    if (errorUtils.setGlobalHandler) {
      errorUtils.setGlobalHandler(previous ?? (() => undefined));
    }
  };
}

export function installUnhandledRejectionHandler(
  callback: (reason: unknown, promise?: unknown) => void
): MobileUnhandledRejectionDisposer | null {
  const globalError = globalThis as {
    addEventListener?: (type: string, listener: (event: MobileUnhandledRejectionEvent) => void) => void;
    removeEventListener?: (
      type: string,
      listener: (event: MobileUnhandledRejectionEvent) => void
    ) => void;
    onunhandledrejection?: (event: unknown) => void;
  };

  const listener = (event: MobileUnhandledRejectionEvent) => {
    callback(event?.reason, event?.promise);
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  };

  if (
    typeof globalError.addEventListener === "function" &&
    typeof globalError.removeEventListener === "function"
  ) {
    globalError.addEventListener("unhandledrejection", listener);
    return () => {
      globalError.removeEventListener?.("unhandledrejection", listener);
    };
  }

  if (!("onunhandledrejection" in globalError)) {
    return null;
  }

  const previous = globalError.onunhandledrejection;
  globalError.onunhandledrejection = (event: unknown) => {
    const parsedEvent = event as MobileUnhandledRejectionEvent;
    listener(parsedEvent);
    if (previous) {
      previous(event);
    }
  };

  return () => {
    globalError.onunhandledrejection = previous;
  };
}
