export type BrowserRequestGuardResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

function normalizeHeaderValue(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOriginCandidate(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = normalizeHeaderValue(hostname);
  // objectives:allow LOCALHOST Justification: Browser request trust checks must treat loopback hosts as same-origin equivalents for local development and E2E runs.
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function normalizePort(url: URL) {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

function resolveTrustedOrigins(request: Request, requestUrl: URL) {
  const origins = new Set<string>();
  origins.add(requestUrl.origin);

  const forwardedProto = normalizeHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );
  const requestProtocol = requestUrl.protocol.replace(/:$/, "");
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : requestProtocol;

  const hostCandidates = [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  ];
  for (const host of hostCandidates) {
    const normalizedHost = String(host || "").trim();
    if (!normalizedHost) continue;
    const candidate = normalizeOriginCandidate(
      `${protocol}://${normalizedHost}`,
    );
    if (candidate) origins.add(candidate);
  }

  return origins;
}

function isSameOrigin(
  reference: string | null | undefined,
  trustedOrigins: Set<string>,
  requestUrl: URL,
) {
  const raw = String(reference || "").trim();
  if (!raw) return true;
  const normalizedReference = normalizeOriginCandidate(raw);
  if (!normalizedReference) return false;
  if (trustedOrigins.has(normalizedReference)) return true;

  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === requestUrl.protocol &&
      normalizePort(parsed) === normalizePort(requestUrl) &&
      isLoopbackHostname(parsed.hostname) &&
      isLoopbackHostname(requestUrl.hostname)
    );
  } catch {
    return false;
  }
}

export function validateTrustedBrowserRequest(
  request: Request,
  options: { requireJson?: boolean } = {},
): BrowserRequestGuardResult {
  const requestUrl = new URL(request.url);
  const trustedOrigins = resolveTrustedOrigins(request, requestUrl);
  const fetchSite = normalizeHeaderValue(request.headers.get("sec-fetch-site"));
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    return {
      ok: false,
      status: 403,
      code: "cross_site_request_rejected",
      message: "Cross-site browser request rejected.",
    };
  }

  if (
    !isSameOrigin(origin, trustedOrigins, requestUrl) ||
    !isSameOrigin(referer, trustedOrigins, requestUrl)
  ) {
    return {
      ok: false,
      status: 403,
      code: "origin_mismatch",
      message: "Browser request origin is not trusted.",
    };
  }

  if (options.requireJson) {
    const contentType = normalizeHeaderValue(request.headers.get("content-type"));
    if (!contentType.includes("application/json")) {
      return {
        ok: false,
        status: 415,
        code: "unsupported_content_type",
        message: "application/json content type is required.",
      };
    }
  }

  return { ok: true };
}
