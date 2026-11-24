export type PodPhotoQualityVerdict = "accept" | "warn" | "reject";

export type PodPhotoQualityScores = {
  brightness: number;
  variance: number;
  edgeDensity: number;
};

export type PodPhotoQualityResult = {
  verdict: PodPhotoQualityVerdict;
  scores: PodPhotoQualityScores;
  reasons: string[];
};

export type PodPhotoQualityOptions = {
  brightnessMin?: number;
  brightnessMax?: number;
  varianceMin?: number;
  edgeDensityMin?: number;
  brightnessWarnMin?: number;
  brightnessWarnMax?: number;
  edgeGradientThreshold?: number;
};

type ResolvedOptions = Required<PodPhotoQualityOptions>;

export const DEFAULT_POD_PHOTO_QUALITY_OPTIONS: ResolvedOptions = {
  brightnessMin: 0.20,
  brightnessMax: 0.85,
  varianceMin: 0.04,
  edgeDensityMin: 0.08,
  brightnessWarnMin: 0.25,
  brightnessWarnMax: 0.75,
  edgeGradientThreshold: 0.05,
};

export const POD_PHOTO_QUALITY_REASON_CODES = {
  TOO_DARK: "too_dark",
  TOO_BRIGHT: "too_bright",
  BRIGHTNESS_OFF: "brightness_off",
  LOW_VARIANCE_LIKELY_BLURRY: "low_variance_likely_blurry",
  LOW_EDGE_DENSITY: "low_edge_density",
  EMPTY_IMAGE: "empty_image",
  INVALID_DIMENSIONS: "invalid_dimensions",
} as const;

type PixelData = Uint8ClampedArray | Uint8Array;

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function luminanceAt(data: PixelData, idx: number): number {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function resolveOptions(opts: PodPhotoQualityOptions | undefined): ResolvedOptions {
  if (!opts) return { ...DEFAULT_POD_PHOTO_QUALITY_OPTIONS };
  return {
    brightnessMin: readNonNegativeNumber(opts.brightnessMin, DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessMin),
    brightnessMax: readNonNegativeNumber(opts.brightnessMax, DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessMax),
    varianceMin: readNonNegativeNumber(opts.varianceMin, DEFAULT_POD_PHOTO_QUALITY_OPTIONS.varianceMin),
    edgeDensityMin: readNonNegativeNumber(opts.edgeDensityMin, DEFAULT_POD_PHOTO_QUALITY_OPTIONS.edgeDensityMin),
    brightnessWarnMin: readNonNegativeNumber(
      opts.brightnessWarnMin,
      DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessWarnMin,
    ),
    brightnessWarnMax: readNonNegativeNumber(
      opts.brightnessWarnMax,
      DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessWarnMax,
    ),
    edgeGradientThreshold: readNonNegativeNumber(
      opts.edgeGradientThreshold,
      DEFAULT_POD_PHOTO_QUALITY_OPTIONS.edgeGradientThreshold,
    ),
  };
}

export function computeBrightness(data: PixelData): number {
  const len = data.length;
  if (len < 4) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < len; i += 4) {
    sum += luminanceAt(data, i);
    count++;
  }
  return count > 0 ? clampUnit(sum / count) : 0;
}

export function computeVariance(data: PixelData, mean?: number): number {
  const len = data.length;
  if (len < 4) return 0;
  const m = typeof mean === "number" && Number.isFinite(mean) ? mean : computeBrightness(data);
  let sumSquared = 0;
  let count = 0;
  for (let i = 0; i < len; i += 4) {
    const lum = luminanceAt(data, i);
    const delta = lum - m;
    sumSquared += delta * delta;
    count++;
  }
  return count > 0 ? clampUnit(sumSquared / count) : 0;
}

export function computeEdgeDensity(
  data: PixelData,
  width: number,
  height: number,
  threshold: number = DEFAULT_POD_PHOTO_QUALITY_OPTIONS.edgeGradientThreshold,
): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2
  ) {
    return 0;
  }
  const expectedLength = width * height * 4;
  if (data.length < expectedLength) return 0;

  const safeThreshold = Number.isFinite(threshold) && threshold >= 0
    ? threshold
    : DEFAULT_POD_PHOTO_QUALITY_OPTIONS.edgeGradientThreshold;

  const rowStride = width * 4;
  let edges = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const idx = (y * width + x) * 4;
      const center = luminanceAt(data, idx);
      const right = luminanceAt(data, idx + 4);
      const below = luminanceAt(data, idx + rowStride);
      const dx = Math.abs(center - right);
      const dy = Math.abs(center - below);
      if (dx > safeThreshold || dy > safeThreshold) edges++;
      count++;
    }
  }

  return count > 0 ? clampUnit(edges / count) : 0;
}

export function evaluatePodPhotoQuality(
  data: PixelData,
  width: number,
  height: number,
  opts?: PodPhotoQualityOptions,
): PodPhotoQualityResult {
  const o = resolveOptions(opts);
  const reasons: string[] = [];

  if (!data || data.length < 4) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.EMPTY_IMAGE);
    return {
      verdict: "reject",
      scores: { brightness: 0, variance: 0, edgeDensity: 0 },
      reasons,
    };
  }

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  ) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.INVALID_DIMENSIONS);
    return {
      verdict: "reject",
      scores: { brightness: 0, variance: 0, edgeDensity: 0 },
      reasons,
    };
  }

  const brightness = computeBrightness(data);
  const variance = computeVariance(data, brightness);
  const edgeDensity = computeEdgeDensity(data, width, height, o.edgeGradientThreshold);

  let verdict: PodPhotoQualityVerdict = "accept";

  if (brightness < o.brightnessMin) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.TOO_DARK);
    verdict = "reject";
  } else if (brightness > o.brightnessMax) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.TOO_BRIGHT);
    verdict = "reject";
  } else if (brightness < o.brightnessWarnMin || brightness > o.brightnessWarnMax) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.BRIGHTNESS_OFF);
    if (verdict === "accept") verdict = "warn";
  }

  if (variance < o.varianceMin) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.LOW_VARIANCE_LIKELY_BLURRY);
    verdict = "reject";
  }

  if (edgeDensity < o.edgeDensityMin) {
    reasons.push(POD_PHOTO_QUALITY_REASON_CODES.LOW_EDGE_DENSITY);
    if (verdict === "accept") verdict = "warn";
  }

  return {
    verdict,
    scores: { brightness, variance, edgeDensity },
    reasons,
  };
}
