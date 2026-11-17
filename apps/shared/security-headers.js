function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function uniqueValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function resolveWebsocketOrigin(origin) {
  if (!origin) return null;
  if (origin.startsWith("https://")) return origin.replace("https://", "wss://");
  if (origin.startsWith("http://")) return origin.replace("http://", "ws://");
  return null;
}

function buildCsp({ supabaseUrl, nodeEnv = process.env.NODE_ENV, nonce = "" }) {
  const supabaseOrigin = normalizeOrigin(supabaseUrl);
  const websocketOrigin = resolveWebsocketOrigin(supabaseOrigin);
  const isProduction = String(nodeEnv || "").trim().toLowerCase() === "production";

  const connectSources = ["'self'"];
  if (supabaseOrigin) {
    connectSources.push(supabaseOrigin);
  }
  if (websocketOrigin) {
    connectSources.push(websocketOrigin);
  }

  const scriptSources = ["'self'"];
  if (isProduction && nonce) {
    scriptSources.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  } else if (!isProduction) {
    scriptSources.push("'unsafe-inline'");
    scriptSources.push("'unsafe-eval'");
  }

  const directives = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "frame-src": ["'none'"],
    "script-src": scriptSources,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": connectSources,
    "frame-ancestors": ["'none'"],
  };
  if (isProduction) {
    directives["upgrade-insecure-requests"] = [];
  }

  return Object.entries(directives)
    .map(([key, value]) =>
      Array.isArray(value) && value.length > 0
        ? `${key} ${uniqueValues(value).join(" ")}`
        : key
    )
    .join("; ");
}

function buildBaseSecurityHeaders() {
  return [
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "X-Frame-Options",
      value: "DENY",
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    {
      key: "Cross-Origin-Opener-Policy",
      value: "same-origin",
    },
    {
      key: "Cross-Origin-Resource-Policy",
      value: "same-origin",
    },
    {
      key: "Origin-Agent-Cluster",
      value: "?1",
    },
  ];
}

function buildSecurityHeaders({ supabaseUrl, nodeEnv = process.env.NODE_ENV, nonce = "" }) {
  return [
    {
      key: "Content-Security-Policy",
      value: buildCsp({ supabaseUrl, nodeEnv, nonce }),
    },
    ...buildBaseSecurityHeaders(),
  ];
}

function buildStaticSecurityHeaders() {
  return buildBaseSecurityHeaders();
}

module.exports = {
  buildCsp,
  buildSecurityHeaders,
  buildStaticSecurityHeaders,
  normalizeOrigin,
  resolveWebsocketOrigin,
};
module.exports.default = module.exports;
