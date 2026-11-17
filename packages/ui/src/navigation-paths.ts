export function normalizeBasePath(basePath?: string) {
  if (!basePath) return "";
  const trimmed = basePath.replace(/\/+$/g, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function splitSuffix(value: string) {
  const match = value.match(/[?#]/);
  if (!match) return { path: value, suffix: "" };
  const index = match.index ?? value.length;
  return { path: value.slice(0, index), suffix: value.slice(index) };
}

function dedupeLeadingSegment(pathValue: string) {
  const { path, suffix } = splitSuffix(pathValue);
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 1 && segments[0] === segments[1]) {
    segments.splice(1, 1);
  }
  const normalized = `/${segments.join("/")}`;
  const result = normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
  return suffix ? `${result}${suffix}` : result;
}

function stripLegacyRootAppPrefix(pathValue: string) {
  const { path, suffix } = splitSuffix(pathValue);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const legacyPrefixes = ["/console", "/portal"];
  for (const prefix of legacyPrefixes) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      const stripped = normalizedPath.slice(prefix.length) || "/";
      const result = stripped.startsWith("/") ? stripped : `/${stripped}`;
      return suffix ? `${result}${suffix}` : result;
    }
  }
  return pathValue;
}

export function stripBasePath(href: string, basePath?: string) {
  const normalizedBase = normalizeBasePath(basePath);
  if (!normalizedBase) return href;
  const { path, suffix } = splitSuffix(href);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!normalizedPath.startsWith(normalizedBase)) return href;
  const stripped = normalizedPath.slice(normalizedBase.length) || "/";
  const result = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return suffix ? `${result}${suffix}` : result;
}

export function normalizeAppHref(href: string, basePath?: string) {
  const trimmed = href.trim();
  if (!trimmed) return "";
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedHref = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!normalizedBase) {
    return stripLegacyRootAppPrefix(dedupeLeadingSegment(normalizedHref));
  }
  if (normalizedBase) {
    const doublePrefix = `${normalizedBase}${normalizedBase}`;
    if (normalizedHref.startsWith(doublePrefix)) {
      return dedupeLeadingSegment(
        normalizedHref.replace(doublePrefix, normalizedBase)
      );
    }
  }
  return dedupeLeadingSegment(normalizedHref);
}

function stripHashAndQuery(value: string) {
  return value.split("#")[0]?.split("?")[0] ?? value;
}

export function normalizePath(value: string, basePath?: string) {
  const cleaned = stripHashAndQuery(value);
  const normalizedBase = normalizeBasePath(basePath);
  let normalized = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  if (normalizedBase && normalized.startsWith(normalizedBase)) {
    normalized = normalized.slice(normalizedBase.length) || "/";
  }
  if (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || "/";
}
