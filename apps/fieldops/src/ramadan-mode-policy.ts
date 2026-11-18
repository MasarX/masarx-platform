// Resolve Ramadan scheduling adjustments from ramadan_mode_policy.
//
// Contract: the resolver `public.resolve_ramadan_mode_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     enabled: false,
//     active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
//     eta_inflation: {
//       iftar_hour:   { start_local_offset_min_before_maghrib: 30,
//                       end_local_offset_min_after_maghrib: 30,
//                       multiplier_pct: 130 },
//       general:      { multiplier_pct: 110 }
//     },
//     shift_overrides: {
//       iftar_break_minutes: 45,
//       suhoor_shift_start_local: "21:00",
//       suhoor_shift_end_local:   "03:00"
//     },
//     bonuses: {
//       iftar_completion_pct: 25,
//       suhoor_completion_pct: 15
//     }
//   }
//
// This module:
//  1. Defines the typed shape (RamadanModePolicyValue + sub-types).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Provides pure resolvers for the three correlated MENA behaviors:
//       - resolveEtaMultiplierPct(policy, localTime, maghribTime)
//       - inflateEtaMinutes(policy, baseEtaMinutes, localTime, maghribTime)
//       - isInSuhoorShiftWindow(policy, "HH:MM")
//  4. Ships a STATIC fallback that mirrors the global default seed
//     (enabled=false), so consumers stay legible while the network query is
//     in flight or offline — and Ramadan mode is fully a no-op in that
//     fallback path so we never inflate ETAs or shift schedules
//     unintentionally.
//
// Callers apply the resolved Iftar and Suhoor windows, ETA multipliers and shift adjustments.
//
// Backward compat: STATIC_RAMADAN_MODE MUST stay in sync with the migration
// global default seed in
// supabase/migrations/202604241910_ramadan_mode_policy_v1.sql. The pgTAP test
// 0zd_ramadan_mode_policy.sql asserts the seed values. The Jest test
// tests/unit/ramadan-mode-policy.test.ts asserts that this constant matches
// the migration default exactly.

export type RamadanActiveWindow = {
  from_hijri_year: number;
  to_hijri_year: number;
};

export type IftarHourEtaConfig = {
  start_local_offset_min_before_maghrib: number;
  end_local_offset_min_after_maghrib: number;
  multiplier_pct: number;
};

export type GeneralEtaConfig = {
  multiplier_pct: number;
};

export type EtaInflationConfig = {
  iftar_hour: IftarHourEtaConfig;
  general: GeneralEtaConfig;
};

export type ShiftOverridesConfig = {
  iftar_break_minutes: number;
  // 24h "HH:MM" local time. End may be earlier than start (overnight wrap).
  suhoor_shift_start_local: string;
  suhoor_shift_end_local: string;
};

export type BonusesConfig = {
  iftar_completion_pct: number;
  suhoor_completion_pct: number;
};

export type RamadanModePolicyValue = {
  version: number;
  enabled: boolean;
  active_window: RamadanActiveWindow;
  eta_inflation: EtaInflationConfig;
  shift_overrides: ShiftOverridesConfig;
  bonuses: BonusesConfig;
};

// Mirror of the migration seed (see supabase/migrations/202604241910_ramadan_mode_policy_v1.sql).
// enabled=false means this fallback is fully a no-op — multiplier 100, no
// suhoor window match unless tenants opt in. Both unit + pgTAP tests pin this
// contract to catch drift between code and DB seed at PR time.
export const STATIC_RAMADAN_MODE: RamadanModePolicyValue = {
  version: 1,
  enabled: false,
  active_window: { from_hijri_year: 1447, to_hijri_year: 1447 },
  eta_inflation: {
    iftar_hour: {
      start_local_offset_min_before_maghrib: 30,
      end_local_offset_min_after_maghrib: 30,
      multiplier_pct: 130,
    },
    general: { multiplier_pct: 110 },
  },
  shift_overrides: {
    iftar_break_minutes: 45,
    suhoor_shift_start_local: "21:00",
    suhoor_shift_end_local: "03:00",
  },
  bonuses: {
    iftar_completion_pct: 25,
    suhoor_completion_pct: 15,
  },
};

// Helpers to clone the static seed (avoid sharing mutable references).
function cloneStaticActiveWindow(): RamadanActiveWindow {
  return { ...STATIC_RAMADAN_MODE.active_window };
}

function cloneStaticEtaInflation(): EtaInflationConfig {
  return {
    iftar_hour: { ...STATIC_RAMADAN_MODE.eta_inflation.iftar_hour },
    general: { ...STATIC_RAMADAN_MODE.eta_inflation.general },
  };
}

function cloneStaticShiftOverrides(): ShiftOverridesConfig {
  return { ...STATIC_RAMADAN_MODE.shift_overrides };
}

function cloneStaticBonuses(): BonusesConfig {
  return { ...STATIC_RAMADAN_MODE.bonuses };
}

