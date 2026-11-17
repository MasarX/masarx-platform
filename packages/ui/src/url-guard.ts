const TRUSTED_BROWSER_SCHEMES = new Set(["http:", "https:"]);
const FALLBACK_TRUSTED_ORIGIN = "https://example.invalid";

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

export const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = parseHostList(
  process.env.NEXT_PUBLIC_DOWNLOAD_ALLOWED_HOSTS ?? undefined
);

export const resolveSafeAppBasePath = (appBasePath: string) => {
  const base = appBasePath.trim().replace(/\/+$/g, "");
  if (!base || base === "/") return "";
  if (base.startsWith("//")) return null;
  if (base.includes("://")) return null;
  if (/\s/.test(base)) return null;
  return base.startsWith("/") ? base : null;
};

export function resolveSafeHref(appBasePath: string, path: string) {
  const resolvedBase = resolveSafeAppBasePath(appBasePath);
  if (resolvedBase === null) return null;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const href = `${resolvedBase || ""}${normalizedPath}`;
  return isTrustedUrl(href) ? href : null;
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
  const normalized = url?.trim();
  if (!normalized) return false;
  const merged = { ...DEFAULT_TRUSTED_URL_OPTIONS, ...options };
  if (!merged.allowProtocolRelative && normalized.startsWith("//")) {
    return false;
  }
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
  try {
    const parsed = new URL(normalized, merged.resolveBase());
    if (!merged.allowedSchemes.has(parsed.protocol)) return false;
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

export function isTrustedDownloadUrl(
  url: string,
  allowedHosts: ReadonlySet<string> | null = DEFAULT_ALLOWED_DOWNLOAD_HOSTS
) {
  return isTrustedUrl(url, {
    allowedHosts,
    allowedSchemes: TRUSTED_BROWSER_SCHEMES,
  });
}

export function safeDownloadUrls(
  urls: string[],
  allowedHosts: ReadonlySet<string> | null = DEFAULT_ALLOWED_DOWNLOAD_HOSTS
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
