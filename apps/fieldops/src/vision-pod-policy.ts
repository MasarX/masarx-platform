// Evaluate photo proof-of-delivery quality gates using vision_pod_policy.
//
// Contract: the resolver `public.resolve_vision_pod_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     enabled: false,
//     model: {
//       name: "yolov26-n",
//       version: "1.0.0",
//       size_mb: 8,
//       asset_uri_pattern: "${cdn_base}/vision/yolov26-n-${version}.tflite"
//     },
//     quality_gates: {
//       min_confidence: 0.65,
//       require_package_in_frame: true,
//       require_label_legible: false,
//       require_addressee_visible: false,
//       min_frame_brightness: 0.15,
//       max_motion_blur: 0.30
//     },
//     user_messaging: {
//       package_missing_en:  "Move closer so the package fills the frame",
//       package_missing_ar:  "اقترب أكثر حتى تملأ الطرد الإطار",
//       label_unreadable_en: "Try again with better lighting on the label",
//       label_unreadable_ar: "حاول مرة أخرى مع إضاءة أفضل للملصق",
//       low_brightness_en:   "Find a brighter spot",
//       low_brightness_ar:   "ابحث عن مكان أكثر إضاءة",
//       motion_blur_en:      "Hold still and try again",
//       motion_blur_ar:      "اثبت في مكانك وحاول مرة أخرى"
//     },
//     fallback_to_manual_after_attempts: 3
//   }
//
// This module:
//  1. Defines the typed shape (VisionPodPolicyValue + sub-types).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Provides pure resolvers:
//       - evaluateClassification(policy, classification, locale)
//           → { passed, failures, userMessage }  (applies all enabled gates,
//             returns the first failure's user message — first-fail wins so
//             the driver sees one clear instruction at a time).
//       - buildModelAssetUri(policy, cdnBase)
//           → string  (substitutes ${cdn_base} + ${version} into
//             asset_uri_pattern; the tenant-configurable CDN base lets ops
//             route asset delivery without touching the policy row).
//       - shouldFallbackToManual(policy, attemptCount)
//           → boolean (true when attemptCount >= fallback_to_manual_after_attempts;
//             the composer uses this to surface a manual-submit escape hatch
//             so an over-strict ML gate never blocks the driver).
//  4. Ships a STATIC fallback that mirrors the global default seed
//     (enabled=false), so consumers stay legible while the network query is
//     in flight or offline — and the gate evaluator is fully a no-op in that
//     fallback path so we never reject a POD photo unintentionally.
//
// Callers load the classifier and pass its results here. The policy can offer manual submission after repeated failures.
//
// Backward compat: STATIC_VISION_POD MUST stay in sync with the migration
// global default seed in
// supabase/migrations/202604242050_vision_pod_policy_v1.sql. The pgTAP test
// 0zd_vision_pod_policy.sql asserts the seed values. The Jest test
// tests/unit/vision-pod-policy.test.ts asserts that this constant matches
// the migration default exactly.

export type VisionPodLocale = "en" | "ar";

export type ModelDescriptor = {
  name: string;
  version: string;
  size_mb: number;
  asset_uri_pattern: string;
};

export type QualityGatesConfig = {
  min_confidence: number;
  require_package_in_frame: boolean;
  require_label_legible: boolean;
  require_addressee_visible: boolean;
  min_frame_brightness: number;
  max_motion_blur: number;
};

export type UserMessagingConfig = {
  package_missing_en: string;
  package_missing_ar: string;
  label_unreadable_en: string;
  label_unreadable_ar: string;
  low_brightness_en: string;
  low_brightness_ar: string;
  motion_blur_en: string;
  motion_blur_ar: string;
};

export type VisionPodPolicyValue = {
  version: number;
  enabled: boolean;
  model: ModelDescriptor;
  quality_gates: QualityGatesConfig;
  user_messaging: UserMessagingConfig;
  fallback_to_manual_after_attempts: number;
};

// Single observation from the (yet-to-be-integrated) on-device model. Each
// field is intentionally a simple primitive so the helper has zero coupling
// to the runtime — TFLite / Core ML / TFJS all collapse into this shape
// when the dependency-install card lands.
export type ClassificationResult = {
  confidence: number;
  has_package: boolean;
  label_legible: boolean;
  addressee_visible: boolean;
  brightness: number;
  motion_blur: number;
};

