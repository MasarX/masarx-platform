type JsonRecord = Record<string, unknown>;

export type MobileUiEventLogResult = {
  readonly status:
    | "synced"
    | "queued_offline"
    | "queued_pending_sync"
    | "retryable_failure"
    | "readback_mismatch";
  readonly eventCount: number;
  readonly recordedAt: string;
  readonly eventType: string | null;
};

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function coerceText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeMobileUiEvent(input: JsonRecord): JsonRecord | null {
  const eventType = coerceText(input.type) ?? coerceText(input.event_type);
  if (!eventType) return null;

  const meta = {
    ...asRecord(input.meta),
    ...asRecord(input.metadata),
  };
  const capturedAt = coerceText(input.captured_at);
  if (capturedAt && !("captured_at" in meta)) {
    meta.captured_at = capturedAt;
  }

  return {
    type: eventType,
    context: coerceText(input.context) ?? undefined,
    name: coerceText(input.name) ?? undefined,
    message: coerceText(input.message) ?? undefined,
    digest: coerceText(input.digest) ?? undefined,
    meta,
  };
}

export function normalizeMobileUiEvents(events: ReadonlyArray<JsonRecord>): JsonRecord[] {
  return events
    .map((event) => normalizeMobileUiEvent(event))
    .filter((event): event is JsonRecord => event !== null);
}

export function firstMobileUiEventType(events: ReadonlyArray<JsonRecord>): string | null {
  for (const event of events) {
    const eventType = coerceText(event.type) ?? coerceText(event.event_type);
    if (eventType) return eventType;
  }
  return null;
}

export function resolveMobileUiEventLogReadback(input: {
  readonly data: unknown;
  readonly expectedEventCount: number;
  readonly recordedAt: string;
  readonly eventType: string | null;
}): MobileUiEventLogResult {
  const rawCount = typeof input.data === "number" ? input.data : Number(input.data ?? 0);
  const eventCount = Number.isFinite(rawCount) ? rawCount : 0;
  return {
    status: eventCount >= input.expectedEventCount ? "synced" : "readback_mismatch",
    eventCount,
    recordedAt: input.recordedAt,
    eventType: input.eventType,
  };
}
