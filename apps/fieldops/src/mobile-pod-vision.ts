/**
 * Pure TS helpers for FieldOps vision-based POD image quality analysis
 * (plan P3.6). No ML runtime — this is a heuristic pass that scores POD
 * photos based on metadata (dimensions, byte size, capture context) so the
 * mobile shell can warn/reject obviously unusable captures *before* they
 * ever reach the outbox.
 *
 * Future integration with Core ML / TFLite models plugs in behind the same
 * `analyzePodImageQuality` shape.
 */

export type PodImageOrientation = "portrait" | "landscape" | "unknown";

export type PodImageCaptureContext = {
  speedKph?: number | null;
  accuracy_m?: number | null;
  orientation?: PodImageOrientation;
};

export type PodImageAnalysisInput = {
  widthPx: number;
  heightPx: number;
  byteSize: number;
  mime: string;
  captureContext?: PodImageCaptureContext;
};

export type PodImageClassification = "acceptable" | "borderline" | "reject";

export type PodImageQualityResult = {
  score: number;
  classification: PodImageClassification;
  warnings: string[];
  bytes_per_megapixel: number;
};

export type PodPhotoPolicy = {
  min_width_px: number;
  min_height_px: number;
  min_bytes_per_megapixel: number;
  max_bytes_per_megapixel: number;
  reject_threshold: number;
  borderline_threshold: number;
  max_capture_speed_kph: number;
};

export const DEFAULT_POD_PHOTO_POLICY: PodPhotoPolicy = {
  min_width_px: 800,
  min_height_px: 800,
  min_bytes_per_megapixel: 40_000,
  max_bytes_per_megapixel: 2_500_000,
  reject_threshold: 0.45,
  borderline_threshold: 0.7,
  max_capture_speed_kph: 20,
};

const MIN_IMAGE_DIMENSION = 1;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  return value;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  return value;
}

