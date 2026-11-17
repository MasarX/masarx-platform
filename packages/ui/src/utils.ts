import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeLower(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`
  );
  return `{${entries.join(",")}}`;
}

// Classification uses the original message; render only formatUiError's result.
export function getUiErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const key of ["message", "details", "hint", "error_description", "error", "code"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return null;
}

const TECHNICAL_UI_ERROR_PATTERN = /\b(?:backend|read[-_\s]?back|event[-_\s]?read[-_\s]?back|correlation(?:[_\s-]?id)?|debug|diagnostic|raw[-_\s]?(?:backend|json|payload|response|table))\b/i;

export function formatUiError(error: unknown, fallback: string) {
  const message = sanitizeUiError(getUiErrorMessage(error));
  if (!message) return fallback;
  if (!TECHNICAL_UI_ERROR_PATTERN.test(message)) return message;
  // Retain blocked-state classification without exposing the diagnostic suffix.
  if (isCapabilityDeniedMessage(message)) {
    const key = extractCapabilityDeniedKey(message);
    return key ? `Capability denied: ${key}` : "Capability denied";
  }
  return fallback;
}

export function isSchemaCacheFunctionUnavailableError(
  error: unknown,
  functionName?: string
) {
  const normalized = normalizeLower(getUiErrorMessage(error));
  if (!normalized) return false;
  const hasSchemaCacheMarker =
    normalized.includes("schema cache") ||
    normalized.includes("could not find the function");
  if (!hasSchemaCacheMarker) return false;
  if (!functionName) return true;
  return normalized.includes(functionName.trim().toLowerCase());
}

export function isCapabilityDeniedMessage(message: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("capability denied") ||
    normalized.includes("missing required capability") ||
    normalized.includes("permission denied for capability")
  );
}

function normalizeCapabilityKeyCandidate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "*") return trimmed;
  if (!/^[a-z0-9_.*-]+$/i.test(trimmed)) return null;
  if (!trimmed.includes(".")) return null;
  return trimmed;
}

const CAPABILITY_KEY_PATTERNS: RegExp[] = [
  /capability denied:\s*([a-z0-9_.*-]+)/i,
  /missing required capability:\s*([a-z0-9_.*-]+)/i,
  /requires?\s+([a-z0-9_.*-]+)\s+capability/i,
  /for capability\s+([a-z0-9_.*-]+)/i,
];

export function extractCapabilityDeniedKey(message: string | null): string | null {
  if (!message) return null;
  for (const pattern of CAPABILITY_KEY_PATTERNS) {
    const match = message.match(pattern);
    const candidate = normalizeCapabilityKeyCandidate(match?.[1] ?? null);
    if (candidate) return candidate;
  }
  return null;
}

export function isStatementTimeoutUiError(error: unknown): boolean {
  if (!error) return false;

  const normalizedMessage = normalizeLower(getUiErrorMessage(error));
  if (normalizedMessage?.includes("statement timeout")) return true;

  if (typeof error !== "object") return false;

  const typed = error as {
    code?: string | number;
    status?: string | number;
    details?: string;
    message?: string;
  };

  const normalizedDetails = normalizeLower(typed.details);
  if (normalizedDetails?.includes("statement timeout")) return true;

  const normalizedCode = typed.code ? String(typed.code).trim().toUpperCase() : null;
  if (normalizedCode === "57014") return true;

  const normalizedStatus = typed.status ? String(typed.status).trim().toUpperCase() : null;
  if (normalizedStatus === "57014") return true;

  return false;
}

export function sanitizeUiError(message: string | null) {
  if (!message) return null;
  let sanitized = message;
  sanitized = sanitized.replace(
    /(^|[^a-z0-9_-])(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
    "$1$2[redacted]"
  );
  sanitized = sanitized.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]+(?:\.[A-Za-z0-9_-]+)*/gi, "$1 [redacted]");
  sanitized = sanitized.replace(
    /(^|[^a-z0-9_-])((?:["']?)(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|(?:[a-z0-9]+[_-])*(?:api[_-]?key|password|secret|token|signature|private[_-]?key))["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,
    "$1$2[redacted]"
  );
  sanitized = sanitized.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  sanitized = sanitized.replace(
    /\b([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\b/g,
    (match, partOne, partTwo, partThree) => {
      const looksLikeJwt =
        match.length >= 50 &&
        String(partOne).length >= 8 &&
        String(partTwo).length >= 8 &&
        String(partThree).length >= 8;
      return looksLikeJwt ? "[redacted]" : match;
    }
  );
  sanitized = sanitized.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]");
  return sanitized.trim() || null;
}
