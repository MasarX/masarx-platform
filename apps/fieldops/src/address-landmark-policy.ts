// Resolve address landmark policy and validate structured landmark and national address fields.
//
// Contract: the resolver `public.resolve_address_landmark_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     spl_validation: {
//       enabled: true,
//       required_for_market: ["SA"],
//       format_regex: "^[A-Z0-9]{8}$",
//       weak_validation_only: false
//     },
//     landmark_capture: {
//       enabled: true,
//       fields: [
//         { key: "primary_landmark",   label_en: "Primary landmark",   label_ar: "المعلم الأساسي",   max_length: 80,  required: false },
//         { key: "secondary_landmark", label_en: "Secondary landmark", label_ar: "المعلم الثانوي",   max_length: 80,  required: false },
//         { key: "delivery_notes",     label_en: "Delivery notes",     label_ar: "ملاحظات التسليم", max_length: 240, required: false }
//       ]
//     }
//   }
//
// This module:
//  1. Defines the typed shape (AddressLandmarkPolicyValue + LandmarkField +
//     SplValidationResult).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Provides pure validators:
//       - validateSplCode(policy, code, market) → SplValidationResult
//       - getLandmarkFields(policy) → LandmarkField[]
//       - validateLandmarkField(policy, fieldKey, value) → { valid, reason? }
//  4. Ships a STATIC fallback that mirrors the global default seed, so
//     consumers stay legible while the network query is in flight or offline.
//
// Structured landmark fields and per-market address requirements come from the resolved policy.
//
// Backward compat: STATIC_ADDRESS_LANDMARK MUST stay in sync with the
// migration global default seed in
// supabase/migrations/202604241950_address_landmark_policy_v1.sql. The pgTAP
// test 0zd_address_landmark_policy.sql asserts the seed values. The Jest test
// tests/unit/address-landmark-policy.test.ts asserts that this constant
// matches the migration default exactly.

export type SplValidationConfig = {
  enabled: boolean;
  required_for_market: string[];
  format_regex: string;
  weak_validation_only: boolean;
};

export type LandmarkField = {
  key: string;
  label_en: string;
  label_ar: string;
  max_length: number;
  required: boolean;
};

export type LandmarkCaptureConfig = {
  enabled: boolean;
  fields: LandmarkField[];
};

export type AddressLandmarkPolicyValue = {
  version: number;
  spl_validation: SplValidationConfig;
  landmark_capture: LandmarkCaptureConfig;
};

// SPL validation result. `reason` is a stable machine code for downstream
// branching (e.g. UI surfacing of a tooltip vs. blocking dispatch). Reasons:
//   - "missing": SPL value is null/undefined in a required market
//   - "empty":   SPL value is an empty / whitespace-only string in a required
//                market
//   - "invalid_format": SPL value does not match the configured format_regex
// Absence of `reason` means the value is valid in this market context.
export type SplValidationReason = "missing" | "empty" | "invalid_format";

export type SplValidationResult = {
  valid: boolean;
  reason?: SplValidationReason;
};

// Mirror of the migration seed (see
// supabase/migrations/202604241950_address_landmark_policy_v1.sql). Both unit
// + pgTAP tests pin this contract to catch drift between code and DB seed at
// PR time.
export const STATIC_ADDRESS_LANDMARK: AddressLandmarkPolicyValue = {
  version: 1,
  spl_validation: {
    enabled: true,
    required_for_market: ["SA"],
    format_regex: "^[A-Z0-9]{8}$",
    weak_validation_only: false,
  },
  landmark_capture: {
    enabled: true,
    fields: [
      {
        key: "primary_landmark",
        label_en: "Primary landmark",
        label_ar: "المعلم الأساسي",
        max_length: 80,
        required: false,
      },
      {
        key: "secondary_landmark",
        label_en: "Secondary landmark",
        label_ar: "المعلم الثانوي",
        max_length: 80,
        required: false,
      },
      {
        key: "delivery_notes",
        label_en: "Delivery notes",
        label_ar: "ملاحظات التسليم",
        max_length: 240,
        required: false,
      },
    ],
  },
};

// Helpers to clone the static seed (avoid sharing mutable references).
function cloneStaticSplValidation(): SplValidationConfig {
  return {
    enabled: STATIC_ADDRESS_LANDMARK.spl_validation.enabled,
    required_for_market: [
      ...STATIC_ADDRESS_LANDMARK.spl_validation.required_for_market,
    ],
    format_regex: STATIC_ADDRESS_LANDMARK.spl_validation.format_regex,
    weak_validation_only:
      STATIC_ADDRESS_LANDMARK.spl_validation.weak_validation_only,
  };
}

