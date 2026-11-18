function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const raw = String(hostname || "").trim().toLowerCase();
  if (raw.endsWith("..")) return false;
  if ((raw.startsWith("[") && !raw.endsWith("]")) || (!raw.startsWith("[") && raw.endsWith("]"))) {
    return false;
  }
  const unbracketed = raw.startsWith("[") && raw.endsWith("]")
    ? raw.slice(1, -1)
    : raw;
  const normalized = unbracketed.endsWith(".")
    ? unbracketed.slice(0, -1)
    : unbracketed;
  const ipv4Parts = normalized.split(".");
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(ipv4Parts[0]) === 127;
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const mappedHighWord = mappedHex ? Number.parseInt(mappedHex[1], 16) : -1;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    isIpv4Loopback ||
    (mappedIpv4 ? isLoopbackHostname(mappedIpv4) : false) ||
    (mappedHighWord >> 8) === 127
  );
}

function normalizeTrustedOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin.toLowerCase();
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

function resolveTrustedExternalDataOrigins({
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  configuredOrigins = process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS,
} = {}) {
  const origins = [];
  const supabaseOrigin = normalizeTrustedOrigin(supabaseUrl);
  if (supabaseOrigin) origins.push(supabaseOrigin);
  String(configuredOrigins || "")
    .split(",")
    .forEach((candidate) => {
      const origin = normalizeTrustedOrigin(candidate);
      if (origin) origins.push(origin);
    });
  return uniqueValues(origins);
}

function resolveWebsocketOrigin(origin) {
  if (!origin) return null;
  if (origin.startsWith("https://")) return origin.replace("https://", "wss://");
  if (origin.startsWith("http://")) return origin.replace("http://", "ws://");
  return null;
}

function resolveMapTileOrigins(value) {
  return uniqueValues(String(value || '').split(',').flatMap(candidate => {
    const raw = candidate.trim();
    // Exact HTTPS origins only: never turn an image allowlist into fetch grants.
    if (!/^https:\/\/[^\s/?#\\@*]+\/?$/i.test(raw)) return [];
    const origin = normalizeTrustedOrigin(raw);
    return origin ? [origin] : [];
  }));
}

function buildCsp({
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  nodeEnv = process.env.NODE_ENV,
  nonce = "",
  trustedExternalDataOrigins = process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS,
  mapTileOrigins = process.env.NEXT_PUBLIC_UI_MAP_TILE_ORIGINS,
}) {
  const supabaseOrigin = normalizeOrigin(supabaseUrl);
  const websocketOrigin = resolveWebsocketOrigin(supabaseOrigin);
  const isProduction = String(nodeEnv || "").trim().toLowerCase() === "production";
  const trustedImageOrigins = resolveTrustedExternalDataOrigins({
    supabaseUrl,
    configuredOrigins: trustedExternalDataOrigins,
  });

  const connectSources = ["'self'", ...resolveMapTileOrigins(mapTileOrigins)];
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

  const imageSources = ["'self'", "data:", "blob:", ...trustedImageOrigins];

  const directives = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "frame-src": ["'none'"],
    "script-src": scriptSources,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": imageSources,
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

function buildSecurityHeaders({
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  nodeEnv = process.env.NODE_ENV,
  nonce = "",
  trustedExternalDataOrigins = process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS,
  mapTileOrigins = process.env.NEXT_PUBLIC_UI_MAP_TILE_ORIGINS,
}) {
  return [
    {
      key: "Content-Security-Policy",
      value: buildCsp({
        supabaseUrl,
        nodeEnv,
        nonce,
        trustedExternalDataOrigins,
        mapTileOrigins,
      }),
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
  isLoopbackHostname,
  normalizeOrigin,
  normalizeTrustedOrigin,
  resolveTrustedExternalDataOrigins,
  resolveWebsocketOrigin,
};
module.exports.default = module.exports;
