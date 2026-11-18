import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type MobileStorageAdapter = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type MobileTraceContext = {
  correlationId: string;
  traceparent: string;
};

export type MobileRequestFailureContext = {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  correlationId: string;
  traceparent: string;
  error?: string;
};

export type MobileRequestTraceEvent = MobileTraceContext & {
  phase: "start" | "end" | "error";
  method: string;
  url: string;
  status?: number;
  durationMs?: number | null;
};

type MobileClientParams = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  storage: MobileStorageAdapter;
  schema?: string;
  getTraceContext?: () => MobileTraceContext;
  onRequestFailure?: (context: MobileRequestFailureContext) => void;
  onRequestTrace?: (event: MobileRequestTraceEvent) => void;
};

function toHex(n: number) {
  return n.toString(16).padStart(2, "0");
}

function randomHex(length: number) {
  const bytes = new Uint8Array(Math.max(1, Math.ceil(length / 2)));
  const nativeCrypto = globalThis.crypto;

  if (nativeCrypto?.getRandomValues) {
    nativeCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      const value = Math.floor(Math.random() * 256);
      bytes[i] = value;
    }
  }

  return Array.from(bytes, toHex).join("").slice(0, length);
}

function createTraceContext(): MobileTraceContext {
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  const correlationId = `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
  return { correlationId, traceparent: `00-${traceId}-${spanId}-01` };
}

function normalizeRequestUrl(input: Request | URL | string): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof input === "object" && input !== null && "url" in input
          ? String((input as { url?: unknown }).url)
          : String(input);

  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

function coerceRequestMethod(input: Request | URL | string, init?: RequestInit) {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    return String((input as { method?: unknown }).method || "GET").toUpperCase();
  }
  return "GET";
}

function normalizeFailureError(error: unknown) {
  if (!error) return "unknown failure";
  if (error instanceof Error) return error.message || "request failure";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function safeHeaders(input?: HeadersInit) {
  const headers = new Headers();

  if (!input) return headers;

  if (input instanceof Headers) {
    input.forEach((value, key) => {
      headers.set(key, value);
    });
    return headers;
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) headers.set(key, value);
    return headers;
  }

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") headers.set(key, value);
  }

  return headers;
}

function createMobileFetch(
  onRequestFailure?: (context: MobileRequestFailureContext) => void,
  getTraceContext: () => MobileTraceContext = createTraceContext,
  onRequestTrace?: (event: MobileRequestTraceEvent) => void
) {
  return async (input: Request | URL | string, init: RequestInit = {}) => {
    const traceContext = getTraceContext();
    const headers = safeHeaders(init?.headers);
    headers.set("x-correlation-id", traceContext.correlationId);
    headers.set("traceparent", traceContext.traceparent);

    let response: Response;
    const requestUrl = normalizeRequestUrl(input);
    // Observer failures must never replace a transport response or exception.
    const now = () => typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : null;
    const startedAt = now();
    const emit = (phase: MobileRequestTraceEvent["phase"], status?: number) => {
      // Do not create new telemetry merely by delivering buffered telemetry.
      if (requestUrl.replace(/^https?:\/\/[^/]+/, "") === "/rest/v1/rpc/ui_log_events_v1") return;
      try {
        onRequestTrace?.({
          ...traceContext, phase, method: coerceRequestMethod(input, init),
          url: (() => {
            try {
              const url = new URL(requestUrl);
              // RPC names are operation descriptors; storage/table paths are data.
              return url.origin + (/^\/rest\/v1\/rpc\/[a-zA-Z0-9_]+$/.test(url.pathname) ? url.pathname : "/[redacted-path]");
            } catch { return "[unparseable-url]"; }
          })(), ...(status === undefined ? {} : { status }),
          ...(phase === "start" ? {} : { durationMs: startedAt === null ? null : Math.max(0, (now() ?? startedAt) - startedAt) }),
        });
      } catch { /* Telemetry is not a transport gate. */ }
    };
    emit("start");

    try {
      response = await fetch(input as RequestInfo, {
        ...init,
        headers,
      });
    } catch (error) {
      emit("error");
      if (onRequestFailure) {
        onRequestFailure({
          method: coerceRequestMethod(input, init),
          url: requestUrl,
          correlationId: traceContext.correlationId,
          traceparent: traceContext.traceparent,
          error: normalizeFailureError(error),
        });
      }
      throw error;
    }

    emit(response.ok ? "end" : "error", response.status);
    if (!response.ok && onRequestFailure) {
      onRequestFailure({
        method: coerceRequestMethod(input, init),
        url: requestUrl,
        status: response.status,
        statusText: response.statusText,
        correlationId: traceContext.correlationId,
        traceparent: traceContext.traceparent,
      });
    }

    return response;
  };
}

export function createMobileClient(params: MobileClientParams) {
  return createClient(params.supabaseUrl, params.supabaseAnonKey, {
    db: { schema: params.schema ?? "api" },
    auth: {
      storage: params.storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createMobileFetch(params.onRequestFailure, params.getTraceContext, params.onRequestTrace),
    },
  });
}

export function createSupabaseExecutor(
  client: SupabaseClient<any, any, any, any, any>
) {
  return async (
    rpc: string,
    args: Record<string, unknown>,
    transport: "rpc" | "edge" = "rpc"
  ) => {
    if (transport === "rpc") {
      const result = await client.rpc(rpc as any, args as any);
      if (result.error) {
        const error = result.error;
        // PostgREST wraps rejected fetches; retain transport provenance rather
        // than treating arbitrary database error text as a network failure.
        if (result.status === 0 && error.code === "" && error.hint === "" &&
            /^TypeError: (?:failed to fetch|fetch failed|networkerror(?: when attempting to fetch resource\.)?)$/i.test(error.message)) {
          const networkError = new TypeError("Failed to fetch RPC.");
          Object.defineProperty(networkError, "cause", { value: error, configurable: true });
          throw networkError;
        }
        throw error;
      }
      return result.data;
    }
    if (transport !== "edge" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rpc)) {
      throw new Error("Unsupported outbox transport or Edge function name.");
    }
    const result = await client.functions.invoke(rpc, { body: args });
    if (result.error) {
      // Preserve the shared retry contract without interpreting a product response.
      const error = result.error as Error & { context?: { status?: number }; status?: number };
      if (error.name === "FunctionsFetchError") throw new TypeError("Failed to fetch Edge function.");
      if (error.name === "FunctionsRelayError") error.status = 503;
      else if (typeof error.context?.status === "number") error.status = error.context.status;
      throw error;
    }
    return result.data;
  };
}