function cloneStaticLandmarkFields(): LandmarkField[] {
  return STATIC_ADDRESS_LANDMARK.landmark_capture.fields.map((f) => ({ ...f }));
}

function cloneStaticLandmarkCapture(): LandmarkCaptureConfig {
  return {
    enabled: STATIC_ADDRESS_LANDMARK.landmark_capture.enabled,
    fields: cloneStaticLandmarkFields(),
  };
}

// Boolean coercion: accepts strict booleans only; non-boolean values fall
// through to the safe fallback.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

// Numeric coercion: accepts finite positive integers; returns fallback otherwise.
function readPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return fallback;
}

function readNonEmptyString(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return fallback;
}

// Read an array of ISO-3166-1 alpha-2 market codes. Drops any entry that
// is not a 2-letter uppercase string. Falls back to the static seed when the
// input is not an array OR when no valid entries remain.
function readMarketList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (/^[A-Z]{2}$/.test(trimmed)) out.push(trimmed);
  }
  if (out.length === 0) return [...fallback];
  return out;
}

function normalizeSplValidation(raw: unknown): SplValidationConfig {
  if (!raw || typeof raw !== "object") return cloneStaticSplValidation();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(obj.enabled, STATIC_ADDRESS_LANDMARK.spl_validation.enabled),
    required_for_market: readMarketList(
      obj.required_for_market,
      STATIC_ADDRESS_LANDMARK.spl_validation.required_for_market,
    ),
    format_regex: readNonEmptyString(
      obj.format_regex,
      STATIC_ADDRESS_LANDMARK.spl_validation.format_regex,
    ),
    weak_validation_only: readBool(
      obj.weak_validation_only,
      STATIC_ADDRESS_LANDMARK.spl_validation.weak_validation_only,
    ),
  };
}

// Field-key shape: lowercase letters, digits, underscore, must start with a
// letter. Mirrors the schema_registry pattern. Anything else is dropped.
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

function normalizeLandmarkField(raw: unknown): LandmarkField | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const key = typeof obj.key === "string" ? obj.key : "";
  if (!FIELD_KEY_RE.test(key)) return null;
  const labelEn =
    typeof obj.label_en === "string" && obj.label_en.length > 0
      ? obj.label_en
      : null;
  const labelAr =
    typeof obj.label_ar === "string" && obj.label_ar.length > 0
      ? obj.label_ar
      : null;
  if (labelEn === null || labelAr === null) return null;
  // Fall back conservatively to a sane max-length cap rather than the static
  // seed for THIS specific field (we don't know which seed entry matches).
  const maxLength = readPositiveInt(obj.max_length, 240);
  const required = readBool(obj.required, false);
  return {
    key,
    label_en: labelEn,
    label_ar: labelAr,
    max_length: maxLength,
    required,
  };
}

function normalizeLandmarkCapture(raw: unknown): LandmarkCaptureConfig {
  if (!raw || typeof raw !== "object") return cloneStaticLandmarkCapture();
  const obj = raw as Record<string, unknown>;
  const enabled = readBool(
    obj.enabled,
    STATIC_ADDRESS_LANDMARK.landmark_capture.enabled,
  );
  const fields: LandmarkField[] = [];
  if (Array.isArray(obj.fields)) {
    for (const entry of obj.fields) {
      const field = normalizeLandmarkField(entry);
      if (field !== null) fields.push(field);
    }
  }
  if (fields.length === 0) {
    return { enabled, fields: cloneStaticLandmarkFields() };
  }
  return { enabled, fields };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// AddressLandmarkPolicyValue. Defensive: malformed sub-objects fall back to
// the STATIC seed so a bad row in production cannot brick mobile intake.
export function normalizeAddressLandmarkPolicy(
  raw: unknown,
): AddressLandmarkPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_ADDRESS_LANDMARK.version,
      spl_validation: cloneStaticSplValidation(),
      landmark_capture: cloneStaticLandmarkCapture(),
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_ADDRESS_LANDMARK.version;
  return {
    version,
    spl_validation: normalizeSplValidation(obj.spl_validation),
    landmark_capture: normalizeLandmarkCapture(obj.landmark_capture),
  };
}

// ---------------------------------------------------------------------------
// SPL validation
// ---------------------------------------------------------------------------

