export type ReattemptPolicyLike = {
  suggested_slots?: Array<{ label: string; offset_minutes: number }> | null;
  max_attempts?: number | null;
  notify_customer?: boolean | null;
  require_notes_on_attempts_above?: number | null;
  reason_specific?: Record<
    string,
    {
      slots?: Array<{ label: string; offset_minutes: number }>;
      notify?: boolean;
    }
  > | null;
};

export type ReattemptSuggestion = {
  label: string;
  scheduledAt: string;
  channel: "default" | "reason_specific";
  notifyCustomer: boolean;
  requiresNotes: boolean;
};

export const DEFAULT_REATTEMPT_SLOTS: Array<{ label: string; offset_minutes: number }> = [
  { label: "In 1 hour", offset_minutes: 60 },
  { label: "Tomorrow morning", offset_minutes: 1440 },
];

export const DEFAULT_REATTEMPT_MAX_ATTEMPTS = 3;
export const DEFAULT_REATTEMPT_REQUIRE_NOTES_ABOVE = 1;

function isSlot(value: unknown): value is { label: string; offset_minutes: number } {
  if (!value || typeof value !== "object") return false;
  const label = (value as { label?: unknown }).label;
  const offset = (value as { offset_minutes?: unknown }).offset_minutes;
  return (
    typeof label === "string" &&
    label.length > 0 &&
    typeof offset === "number" &&
    Number.isFinite(offset)
  );
}

function resolveSlots(
  policy: ReattemptPolicyLike | null | undefined,
  reasonKey: string
): {
  slots: Array<{ label: string; offset_minutes: number }>;
  channel: "default" | "reason_specific";
  notifyOverride: boolean | null;
} {
  const reasonSpecific = policy?.reason_specific ?? null;
  if (reasonSpecific && typeof reasonSpecific === "object") {
    const entry = reasonSpecific[reasonKey];
    if (entry && typeof entry === "object") {
      const rawSlots = Array.isArray(entry.slots) ? entry.slots : [];
      const slots = rawSlots.filter(isSlot);
      if (slots.length > 0) {
        const notifyOverride =
          typeof entry.notify === "boolean" ? entry.notify : null;
        return { slots, channel: "reason_specific", notifyOverride };
      }
    }
  }

  const fromPolicy = Array.isArray(policy?.suggested_slots)
    ? (policy?.suggested_slots as Array<unknown>).filter(isSlot)
    : [];
  if (fromPolicy.length > 0) {
    return { slots: fromPolicy, channel: "default", notifyOverride: null };
  }

  return {
    slots: [...DEFAULT_REATTEMPT_SLOTS],
    channel: "default",
    notifyOverride: null,
  };
}

function resolveMaxAttempts(policy: ReattemptPolicyLike | null | undefined): number {
  const raw = policy?.max_attempts;
  if (raw == null) return DEFAULT_REATTEMPT_MAX_ATTEMPTS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return DEFAULT_REATTEMPT_MAX_ATTEMPTS;
  }
  return Math.floor(raw);
}

function resolveNotifyCustomer(
  policy: ReattemptPolicyLike | null | undefined,
  reasonOverride: boolean | null
): boolean {
  if (reasonOverride !== null) return reasonOverride;
  if (policy?.notify_customer === false) return false;
  return true;
}

function resolveRequireNotesThreshold(
  policy: ReattemptPolicyLike | null | undefined
): number {
  const raw = policy?.require_notes_on_attempts_above;
  if (raw == null) return DEFAULT_REATTEMPT_REQUIRE_NOTES_ABOVE;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_REATTEMPT_REQUIRE_NOTES_ABOVE;
  }
  return Math.floor(raw);
}

export function buildReattemptSuggestions(input: {
  reasonKey: string;
  policy: ReattemptPolicyLike | null | undefined;
  previousAttemptCount: number;
  now: number;
}): ReattemptSuggestion[] {
  const { reasonKey, policy, previousAttemptCount, now } = input;
  const { slots, channel, notifyOverride } = resolveSlots(policy, reasonKey);
  const maxAttempts = resolveMaxAttempts(policy);
  const notifyCustomer = resolveNotifyCustomer(policy, notifyOverride);
  const notesThreshold = resolveRequireNotesThreshold(policy);
  const attemptNumber =
    Number.isFinite(previousAttemptCount) && previousAttemptCount >= 0
      ? Math.floor(previousAttemptCount) + 1
      : 1;
  const requiresNotes = attemptNumber > notesThreshold;

  const capped = slots.slice(0, Math.max(0, maxAttempts));
  const suggestions: ReattemptSuggestion[] = [];
  for (const slot of capped) {
    const offsetMs = slot.offset_minutes * 60_000;
    const scheduledAt = new Date(now + offsetMs).toISOString();
    suggestions.push({
      label: slot.label,
      scheduledAt,
      channel,
      notifyCustomer,
      requiresNotes,
    });
  }
  return suggestions;
}

export type NdrNotificationDraft = {
  channels: Array<"sms" | "whatsapp" | "email">;
  messageKey: string;
  metadata: Record<string, unknown>;
  etaIso: string | null;
};

const NDR_SUPPORTED_CHANNELS: Array<"sms" | "whatsapp" | "email"> = [
  "sms",
  "whatsapp",
  "email",
];

export function buildNdrNotificationDraft(input: {
  reasonKey: string;
  nextAttemptIso: string | null;
  communicationPolicyChannels: Array<"sms" | "whatsapp" | "email" | "call">;
  notifyCustomer: boolean;
  stopId: string;
  customerPhone: string | null;
  customerName: string | null;
}): NdrNotificationDraft | null {
  if (!input || input.notifyCustomer === false) return null;
  const phone =
    typeof input.customerPhone === "string" && input.customerPhone.trim().length > 0
      ? input.customerPhone.trim()
      : null;
  if (!phone) return null;

  const rawChannels = Array.isArray(input.communicationPolicyChannels)
    ? input.communicationPolicyChannels
    : [];
  const filtered: Array<"sms" | "whatsapp" | "email"> = [];
  const seen = new Set<string>();
  for (const channel of rawChannels) {
    if (!channel || seen.has(channel)) continue;
    if (
      channel === "sms" ||
      channel === "whatsapp" ||
      channel === "email"
    ) {
      if (NDR_SUPPORTED_CHANNELS.includes(channel)) {
        filtered.push(channel);
        seen.add(channel);
      }
    }
  }

  if (filtered.length === 0) return null;

  const metadata: Record<string, unknown> = {
    stopId: input.stopId,
    reasonKey: input.reasonKey,
    customerName: input.customerName ?? null,
    customerPhone: phone,
  };

  return {
    channels: filtered,
    messageKey: `ndr.${input.reasonKey}`,
    metadata,
    etaIso: input.nextAttemptIso ?? null,
  };
}
