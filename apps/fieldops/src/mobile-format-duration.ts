// Format elapsed time in the selected locale, using hours or days once the value exceeds the minute range.

export type DurationLocale = "en" | "ar";

const STRINGS = {
  en: { now: "Now", m: "m", h: "h", d: "d" },
  ar: { now: "الآن", m: "د", h: "س", d: "ي" },
} as const;

export function formatRelativeDuration(
  minutes: number,
  locale: DurationLocale,
): string {
  const dict = STRINGS[locale] ?? STRINGS.en;

  // Defensive: NaN / non-finite → "Now"
  const safeMinutes =
    typeof minutes === "number" && Number.isFinite(minutes) ? Math.floor(minutes) : 0;

  if (safeMinutes <= 0) return dict.now;

  // < 60 minutes → minutes only
  if (safeMinutes < 60) {
    return `${safeMinutes}${dict.m}`;
  }

  // < 24 hours → hours + remaining minutes (drop minutes if 0)
  if (safeMinutes < 1440) {
    const hours = Math.floor(safeMinutes / 60);
    const remMinutes = safeMinutes % 60;
    if (remMinutes === 0) return `${hours}${dict.h}`;
    return `${hours}${dict.h} ${remMinutes}${dict.m}`;
  }

  // >= 24 hours → days + remaining hours (drop hours if 0)
  const days = Math.floor(safeMinutes / 1440);
  const remHours = Math.floor((safeMinutes % 1440) / 60);
  if (remHours === 0) return `${days}${dict.d}`;
  return `${days}${dict.d} ${remHours}${dict.h}`;
}
