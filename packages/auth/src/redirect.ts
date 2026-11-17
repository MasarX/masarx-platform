const LEGACY_APP_PREFIXES = ["/console", "/portal"] as const;

type PathParts = {
  path: string;
  search: string;
  hash: string;
};

function splitPathParts(value: string): PathParts {
  const raw = String(value || "");
  const hashIndex = raw.indexOf("#");
  const withNoHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : "";
  const queryIndex = withNoHash.indexOf("?");
  const path = queryIndex >= 0 ? withNoHash.slice(0, queryIndex) : withNoHash;
  const search = queryIndex >= 0 ? withNoHash.slice(queryIndex) : "";
  return { path, search, hash };
}

function normalizeAbsolutePath(pathValue: string) {
  const raw = String(pathValue || "").trim();
  if (!raw || raw === "/") return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash.startsWith("//")) return "/";
  return withLeadingSlash.replace(/\/+$/g, "") || "/";
}

export function stripLegacyRootAppPrefix(pathWithSuffix: string) {
  const parts = splitPathParts(pathWithSuffix);
  const normalizedPath = normalizeAbsolutePath(parts.path);
  for (const prefix of LEGACY_APP_PREFIXES) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      const stripped = normalizedPath.slice(prefix.length) || "/";
      const normalized = normalizeAbsolutePath(stripped);
      return `${normalized}${parts.search}${parts.hash}`;
    }
  }
  return `${normalizedPath}${parts.search}${parts.hash}`;
}

function normalizeNextPath(nextPath: string | null | undefined) {
  const trimmed = String(nextPath || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return stripLegacyRootAppPrefix(trimmed);
  }
  return trimmed;
}

export function normalizeAppBasePath(input?: string | null) {
  const trimmed = input?.trim() ?? "";
  if (!trimmed || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash === "//") return "/";
  if (withSlash.includes("://")) return "/";
  if (withSlash.startsWith("//")) return "/";
  if (/\s/.test(withSlash)) return "/";
  return stripLegacyRootAppPrefix(withSlash.replace(/\/+$/g, "")) || "/";
}

export function resolveRedirectTarget(
  requestUrl: URL,
  nextPath: string | null | undefined,
  fallbackPath: string
) {
  const normalizedFallback = normalizeAppBasePath(fallbackPath);
  const fallback = new URL(normalizedFallback, requestUrl.origin);
  const normalizedNext = normalizeNextPath(nextPath);
  if (!normalizedNext) {
    return fallback;
  }

  try {
    const target = new URL(normalizedNext, requestUrl.origin);
    if (target.origin !== requestUrl.origin) {
      return fallback;
    }
    const normalizedPath = stripLegacyRootAppPrefix(
      `${target.pathname}${target.search}${target.hash}`
    );
    const normalizedUrl = new URL(normalizedPath, requestUrl.origin);
    return normalizedUrl;
  } catch {
    return fallback;
  }
}