// Normalize a market string for comparison: trim + uppercase. Returns "" if
// not a string.
function normalizeMarket(market: unknown): string {
  if (typeof market !== "string") return "";
  return market.trim().toUpperCase();
}

// Validate an SPL (Saudi National Address) code against the policy.
//
// Validation rules
//   - If policy.spl_validation.enabled === false → always valid (SPL gate is
//     fully off for this scope).
//   - If the resolved market is NOT in required_for_market → SPL is optional:
//       * Empty / null / undefined / whitespace value → valid.
//       * Non-empty value that does not match format_regex → invalid_format
//         (we still validate the format when the user typed something).
//   - If the resolved market IS in required_for_market → SPL is mandatory:
//       * Null / undefined → invalid (reason: "missing").
//       * Empty / whitespace string → invalid (reason: "empty").
//       * Non-empty value that does not match format_regex → invalid
//         (reason: "invalid_format").
//       * Otherwise → valid.
//
// Defensive: if format_regex is itself malformed (RegExp construction throws),
// we return valid to avoid bricking intake — the policy author wrote a bad
// regex, not the driver. UI integration should surface a logged warning.
export function validateSplCode(
  policy: AddressLandmarkPolicyValue,
  code: string | null | undefined,
  market: string,
): SplValidationResult {
  if (!policy.spl_validation.enabled) {
    return { valid: true };
  }

  const normalizedMarket = normalizeMarket(market);
  const requiredMarkets = policy.spl_validation.required_for_market.map((m) =>
    m.trim().toUpperCase(),
  );
  const isRequired = requiredMarkets.includes(normalizedMarket);

  const codeStr = typeof code === "string" ? code : "";
  const trimmed = codeStr.trim();

  if (code === null || code === undefined) {
    if (isRequired) return { valid: false, reason: "missing" };
    return { valid: true };
  }

  if (trimmed.length === 0) {
    if (isRequired) return { valid: false, reason: "empty" };
    return { valid: true };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(policy.spl_validation.format_regex);
  } catch {
    // Malformed policy regex — fail open to keep intake flowing. UI should
    // surface a warning to the policy owner.
    return { valid: true };
  }

  if (!regex.test(trimmed)) {
    return { valid: false, reason: "invalid_format" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Landmark fields
// ---------------------------------------------------------------------------

// Returns the configured landmark fields in render order. When
// landmark_capture.enabled is false, returns an empty array (no fields are
// surfaced even if the field list is populated, so callers can hide the
// section uniformly).
export function getLandmarkFields(
  policy: AddressLandmarkPolicyValue,
): LandmarkField[] {
  if (!policy.landmark_capture.enabled) return [];
  return policy.landmark_capture.fields.map((f) => ({ ...f }));
}

// Landmark field validation result. `reason` codes:
//   - "unknown_field": the fieldKey does not match any field in the policy
//   - "required":      the field is required and the value is empty
//   - "max_length":    the value exceeds the configured max_length
// Absence of `reason` means the value is valid for this field.
export type LandmarkFieldValidationReason =
  | "unknown_field"
  | "required"
  | "max_length";

export type LandmarkFieldValidationResult = {
  valid: boolean;
  reason?: LandmarkFieldValidationReason;
};

// Validate a single landmark field value. Looks up the field by key, then:
//   - If the field is not in the policy → unknown_field (caller bug or stale
//     form). Defensive: never silently accept arbitrary keys.
//   - If field.required && value is empty/whitespace → required.
//   - If field.max_length && value.length > max_length → max_length.
//   - Otherwise → valid.
//
// Empty value (null/undefined/whitespace) on a non-required field is always
// valid — landmark fields are optional capture aids.
export function validateLandmarkField(
  policy: AddressLandmarkPolicyValue,
  fieldKey: string,
  value: string | null | undefined,
): LandmarkFieldValidationResult {
  const field = policy.landmark_capture.fields.find((f) => f.key === fieldKey);
  if (!field) {
    return { valid: false, reason: "unknown_field" };
  }
  const valueStr = typeof value === "string" ? value : "";
  const trimmed = valueStr.trim();
  if (trimmed.length === 0) {
    if (field.required) return { valid: false, reason: "required" };
    return { valid: true };
  }
  // Compare against raw length (not trimmed) so the user sees the same count
  // their input field shows.
  if (valueStr.length > field.max_length) {
    return { valid: false, reason: "max_length" };
  }
  return { valid: true };
}
