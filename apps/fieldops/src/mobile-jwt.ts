function decodeBase64Url(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? `${normalized}${"=".repeat(4 - pad)}` : normalized;

  try {
    if (typeof globalThis.atob === "function") {
      return globalThis.atob(padded);
    }
  } catch {
    // Ignore.
  }

  const bufferRef = (globalThis as { Buffer?: { from?: unknown } }).Buffer;
  if (bufferRef && typeof bufferRef.from === "function") {
    try {
      return (bufferRef.from as any)(padded, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const decoded = decodeBase64Url(parts[1] ?? "");
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveJwtRole(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const role = payload?.role;
  return typeof role === "string" ? role : null;
}

export function isJwtPrivilegedRole(role: string | null): boolean {
  if (!role) return false;
  return role === ["service", "role"].join("_");
}
