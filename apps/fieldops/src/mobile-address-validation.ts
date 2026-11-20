/**
 * Pure TS helpers for FieldOps AI-assisted address validation (plan P3.5).
 *
 * This module ships the offline/local helper surface: detector primitives for
 * Plus Codes / What3Words / free-text coordinates and a MENA-friendly component
 * extractor. Production integrations can later hook Google Plus Codes / W3W
 * APIs behind the same shape, but nothing here depends on a network runtime.
 */

export type AddressValidationKind =
  | "free_text"
  | "plus_code"
  | "what3words"
  | "coordinates";

export type AddressValidationConfidence = "high" | "medium" | "low";

export type AddressValidationComponents = {
  city: string | null;
  district: string | null;
  street: string | null;
  postal_code: string | null;
  building: string | null;
  plus_code: string | null;
  what3words: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type AddressValidationResult = {
  normalized: string;
  kind: AddressValidationKind;
  confidence: AddressValidationConfidence;
  components: AddressValidationComponents;
  warnings: string[];
};

// Simplified Open Location Code alphabet: the 20 disambiguation-friendly chars.
const OLC_ALPHABET = "[23456789CFGHJMPQRVWX]";
// Local OLC: 4..8 code chars, then '+', then 2..3 code chars (e.g. 8FVC9G8F+6X).
const PLUS_CODE_LOCAL = new RegExp(
  `^${OLC_ALPHABET}{4,8}\\+${OLC_ALPHABET}{2,3}$`,
  "i",
);
// Regional OLC with 6-char area prefix (e.g. 7JQGH+2P, 9C3XG8+XX).
const PLUS_CODE_REGIONAL = new RegExp(
  `^${OLC_ALPHABET}{4,6}\\+${OLC_ALPHABET}{2,3}$`,
  "i",
);

// What3Words: triple-slash prefix + three unicode-letter words separated by dots.
const WHAT3WORDS_PATTERN = /^\/{3}\s*[\p{L}]+\.[\p{L}]+\.[\p{L}]+\s*$/u;

// MENA-friendly postal code (5 digits, covers SA/JO/AE/KW etc.).
const POSTAL_CODE_PATTERN = /\b(\d{5})\b/;

// Arabic/English street + district keyword hints.
const STREET_KEYWORDS = [
  "شارع",
  "طريق",
  "street",
  "st.",
  "st ",
  "rd.",
  "road",
  "avenue",
  "ave",
];
const DISTRICT_KEYWORDS = ["حي", "district", "neighborhood", "neighbourhood"];
const BUILDING_KEYWORDS = [
  "مبنى",
  "بناية",
  "عمارة",
  "building",
  "bldg",
  "tower",
  "block",
  "villa",
];

// Known MENA cities + districts (short, representative set — extensions welcome).
const KNOWN_CITIES = [
  "riyadh",
  "jeddah",
  "dammam",
  "mecca",
  "makkah",
  "medina",
  "madinah",
  "dubai",
  "abu dhabi",
  "sharjah",
  "doha",
  "kuwait city",
  "manama",
  "muscat",
  "amman",
  "cairo",
  "alexandria",
  "beirut",
  "الرياض",
  "جدة",
  "الدمام",
  "مكة",
  "المدينة",
  "دبي",
  "أبوظبي",
  "الشارقة",
  "الدوحة",
  "عمان",
  "القاهرة",
  "الإسكندرية",
  "بيروت",
];
const KNOWN_DISTRICTS = [
  "al olaya",
  "al malaz",
  "al nakheel",
  "al sulaimaniyah",
  "al khalidiyah",
  "al murabba",
  "al rawdah",
  "العليا",
  "الملز",
  "النخيل",
  "الروضة",
  "الخالدية",
  "الحمراء",
];

function asTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForDetector(value: string): string {
  return collapseWhitespace(value);
}

function lower(value: string): string {
  return value.toLowerCase();
}

function clampLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function clampLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * Detect whether a raw string is an Open Location Code (Plus Code) — either
 * in its local 4..8 + 2..3 form (e.g. "8FVC9G8F+6X") or its shorter regional
 * prefix form (e.g. "7JQGH+2P" or "9C3XG8+XX"). The check is deliberately a
 * pure syntactic test; full OLC validity (grid parity) is out of scope for
 * this offline helper.
 */
export function isPlusCode(value: string): boolean {
  const normalized = asTrimmedString(value);
  if (!normalized) return false;
  if (PLUS_CODE_LOCAL.test(normalized)) return true;
  if (PLUS_CODE_REGIONAL.test(normalized)) return true;
  return false;
}

/**
 * Detect whether a raw string is a What3Words address. Accepts English and
 * Arabic letter words (via the Unicode letter class) and tolerates optional
 * whitespace after the leading slashes (e.g. "/// word.word.word").
 */
export function isWhat3Words(value: string): boolean {
  const normalized = asTrimmedString(value);
  if (!normalized) return false;
  return WHAT3WORDS_PATTERN.test(normalized);
}

/**
 * Extract a coordinate pair from free-text. Recognizes common shapes:
 *   - "24.71, 46.67"
 *   - "lat: 24.71, lng: 46.67"
 *   - "geo:24.71,46.67"
 *   - "24.71 46.67"
 *
 * Returns null if the string does not contain a coordinate pair with a valid
 * latitude (-90..90) and longitude (-180..180).
 */
export function extractCoordinatesFromFreeText(
  raw: string,
): { latitude: number; longitude: number } | null {
  const text = asTrimmedString(raw);
  if (!text) return null;

  const geoScheme = text.match(/geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (geoScheme) {
    const lat = Number(geoScheme[1]);
    const lng = Number(geoScheme[2]);
    if (clampLatitude(lat) && clampLongitude(lng)) {
      return { latitude: lat, longitude: lng };
    }
  }

  const pair = text.match(
    /(-?\d{1,3}(?:\.\d+)?)[\s,;]+(-?\d{1,3}(?:\.\d+)?)/,
  );
  if (pair) {
    const lat = Number(pair[1]);
    const lng = Number(pair[2]);
    if (clampLatitude(lat) && clampLongitude(lng)) {
      return { latitude: lat, longitude: lng };
    }
  }

  return null;
}

function findFirstPlusCodeToken(raw: string): string | null {
  const tokens = raw.split(/[\s,;|]+/).filter(Boolean);
  for (const token of tokens) {
    if (isPlusCode(token)) return token.toUpperCase();
  }
  return null;
}

function findFirstWhat3WordsToken(raw: string): string | null {
  // Look for "///word.word.word" anywhere in the string.
  const match = raw.match(/\/{3}\s*[\p{L}]+\.[\p{L}]+\.[\p{L}]+/u);
  if (match) {
    return collapseWhitespace(match[0]);
  }
  return null;
}

function detectPostalCode(raw: string): string | null {
  const match = raw.match(POSTAL_CODE_PATTERN);
  return match ? match[1] : null;
}

function detectKnownFromList(raw: string, entries: string[]): string | null {
  const haystack = lower(raw);
  for (const entry of entries) {
    if (!entry) continue;
    const needle = lower(entry);
    if (haystack.includes(needle)) return entry;
  }
  return null;
}

function detectKeywordLine(raw: string, keywords: string[]): string | null {
  const parts = raw.split(/[,\n]/);
  const haystackParts = parts.map((p) => collapseWhitespace(p)).filter(Boolean);
  for (const segment of haystackParts) {
    const lowered = lower(segment);
    for (const keyword of keywords) {
      if (lowered.includes(keyword)) return segment;
    }
  }
  return null;
}

function emptyComponents(): AddressValidationComponents {
  return {
    city: null,
    district: null,
    street: null,
    postal_code: null,
    building: null,
    plus_code: null,
    what3words: null,
    latitude: null,
    longitude: null,
  };
}

/**
 * Compute a 0..1 completeness score: +0.15 per non-null component, capped at
 * 1.0. Latitude and longitude count as a single coordinate component to avoid
 * double-counting a single geo-point.
 */
export function scoreAddressCompleteness(
  components: AddressValidationComponents,
): number {
  let filled = 0;
  const considerations: Array<boolean> = [
    components.city !== null,
    components.district !== null,
    components.street !== null,
    components.postal_code !== null,
    components.building !== null,
    components.plus_code !== null,
    components.what3words !== null,
    components.latitude !== null && components.longitude !== null,
  ];
  for (const present of considerations) {
    if (present) filled += 1;
  }
  const score = filled * 0.15;
  return score > 1 ? 1 : score;
}

function resolveConfidence(
  kind: AddressValidationKind,
  components: AddressValidationComponents,
  completeness: number,
): AddressValidationConfidence {
  if (kind === "plus_code" || kind === "what3words" || kind === "coordinates") {
    return "high";
  }
  if (completeness >= 0.6) return "high";
  if (completeness >= 0.3) return "medium";
  if (components.city || components.postal_code) return "medium";
  return "low";
}

/**
 * Validate and normalize a raw address string. Detectors run in order:
 * coordinates → Plus Code → What3Words → free-text (MENA heuristics).
 *
 * The returned shape is always populated (never partially undefined); missing
 * values use nulls so downstream UI can render fallback UX deterministically.
 */
export function validateAddress(raw: string): AddressValidationResult {
  const warnings: string[] = [];
  const input = typeof raw === "string" ? raw : "";
  const normalized = collapseWhitespace(input);

  if (!normalized) {
    warnings.push("empty_input");
    return {
      normalized: "",
      kind: "free_text",
      confidence: "low",
      components: emptyComponents(),
      warnings,
    };
  }

  const components = emptyComponents();

  // 1. Coordinates (including geo: scheme).
  const coords = extractCoordinatesFromFreeText(normalized);
  if (coords) {
    components.latitude = coords.latitude;
    components.longitude = coords.longitude;
  }

  // 2. Plus Code detection — either the entire string or embedded.
  const directPlus = isPlusCode(normalizeForDetector(normalized));
  const tokenPlus = findFirstPlusCodeToken(normalized);
  if (directPlus) {
    components.plus_code = normalized.toUpperCase();
  } else if (tokenPlus) {
    components.plus_code = tokenPlus;
  }

  // 3. What3Words detection — whole or embedded.
  const directW3W = isWhat3Words(normalized);
  const tokenW3W = findFirstWhat3WordsToken(normalized);
  if (directW3W) {
    components.what3words = normalized;
  } else if (tokenW3W) {
    components.what3words = tokenW3W;
  }

  // 4. Free-text extraction (postal code, known city/district, street/bldg hints).
  components.postal_code = detectPostalCode(normalized);
  components.city = detectKnownFromList(normalized, KNOWN_CITIES);
  components.district =
    detectKnownFromList(normalized, KNOWN_DISTRICTS)
      ?? detectKeywordLine(normalized, DISTRICT_KEYWORDS);
  components.street = detectKeywordLine(normalized, STREET_KEYWORDS);
  components.building = detectKeywordLine(normalized, BUILDING_KEYWORDS);

  // Determine kind — coordinates win only when the raw string is *only* a
  // coordinate pair (no other components detected). Plus Code / What3Words
  // win when the raw string is exactly that form.
  let kind: AddressValidationKind = "free_text";
  if (directPlus) {
    kind = "plus_code";
  } else if (directW3W) {
    kind = "what3words";
  } else if (coords && !components.city && !components.postal_code && !components.plus_code && !components.what3words) {
    kind = "coordinates";
  }

  // Warnings — bubble up useful signals for UI.
  if (!components.city && !components.postal_code && !components.plus_code && !components.what3words && !coords) {
    warnings.push("no_structural_components");
  }
  if (components.latitude !== null && components.longitude === null) {
    warnings.push("partial_coordinates");
  }
  if (components.longitude !== null && components.latitude === null) {
    warnings.push("partial_coordinates");
  }
  if (!components.city && kind === "free_text") {
    warnings.push("missing_city");
  }

  const completeness = scoreAddressCompleteness(components);
  const confidence = resolveConfidence(kind, components, completeness);

  return {
    normalized,
    kind,
    confidence,
    components,
    warnings,
  };
}
