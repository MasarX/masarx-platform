// Resolve the high-contrast sunlight theme from the manual toggle and the policy-controlled ambient-light threshold.
//
// Contract: the resolver `public.resolve_sunlight_mode_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     enabled: false,
//     auto_switch: {
//       enabled: false,
//       ambient_lux_threshold: 50000,
//       user_override_persists_minutes: 30
//     },
//     user_toggle_visible: true
//   }
//
// This module:
//  1. Defines the typed shape (SunlightModePolicyValue + AutoSwitchConfig).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Provides `resolveSunlightActive(policy, ambientLux, userToggleActive)`
//     — the canonical "should the sunlight variant be active right now?"
//     decision. User toggle always wins; otherwise auto-switch evaluates
//     the ambient lux reading against the policy threshold.
//  4. Ships a STATIC fallback that mirrors the global default seed
//     (enabled=false), so consumers stay legible while the network query
//     is in flight or offline — and the sunlight variant is fully a
//     no-op in that fallback path so existing tenants are not surprised.
//
// The theme provider applies the resolved variant.
//
// Backward compat: STATIC_SUNLIGHT_MODE MUST stay in sync with the migration
// global default seed in
// supabase/migrations/202604241970_sunlight_mode_policy_v1.sql. The pgTAP
// test 0zd_sunlight_mode_policy.sql asserts the seed values. The Jest test
// tests/unit/sunlight-mode-policy.test.ts asserts that this constant
// matches the migration default exactly.

export type AutoSwitchConfig = {
  enabled: boolean;
  ambient_lux_threshold: number;
  user_override_persists_minutes: number;
};

export type SunlightModePolicyValue = {
  version: number;
  enabled: boolean;
  auto_switch: AutoSwitchConfig;
  user_toggle_visible: boolean;
};

// The seed is opt-in. Tenant overrides can enable the variant and its ambient-light threshold independently.
export const STATIC_SUNLIGHT_MODE: SunlightModePolicyValue = {
  version: 1,
  enabled: false,
  auto_switch: {
    enabled: false,
    ambient_lux_threshold: 50000,
    user_override_persists_minutes: 30,
  },
  user_toggle_visible: true,
};

// Boolean coercion: accepts strict booleans only; non-boolean values fall
// through to the safe fallback.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

// Numeric coercion: accepts finite numbers only; coerces to integer; clamps
// to >= 0 so a malformed negative threshold can never spuriously activate.
function readNonNegativeInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  return fallback;
}

function cloneStaticAutoSwitch(): AutoSwitchConfig {
  return { ...STATIC_SUNLIGHT_MODE.auto_switch };
}

function normalizeAutoSwitch(raw: unknown): AutoSwitchConfig {
  if (!raw || typeof raw !== "object") return cloneStaticAutoSwitch();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(obj.enabled, STATIC_SUNLIGHT_MODE.auto_switch.enabled),
    ambient_lux_threshold: readNonNegativeInt(
      obj.ambient_lux_threshold,
      STATIC_SUNLIGHT_MODE.auto_switch.ambient_lux_threshold,
    ),
    user_override_persists_minutes: readNonNegativeInt(
      obj.user_override_persists_minutes,
      STATIC_SUNLIGHT_MODE.auto_switch.user_override_persists_minutes,
    ),
  };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// SunlightModePolicyValue. Defensive: malformed sub-objects fall back to the
// STATIC seed so a bad row in production cannot brick the theme dispatch.
export function normalizeSunlightModePolicy(
  raw: unknown,
): SunlightModePolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_SUNLIGHT_MODE.version,
      enabled: STATIC_SUNLIGHT_MODE.enabled,
      auto_switch: cloneStaticAutoSwitch(),
      user_toggle_visible: STATIC_SUNLIGHT_MODE.user_toggle_visible,
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_SUNLIGHT_MODE.version;
  return {
    version,
    enabled: readBool(obj.enabled, STATIC_SUNLIGHT_MODE.enabled),
    auto_switch: normalizeAutoSwitch(obj.auto_switch),
    user_toggle_visible: readBool(
      obj.user_toggle_visible,
      STATIC_SUNLIGHT_MODE.user_toggle_visible,
    ),
  };
}

// A manual toggle takes precedence. Automatic activation requires both policy switches and a sensor reading at or above the configured threshold.
export function resolveSunlightActive(
  policy: SunlightModePolicyValue,
  ambientLux: number | null,
  userToggleActive: boolean,
): boolean {
  // Rule 1: user toggle always wins (driver intent escape hatch).
  if (userToggleActive === true) return true;
  // Rule 2: master switch.
  if (!policy.enabled) return false;
  // Rule 3: auto-switch must be enabled.
  if (!policy.auto_switch.enabled) return false;
  // Rule 4: sensor must have a reading.
  if (ambientLux === null) return false;
  // Defensive: non-finite numbers (NaN / Infinity) are treated as "no
  // reading" rather than "infinite lux" so we never spuriously activate.
  if (typeof ambientLux !== "number" || !Number.isFinite(ambientLux)) {
    return false;
  }
  // Rule 5: threshold check.
  return ambientLux >= policy.auto_switch.ambient_lux_threshold;
}
