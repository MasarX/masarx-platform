export type VoicePodLocale = "en" | "ar";

export type WakewordsByLocale = {
  en: string[];
  ar?: string[];
};

export type SpeechRecognizerConfig = {
  engine: string;
  min_confidence: number;
  max_listen_seconds: number;
  ambient_speech_filter: boolean;
};

export type ConfirmationConfig = {
  require_readback: boolean;
  readback_template_en: string;
  readback_template_ar: string;
  haptic_pattern_on_accept: string;
  cancel_window_seconds: number;
};

export type VoicePodPolicyValue = {
  version: number;
  enabled: boolean;
  wakewords: WakewordsByLocale;
  speech_recognizer: SpeechRecognizerConfig;
  confirmation: ConfirmationConfig;
  respect_driving_lock: boolean;
  driving_lock_required_stage: string;
};

export const STATIC_VOICE_POD: VoicePodPolicyValue = {
  version: 1,
  enabled: false,
  wakewords: {
    en: ["mark delivered", "mark complete"],
    ar: ["تم التسليم"],
  },
  speech_recognizer: {
    engine: "platform_native",
    min_confidence: 0.75,
    max_listen_seconds: 8,
    ambient_speech_filter: true,
  },
  confirmation: {
    require_readback: true,
    readback_template_en: "Delivered to ${customer_name} at ${address}. Confirm?",
    readback_template_ar: "تم التسليم إلى ${customer_name} في ${address}. تأكيد؟",
    haptic_pattern_on_accept: "medium",
    cancel_window_seconds: 5,
  },
  respect_driving_lock: false,
  driving_lock_required_stage: "voice",
};

function cloneStaticWakewords(): WakewordsByLocale {
  return {
    en: [...STATIC_VOICE_POD.wakewords.en],
    ar: STATIC_VOICE_POD.wakewords.ar
      ? [...STATIC_VOICE_POD.wakewords.ar]
      : undefined,
  };
}

function cloneStaticSpeechRecognizer(): SpeechRecognizerConfig {
  return { ...STATIC_VOICE_POD.speech_recognizer };
}

function cloneStaticConfirmation(): ConfirmationConfig {
  return { ...STATIC_VOICE_POD.confirmation };
}

function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

function readNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return fallback;
}

function readInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

function readNonEmptyString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

function readStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  if (out.length === 0) return [...fallback];
  return out;
}

function normalizeWakewords(raw: unknown): WakewordsByLocale {
  if (!raw || typeof raw !== "object") return cloneStaticWakewords();
  const obj = raw as Record<string, unknown>;
  const en = readStringArray(obj.en, STATIC_VOICE_POD.wakewords.en);
  const arRaw = obj.ar;
  const arResolved =
    arRaw === undefined || arRaw === null
      ? STATIC_VOICE_POD.wakewords.ar
        ? [...STATIC_VOICE_POD.wakewords.ar]
        : undefined
      : readStringArray(
          arRaw,
          STATIC_VOICE_POD.wakewords.ar ? STATIC_VOICE_POD.wakewords.ar : [],
        );
  const out: WakewordsByLocale = { en };
  if (arResolved !== undefined) {
    out.ar = arResolved;
  }
  return out;
}

function normalizeSpeechRecognizer(raw: unknown): SpeechRecognizerConfig {
  if (!raw || typeof raw !== "object") return cloneStaticSpeechRecognizer();
  const obj = raw as Record<string, unknown>;
  const minConfRaw = readNumber(
    obj.min_confidence,
    STATIC_VOICE_POD.speech_recognizer.min_confidence,
  );
  const minConfidence = Math.max(0, Math.min(1, minConfRaw));
  const maxListenRaw = readInt(
    obj.max_listen_seconds,
    STATIC_VOICE_POD.speech_recognizer.max_listen_seconds,
  );
  const maxListenSeconds = Math.max(1, Math.min(60, maxListenRaw));
  return {
    engine: readNonEmptyString(
      obj.engine,
      STATIC_VOICE_POD.speech_recognizer.engine,
    ),
    min_confidence: minConfidence,
    max_listen_seconds: maxListenSeconds,
    ambient_speech_filter: readBool(
      obj.ambient_speech_filter,
      STATIC_VOICE_POD.speech_recognizer.ambient_speech_filter,
    ),
  };
}

