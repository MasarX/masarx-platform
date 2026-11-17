const TRUSTED_BROWSER_SCHEMES = new Set(["http:", "https:"]);
const FALLBACK_TRUSTED_ORIGIN = "https://example.invalid";
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function hasUnsafeUrlCharacters(value: string | null | undefined) {
  return typeof value === "string" &&
    (value.includes("\\") || URL_CONTROL_CHARACTERS.test(value));
}

export const resolveBaseOrigin = () => {
  if (typeof window === "undefined") {
    const configuredOrigin =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.VERCEL_URL;
    if (configuredOrigin) {
      return configuredOrigin.startsWith("http") ? configuredOrigin : `https://${configuredOrigin}`;
    }
    return FALLBACK_TRUSTED_ORIGIN;
  }
  return window.location.origin;
};

const parseHostList = (raw: string | undefined) => {
  if (!raw) return null;
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length === 0 ? null : new Set(hosts);
};

export function isLoopbackHostname(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase();
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
    ipv4Parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
    ) &&
    Number(ipv4Parts[0]) === 127;
  const mappedIpv4 = normalized.match(
    /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/
  )?.[1];
  const mappedHex = normalized.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
  );
  const mappedHighWordText = mappedHex?.[1];
  const mappedHighWord = mappedHighWordText
    ? Number.parseInt(mappedHighWordText, 16)
    : -1;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    isIpv4Loopback ||
    (mappedIpv4 !== undefined && isLoopbackHostname(mappedIpv4)) ||
    (mappedHighWord >> 8) === 127
  );
}

