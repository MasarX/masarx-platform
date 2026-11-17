const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function isRetriableNetworkError(error: unknown) {
  if (!error) return false;
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("failed to fetch") ||
      message.includes("networkerror")
    ) {
      return true;
    }
  }
  if (typeof error === "object") {
    const typed = error as { cause?: unknown; code?: unknown };
    const code = typeof typed.code === "string" ? typed.code : null;
    const causeCode =
      typed.cause && typeof typed.cause === "object" && "code" in typed.cause
        ? String((typed.cause as { code?: unknown }).code ?? "")
        : null;
    const normalized = (code || causeCode || "").toUpperCase();
    return TRANSIENT_NETWORK_CODES.has(normalized);
  }
  return false;
}

export function isRetriableSupabaseError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const typed = error as {
    status?: number | string;
    code?: string | number;
    message?: string;
    details?: string;
    hint?: string;
  };
  const status = typed.status ? Number(typed.status) : null;
  if (status && (status === 429 || status >= 500)) return true;
  const code = typed.code ? String(typed.code).toUpperCase() : null;
  if (code && ["429", "500", "502", "503", "504"].includes(code)) return true;

  const details = [typed.message, typed.details, typed.hint]
    .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
    .join(" ");
  const schemaCacheFunctionMiss =
    details.includes("schema cache") && details.includes("could not find the function");

  if (code === "PGRST202" || schemaCacheFunctionMiss) {
    return true;
  }

  return false;
}
