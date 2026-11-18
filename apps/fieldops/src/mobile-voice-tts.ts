export type VoiceCalloutPolicy = {
  enabled: boolean;
  locale: string;
  rate: number;
  pitch: number;
  volume: number;
  quiet_hours_start_utc?: number | null;
  quiet_hours_end_utc?: number | null;
};

export const DEFAULT_VOICE_CALLOUT_POLICY: VoiceCalloutPolicy = {
  enabled: false,
  locale: "en-US",
  rate: 1,
  pitch: 1,
  volume: 1,
  quiet_hours_start_utc: null,
  quiet_hours_end_utc: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(trimmed)) return true;
    if (["false", "0", "no", "n", ""].includes(trimmed)) return false;
  }
  return fallback;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampRange(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readLocale(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readQuietHour(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  if (parsed == null) return null;
  const hour = Math.floor(parsed);
  if (hour < 0 || hour > 23) return null;
  return hour;
}

export function normalizeVoiceCalloutPolicy(raw: unknown): VoiceCalloutPolicy {
  const input = asRecord(raw);
  const rateRaw = readFiniteNumber(input.rate);
  const pitchRaw = readFiniteNumber(input.pitch);
  const volumeRaw = readFiniteNumber(input.volume);
  const rate = clampRange(
    rateRaw == null ? DEFAULT_VOICE_CALLOUT_POLICY.rate : rateRaw,
    0.5,
    1.5
  );
  const pitch = clampRange(
    pitchRaw == null ? DEFAULT_VOICE_CALLOUT_POLICY.pitch : pitchRaw,
    0.5,
    1.5
  );
  const volume = clampRange(
    volumeRaw == null ? DEFAULT_VOICE_CALLOUT_POLICY.volume : volumeRaw,
    0,
    1
  );
  const quietStart = readQuietHour(input.quiet_hours_start_utc);
  const quietEnd = readQuietHour(input.quiet_hours_end_utc);

  return {
    enabled: readBoolean(input.enabled, DEFAULT_VOICE_CALLOUT_POLICY.enabled),
    locale: readLocale(input.locale, DEFAULT_VOICE_CALLOUT_POLICY.locale),
    rate,
    pitch,
    volume,
    quiet_hours_start_utc: quietStart,
    quiet_hours_end_utc: quietEnd,
  };
}

export type VoiceCalloutKey =
  | "stop_approaching"
  | "arrived_at_stop"
  | "delivery_completed"
  | "connection_lost"
  | "connection_restored"
  | "driving_lock_active";

export type VoiceSpeaker = (utterance: {
  text: string;
  locale: string;
  rate: number;
  pitch: number;
  volume: number;
}) => Promise<void>;

function isQuietWindowActive(
  hour: number,
  start: number | null | undefined,
  end: number | null | undefined
): boolean {
  if (start == null || end == null) return false;
  if (start === end) return false;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Spans midnight (e.g. 22 -> 6): active if at/after start OR before end.
  return hour >= start || hour < end;
}

export function shouldSpeakNow(policy: VoiceCalloutPolicy, now: Date): boolean {
  if (!policy || policy.enabled !== true) return false;
  const hour = now.getUTCHours();
  if (!Number.isFinite(hour)) return false;
  if (isQuietWindowActive(hour, policy.quiet_hours_start_utc, policy.quiet_hours_end_utc)) {
    return false;
  }
  return true;
}

export type VoiceCalloutCatalog = Record<VoiceCalloutKey, Record<"en" | "ar", string>>;

export const DEFAULT_VOICE_CATALOG: VoiceCalloutCatalog = {
  stop_approaching: {
    en: "Stop approaching. Prepare to pull over safely.",
    ar: "الوجهة تقترب. استعد للتوقف بأمان.",
  },
  arrived_at_stop: {
    en: "Arrived at the stop.",
    ar: "وصلت إلى نقطة التوقف.",
  },
  delivery_completed: {
    en: "Delivery completed. Continue to the next stop.",
    ar: "تم إنجاز التسليم. انتقل إلى الوجهة التالية.",
  },
  connection_lost: {
    en: "Connection lost. Working offline.",
    ar: "انقطع الاتصال. العمل بدون إنترنت.",
  },
  connection_restored: {
    en: "Connection restored. Syncing updates.",
    ar: "عاد الاتصال. جارٍ المزامنة.",
  },
  driving_lock_active: {
    en: "Driving mode active. Keep eyes on the road.",
    ar: "وضع القيادة مفعّل. ركّز على الطريق.",
  },
};

function resolveLocaleBucket(
  policy: VoiceCalloutPolicy,
  override: "en" | "ar" | undefined
): "en" | "ar" {
  if (override === "en" || override === "ar") return override;
  const prefix = String(policy.locale ?? "")
    .trim()
    .slice(0, 2)
    .toLowerCase();
  if (prefix === "ar") return "ar";
  return "en";
}

export async function speakCallout(
  key: VoiceCalloutKey,
  policy: VoiceCalloutPolicy,
  speaker: VoiceSpeaker,
  options?: { now?: Date; catalog?: VoiceCalloutCatalog; locale?: "en" | "ar" }
): Promise<{ spoke: boolean; skipped_reason?: "disabled" | "quiet_hours" }> {
  const now = options?.now ?? new Date();
  if (!policy || policy.enabled !== true) {
    return { spoke: false, skipped_reason: "disabled" };
  }
  if (!shouldSpeakNow(policy, now)) {
    return { spoke: false, skipped_reason: "quiet_hours" };
  }

  const catalog = options?.catalog ?? DEFAULT_VOICE_CATALOG;
  const bucket = resolveLocaleBucket(policy, options?.locale);
  const entry = catalog[key];
  const text = entry ? entry[bucket] ?? entry.en : "";

  await speaker({
    text,
    locale: policy.locale,
    rate: policy.rate,
    pitch: policy.pitch,
    volume: policy.volume,
  });

  return { spoke: true };
}