function normalizeConfiguredOrigin(value: string | undefined) {
  if (hasUnsafeUrlCharacters(value)) return null;
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!TRUSTED_BROWSER_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function resolveConfiguredOrigins(raw: string | undefined) {
  const origins = new Set<string>();
  (raw?.split(",") ?? []).forEach((candidate) => {
    const origin = normalizeConfiguredOrigin(candidate);
    if (origin) origins.add(origin);
  });
  return origins;
}

function resolveCanonicalBaseUrl(resolveBase: () => string = resolveBaseOrigin) {
  try {
    const rawBase = resolveBase();
    if (hasUnsafeUrlCharacters(rawBase)) return null;
    const parsed = new URL(rawBase);
    if (!TRUSTED_BROWSER_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    return new URL(`${parsed.origin}/`);
  } catch {
    return null;
  }
}

function resolveTrustedUrlAgainstOrigins(
  url: string,
  allowedOrigins: ReadonlySet<string>,
  options: { allowPathRelative: boolean }
) {
  if (hasUnsafeUrlCharacters(url)) return null;
  const normalized = url?.trim();
  if (!normalized) return null;

  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
  const base = resolveCanonicalBaseUrl();
  if (!hasExplicitScheme) {
    if (!base) return null;
    if (!options.allowPathRelative && !normalized.startsWith("/")) return null;
    try {
      const parsed = new URL(normalized, base);
      if (parsed.origin.toLowerCase() !== base.origin.toLowerCase()) return null;
      if (parsed.username || parsed.password) return null;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(normalized);
    if (!TRUSTED_BROWSER_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    if (!allowedOrigins.has(parsed.origin.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveTrustedExternalDataOrigins() {
  const origins = new Set<string>();
  const supabaseOrigin = normalizeConfiguredOrigin(
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  if (supabaseOrigin) origins.add(supabaseOrigin);
  resolveConfiguredOrigins(
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS
  ).forEach((origin) => origins.add(origin));
  return origins;
}

export function resolveTrustedOperationDocOrigins() {
  const origins = resolveConfiguredOrigins(
    process.env.NEXT_PUBLIC_UI_TRUSTED_OPERATION_DOC_ORIGINS
  );
  const base = resolveCanonicalBaseUrl();
  if (base) origins.add(base.origin.toLowerCase());
  return origins;
}

export const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = parseHostList(
  process.env.NEXT_PUBLIC_DOWNLOAD_ALLOWED_HOSTS ?? undefined
);

export const resolveSafeAppBasePath = (appBasePath: string) => {
  if (hasUnsafeUrlCharacters(appBasePath)) return null;
  const base = appBasePath.trim().replace(/\/+$/g, "");
  if (!base || base === "/") return "";
  if (base.startsWith("//")) return null;
  if (base.includes("://")) return null;
  if (/\s/.test(base)) {
    return null;
  }
  return base.startsWith("/") ? base : null;
};

export function resolveSafeHref(appBasePath: string, path: string) {
  const resolvedBase = resolveSafeAppBasePath(appBasePath);
  if (resolvedBase === null) return null;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const href = `${resolvedBase || ""}${normalizedPath}`;
  return resolveTrustedUrlAgainstOrigins(href, new Set(), {
    allowPathRelative: false,
  });
}

type TrustedUrlOptions = {
  allowedHosts?: ReadonlySet<string> | null;
  allowedSchemes?: ReadonlySet<string>;
  allowProtocolRelative?: boolean;
  resolveBase?: () => string;
};

const DEFAULT_TRUSTED_URL_OPTIONS: Required<TrustedUrlOptions> = {
  allowedHosts: null,
  allowedSchemes: TRUSTED_BROWSER_SCHEMES,
  allowProtocolRelative: false,
  resolveBase: resolveBaseOrigin,
};

export function isTrustedUrl(url: string, options?: TrustedUrlOptions) {
  if (hasUnsafeUrlCharacters(url)) return false;
  const normalized = url?.trim();
  if (!normalized) return false;
  const merged = { ...DEFAULT_TRUSTED_URL_OPTIONS, ...options };
  if (!merged.allowProtocolRelative && normalized.startsWith("//")) {
    return false;
  }
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
  try {
    const base = resolveCanonicalBaseUrl(merged.resolveBase);
    if (!base) return false;
    const parsed = new URL(normalized, base);
    if (!merged.allowedSchemes.has(parsed.protocol)) return false;
    if (!hasExplicitScheme && parsed.origin !== base.origin) return false;
    if (parsed.username || parsed.password) return false;
    if (
      hasExplicitScheme &&
      merged.allowedHosts &&
      merged.allowedHosts.size > 0
    ) {
      return merged.allowedHosts.has(parsed.host.toLowerCase());
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveTrustedExternalDataUrl(
  url: string,
  allowedOrigins: ReadonlySet<string> = resolveTrustedExternalDataOrigins()
) {
  return resolveTrustedUrlAgainstOrigins(url, allowedOrigins, {
    allowPathRelative: false,
  });
}

export function resolveTrustedOperationDocUrl(
  url: string,
  allowedOrigins: ReadonlySet<string> = resolveTrustedOperationDocOrigins()
) {
  return resolveTrustedUrlAgainstOrigins(url, allowedOrigins, {
    allowPathRelative: true,
  });
}

export function isTrustedExternalDataUrl(
  url: string,
  allowedOrigins?: ReadonlySet<string>
) {
  return resolveTrustedExternalDataUrl(url, allowedOrigins) !== null;
}

export function isTrustedDownloadUrl(
  url: string,
  allowedHosts?: ReadonlySet<string> | null
) {
  if (!allowedHosts) return isTrustedExternalDataUrl(url);
  if (!isTrustedUrl(url, {
    allowedHosts,
    allowedSchemes: TRUSTED_BROWSER_SCHEMES,
  })) {
    return false;
  }
  const normalized = url.trim();
  if (normalized.startsWith("/") && !normalized.startsWith("//")) return true;
  try {
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password) return false;
    return parsed.protocol !== "http:" || isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function safeDownloadUrls(
  urls: string[],
  allowedHosts?: ReadonlySet<string> | null
) {
  return urls.filter((url) => isTrustedDownloadUrl(url, allowedHosts));
}

export function openTrustedInNewTab(
  url: string,
  features = "noopener,noreferrer"
) {
  if (!isTrustedUrl(url)) {
    return null;
  }
  if (typeof window === "undefined") return null;
  return window.open(url, "_blank", features);
}
