import type { MobileV2PodMethod } from "./mobile-v2-pod-policy";

export type MobileV2PodArtifactKind = "photo" | "signature" | "identity" | "cod_receipt";

export interface MobileV2PodCapturedArtifact {
  readonly artifactId: string;
  readonly kind: MobileV2PodArtifactKind;
  readonly method: MobileV2PodMethod | null;
  readonly capturedAt: string;
  readonly storageKey?: string | null;
}

export interface MobileV2PodArtifactCaptureInput {
  readonly kind: MobileV2PodArtifactKind;
  readonly method: MobileV2PodMethod | null;
  readonly mimeType: string;
  readonly extension: string;
  readonly capturedAt: string;
  readonly base64?: string | null;
  readonly text?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MobileV2SignaturePoint {
  readonly x: number;
  readonly y: number;
}

export const MOBILE_V2_SIGNATURE_MIME_TYPE = "image/png";
export const MOBILE_V2_SIGNATURE_FILE_EXTENSION = "png";
const MOBILE_V2_SIGNATURE_MAX_PNG_WIDTH = 640;
const MOBILE_V2_SIGNATURE_MAX_PNG_HEIGHT = 256;

const REQUIRED_ARTIFACT_KIND_BY_METHOD: Readonly<Partial<Record<MobileV2PodMethod, MobileV2PodArtifactKind>>> =
  Object.freeze({
    photo: "photo",
    sig: "signature",
    id: "identity",
  });

const REQUIRED_ARTIFACT_METHOD_LABELS: Readonly<Record<MobileV2PodMethod, string>> = Object.freeze({
  scan: "parcel scan",
  photo: "parcel photo",
  sig: "customer signature",
  otp: "OTP",
  id: "ID document",
  cod: "COD collection",
});

function coerceNonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function readMobileV2PolicyContextId(
  context: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  if (context === undefined) return null;
  const direct = coerceNonEmptyText(context[key]);
  if (direct !== null) return direct;
  const policy = context.policy_context;
  if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
    return coerceNonEmptyText((policy as Record<string, unknown>)[key]);
  }
  return null;
}

