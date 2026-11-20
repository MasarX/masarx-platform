// Resolve status tones from the current status_theme_policy.

// Status tones are shared between the policy resolver and presentation. The meta tone is available to explicit UI callers.
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "meta";

export type StatusThemePolicyValue = {
  version: number;
  default_tone: StatusTone;
  status_map: Record<string, { tone: StatusTone }>;
};

// The normalizer accepts only tones supported by the shared status presentation.
const VALID_TONES: ReadonlySet<StatusTone> = new Set([
  "info",
  "success",
  "warning",
  "danger",
  "neutral",
  "meta",
]);

function coerceTone(input: unknown, fallback: StatusTone): StatusTone {
  if (typeof input !== "string") return fallback;
  return VALID_TONES.has(input as StatusTone) ? (input as StatusTone) : fallback;
}

// Mirror of the migration seed (see supabase/migrations/202604241430_status_theme_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, the chip rendering
// should match the global default the server would have returned.
export const STATIC_STATUS_THEME: StatusThemePolicyValue = {
  version: 1,
  default_tone: "neutral",
  status_map: {
    open: { tone: "info" },
    assigned: { tone: "info" },
    queued: { tone: "info" },
    new: { tone: "info" },
    in_progress: { tone: "info" },
    "in-progress": { tone: "info" },
    inprogress: { tone: "info" },
    en_route: { tone: "info" },
    "en-route": { tone: "info" },
    enroute: { tone: "info" },
    arrived: { tone: "info" },
    started: { tone: "info" },
    completed: { tone: "success" },
    complete: { tone: "success" },
    done: { tone: "success" },
    closed: { tone: "success" },
    synced: { tone: "success" },
    succeeded: { tone: "success" },
    success: { tone: "success" },
    failed: { tone: "danger" },
    fail: { tone: "danger" },
    dead: { tone: "danger" },
    exception: { tone: "danger" },
    rejected: { tone: "danger" },
    refused: { tone: "danger" },
    error: { tone: "danger" },
    overdue: { tone: "warning" },
    delayed: { tone: "warning" },
    late: { tone: "warning" },
    warning: { tone: "warning" },
    pending: { tone: "warning" },
  },
};

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// StatusThemePolicyValue. Defensive: any malformed entry falls back to the
// static seed so a bad row in production cannot brick chip rendering.
export function normalizeStatusThemePolicy(
  raw: unknown,
): StatusThemePolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_STATUS_THEME;
  const obj = raw as Record<string, unknown>;
  const default_tone = coerceTone(obj.default_tone, STATIC_STATUS_THEME.default_tone);
  const status_map: Record<string, { tone: StatusTone }> = {};
  const sourceMap = obj.status_map;
  if (sourceMap && typeof sourceMap === "object") {
    for (const [rawKey, rawEntry] of Object.entries(sourceMap as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const tone = coerceTone((rawEntry as { tone?: unknown }).tone, default_tone);
      status_map[String(rawKey).toLowerCase()] = { tone };
    }
  }
  // If the policy ships an empty status_map (operator misconfiguration), fall
  // back to the static seed so chips stay semantically meaningful.
  if (Object.keys(status_map).length === 0) {
    return { ...STATIC_STATUS_THEME, default_tone };
  }
  const versionRaw = obj.version;
  const version = typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;
  return { version, default_tone, status_map };
}

// Pure resolver: status string → tone. Lowercases the input before lookup.
// Returns the policy's `default_tone` for unknown statuses (currently "neutral"
// in the global seed, but operators can override per tenant).
export function resolveToneFromPolicy(
  policy: StatusThemePolicyValue,
  status: string | null | undefined,
): StatusTone {
  if (status === null || status === undefined) return policy.default_tone;
  const normalized = String(status).trim().toLowerCase();
  if (normalized.length === 0) return policy.default_tone;
  return policy.status_map[normalized]?.tone ?? policy.default_tone;
}
