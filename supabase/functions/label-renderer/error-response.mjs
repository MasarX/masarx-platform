export const rendererInternalCode = "renderer_internal";

const configMissing = "config_missing";
const unknown = "unknown";
const fixedClasses = new Set([configMissing, unknown]);

export class RendererConfigurationError extends Error {}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isSqlState = (value) =>
  typeof value === "string" && value.length === 5 && /^[0-9A-Z]{5}$/.test(value);

/** @param {unknown} value */
export const isRendererErrorClass = (value) =>
  (typeof value === "string" && fixedClasses.has(value)) || isSqlState(value);

/** @param {unknown} error */
export function rendererInternalErrorBody(error) {
  let errorClass = unknown;
  if (error instanceof RendererConfigurationError) {
    errorClass = configMissing;
  } else if (
    error && typeof error === "object" && "code" in error &&
    ("severity" in error || ("details" in error && "hint" in error)) &&
    isSqlState(error.code)
  ) {
    errorClass = error.code;
  }
  return { error: { code: rendererInternalCode, class: errorClass } };
}
