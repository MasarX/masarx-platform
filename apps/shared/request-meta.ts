import { NextResponse } from "next/server";

export type RequestWithHeaders = {
  headers: {
    get(name: string): string | null;
  };
  url?: string;
};

type JsonResponseInit = Omit<
  Parameters<typeof NextResponse.json>[1],
  "status"
> & {
  status?: number;
  headers?: HeadersInit;
};

const generateFallbackRequestId = () =>
  `ui-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

function makeRequestId(): string {
  const headerValue = crypto.randomUUID?.();
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue;
  }
  return generateFallbackRequestId();
}

const normalizeRequestIdHeaderValue = (value: string | null | undefined) => {
  const normalized = value?.trim().replace(/[^\w-]/g, "").slice(0, 128);
  return normalized || undefined;
};

const getRequestIdFromUrl = (request: RequestWithHeaders) => {
  if (!request.url) return undefined;
  try {
    const url = new URL(request.url);
    return normalizeRequestIdHeaderValue(url.searchParams.get("request_id"));
  } catch {
    return undefined;
  }
};

export function getRequestIdFromHeaders(request: RequestWithHeaders): string {
  const headerRequestId = normalizeRequestIdHeaderValue(
    request.headers.get("x-request-id")
  );
  if (headerRequestId) return headerRequestId;

  const legacyCorrelationId = normalizeRequestIdHeaderValue(
    request.headers.get("x-correlation-id")
  );
  if (legacyCorrelationId) return legacyCorrelationId;

  const correlationId = normalizeRequestIdHeaderValue(
    request.headers.get("x-correlation")
  );
  if (correlationId) return correlationId;

  return getRequestIdFromUrl(request) ?? makeRequestId();
}

export function addRequestIdHeader(
  headers: HeadersInit | undefined,
  requestId: string
): HeadersInit {
  const nextHeaders = new Headers(headers || {});
  nextHeaders.set("x-request-id", normalizeRequestIdHeaderValue(requestId) ?? makeRequestId());
  return Object.fromEntries(nextHeaders.entries());
}

export function jsonResponseWithRequestId(
  payload: Record<string, unknown>,
  status: number,
  requestId: string,
  init: JsonResponseInit = {}
) {
  return NextResponse.json(payload, {
    ...init,
    status,
    headers: addRequestIdHeader(init.headers, requestId),
  });
}

export function redirectWithRequestId(
  url: string | URL,
  requestId: string,
  status = 302,
  headers?: HeadersInit
) {
  return NextResponse.redirect(url, {
    status,
    headers: addRequestIdHeader(headers, requestId),
  });
}