function readUnitFloat(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeMime(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const trimmed = value.trim().toLowerCase();
  return trimmed || "application/octet-stream";
}

function resolveSpeedKph(context: PodImageCaptureContext | undefined): number {
  if (!context) return 0;
  const raw = context.speedKph;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return raw;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function computeBytesPerMegapixel(widthPx: number, heightPx: number, byteSize: number): number {
  const width = Math.max(MIN_IMAGE_DIMENSION, Math.round(widthPx));
  const height = Math.max(MIN_IMAGE_DIMENSION, Math.round(heightPx));
  const megapixels = (width * height) / 1_000_000;
  if (megapixels <= 0) return 0;
  return byteSize / megapixels;
}

function classifyScore(
  score: number,
  rejectThreshold: number,
  borderlineThreshold: number,
): PodImageClassification {
  if (score < rejectThreshold) return "reject";
  if (score < borderlineThreshold) return "borderline";
  return "acceptable";
}

/**
 * Heuristic POD image quality analysis. Score starts at 1.0 and deducts for
 * each red flag the metadata exposes. Classification is derived from the
 * final score using the default reject/borderline thresholds from the
 * built-in policy; {@link evaluatePodPhotoAgainstPolicy} lets callers pass
 * their own row-driven thresholds.
 */
export function analyzePodImageQuality(input: PodImageAnalysisInput): PodImageQualityResult {
  const warnings: string[] = [];
  const widthPx = readPositiveNumber(input.widthPx, 0);
  const heightPx = readPositiveNumber(input.heightPx, 0);
  const byteSize = readNonNegativeNumber(input.byteSize, 0);
  const mime = safeMime(input.mime);
  const speedKph = resolveSpeedKph(input.captureContext);
  const orientation = input.captureContext?.orientation ?? "unknown";

  const bytesPerMegapixel = computeBytesPerMegapixel(widthPx, heightPx, byteSize);

  let score = 1.0;

  if (widthPx < 800 || heightPx < 800) {
    score -= 0.3;
    warnings.push("low_resolution");
  }

  if (bytesPerMegapixel > 0 && bytesPerMegapixel < 40_000) {
    score -= 0.2;
    warnings.push("over_compressed");
  }

  if (speedKph > 20) {
    score -= 0.1;
    warnings.push("captured_while_moving");
  }

  if (byteSize <= 0) {
    warnings.push("missing_byte_size");
  }
  if (widthPx <= 0 || heightPx <= 0) {
    warnings.push("missing_dimensions");
  }
  if (mime.startsWith("image/") === false) {
    warnings.push("non_image_mime");
  }
  if (orientation === "unknown") {
    warnings.push("unknown_orientation");
  }

  const normalizedScore = clampScore(score);
  const classification = classifyScore(normalizedScore, 0.45, 0.7);

  return {
    score: normalizedScore,
    classification,
    warnings,
    bytes_per_megapixel: bytesPerMegapixel,
  };
}

/**
 * Normalize an arbitrary policy row into a typed {@link PodPhotoPolicy}. Any
 * missing or invalid field falls back to the default built-in value so the
 * mobile shell can always compute a deterministic result.
 */
export function normalizePodPhotoPolicy(raw: unknown): PodPhotoPolicy {
  const input = asRecord(raw);
  const defaults = DEFAULT_POD_PHOTO_POLICY;

  const minWidth = Math.round(readPositiveNumber(input.min_width_px, defaults.min_width_px));
  const minHeight = Math.round(readPositiveNumber(input.min_height_px, defaults.min_height_px));
  const minBpm = readPositiveNumber(input.min_bytes_per_megapixel, defaults.min_bytes_per_megapixel);
  const maxBpmCandidate = readPositiveNumber(input.max_bytes_per_megapixel, defaults.max_bytes_per_megapixel);
  const maxBpm = maxBpmCandidate > minBpm ? maxBpmCandidate : defaults.max_bytes_per_megapixel;

  let rejectThreshold = readUnitFloat(input.reject_threshold, defaults.reject_threshold);
  let borderlineThreshold = readUnitFloat(input.borderline_threshold, defaults.borderline_threshold);
  if (borderlineThreshold <= rejectThreshold) {
    // Keep invariants: borderline must be above reject so a score can fall
    // between them deterministically.
    borderlineThreshold = defaults.borderline_threshold;
    rejectThreshold = defaults.reject_threshold;
  }

  const maxSpeedKph = readNonNegativeNumber(
    input.max_capture_speed_kph,
    defaults.max_capture_speed_kph,
  );

  return {
    min_width_px: minWidth > 0 ? minWidth : defaults.min_width_px,
    min_height_px: minHeight > 0 ? minHeight : defaults.min_height_px,
    min_bytes_per_megapixel: minBpm > 0 ? minBpm : defaults.min_bytes_per_megapixel,
    max_bytes_per_megapixel: maxBpm > 0 ? maxBpm : defaults.max_bytes_per_megapixel,
    reject_threshold: rejectThreshold,
    borderline_threshold: borderlineThreshold,
    max_capture_speed_kph: maxSpeedKph,
  };
}

/**
 * Evaluate a POD photo against the (resolved) policy row. Returns both the
 * pass/fail verdict and the structured reasons list so the UI can surface
 * precise guidance to the driver (e.g. "retake: image too compressed").
 */
export function evaluatePodPhotoAgainstPolicy(
  input: PodImageAnalysisInput,
  policy: PodPhotoPolicy,
): { pass: boolean; reasons: string[]; quality: PodImageQualityResult } {
  const quality = analyzePodImageQuality(input);
  const reasons: string[] = [];

  const widthPx = readPositiveNumber(input.widthPx, 0);
  const heightPx = readPositiveNumber(input.heightPx, 0);
  const speedKph = resolveSpeedKph(input.captureContext);

  if (widthPx < policy.min_width_px) {
    reasons.push("width_below_minimum");
  }
  if (heightPx < policy.min_height_px) {
    reasons.push("height_below_minimum");
  }
  if (
    quality.bytes_per_megapixel > 0 &&
    quality.bytes_per_megapixel < policy.min_bytes_per_megapixel
  ) {
    reasons.push("image_over_compressed");
  }
  if (quality.bytes_per_megapixel > policy.max_bytes_per_megapixel) {
    reasons.push("image_bytes_excessive");
  }
  if (speedKph > policy.max_capture_speed_kph) {
    reasons.push("speed_above_maximum");
  }

  // Re-classify using the policy-provided thresholds so row-driven tenants
  // can tighten/relax the rails without code changes.
  const policyClassification = classifyScore(
    quality.score,
    policy.reject_threshold,
    policy.borderline_threshold,
  );
  if (policyClassification === "reject") {
    reasons.push("quality_score_rejected");
  } else if (policyClassification === "borderline") {
    reasons.push("quality_score_borderline");
  }

  const failedByClassification = policyClassification === "reject";
  const failedBySpeed = speedKph > policy.max_capture_speed_kph;

  const pass = !failedByClassification && !failedBySpeed;

  return {
    pass,
    reasons,
    quality: {
      ...quality,
      classification: policyClassification,
    },
  };
}
