import { createUiTranslator } from "./i18n";

export type JsonFieldResult = { ok: true; value: unknown } | { ok: false; message: string };

// The one parser for JSON form fields; users get the catalog message, never the engine's English parse error.
export function parseJsonValue(raw: string, fallback: unknown): JsonFieldResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: fallback };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, message: createUiTranslator("ui.common")("invalidJson") };
  }
}
