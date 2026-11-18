export type ContactChannel = "call" | "sms" | "whatsapp";

export type ContactPolicyLike = {
  allowed_channels?: ContactChannel[] | null;
  min_interval_ms?: number | null;
  templates?: {
    allowed_for_sms?: string[] | null;
    allowed_for_whatsapp?: string[] | null;
  } | null;
};

export type ContactAttempt = {
  channel: ContactChannel;
  stopId: string;
  templateId?: string | null;
  attemptedAt: number;
};

export type ContactGateState = {
  recent: ContactAttempt[];
};

export const DEFAULT_CONTACT_MIN_INTERVAL_MS = 1_500;
const CONTACT_WINDOW_MS = 60_000;

export function createContactGateState(): ContactGateState {
  return { recent: [] };
}

export type ContactGateResult =
  | { ok: true }
  | {
      ok: false;
      reason: "channel_disallowed" | "template_disallowed" | "rate_limited";
      retryAfterMs?: number;
    };

function resolveMinIntervalMs(policy: ContactPolicyLike | null | undefined): number {
  const raw = policy?.min_interval_ms;
  if (raw === null || raw === undefined) return DEFAULT_CONTACT_MIN_INTERVAL_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CONTACT_MIN_INTERVAL_MS;
  }
  return raw;
}

function isTemplateAllowed(
  channel: ContactChannel,
  templateId: string | null | undefined,
  policy: ContactPolicyLike | null | undefined
): boolean {
  if (channel !== "sms" && channel !== "whatsapp") return true;
  const templates = policy?.templates ?? null;
  if (!templates) return true;
  const list =
    channel === "sms"
      ? templates.allowed_for_sms
      : templates.allowed_for_whatsapp;
  if (list === null || list === undefined) return true;
  if (!Array.isArray(list)) return true;
  // Policy explicitly lists allowed templates; require a match.
  if (!templateId) return false;
  return list.includes(templateId);
}

function isChannelAllowed(
  channel: ContactChannel,
  policy: ContactPolicyLike | null | undefined
): boolean {
  const allowed = policy?.allowed_channels;
  if (allowed === null || allowed === undefined) return true;
  if (!Array.isArray(allowed)) return true;
  return allowed.includes(channel);
}

export function evaluateContactAttempt(
  state: ContactGateState,
  request: {
    channel: ContactChannel;
    stopId: string;
    templateId?: string | null;
    now: number;
  },
  policy: ContactPolicyLike | null | undefined
): ContactGateResult {
  if (!isChannelAllowed(request.channel, policy)) {
    return { ok: false, reason: "channel_disallowed" };
  }

  if (!isTemplateAllowed(request.channel, request.templateId ?? null, policy)) {
    return { ok: false, reason: "template_disallowed" };
  }

  const minIntervalMs = resolveMinIntervalMs(policy);
  if (minIntervalMs > 0) {
    const recent = Array.isArray(state?.recent) ? state.recent : [];
    let lastMatchingAt: number | null = null;
    for (const entry of recent) {
      if (!entry) continue;
      if (entry.channel !== request.channel) continue;
      if (entry.stopId !== request.stopId) continue;
      const at = typeof entry.attemptedAt === "number" ? entry.attemptedAt : null;
      if (at == null) continue;
      if (lastMatchingAt == null || at > lastMatchingAt) {
        lastMatchingAt = at;
      }
    }
    if (lastMatchingAt != null) {
      const elapsed = request.now - lastMatchingAt;
      if (elapsed < minIntervalMs) {
        const retryAfterMs = Math.max(0, minIntervalMs - elapsed);
        return { ok: false, reason: "rate_limited", retryAfterMs };
      }
    }
  }

  return { ok: true };
}

// Record an accepted attempt and return the updated state with window
// pruning (keep only last 60s).
export function recordContactAttempt(
  state: ContactGateState,
  attempt: ContactAttempt
): ContactGateState {
  const prev = Array.isArray(state?.recent) ? state.recent : [];
  const cutoff = attempt.attemptedAt - CONTACT_WINDOW_MS;
  const next: ContactAttempt[] = [];
  for (const entry of prev) {
    if (!entry) continue;
    if (typeof entry.attemptedAt !== "number") continue;
    if (entry.attemptedAt >= cutoff) {
      next.push(entry);
    }
  }
  next.push(attempt);
  return { recent: next };
}
