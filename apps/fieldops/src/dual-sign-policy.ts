export type SigningOrder = "driver_first" | "customer_first";

export type SignatureRole = "driver" | "customer";

export type DualSignState =
  | "idle"
  | "driver_signing"
  | "driver_signed"
  | "customer_signing"
  | "complete";

export type DualSignTransitionEvent = "driver_signed" | "customer_signed";

export type SignatureCaptureConfig = {
  label_en: string;
  label_ar: string;
  min_strokes: number;
  min_duration_ms: number;
};

export type CustomerSignatureCaptureConfig = SignatureCaptureConfig & {
  captured_on_driver_device: boolean;
};

export type DualSignPolicyValue = {
  version: number;
  enabled: boolean;
  required_for_categories: string[];
  signing_order: SigningOrder;
  driver_signature: SignatureCaptureConfig;
  customer_signature: CustomerSignatureCaptureConfig;
  auto_advance_after_first_signed: boolean;
  show_witness_pill: boolean;
};

export const STATIC_DUAL_SIGN: DualSignPolicyValue = {
  version: 1,
  enabled: false,
  required_for_categories: ["pharma", "high_value", "controlled_goods"],
  signing_order: "driver_first",
  driver_signature: {
    label_en: "Driver signature",
    label_ar: "توقيع السائق",
    min_strokes: 3,
    min_duration_ms: 500,
  },
  customer_signature: {
    label_en: "Customer signature",
    label_ar: "توقيع العميل",
    min_strokes: 3,
    min_duration_ms: 500,
    captured_on_driver_device: true,
  },
  auto_advance_after_first_signed: true,
  show_witness_pill: true,
};

function cloneStaticDriverSignature(): SignatureCaptureConfig {
  return { ...STATIC_DUAL_SIGN.driver_signature };
}

function cloneStaticCustomerSignature(): CustomerSignatureCaptureConfig {
  return { ...STATIC_DUAL_SIGN.customer_signature };
}

function cloneStaticRequiredCategories(): string[] {
  return [...STATIC_DUAL_SIGN.required_for_categories];
}

function readInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

function readString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

function readSigningOrder(raw: unknown, fallback: SigningOrder): SigningOrder {
  if (raw === "driver_first" || raw === "customer_first") return raw;
  return fallback;
}

function readCategories(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeDriverSignature(raw: unknown): SignatureCaptureConfig {
  if (!raw || typeof raw !== "object") return cloneStaticDriverSignature();
  const obj = raw as Record<string, unknown>;
  return {
    label_en: readString(
      obj.label_en,
      STATIC_DUAL_SIGN.driver_signature.label_en,
    ),
    label_ar: readString(
      obj.label_ar,
      STATIC_DUAL_SIGN.driver_signature.label_ar,
    ),
    min_strokes: Math.max(
      0,
      readInt(obj.min_strokes, STATIC_DUAL_SIGN.driver_signature.min_strokes),
    ),
    min_duration_ms: Math.max(
      0,
      readInt(
        obj.min_duration_ms,
        STATIC_DUAL_SIGN.driver_signature.min_duration_ms,
      ),
    ),
  };
}

function normalizeCustomerSignature(raw: unknown): CustomerSignatureCaptureConfig {
  if (!raw || typeof raw !== "object") return cloneStaticCustomerSignature();
  const obj = raw as Record<string, unknown>;
  return {
    label_en: readString(
      obj.label_en,
      STATIC_DUAL_SIGN.customer_signature.label_en,
    ),
    label_ar: readString(
      obj.label_ar,
      STATIC_DUAL_SIGN.customer_signature.label_ar,
    ),
    min_strokes: Math.max(
      0,
      readInt(obj.min_strokes, STATIC_DUAL_SIGN.customer_signature.min_strokes),
    ),
    min_duration_ms: Math.max(
      0,
      readInt(
        obj.min_duration_ms,
        STATIC_DUAL_SIGN.customer_signature.min_duration_ms,
      ),
    ),
    captured_on_driver_device: readBool(
      obj.captured_on_driver_device,
      STATIC_DUAL_SIGN.customer_signature.captured_on_driver_device,
    ),
  };
}

export function normalizeDualSignPolicy(raw: unknown): DualSignPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_DUAL_SIGN.version,
      enabled: STATIC_DUAL_SIGN.enabled,
      required_for_categories: cloneStaticRequiredCategories(),
      signing_order: STATIC_DUAL_SIGN.signing_order,
      driver_signature: cloneStaticDriverSignature(),
      customer_signature: cloneStaticCustomerSignature(),
      auto_advance_after_first_signed:
        STATIC_DUAL_SIGN.auto_advance_after_first_signed,
      show_witness_pill: STATIC_DUAL_SIGN.show_witness_pill,
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_DUAL_SIGN.version;
  return {
    version,
    enabled: readBool(obj.enabled, STATIC_DUAL_SIGN.enabled),
    required_for_categories: readCategories(
      obj.required_for_categories,
      STATIC_DUAL_SIGN.required_for_categories,
    ),
    signing_order: readSigningOrder(
      obj.signing_order,
      STATIC_DUAL_SIGN.signing_order,
    ),
    driver_signature: normalizeDriverSignature(obj.driver_signature),
    customer_signature: normalizeCustomerSignature(obj.customer_signature),
    auto_advance_after_first_signed: readBool(
      obj.auto_advance_after_first_signed,
      STATIC_DUAL_SIGN.auto_advance_after_first_signed,
    ),
    show_witness_pill: readBool(
      obj.show_witness_pill,
      STATIC_DUAL_SIGN.show_witness_pill,
    ),
  };
}

export function requiresDualSign(
  policy: DualSignPolicyValue,
  taskCategory: string,
): boolean {
  if (!policy.enabled) return false;
  if (typeof taskCategory !== "string") return false;
  const trimmed = taskCategory.trim();
  if (trimmed.length === 0) return false;
  return policy.required_for_categories.includes(trimmed);
}

export type SignatureValidation = {
  valid: boolean;
  reason?: string;
};

export function validateSignature(
  policy: DualSignPolicyValue,
  role: SignatureRole,
  strokes: number,
  durationMs: number,
): SignatureValidation {
  if (
    typeof strokes !== "number" ||
    !Number.isFinite(strokes) ||
    strokes < 0 ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return { valid: false, reason: "invalid_input" };
  }
  const config: SignatureCaptureConfig =
    role === "driver" ? policy.driver_signature : policy.customer_signature;
  const strokesInt = Math.trunc(strokes);
  const durationInt = Math.trunc(durationMs);
  if (strokesInt < config.min_strokes) {
    return { valid: false, reason: "below_min_strokes" };
  }
  if (durationInt < config.min_duration_ms) {
    return { valid: false, reason: "below_min_duration" };
  }
  return { valid: true };
}

export function nextStateAfter(
  currentState: DualSignState,
  event: DualSignTransitionEvent,
): DualSignState {
  if (event === "driver_signed") {
    if (currentState === "idle" || currentState === "driver_signing") {
      return "driver_signed";
    }
    return currentState;
  }
  if (event === "customer_signed") {
    if (
      currentState === "driver_signed" ||
      currentState === "customer_signing"
    ) {
      return "complete";
    }
    return currentState;
  }
  return currentState;
}
