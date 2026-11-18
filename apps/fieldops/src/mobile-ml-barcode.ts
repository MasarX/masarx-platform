import {
  validateBarcode,
  type ScanFormatPolicy,
  type ScanValidationResult,
} from "./mobile-scan-rapid";

/**
 * Pure-TS ML-ready barcode classifier. Wraps `validateBarcode` with a
 * confidence score derived from image quality + matcher context so a future
 * on-device ML runtime (P3.3) can hook in behind the same shape without
 * changing call sites.
 */

export type BarcodeMLClassifierSource = "validate_only" | "heuristic" | "ml_v1";

export type BarcodeMLClassification = {
  barcode: string;
  validation: ScanValidationResult;
  confidence: number;
  classifier_source: BarcodeMLClassifierSource;
  warnings: string[];
};

export type BarcodeMLImageMetadata = {
  widthPx: number;
  heightPx: number;
  byteSize: number;
  mime: string;
  blur_score?: number | null;
};

export type BarcodeMLContext = {
  matched_stop_id?: string | null;
  consecutive_rapid_scans?: number;
  duplicate_of_recent?: boolean;
};

export type BarcodeMLInput = {
  raw_barcode: string;
  scan_policy: ScanFormatPolicy | null;
  image_metadata?: BarcodeMLImageMetadata | null;
  context?: BarcodeMLContext;
};

export type BarcodeMLInferencer = (
  input: BarcodeMLInput
) => Promise<BarcodeMLClassification>;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function hasImageMetadata(input: BarcodeMLInput): boolean {
  return Boolean(input.image_metadata && input.image_metadata.widthPx > 0);
}

function hasContext(input: BarcodeMLInput): boolean {
  return Boolean(
    input.context &&
      (input.context.matched_stop_id != null ||
        (input.context.consecutive_rapid_scans ?? 0) > 0 ||
        input.context.duplicate_of_recent === true)
  );
}

export function classifyBarcode(input: BarcodeMLInput): BarcodeMLClassification {
  const validation = validateBarcode(input.raw_barcode, input.scan_policy);
  const warnings: string[] = [];

  if (!validation.ok) {
    return {
      barcode: String(input.raw_barcode || "").trim(),
      validation,
      confidence: 0,
      classifier_source:
        hasImageMetadata(input) || hasContext(input) ? "heuristic" : "validate_only",
      warnings: [`validation_failed:${validation.reason}`],
    };
  }

  let confidence = 0.6;

  if (input.image_metadata) {
    const { widthPx, heightPx, byteSize } = input.image_metadata;
    const pixels = Math.max(1, widthPx * heightPx);

    if (widthPx >= 800 && heightPx >= 800) {
      confidence += 0.1;
    } else {
      warnings.push("low_resolution_image");
    }

    const bytesPerPixel = byteSize / pixels;
    if (bytesPerPixel >= 0.05) {
      confidence += 0.1;
    } else {
      warnings.push("over_compressed_image");
    }

    if (typeof input.image_metadata.blur_score === "number") {
      if (input.image_metadata.blur_score < 0.35) {
        confidence -= 0.15;
        warnings.push("blurry_image");
      } else if (input.image_metadata.blur_score > 0.75) {
        confidence += 0.05;
      }
    }
  }

  if (input.context) {
    if (input.context.matched_stop_id != null) {
      confidence += 0.1;
    }
    if (input.context.duplicate_of_recent === true) {
      confidence -= 0.15;
      warnings.push("duplicate_of_recent_scan");
    }
    if ((input.context.consecutive_rapid_scans ?? 0) > 5) {
      confidence -= 0.1;
      warnings.push("rapid_scan_fatigue");
    }
  }

  const classifier_source: BarcodeMLClassifierSource =
    hasImageMetadata(input) || hasContext(input) ? "heuristic" : "validate_only";

  return {
    barcode: validation.normalized,
    validation,
    confidence: clamp(confidence, 0, 1),
    classifier_source,
    warnings,
  };
}

/**
 * Runtime-registered inferencer (P3.3). A future on-device ML runtime (TFLite
 * / CoreML / Expo camera ML) registers itself once at boot via
 * `setBarcodeInferencer(...)` and every `classifyBarcodeAsync` call site
 * transparently routes through it. Passing `null` clears the registration
 * (useful for tests).
 */
let registeredInferencer: BarcodeMLInferencer | null = null;

export function setBarcodeInferencer(
  inferencer: BarcodeMLInferencer | null
): void {
  registeredInferencer = typeof inferencer === "function" ? inferencer : null;
}

export function getBarcodeInferencer(): BarcodeMLInferencer | null {
  return registeredInferencer;
}

export async function classifyBarcodeAsync(
  input: BarcodeMLInput,
  inferencer?: BarcodeMLInferencer
): Promise<BarcodeMLClassification> {
  const active = inferencer ?? registeredInferencer;
  if (typeof active === "function") {
    try {
      return await active(input);
    } catch {
      return classifyBarcode(input);
    }
  }
  return classifyBarcode(input);
}