// Numeric coercion: accepts finite numbers; returns fallback otherwise.
function readInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

// Boolean coercion: accepts strict booleans only; non-boolean values fall
// through to the safe fallback (default `false` for `enabled`).
function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

// "HH:MM" 24h validation. Accepts 00:00–23:59. Returns the trimmed string
// when valid, otherwise returns the fallback. Treat anything else as opaque.
const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function readHhmm(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!HHMM_RE.test(trimmed)) return fallback;
  return trimmed;
}

function normalizeActiveWindow(raw: unknown): RamadanActiveWindow {
  if (!raw || typeof raw !== "object") return cloneStaticActiveWindow();
  const obj = raw as Record<string, unknown>;
  return {
    from_hijri_year: readInt(
      obj.from_hijri_year,
      STATIC_RAMADAN_MODE.active_window.from_hijri_year,
    ),
    to_hijri_year: readInt(
      obj.to_hijri_year,
      STATIC_RAMADAN_MODE.active_window.to_hijri_year,
    ),
  };
}

function normalizeIftarHour(raw: unknown): IftarHourEtaConfig {
  if (!raw || typeof raw !== "object") {
    return { ...STATIC_RAMADAN_MODE.eta_inflation.iftar_hour };
  }
  const obj = raw as Record<string, unknown>;
  return {
    start_local_offset_min_before_maghrib: Math.max(
      0,
      readInt(
        obj.start_local_offset_min_before_maghrib,
        STATIC_RAMADAN_MODE.eta_inflation.iftar_hour
          .start_local_offset_min_before_maghrib,
      ),
    ),
    end_local_offset_min_after_maghrib: Math.max(
      0,
      readInt(
        obj.end_local_offset_min_after_maghrib,
        STATIC_RAMADAN_MODE.eta_inflation.iftar_hour
          .end_local_offset_min_after_maghrib,
      ),
    ),
    // Clamp to >= 100 so a malformed multiplier never DEFLATES ETA.
    multiplier_pct: Math.max(
      100,
      readInt(
        obj.multiplier_pct,
        STATIC_RAMADAN_MODE.eta_inflation.iftar_hour.multiplier_pct,
      ),
    ),
  };
}

function normalizeGeneralEta(raw: unknown): GeneralEtaConfig {
  if (!raw || typeof raw !== "object") {
    return { ...STATIC_RAMADAN_MODE.eta_inflation.general };
  }
  const obj = raw as Record<string, unknown>;
  return {
    multiplier_pct: Math.max(
      100,
      readInt(
        obj.multiplier_pct,
        STATIC_RAMADAN_MODE.eta_inflation.general.multiplier_pct,
      ),
    ),
  };
}

function normalizeEtaInflation(raw: unknown): EtaInflationConfig {
  if (!raw || typeof raw !== "object") return cloneStaticEtaInflation();
  const obj = raw as Record<string, unknown>;
  return {
    iftar_hour: normalizeIftarHour(obj.iftar_hour),
    general: normalizeGeneralEta(obj.general),
  };
}

function normalizeShiftOverrides(raw: unknown): ShiftOverridesConfig {
  if (!raw || typeof raw !== "object") return cloneStaticShiftOverrides();
  const obj = raw as Record<string, unknown>;
  return {
    iftar_break_minutes: Math.max(
      0,
      readInt(
        obj.iftar_break_minutes,
        STATIC_RAMADAN_MODE.shift_overrides.iftar_break_minutes,
      ),
    ),
    suhoor_shift_start_local: readHhmm(
      obj.suhoor_shift_start_local,
      STATIC_RAMADAN_MODE.shift_overrides.suhoor_shift_start_local,
    ),
    suhoor_shift_end_local: readHhmm(
      obj.suhoor_shift_end_local,
      STATIC_RAMADAN_MODE.shift_overrides.suhoor_shift_end_local,
    ),
  };
}

function normalizeBonuses(raw: unknown): BonusesConfig {
  if (!raw || typeof raw !== "object") return cloneStaticBonuses();
  const obj = raw as Record<string, unknown>;
  return {
    iftar_completion_pct: Math.max(
      0,
      readInt(
        obj.iftar_completion_pct,
        STATIC_RAMADAN_MODE.bonuses.iftar_completion_pct,
      ),
    ),
    suhoor_completion_pct: Math.max(
      0,
      readInt(
        obj.suhoor_completion_pct,
        STATIC_RAMADAN_MODE.bonuses.suhoor_completion_pct,
      ),
    ),
  };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// RamadanModePolicyValue. Defensive: malformed sub-objects fall back to the
// STATIC seed so a bad row in production cannot brick mobile dispatch logic.
export function normalizeRamadanModePolicy(raw: unknown): RamadanModePolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_RAMADAN_MODE.version,
      enabled: STATIC_RAMADAN_MODE.enabled,
      active_window: cloneStaticActiveWindow(),
      eta_inflation: cloneStaticEtaInflation(),
      shift_overrides: cloneStaticShiftOverrides(),
      bonuses: cloneStaticBonuses(),
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_RAMADAN_MODE.version;
  return {
    version,
    enabled: readBool(obj.enabled, STATIC_RAMADAN_MODE.enabled),
    active_window: normalizeActiveWindow(obj.active_window),
    eta_inflation: normalizeEtaInflation(obj.eta_inflation),
    shift_overrides: normalizeShiftOverrides(obj.shift_overrides),
    bonuses: normalizeBonuses(obj.bonuses),
  };
}