export function normalizeMobileV2PodArtifactIds(
  artifactsOrIds: ReadonlyArray<MobileV2PodCapturedArtifact | string> | null | undefined,
): ReadonlyArray<string> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of artifactsOrIds ?? []) {
    const id = typeof entry === "string" ? entry.trim() : entry.artifactId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

export function getMobileV2RequiredPodArtifactKind(
  method: MobileV2PodMethod,
): MobileV2PodArtifactKind | null {
  return REQUIRED_ARTIFACT_KIND_BY_METHOD[method] ?? null;
}

export function mobileV2PodArtifactIsRegistered(
  artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>,
  method: MobileV2PodMethod,
): boolean {
  const requiredKind = getMobileV2RequiredPodArtifactKind(method);
  if (requiredKind === null) return true;
  return artifacts.some((artifact) =>
    artifact.method === method &&
    artifact.kind === requiredKind &&
    artifact.artifactId.trim().length > 0,
  );
}

export function listMissingMobileV2PodArtifactMethods(
  methods: ReadonlyArray<MobileV2PodMethod>,
  artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>,
): ReadonlyArray<MobileV2PodMethod> {
  const seen = new Set<MobileV2PodMethod>();
  const missing: MobileV2PodMethod[] = [];
  for (const method of methods) {
    if (seen.has(method)) continue;
    seen.add(method);
    if (getMobileV2RequiredPodArtifactKind(method) === null) continue;
    if (mobileV2PodArtifactIsRegistered(artifacts, method)) continue;
    missing.push(method);
  }
  return Object.freeze(missing);
}

export function formatMobileV2PodArtifactMethodList(
  methods: ReadonlyArray<MobileV2PodMethod>,
): string {
  return methods.map((method) => REQUIRED_ARTIFACT_METHOD_LABELS[method]).join(", ");
}

export function buildMobileV2PodArtifactStorageKey(input: {
  readonly organizationId: string;
  readonly routeStopId: string;
  readonly kind: MobileV2PodArtifactKind;
  readonly extension: string;
  readonly uniqueId: string;
}): string {
  const extension = sanitizePathPart(input.extension).replace(/^[.]+/, "") || "bin";
  return [
    input.organizationId,
    "pod",
    input.routeStopId,
    `${sanitizePathPart(input.kind)}-${sanitizePathPart(input.uniqueId)}.${extension}`,
  ].join("/");
}

export function buildMobileV2CleaningEvidenceStorageKey(input: {
  readonly organizationId: string;
  readonly shiftId: string;
  readonly uniqueId: string;
}): string {
  return [
    input.organizationId,
    "cleaning",
    sanitizePathPart(input.shiftId),
    `photo-${sanitizePathPart(input.uniqueId)}.jpg`,
  ].join("/");
}

export function buildMobileV2CashDropEvidenceStorageKey(input: {
  readonly organizationId: string;
  readonly uniqueId: string;
  readonly extension: string;
}): string {
  const extension = sanitizePathPart(input.extension).replace(/^[.]+/, "") || "bin";
  return [
    input.organizationId,
    "cash-drop",
    `envelope-${sanitizePathPart(input.uniqueId)}.${extension}`,
  ].join("/");
}

export function buildMobileV2KycDocumentStorageKey(input: {
  readonly organizationId: string;
  readonly docKey: string;
  readonly uniqueId: string;
}): string {
  return [
    input.organizationId,
    "kyc-documents",
    sanitizePathPart(input.docKey),
    `photo-${sanitizePathPart(input.uniqueId)}.jpg`,
  ].join("/");
}

export function buildMobileV2IstimaraStorageKey(input: {
  readonly organizationId: string;
  readonly uniqueId: string;
}): string {
  return [
    input.organizationId,
    "kyc-vehicle",
    "istimara",
    `photo-${sanitizePathPart(input.uniqueId)}.jpg`,
  ].join("/");
}

export function buildMobileV2VehiclePhotoStorageKey(input: {
  readonly organizationId: string;
  readonly angleId: string;
  readonly uniqueId: string;
}): string {
  return [
    input.organizationId,
    "vehicle-photos",
    sanitizePathPart(input.angleId),
    `photo-${sanitizePathPart(input.uniqueId)}.jpg`,
  ].join("/");
}

export function decodeMobileV2Base64ToArrayBuffer(value: string): ArrayBuffer {
  const Buffer = (
    globalThis as {
      Buffer?: { from: (input: string, encoding: "base64") => { toString: (encoding: "binary") => string } };
    }
  ).Buffer;
  const binary =
    typeof atob === "function"
      ? atob(value)
      : Buffer && Buffer.from(value, "base64").toString("binary");
  if (binary === undefined) {
    throw new Error("Base64 decoding is unavailable in this runtime.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function encodeMobileV2TextToArrayBuffer(value: string): ArrayBuffer {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).buffer;
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes.buffer;
}

export function buildMobileV2SignatureSvg(input: {
  readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}): string {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  const paths = input.strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const [first, ...rest] = stroke;
      if (first === undefined) return "";
      const d = [
        `M ${Math.round(first.x * 100) / 100} ${Math.round(first.y * 100) / 100}`,
        ...rest.map((point) => `L ${Math.round(point.x * 100) / 100} ${Math.round(point.y * 100) / 100}`),
      ].join(" ");
      return `<path d="${d}" fill="none" stroke="#111827" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<metadata>${input.capturedAt}</metadata>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    paths,
    "</svg>",
  ].join("");
}

function writeUint32Be(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    a = (a + (bytes[index] ?? 0)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function textBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index) & 0xff;
  }
  return out;
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeData = textBytes(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32Be(chunk, 0, data.length);
  chunk.set(typeData, 4);
  chunk.set(data, 8);
  writeUint32Be(chunk, 8 + data.length, crc32(concatBytes([typeData, data])));
  return chunk;
}

function zlibStore(bytes: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < bytes.length; offset += 65535) {
    const slice = bytes.slice(offset, Math.min(offset + 65535, bytes.length));
    const finalBlock = offset + slice.length >= bytes.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = finalBlock;
    header[1] = slice.length & 0xff;
    header[2] = (slice.length >>> 8) & 0xff;
    const nlen = (~slice.length) & 0xffff;
    header[3] = nlen & 0xff;
    header[4] = (nlen >>> 8) & 0xff;
    blocks.push(header, slice);
  }
  const checksum = new Uint8Array(4);
  writeUint32Be(checksum, 0, adler32(bytes));
  blocks.push(checksum);
  return concatBytes(blocks);
}

function putPixel(data: Uint8Array, width: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= width) return;
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  if (offset < 1 || offset + 3 >= data.length) return;
  data[offset] = 17;
  data[offset + 1] = 24;
  data[offset + 2] = 39;
  data[offset + 3] = 255;
}

function drawSignatureLine(
  data: Uint8Array,
  width: number,
  height: number,
  from: MobileV2SignaturePoint,
  to: MobileV2SignaturePoint,
): void {
  const x0 = Math.round(from.x);
  const y0 = Math.round(from.y);
  const x1 = Math.round(to.x);
  const y1 = Math.round(to.y);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) {
          putPixel(data, width, x + dx, y + dy);
        }
      }
    }
  }
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const Buffer = (
    globalThis as {
      Buffer?: { from: (input: Uint8Array) => { toString: (encoding: "base64") => string } };
    }
  ).Buffer;
  if (Buffer !== undefined) {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this runtime.");
  }
  return btoa(binary);
}

export function buildMobileV2SignaturePngBase64(input: {
  readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
  readonly width: number;
  readonly height: number;
}): string {
  const sourceWidth = Math.max(1, Math.round(input.width));
  const sourceHeight = Math.max(1, Math.round(input.height));
  const scale = Math.min(
    1,
    MOBILE_V2_SIGNATURE_MAX_PNG_WIDTH / sourceWidth,
    MOBILE_V2_SIGNATURE_MAX_PNG_HEIGHT / sourceHeight,
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const scanlineLength = width * 4 + 1;
  const rgba = new Uint8Array(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    rgba[y * scanlineLength] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * scanlineLength + 1 + x * 4;
      rgba[offset] = 255;
      rgba[offset + 1] = 255;
      rgba[offset + 2] = 255;
      rgba[offset + 3] = 255;
    }
  }
  for (const stroke of input.strokes) {
    const scaledStroke = stroke.map((point) => ({
      x: point.x * scale,
      y: point.y * scale,
    }));
    if (scaledStroke.length === 1) {
      const point = scaledStroke[0];
      if (point !== undefined) putPixel(rgba, width, Math.round(point.x), Math.round(point.y));
    }
    for (let index = 1; index < scaledStroke.length; index += 1) {
      const from = scaledStroke[index - 1];
      const to = scaledStroke[index];
      if (from !== undefined && to !== undefined) {
        drawSignatureLine(rgba, width, height, from, to);
      }
    }
  }
  const ihdr = new Uint8Array(13);
  writeUint32Be(ihdr, 0, width);
  writeUint32Be(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return encodeBytesToBase64(concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStore(rgba)),
    pngChunk("IEND", new Uint8Array()),
  ]));
}

export function buildMobileV2SignatureArtifactCaptureInput(input: {
  readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
}): MobileV2PodArtifactCaptureInput {
  return {
    kind: "signature",
    method: "sig",
    mimeType: MOBILE_V2_SIGNATURE_MIME_TYPE,
    extension: MOBILE_V2_SIGNATURE_FILE_EXTENSION,
    capturedAt: input.capturedAt,
    base64: buildMobileV2SignaturePngBase64(input),
    metadata: {
      proof_type: "sig",
      artifact_kind: "signature",
      signature: {
        strokes: input.strokes.length,
        width: input.width,
        height: input.height,
      },
    },
  };
}
