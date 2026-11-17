const DEFAULT_ALLOWED_HEADERS = [
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
];
const DEFAULT_ALLOWED_METHODS = "GET, POST, OPTIONS";

const normalizeOrigin = (value) => {
  if (typeof value !== "string") return "*";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "*";
};

const normalizeRequestedHeaders = (value) => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
};

export const buildCorsHeaders = (req) => {
  const origin = normalizeOrigin(req?.headers?.get?.("origin"));
  const requestedHeaders = normalizeRequestedHeaders(
    req?.headers?.get?.("access-control-request-headers"),
  );
  const allowedHeaders = Array.from(
    new Set([...DEFAULT_ALLOWED_HEADERS, ...requestedHeaders]),
  ).join(", ");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": allowedHeaders,
    "Access-Control-Allow-Methods": DEFAULT_ALLOWED_METHODS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

export const withCorsJson = (status, body, corsHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
  });
