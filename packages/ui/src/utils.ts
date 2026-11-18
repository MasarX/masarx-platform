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

export function formatUiError(error: unknown, fallback: string) {
  if (!error) return fallback;
  if (typeof error === "string") {
    return sanitizeUiError(error) ?? fallback;
  }
  if (error instanceof Error && error.message) {
    return sanitizeUiError(error.message) ?? fallback;
  }
  if (typeof error === "object") {
    const typed = error as {
      message?: string;
      details?: string;
      hint?: string;
      error?: string;
      error_description?: string;
      code?: string;
    };
    const resolved =
      typed.message ||
      typed.details ||
      typed.hint ||
      typed.error_description ||
      typed.error ||
      typed.code ||
      fallback;
    return sanitizeUiError(resolved) ?? fallback;
  }
  return fallback;
}

const TECHNICAL_UI_ERROR_PATTERNS: RegExp[] = [
  /\bbackend\b/i,
  /\bread[-_\s]?back\b/i,
  /\bevent[-_\s]?read[-_\s]?back\b/i,
  /\bcorrelation(?:[_\s-]?id)?\b/i,
  /\bdebug\b/i,
  /\bdiagnostic\b/i,
  /\braw[-_\s]?(?:backend|json|payload|response|table)\b/i,
];

function isTechnicalUiErrorMessage(message: string): boolean {
  return TECHNICAL_UI_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function isSchemaCacheFunctionUnavailableError(
  error: unknown,
  functionName?: string
) {
  const normalized = normalizeLower(formatUiError(error, ""));
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

  const normalizedMessage = normalizeLower(formatUiError(error, ""));
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
  const trimmed = sanitized.trim();
  if (!trimmed || isTechnicalUiErrorMessage(trimmed)) return null;
  return trimmed;
}