// ---------------------------------------------------------------------------
// ETA inflation
// ---------------------------------------------------------------------------

// Resolve the ETA multiplier (as percent, e.g. 130 = +30%) for a given local
// wall-clock time and Maghrib instant.
//
// Rules:
//   - If policy.enabled === false → returns 100 (no inflation).
//   - If maghribTime is null AND policy.enabled === true → general multiplier
//     (we can't know if we're in the Iftar window without Maghrib).
//   - If localTime is within [maghribTime - start_offset, maghribTime + end_offset]
//     → returns iftar_hour.multiplier_pct.
//   - Otherwise → returns general.multiplier_pct.
export function resolveEtaMultiplierPct(
  policy: RamadanModePolicyValue,
  localTime: Date,
  maghribTime: Date | null,
): number {
  if (!policy.enabled) return 100;
  if (!(localTime instanceof Date) || Number.isNaN(localTime.getTime())) {
    // Defensive: caller passed a junk Date — fall back to general multiplier
    // (still safer than crashing in dispatch).
    return policy.eta_inflation.general.multiplier_pct;
  }
  if (
    maghribTime instanceof Date &&
    !Number.isNaN(maghribTime.getTime())
  ) {
    const startMs =
      maghribTime.getTime() -
      policy.eta_inflation.iftar_hour.start_local_offset_min_before_maghrib *
        60_000;
    const endMs =
      maghribTime.getTime() +
      policy.eta_inflation.iftar_hour.end_local_offset_min_after_maghrib *
        60_000;
    const t = localTime.getTime();
    if (t >= startMs && t <= endMs) {
      return policy.eta_inflation.iftar_hour.multiplier_pct;
    }
  }
  return policy.eta_inflation.general.multiplier_pct;
}

// Apply the resolved multiplier to a base ETA in minutes. Always rounds to
// nearest whole minute (ETAs are surfaced in whole minutes in the mobile
// shell). Negative / non-finite base ETAs are coerced to 0.
export function inflateEtaMinutes(
  policy: RamadanModePolicyValue,
  baseEtaMinutes: number,
  localTime: Date,
  maghribTime: Date | null,
): number {
  const safeBase =
    typeof baseEtaMinutes === "number" &&
    Number.isFinite(baseEtaMinutes) &&
    baseEtaMinutes > 0
      ? baseEtaMinutes
      : 0;
  const multiplierPct = resolveEtaMultiplierPct(policy, localTime, maghribTime);
  return Math.round((safeBase * multiplierPct) / 100);
}

// ---------------------------------------------------------------------------
// Suhoor shift detection
// ---------------------------------------------------------------------------

// Convert "HH:MM" → minutes-since-midnight. Returns null on malformed input.
function hhmmToMinutes(value: string): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = HHMM_RE.exec(trimmed);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  return hh * 60 + mm;
}

// Returns true iff `localTimeStr` ("HH:MM") falls inside the configured Suhoor
// shift window. Handles overnight wrap-around (start > end, e.g. 21:00 → 03:00):
// in that case, the window covers [start..23:59] AND [00:00..end].
//
// Both endpoints are inclusive.
//
// When policy.enabled === false this returns false (Ramadan mode is off, so
// there's no Suhoor shift conceptually). When the policy timestrings or the
// argument are malformed, this returns false defensively (no false positive).
export function isInSuhoorShiftWindow(
  policy: RamadanModePolicyValue,
  localTimeStr: string,
): boolean {
  if (!policy.enabled) return false;
  const nowMin = hhmmToMinutes(localTimeStr);
  const startMin = hhmmToMinutes(policy.shift_overrides.suhoor_shift_start_local);
  const endMin = hhmmToMinutes(policy.shift_overrides.suhoor_shift_end_local);
  if (nowMin === null || startMin === null || endMin === null) return false;
  if (startMin === endMin) {
    // Zero-length window — by convention treat it as "no Suhoor shift".
    return false;
  }
  if (startMin < endMin) {
    // Same-day window (e.g. 09:00 → 17:00).
    return nowMin >= startMin && nowMin <= endMin;
  }
  // Overnight wrap-around (e.g. 21:00 → 03:00).
  return nowMin >= startMin || nowMin <= endMin;
}