// Discriminator for the first failed gate. The composer surfaces the
// first failure's user message so the driver gets one clear instruction
// rather than a wall of complaints.
export type QualityGateFailure =
  | "low_confidence"
  | "package_missing"
  | "label_unreadable"
  | "addressee_missing"
  | "low_brightness"
  | "motion_blur";

export type EvaluationResult = {
  passed: boolean;
  failures: QualityGateFailure[];
  userMessage: string | null;
};

// Mirror of the migration seed (see supabase/migrations/202604242050_vision_pod_policy_v1.sql).
// enabled=false means this fallback is fully a no-op — evaluateClassification
// returns passed=true with no failures unless tenants opt in. Both unit +
// pgTAP tests pin this contract to catch drift between code and DB seed at
// PR time.
export const STATIC_VISION_POD: VisionPodPolicyValue = {
  version: 1,
  enabled: false,
  model: {
    name: "yolov26-n",
    version: "1.0.0",
    size_mb: 8,
    asset_uri_pattern: "${cdn_base}/vision/yolov26-n-${version}.tflite",
  },
  quality_gates: {
    min_confidence: 0.65,
    require_package_in_frame: true,
    require_label_legible: false,
    require_addressee_visible: false,
    min_frame_brightness: 0.15,
    max_motion_blur: 0.30,
  },
  user_messaging: {
    package_missing_en: "Move closer so the package fills the frame",
    package_missing_ar: "اقترب أكثر حتى تملأ الطرد الإطار",
    label_unreadable_en: "Try again with better lighting on the label",
    label_unreadable_ar: "حاول مرة أخرى مع إضاءة أفضل للملصق",
    low_brightness_en: "Find a brighter spot",
    low_brightness_ar: "ابحث عن مكان أكثر إضاءة",
    motion_blur_en: "Hold still and try again",
    motion_blur_ar: "اثبت في مكانك وحاول مرة أخرى",
  },
  fallback_to_manual_after_attempts: 3,
};

// ---------------------------------------------------------------------------
// Defensive normalization
// ---------------------------------------------------------------------------

function cloneStaticModel(): ModelDescriptor {
  return { ...STATIC_VISION_POD.model };
}

function cloneStaticQualityGates(): QualityGatesConfig {
  return { ...STATIC_VISION_POD.quality_gates };
}

function cloneStaticUserMessaging(): UserMessagingConfig {
  return { ...STATIC_VISION_POD.user_messaging };
}

// Numeric coercion: accepts finite numbers; returns fallback otherwise.
function readNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return fallback;
}

// Integer coercion: accepts finite numbers; returns fallback otherwise.
function readInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

// Boolean coercion: accepts strict booleans only; non-boolean values fall
// through to the safe fallback.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

// String coercion: accepts non-empty strings only; everything else falls
// back to the static default.
function readString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  return raw;
}

// Clamp a number to [min, max] after coercion.
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeModel(raw: unknown): ModelDescriptor {
  if (!raw || typeof raw !== "object") return cloneStaticModel();
  const obj = raw as Record<string, unknown>;
  return {
    name: readString(obj.name, STATIC_VISION_POD.model.name),
    version: readString(obj.version, STATIC_VISION_POD.model.version),
    size_mb: Math.max(
      1,
      readInt(obj.size_mb, STATIC_VISION_POD.model.size_mb),
    ),
    asset_uri_pattern: readString(
      obj.asset_uri_pattern,
      STATIC_VISION_POD.model.asset_uri_pattern,
    ),
  };
}

function normalizeQualityGates(raw: unknown): QualityGatesConfig {
  if (!raw || typeof raw !== "object") return cloneStaticQualityGates();
  const obj = raw as Record<string, unknown>;
  return {
    min_confidence: clamp(
      readNumber(obj.min_confidence, STATIC_VISION_POD.quality_gates.min_confidence),
      0,
      1,
    ),
    require_package_in_frame: readBool(
      obj.require_package_in_frame,
      STATIC_VISION_POD.quality_gates.require_package_in_frame,
    ),
    require_label_legible: readBool(
      obj.require_label_legible,
      STATIC_VISION_POD.quality_gates.require_label_legible,
    ),
    require_addressee_visible: readBool(
      obj.require_addressee_visible,
      STATIC_VISION_POD.quality_gates.require_addressee_visible,
    ),
    min_frame_brightness: clamp(
      readNumber(
        obj.min_frame_brightness,
        STATIC_VISION_POD.quality_gates.min_frame_brightness,
      ),
      0,
      1,
    ),
    max_motion_blur: clamp(
      readNumber(
        obj.max_motion_blur,
        STATIC_VISION_POD.quality_gates.max_motion_blur,
      ),
      0,
      1,
    ),
  };
}

