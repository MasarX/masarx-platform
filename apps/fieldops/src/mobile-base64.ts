function decodeWithAvailableRuntime(value: string): string {
  if (typeof globalThis.atob === "function") {
    return globalThis.atob(value);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("binary");
  }

  throw new Error("Base64 decoding is unavailable in this runtime.");
}

export function normalizeBase64Payload(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const withoutDataUriPrefix = trimmed.replace(/^data:[^;]+;base64,/i, "");
  const withoutWhitespace = withoutDataUriPrefix.replace(/\s+/g, "");
  const normalizedAlphabet = withoutWhitespace.replace(/-/g, "+").replace(/_/g, "/");
  const missingPadding = normalizedAlphabet.length % 4;

  if (missingPadding === 0) {
    return normalizedAlphabet;
  }

  return normalizedAlphabet.padEnd(normalizedAlphabet.length + (4 - missingPadding), "=");
}

export function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const normalized = normalizeBase64Payload(value);
  if (!normalized) {
    throw new Error("Base64 image data is required.");
  }

  const decoded = decodeWithAvailableRuntime(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}
