import type { MobileV2RescheduleWindow } from "./mobile-v2-sheet-reschedule";
import type { MobileV2StopDetail } from "./mobile-v2-stop-screen";
import type { MobileV2WriteEnvelope } from "./mobile-v2-rpc-hooks";

export interface MobileV2ReschedulePolicy {
  readonly version: number;
  readonly defaultRescheduleOffsets: ReadonlyArray<string>;
  readonly warmWindowMinutes: number;
  readonly timeZone: string;
}

export interface MobileV2RescheduleReadback {
  readonly decisionLogId: string;
  readonly state: string;
  readonly windowLabel: string;
  readonly note: string | null;
  readonly submittedAt: string;
}

const DEFAULT_TIME_ZONE = "Asia/Riyadh";

export const MOBILE_V2_RESCHEDULE_DEFAULT_POLICY: MobileV2ReschedulePolicy = Object.freeze({
  version: 1,
  defaultRescheduleOffsets: Object.freeze(["P1D", "P2D", "P3D"]),
  warmWindowMinutes: 90,
  timeZone: DEFAULT_TIME_ZONE,
});

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function parseDayOffset(value: string): number | null {
  const match = /^P([1-9][0-9]*)D$/i.exec(value.trim());
  if (match === null) return null;
  const days = Number(match[1]);
  return Number.isInteger(days) && days > 0 ? days : null;
}

function parseCurrentWindowStart(value: string): { readonly hour: number; readonly minute: number } | null {
  const match = /(^|\D)([01][0-9]|2[0-3]):([0-5][0-9])(\D|$)/.exec(value);
  if (match === null) return null;
  return Object.freeze({
    hour: Number(match[2]),
    minute: Number(match[3]),
  });
}

function readTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: trimmed }).format(new Date(0));
    return trimmed;
  } catch {
    return null;
  }
}

function readZonedDateParts(value: Date, timeZone: string): Record<string, number> {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(value)
    .reduce<Record<string, number>>((acc, part) => {
      if (
        part.type === "year" ||
        part.type === "month" ||
        part.type === "day" ||
        part.type === "hour" ||
        part.type === "minute" ||
        part.type === "second"
      ) {
        acc[part.type] = Number(part.value);
      }
      return acc;
    }, {});
}

function zonedWallTimeToUtc(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
}): Date {
  const utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  const zoneParts = readZonedDateParts(new Date(utcGuess), input.timeZone);
  const zoneAsUtc = Date.UTC(
    zoneParts.year,
    (zoneParts.month ?? 1) - 1,
    zoneParts.day ?? 1,
    zoneParts.hour ?? 0,
    zoneParts.minute ?? 0,
    zoneParts.second ?? 0,
    0,
  );
  return new Date(utcGuess - (zoneAsUtc - utcGuess));
}

function makeZonedWindowDate(input: {
  readonly base: Date;
  readonly offsetDays: number;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
}): Date {
  const baseLocal = readZonedDateParts(input.base, input.timeZone);
  return zonedWallTimeToUtc({
    year: baseLocal.year,
    month: baseLocal.month ?? 1,
    day: (baseLocal.day ?? 1) + input.offsetDays,
    hour: input.hour,
    minute: input.minute,
    timeZone: input.timeZone,
  });
}

function formatZonedTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatDayLabel(offsetDays: number, value: Date, timeZone: string): string {
  if (offsetDays === 1) return "Tomorrow";
  if (offsetDays === 2) return "Day after";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "2-digit",
  }).format(value);
}