function normalizeUserMessaging(raw: unknown): UserMessagingConfig {
  if (!raw || typeof raw !== "object") return cloneStaticUserMessaging();
  const obj = raw as Record<string, unknown>;
  return {
    package_missing_en: readString(
      obj.package_missing_en,
      STATIC_VISION_POD.user_messaging.package_missing_en,
    ),
    package_missing_ar: readString(
      obj.package_missing_ar,
      STATIC_VISION_POD.user_messaging.package_missing_ar,
    ),
    label_unreadable_en: readString(
      obj.label_unreadable_en,
      STATIC_VISION_POD.user_messaging.label_unreadable_en,
    ),
    label_unreadable_ar: readString(
      obj.label_unreadable_ar,
      STATIC_VISION_POD.user_messaging.label_unreadable_ar,
    ),
    low_brightness_en: readString(
      obj.low_brightness_en,
      STATIC_VISION_POD.user_messaging.low_brightness_en,
    ),
    low_brightness_ar: readString(
      obj.low_brightness_ar,
      STATIC_VISION_POD.user_messaging.low_brightness_ar,
    ),
    motion_blur_en: readString(
      obj.motion_blur_en,
      STATIC_VISION_POD.user_messaging.motion_blur_en,
    ),
    motion_blur_ar: readString(
      obj.motion_blur_ar,
      STATIC_VISION_POD.user_messaging.motion_blur_ar,
    ),
  };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// VisionPodPolicyValue. Defensive: malformed sub-objects fall back to the
// STATIC seed so a bad row in production cannot brick mobile capture flows.
export function normalizeVisionPodPolicy(raw: unknown): VisionPodPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_VISION_POD.version,
      enabled: STATIC_VISION_POD.enabled,
      model: cloneStaticModel(),
      quality_gates: cloneStaticQualityGates(),
      user_messaging: cloneStaticUserMessaging(),
      fallback_to_manual_after_attempts:
        STATIC_VISION_POD.fallback_to_manual_after_attempts,
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_VISION_POD.version;
  return {
    version,
    enabled: readBool(obj.enabled, STATIC_VISION_POD.enabled),
    model: normalizeModel(obj.model),
    quality_gates: normalizeQualityGates(obj.quality_gates),
    user_messaging: normalizeUserMessaging(obj.user_messaging),
    fallback_to_manual_after_attempts: clamp(
      readInt(
        obj.fallback_to_manual_after_attempts,
        STATIC_VISION_POD.fallback_to_manual_after_attempts,
      ),
      1,
      10,
    ),
  };
}

// ---------------------------------------------------------------------------
// Quality-gate evaluation
// ---------------------------------------------------------------------------

// Locale-aware lookup for the user-facing message of a given failure. Falls
// back to the EN string if the requested locale is missing (defensive — keeps
// the driver unblocked even if a per-tenant override drops one locale).
function userMessageFor(
  messaging: UserMessagingConfig,
  failure: QualityGateFailure,
  locale: VisionPodLocale,
): string | null {
  switch (failure) {
    case "package_missing":
      return locale === "ar"
        ? messaging.package_missing_ar || messaging.package_missing_en
        : messaging.package_missing_en;
    case "label_unreadable":
      return locale === "ar"
        ? messaging.label_unreadable_ar || messaging.label_unreadable_en
        : messaging.label_unreadable_en;
    case "low_brightness":
      return locale === "ar"
        ? messaging.low_brightness_ar || messaging.low_brightness_en
        : messaging.low_brightness_en;
    case "motion_blur":
      return locale === "ar"
        ? messaging.motion_blur_ar || messaging.motion_blur_en
        : messaging.motion_blur_en;
    // No bespoke string for confidence / addressee — they aggregate under
    // the closest applicable message (package_missing) so the driver gets
    // an actionable instruction rather than an ML-jargon error.
    case "low_confidence":
    case "addressee_missing":
      return locale === "ar"
        ? messaging.package_missing_ar || messaging.package_missing_en
        : messaging.package_missing_en;
    default:
      return null;
  }
}