function normalizeConfirmation(raw: unknown): ConfirmationConfig {
  if (!raw || typeof raw !== "object") return cloneStaticConfirmation();
  const obj = raw as Record<string, unknown>;
  const cancelRaw = readInt(
    obj.cancel_window_seconds,
    STATIC_VOICE_POD.confirmation.cancel_window_seconds,
  );
  const cancelWindow = Math.max(0, Math.min(60, cancelRaw));
  return {
    require_readback: readBool(
      obj.require_readback,
      STATIC_VOICE_POD.confirmation.require_readback,
    ),
    readback_template_en: readNonEmptyString(
      obj.readback_template_en,
      STATIC_VOICE_POD.confirmation.readback_template_en,
    ),
    readback_template_ar: readNonEmptyString(
      obj.readback_template_ar,
      STATIC_VOICE_POD.confirmation.readback_template_ar,
    ),
    haptic_pattern_on_accept: readNonEmptyString(
      obj.haptic_pattern_on_accept,
      STATIC_VOICE_POD.confirmation.haptic_pattern_on_accept,
    ),
    cancel_window_seconds: cancelWindow,
  };
}

export function normalizeVoicePodPolicy(raw: unknown): VoicePodPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_VOICE_POD.version,
      enabled: STATIC_VOICE_POD.enabled,
      wakewords: cloneStaticWakewords(),
      speech_recognizer: cloneStaticSpeechRecognizer(),
      confirmation: cloneStaticConfirmation(),
      respect_driving_lock: STATIC_VOICE_POD.respect_driving_lock,
      driving_lock_required_stage: STATIC_VOICE_POD.driving_lock_required_stage,
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_VOICE_POD.version;
  return {
    version,
    enabled: readBool(obj.enabled, STATIC_VOICE_POD.enabled),
    wakewords: normalizeWakewords(obj.wakewords),
    speech_recognizer: normalizeSpeechRecognizer(obj.speech_recognizer),
    confirmation: normalizeConfirmation(obj.confirmation),
    respect_driving_lock: readBool(
      obj.respect_driving_lock,
      STATIC_VOICE_POD.respect_driving_lock,
    ),
    driving_lock_required_stage: readNonEmptyString(
      obj.driving_lock_required_stage,
      STATIC_VOICE_POD.driving_lock_required_stage,
    ),
  };
}

export function getWakewords(
  policy: VoicePodPolicyValue,
  locale: VoicePodLocale,
): string[] {
  if (locale === "en") {
    return [...policy.wakewords.en];
  }
  const localeList = policy.wakewords[locale];
  if (Array.isArray(localeList) && localeList.length > 0) {
    return [...localeList];
  }
  return [...policy.wakewords.en];
}

export function matchWakeword(
  policy: VoicePodPolicyValue,
  transcript: string,
  locale: VoicePodLocale,
): string | null {
  if (typeof transcript !== "string") return null;
  const normalized = transcript.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const list = getWakewords(policy, locale);
  for (const phrase of list) {
    const phraseTrimmed = phrase.trim();
    if (phraseTrimmed.length === 0) continue;
    if (normalized.includes(phraseTrimmed.toLowerCase())) {
      return phraseTrimmed;
    }
  }
  return null;
}

export function formatReadback(
  policy: VoicePodPolicyValue,
  locale: VoicePodLocale,
  vars: { customer_name?: string; address?: string },
): string {
  const template =
    locale === "ar"
      ? policy.confirmation.readback_template_ar
      : policy.confirmation.readback_template_en;
  const safeCustomer =
    typeof vars.customer_name === "string" ? vars.customer_name : "";
  const safeAddress =
    typeof vars.address === "string" ? vars.address : "";
  return template.replace(/\$\{(customer_name|address)\}/g, (_, key) =>
    key === "customer_name" ? safeCustomer : safeAddress,
  );
}

export function meetsMinConfidence(
  policy: VoicePodPolicyValue,
  confidence: number,
): boolean {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return false;
  }
  return confidence >= policy.speech_recognizer.min_confidence;
}