export function parseMobileV2ReschedulePolicy(raw: unknown): MobileV2ReschedulePolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return MOBILE_V2_RESCHEDULE_DEFAULT_POLICY;
  }
  const record = raw as Record<string, unknown>;
  const offsets = Array.isArray(record.default_reschedule_offsets)
    ? record.default_reschedule_offsets
        .filter((entry): entry is string => typeof entry === "string" && parseDayOffset(entry) !== null)
        .filter((entry, index, all) => all.indexOf(entry) === index)
    : [];
  if (offsets.length === 0) return MOBILE_V2_RESCHEDULE_DEFAULT_POLICY;
  return Object.freeze({
    version: readPositiveInteger(record.version) ?? MOBILE_V2_RESCHEDULE_DEFAULT_POLICY.version,
    defaultRescheduleOffsets: Object.freeze(offsets),
    warmWindowMinutes:
      readPositiveInteger(record.warm_window_minutes) ??
      MOBILE_V2_RESCHEDULE_DEFAULT_POLICY.warmWindowMinutes,
    timeZone:
      readTimeZone(record.time_zone) ??
      readTimeZone(record.timezone) ??
      MOBILE_V2_RESCHEDULE_DEFAULT_POLICY.timeZone,
  });
}

export function buildMobileV2RescheduleWindows(input: {
  readonly policy: MobileV2ReschedulePolicy;
  readonly currentWindow: string;
  readonly now?: Date;
}): ReadonlyArray<MobileV2RescheduleWindow> {
  const parsedStart = parseCurrentWindowStart(input.currentWindow);
  if (parsedStart === null) return Object.freeze([]);
  const now = input.now ?? new Date();
  const windows: MobileV2RescheduleWindow[] = [];
  for (const offset of input.policy.defaultRescheduleOffsets) {
    const offsetDays = parseDayOffset(offset);
    if (offsetDays === null) continue;
    const start = makeZonedWindowDate({
      base: now,
      offsetDays,
      hour: parsedStart.hour,
      minute: parsedStart.minute,
      timeZone: input.policy.timeZone,
    });
    const end = new Date(start.getTime() + input.policy.warmWindowMinutes * 60_000);
    const startLabel = formatZonedTime(start, input.policy.timeZone);
    const endLabel = formatZonedTime(end, input.policy.timeZone);
    windows.push(
      Object.freeze({
        id: `${offset}-${startLabel.replace(":", "")}-${endLabel.replace(":", "")}`,
        label: `${formatDayLabel(offsetDays, start, input.policy.timeZone)} - ${startLabel}-${endLabel}`,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        fit: offsetDays === 1 ? "good" : "ok",
        recommendedReason: offsetDays === 1 ? "Recommended by delivery slot policy" : undefined,
      }),
    );
  }
  return Object.freeze(windows);
}

export function mobileV2RescheduleWindowLabelForReadback(
  window: Pick<MobileV2RescheduleWindow, "startIso">,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return formatZonedTime(new Date(window.startIso), timeZone);
}

export function mobileV2StopDetailMatchesRescheduleWindow(
  stop: MobileV2StopDetail | null | undefined,
  window: Pick<MobileV2RescheduleWindow, "startIso">,
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  if (stop === null || stop === undefined) return false;
  return stop.window.trim() === mobileV2RescheduleWindowLabelForReadback(window, timeZone);
}

export function buildMobileV2RescheduleReadback(input: {
  readonly write: MobileV2WriteEnvelope;
  readonly window: Pick<MobileV2RescheduleWindow, "startIso">;
  readonly timeZone?: string;
  readonly note: string | null;
  readonly submittedAt?: string;
}): MobileV2RescheduleReadback | null {
  if (typeof input.write.decision_log_id !== "string" || input.write.decision_log_id.trim() === "") {
    return null;
  }
  return Object.freeze({
    decisionLogId: input.write.decision_log_id,
    state: typeof input.write.state === "string" && input.write.state.trim() !== ""
      ? input.write.state
      : "rescheduled",
    windowLabel: mobileV2RescheduleWindowLabelForReadback(input.window, input.timeZone ?? DEFAULT_TIME_ZONE),
    note: input.note !== null && input.note.trim() !== "" ? input.note.trim() : null,
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  });
}