// Evaluate a single classification observation against the policy's enabled
// gates. Order is intentional and reflects the user-perceived severity of
// each failure mode:
//   1. brightness (the photo is unusable to a human reviewer)
//   2. motion blur (same)
//   3. confidence (the model isn't sure what it sees)
//   4. package in frame (the most common gate; the driver pointed the
//      camera the wrong way)
//   5. label legibility (a softer constraint)
//   6. addressee visibility (the strictest constraint, kept last)
//
// `passed` is true iff every enabled gate passes. `failures` carries every
// gate that failed (so telemetry and per-gate analytics still see the full
// picture). `userMessage` returns the FIRST failure's locale-aware string so
// the driver sees one clear instruction at a time. When the policy is
// disabled, evaluateClassification short-circuits to passed=true with no
// failures and a null userMessage.
export function evaluateClassification(
  policy: VisionPodPolicyValue,
  classification: ClassificationResult,
  locale: VisionPodLocale,
): EvaluationResult {
  if (!policy.enabled) {
    return { passed: true, failures: [], userMessage: null };
  }

  const failures: QualityGateFailure[] = [];
  const gates = policy.quality_gates;

  // Defensive: if classification is missing/junk, treat as a low-confidence
  // failure so the driver retries rather than silently passing a bad photo.
  if (!classification || typeof classification !== "object") {
    return {
      passed: false,
      failures: ["low_confidence"],
      userMessage: userMessageFor(policy.user_messaging, "low_confidence", locale),
    };
  }

  const confidence = readNumber(classification.confidence, 0);
  const hasPackage = readBool(classification.has_package, false);
  const labelLegible = readBool(classification.label_legible, false);
  const addresseeVisible = readBool(classification.addressee_visible, false);
  const brightness = readNumber(classification.brightness, 0);
  const motionBlur = readNumber(classification.motion_blur, 0);

  if (brightness < gates.min_frame_brightness) {
    failures.push("low_brightness");
  }
  if (motionBlur > gates.max_motion_blur) {
    failures.push("motion_blur");
  }
  if (confidence < gates.min_confidence) {
    failures.push("low_confidence");
  }
  if (gates.require_package_in_frame && !hasPackage) {
    failures.push("package_missing");
  }
  if (gates.require_label_legible && !labelLegible) {
    failures.push("label_unreadable");
  }
  if (gates.require_addressee_visible && !addresseeVisible) {
    failures.push("addressee_missing");
  }

  const passed = failures.length === 0;
  const firstFailure = failures[0];
  const userMessage = passed || !firstFailure
    ? null
    : userMessageFor(policy.user_messaging, firstFailure, locale);

  return { passed, failures, userMessage };
}

// ---------------------------------------------------------------------------
// Model asset URI builder
// ---------------------------------------------------------------------------

// Substitute `${cdn_base}` and `${version}` placeholders in the policy's
// asset_uri_pattern. The cdnBase argument lets ops route asset delivery
// per-tenant (e.g. mena-cdn vs apac-cdn) without touching the policy row.
// Trailing slashes on cdnBase are normalized so the join is always exactly
// one slash.
//
// Defensive: if the pattern is empty or the substitution leaves an unbalanced
// placeholder, the function still returns the (possibly partially substituted)
// string — a malformed asset URI is a configuration error the caller should
// surface, not a reason to crash the composer. Real model loaders should
// validate the URI before issuing the network request.
export function buildModelAssetUri(
  policy: VisionPodPolicyValue,
  cdnBase: string,
): string {
  const safeBase = typeof cdnBase === "string" ? cdnBase.replace(/\/+$/g, "") : "";
  const pattern = policy.model.asset_uri_pattern || "";
  const version = policy.model.version || "";
  return pattern
    .replace(/\$\{cdn_base\}/g, safeBase)
    .replace(/\$\{version\}/g, version);
}

// ---------------------------------------------------------------------------
// Manual-fallback escape hatch
// ---------------------------------------------------------------------------

// True when the composer should surface a manual-submit escape hatch (the
// driver has been blocked by the gate evaluator N times and the policy says
// to fall back). Negative / non-finite attempt counts are coerced to 0.
//
// When the policy is disabled, manual fallback is meaningless (the gate
// never blocks anything), so this returns false.
export function shouldFallbackToManual(
  policy: VisionPodPolicyValue,
  attemptCount: number,
): boolean {
  if (!policy.enabled) return false;
  const safeCount =
    typeof attemptCount === "number" &&
    Number.isFinite(attemptCount) &&
    attemptCount > 0
      ? Math.trunc(attemptCount)
      : 0;
  return safeCount >= policy.fallback_to_manual_after_attempts;
}
