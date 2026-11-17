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

type MobileClientParams = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  storage: MobileStorageAdapter;
  schema?: string;
  getTraceContext?: () => MobileTraceContext;
  onRequestFailure?: (context: MobileRequestFailureContext) => void;
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
    return raw.split("?")[0] || raw;
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
  getTraceContext: () => MobileTraceContext = createTraceContext
) {
  return async (input: Request | URL | string, init: RequestInit = {}) => {
    const traceContext = getTraceContext();
    const headers = safeHeaders(init?.headers);
    headers.set("x-correlation-id", traceContext.correlationId);
    headers.set("traceparent", traceContext.traceparent);

    let response: Response;
    const requestUrl = normalizeRequestUrl(input);

    try {
      response = await fetch(input as RequestInfo, {
        ...init,
        headers,
      });
    } catch (error) {
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
      fetch: createMobileFetch(params.onRequestFailure, params.getTraceContext),
    },
  });
}

export function createSupabaseExecutor(
  client: SupabaseClient<any, any, any, any, any>
) {
  return async (rpc: string, args: Record<string, unknown>) => {
    const result = await client.rpc(rpc as any, args as any);
    if (result.error) throw result.error;
    return result.data;
  };
}
