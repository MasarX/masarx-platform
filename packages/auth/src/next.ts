import { NextResponse } from "next/server";
import { createServerClient } from "./server";
import { normalizeAppBasePath, resolveRedirectTarget } from "./redirect";
import { validateTrustedBrowserRequest } from "./request-guard";

type AuthCallbackOptions = {
  defaultRedirectPath?: string;
};

type SignOutOptions = {
  redirectPath?: string;
};

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_QUERY = "request_id";
const CORRELATION_HEADERS = [
  REQUEST_ID_HEADER,
  "x-correlation-id",
  "x-correlation",
];
const MAX_LOG_FIELD_LENGTH = 240;

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const fallback = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  return `auth-${fallback}`;
}

function truncate(value: string | null | undefined, maxLength: number = MAX_LOG_FIELD_LENGTH) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function sanitizeForLogs(value: string | null | undefined) {
  if (!value) return "";
  return truncate(String(value).replace(/[\r\n]/g, " ").replace(/[^\x20-\x7e]/g, " "), MAX_LOG_FIELD_LENGTH);
}

function normalizeRequestId(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;
  const safe = trimmed.replace(/[^\w-]/g, "");
  if (!safe) return undefined;
  return safe.slice(0, 128);
}

function extractRequestIdFromQueryParam(requestUrl: URL) {
  const requestId = normalizeRequestId(requestUrl.searchParams.get(REQUEST_ID_QUERY));
  if (!requestId) return undefined;
  return requestId;
}

function extractRequestId(request: Request) {
  const requestUrl = new URL(request.url);
  const requestIdFromQuery = extractRequestIdFromQueryParam(requestUrl);
  if (requestIdFromQuery) {
    return requestIdFromQuery;
  }

  for (const headerName of CORRELATION_HEADERS) {
    const requestId = normalizeRequestId(request.headers.get(headerName));
    if (requestId) return requestId;
  }
  return createRequestId();
}

function reportAuthServerEvent(
  requestId: string,
  eventType: string,
  context: Record<string, string | boolean | null | undefined>
) {
  const safeContext = Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeForLogs(value) : value ?? null,
    ])
  );

  if (process.env.NODE_ENV !== "production") {
    console.info("auth.route", JSON.stringify({ eventType, requestId, ...safeContext }));
  }
}

function safeErrorMessage(message: string | null | undefined) {
  if (!message) return "internal_error";
  const compact = sanitizeForLogs(message).toLowerCase();
  if (!compact) return "internal_error";
  return compact.slice(0, 80);
}

function resolveDefaultCallbackPath() {
  return normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH) || "/";
}

function resolveRedirect(requestUrl: URL, nextPath: string | null, fallback: string) {
  return resolveRedirectTarget(requestUrl, nextPath, fallback);
}

function redirectWithinApp(target: URL) {
  // Relative Location preserves the browser's origin when Next receives an
  // internal bind URL, without trusting client-supplied proxy or Host headers.
  // URL dot-segment normalization can leave multiple leading path slashes.
  const pathname = `/${target.pathname.replace(/^\/+/, "")}`;
  return new NextResponse(null, {
    status: 307,
    headers: { location: `${pathname}${target.search}${target.hash}` },
  });
}

function appendError(target: URL, message: string) {
  target.searchParams.set("error", message);
  return target;
}

export async function handleAuthCallback(
  request: Request,
  options: AuthCallbackOptions = {}
) {
  const requestId = extractRequestId(request);
  const requestUrl = new URL(request.url);
  reportAuthServerEvent(requestId, "auth.callback.start", {
    requestPath: requestUrl.pathname,
    hasCode: requestUrl.searchParams.has("code"),
    hasNext: requestUrl.searchParams.has("next"),
    hasError: requestUrl.searchParams.has("error") || requestUrl.searchParams.has("error_description"),
    defaultRedirectPath: options.defaultRedirectPath ?? resolveDefaultCallbackPath(),
  });

  const nextParam = requestUrl.searchParams.get("next");
  const redirectTarget = resolveRedirect(
    requestUrl,
    nextParam,
    options.defaultRedirectPath ?? resolveDefaultCallbackPath()
  );
  const externalError =
    requestUrl.searchParams.get("error_description") ??
    requestUrl.searchParams.get("error");

  if (externalError) {
    const errorRedirect = redirectWithinApp(
      appendError(redirectTarget, safeErrorMessage(externalError))
    );
    errorRedirect.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.callback.blocked.external_error", {
      path: requestUrl.pathname,
      reason: truncate(safeErrorMessage(externalError)),
      next: nextParam,
      redirectTo: errorRedirect.headers.get("Location"),
    });
    return errorRedirect;
  }

  try {
    const code = requestUrl.searchParams.get("code");
    if (code) {
      const supabase = createServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        const errorRedirect = redirectWithinApp(
          appendError(redirectTarget, safeErrorMessage(error.message))
        );
        errorRedirect.headers.set(REQUEST_ID_HEADER, requestId);
        reportAuthServerEvent(requestId, "auth.callback.exchange_error", {
          path: requestUrl.pathname,
          reason: safeErrorMessage(error.message),
          redirectTo: errorRedirect.headers.get("Location"),
        });
        return errorRedirect;
      }
    }

    const response = redirectWithinApp(redirectTarget);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.callback.success", {
      path: requestUrl.pathname,
      redirectTo: response.headers.get("Location"),
    });
    return response;
  } catch (error) {
    const response = redirectWithinApp(
      appendError(redirectTarget, safeErrorMessage((error as Error)?.message))
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.callback.failure", {
      path: requestUrl.pathname,
      reason: safeErrorMessage((error as Error)?.message),
      redirectTo: response.headers.get("Location"),
    });
    return response;
  }
}

export async function handleSignOut(request: Request, options: SignOutOptions = {}) {
  const requestId = extractRequestId(request);
  const requestUrl = new URL(request.url);
  reportAuthServerEvent(requestId, "auth.sign_out.start", {
    path: requestUrl.pathname,
    redirectPath: options.redirectPath,
    appBasePath: process.env.NEXT_PUBLIC_APP_BASE_PATH ?? null,
  });

  const target = resolveRedirect(
    requestUrl,
    options.redirectPath ?? null,
    normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH)
  );
  const trustedRequest = validateTrustedBrowserRequest(request);
  if (!trustedRequest.ok) {
    const response = NextResponse.json(
      { error: trustedRequest.message, code: trustedRequest.code },
      { status: trustedRequest.status }
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.sign_out.blocked.untrusted_request", {
      path: requestUrl.pathname,
      reason: trustedRequest.code,
    });
    return response;
  }

  try {
    const supabase = createServerClient();
    await supabase.auth.signOut({ scope: "local" });
    const response = redirectWithinApp(target);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.sign_out.success", {
      path: requestUrl.pathname,
      redirectTo: response.headers.get("Location"),
    });
    return response;
  } catch (error) {
    const response = redirectWithinApp(
      appendError(target, safeErrorMessage((error as Error)?.message))
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    reportAuthServerEvent(requestId, "auth.sign_out.failure", {
      path: requestUrl.pathname,
      reason: safeErrorMessage((error as Error)?.message),
      redirectTo: response.headers.get("Location"),
    });
    return response;
  }
}
