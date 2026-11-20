/**
 * Rapid multi-scan helpers for the MasarX FieldOps mobile app
 * (format validation, scan-to-stop navigation,
 * and on-device barcode quality).
 *
 * Pure TypeScript: no React, no Expo imports, no side effects. Behaviour is
 * row-driven by `ScanFormatPolicy` inputs resolved elsewhere through the
 * canonical settings ladder; this module only interprets them.
 */

export type ScanFormatPolicy = {
  pattern: string | null; // optional regex source
  min_length: number | null;
  max_length: number | null;
  check_digit?: "none" | "mod10" | "mod11" | null;
};

export type ScanValidationResult =
  | { ok: true; normalized: string }
  | {
      ok: false;
      reason:
        | "empty"
        | "too_short"
        | "too_long"
        | "bad_pattern"
        | "bad_check_digit";
    };

export type RapidScanHit = {
  barcode: string;
  at: number; // ms timestamp
  scan_type: string | null;
  matched_stop_id: string | null;
};

export type RapidScanBuffer = {
  hits: RapidScanHit[];
  maxSize: number;
};

export type StopSnapshotLike = {
  stopId: string;
  reference?: string | null;
  shipmentId?: string | null;
  parcelBarcodes?: string[] | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeForMatch(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Check-digit validators
// ---------------------------------------------------------------------------

/**
 * Luhn / mod-10 check digit validator. The rightmost digit is the check digit
 * itself. The algorithm doubles every second digit from the right (the digit
 * immediately to the left of the check digit is the first to be doubled),
 * sums the resulting digits, and requires the total to be divisible by 10.
 */
export function passesMod10(value: string): boolean {
  if (typeof value !== "string") return false;
  const digits = value.trim();
  if (digits.length < 2) return false;
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = digits.charCodeAt(i) - 48; // '0' = 48
    if (digit < 0 || digit > 9) return false;
    if (doubleNext) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
    doubleNext = !doubleNext;
  }
  return sum % 10 === 0;
}

/**
 * ISBN-10 / GS1 style mod-11 check digit validator. Weights digits from the
 * right-most content digit (position 2) upward: each content digit is multiplied
 * by (position + 1) and summed. The check digit (rightmost) must equal
 * (11 - (sum % 11)) % 11, where 10 is represented as 'X' (case insensitive).
 */
export function passesMod11(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;

  const upper = trimmed.toUpperCase();
  const contentPart = upper.slice(0, upper.length - 1);
  const checkPart = upper.slice(upper.length - 1);
  if (!/^\d+$/.test(contentPart)) return false;

  let checkValue: number;
  if (checkPart === "X") {
    checkValue = 10;
  } else if (/^\d$/.test(checkPart)) {
    checkValue = checkPart.charCodeAt(0) - 48;
  } else {
    return false;
  }

  let sum = 0;
  let weight = 2;
  for (let i = contentPart.length - 1; i >= 0; i -= 1) {
    const digit = contentPart.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    sum += digit * weight;
    weight += 1;
  }

  const expected = (11 - (sum % 11)) % 11;
  return expected === checkValue;
}

// ---------------------------------------------------------------------------
// Barcode validation
// ---------------------------------------------------------------------------

export function validateBarcode(
  raw: string,
  policy: ScanFormatPolicy | null | undefined
): ScanValidationResult {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  if (!normalized) {
    return { ok: false, reason: "empty" };
  }

  const effectivePolicy = policy ?? null;

  if (effectivePolicy) {
    const minLen = effectivePolicy.min_length;
    if (isPositiveInteger(minLen) && normalized.length < minLen) {
      return { ok: false, reason: "too_short" };
    }
    const maxLen = effectivePolicy.max_length;
    if (isPositiveInteger(maxLen) && normalized.length > maxLen) {
      return { ok: false, reason: "too_long" };
    }

    if (typeof effectivePolicy.pattern === "string" && effectivePolicy.pattern.length > 0) {
      let regex: RegExp;
      try {
        regex = new RegExp(effectivePolicy.pattern);
      } catch {
        // Malformed policy regex must not crash scan path; reject as bad_pattern.
        return { ok: false, reason: "bad_pattern" };
      }
      if (!regex.test(normalized)) {
        return { ok: false, reason: "bad_pattern" };
      }
    }

    const checkDigit = effectivePolicy.check_digit ?? "none";
    if (checkDigit === "mod10") {
      if (!passesMod10(normalized)) {
        return { ok: false, reason: "bad_check_digit" };
      }
    } else if (checkDigit === "mod11") {
      if (!passesMod11(normalized)) {
        return { ok: false, reason: "bad_check_digit" };
      }
    }
  }

  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// Rapid scan buffer
// ---------------------------------------------------------------------------

export function createRapidScanBuffer(maxSize: number = 6): RapidScanBuffer {
  const safeMax =
    Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 6;
  return { hits: [], maxSize: safeMax };
}

export function appendRapidScan(
  buffer: RapidScanBuffer,
  hit: RapidScanHit
): RapidScanBuffer {
  const maxSize = buffer.maxSize > 0 ? buffer.maxSize : 6;
  const nextHits = buffer.hits.concat({
    barcode: hit.barcode,
    at: hit.at,
    scan_type: hit.scan_type,
    matched_stop_id: hit.matched_stop_id,
  });
  while (nextHits.length > maxSize) {
    nextHits.shift();
  }
  return {
    hits: nextHits,
    maxSize,
  };
}

export function clearRapidScanBuffer(buffer: RapidScanBuffer): RapidScanBuffer {
  return {
    hits: [],
    maxSize: buffer.maxSize > 0 ? buffer.maxSize : 6,
  };
}

// ---------------------------------------------------------------------------
// Match-to-stop resolver
// ---------------------------------------------------------------------------

/**
 * Find the first stop whose reference / shipment id / parcel barcodes match
 * the scanned value. Matching is case-insensitive and whitespace-trimmed.
 * Priority is strict: reference exact -> shipment id exact -> parcel list
 * includes.
 */
export function matchStopForBarcode(
  barcode: string,
  stops: StopSnapshotLike[]
): StopSnapshotLike | null {
  const needle = normalizeForMatch(barcode);
  if (!needle) return null;
  if (!Array.isArray(stops) || stops.length === 0) return null;

  // Priority 1: reference exact match.
  for (const stop of stops) {
    const reference = normalizeForMatch(stop.reference);
    if (reference && reference === needle) {
      return stop;
    }
  }

  // Priority 2: shipment id exact match.
  for (const stop of stops) {
    const shipmentId = normalizeForMatch(stop.shipmentId);
    if (shipmentId && shipmentId === needle) {
      return stop;
    }
  }

  // Priority 3: parcel barcode list includes.
  for (const stop of stops) {
    const parcels = Array.isArray(stop.parcelBarcodes) ? stop.parcelBarcodes : [];
    for (const parcel of parcels) {
      if (normalizeForMatch(parcel) === needle) {
        return stop;
      }
    }
  }

  return null;
}
