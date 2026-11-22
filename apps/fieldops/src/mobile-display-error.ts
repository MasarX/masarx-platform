import { redactOutboxErrorText } from "@masarx/mobile-core";

function readErrorPart(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" ? value.trim() : "";
}

// Keep the original text available for internal error classification.
export function readRawErrorText(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error.trim() || "Unknown error";
  if (error instanceof Error) return error.message || "Unknown error";
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint].map(readErrorPart).filter(Boolean);
    const code = readErrorPart(record.code);
    if (parts.length) {
      return code ? `[${code}] ${parts.join(" - ")}` : parts.join(" - ");
    }
    try {
      return JSON.stringify(record) ?? String(record);
    } catch {
      return String(record);
    }
  }
  return String(error);
}

export function formatUnknownError(error: unknown): string {
  return redactOutboxErrorText(readRawErrorText(error));
}
