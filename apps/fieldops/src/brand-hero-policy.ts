// Resolve brand hero moments from brand_hero_policy.
//
// Contract: the resolver `public.resolve_brand_hero_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     moments: {
//       sign_in:        { enabled, variant, show_biometric_pill, background_animation },
//       shift_start:    { enabled, variant, show_earnings_preview, haptic_pattern, duration_ms },
//       shift_end:      { enabled, variant, show_sparkline, show_thank_you, show_share_export },
//       error_recovery: { enabled, variant, show_offline_radar, preserve_last_state, show_retry_cta }
//     },
//     respect_reduce_motion: true,
//     respect_driving_lock:  true
//   }
//
// This module:
//  1. Defines the typed shape (BrandHeroPolicyValue + sub-types).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Provides pure resolvers:
//       - resolveHeroMoment(policy, moment) → BrandHeroMomentConfig
//       - shouldShowHeroMoment(policy, moment, options) → boolean
//  4. Ships a STATIC fallback that mirrors the global default seed (all four
//     moments enabled), so consumers stay legible while the network query is
//     in flight or offline. The fallback respects reduce-motion +
//     driving-lock, so a11y and active driving lock still suppress moments
//     even in the offline path.
//
// Callers render the resolved moment and handle haptics.
//
// Backward compat: STATIC_BRAND_HERO MUST stay in sync with the migration
// global default seed in
// supabase/migrations/202604242030_brand_hero_policy_v1.sql. The pgTAP test
// 0zd_brand_hero_policy.sql asserts the seed values. The Jest test
// tests/unit/brand-hero-policy.test.ts asserts that this constant matches
// the migration default exactly.

export type BrandHeroMoment =
  | "sign_in"
  | "shift_start"
  | "shift_end"
  | "error_recovery";

export type SignInMomentConfig = {
  enabled: boolean;
  variant: string;
  show_biometric_pill: boolean;
  background_animation: string;
};

export type ShiftStartMomentConfig = {
  enabled: boolean;
  variant: string;
  show_earnings_preview: boolean;
  haptic_pattern: string;
  duration_ms: number;
};

export type ShiftEndMomentConfig = {
  enabled: boolean;
  variant: string;
  show_sparkline: boolean;
  show_thank_you: boolean;
  show_share_export: boolean;
};

export type ErrorRecoveryMomentConfig = {
  enabled: boolean;
  variant: string;
  show_offline_radar: boolean;
  preserve_last_state: boolean;
  show_retry_cta: boolean;
};

// Discriminated-by-shape union of the four canonical moments. Consumers that
// only care about the `enabled` flag can read it without narrowing.
export type BrandHeroMomentConfig =
  | SignInMomentConfig
  | ShiftStartMomentConfig
  | ShiftEndMomentConfig
  | ErrorRecoveryMomentConfig;

export type BrandHeroMoments = {
  sign_in: SignInMomentConfig;
  shift_start: ShiftStartMomentConfig;
  shift_end: ShiftEndMomentConfig;
  error_recovery: ErrorRecoveryMomentConfig;
};

export type BrandHeroPolicyValue = {
  version: number;
  moments: BrandHeroMoments;
  respect_reduce_motion: boolean;
  respect_driving_lock: boolean;
};

// Mirror of the migration seed (see supabase/migrations/202604242030_brand_hero_policy_v1.sql).
// All four moments enabled at the global default; both respect flags true.
// Both unit + pgTAP tests pin this contract to catch drift between code and
// DB seed at PR time.
export const STATIC_BRAND_HERO: BrandHeroPolicyValue = {
  version: 1,
  moments: {
    sign_in: {
      enabled: true,
      variant: "tinted_glass",
      show_biometric_pill: true,
      background_animation: "subtle_glow",
    },
    shift_start: {
      enabled: true,
      variant: "confetti_haptic",
      show_earnings_preview: true,
      haptic_pattern: "success",
      duration_ms: 2400,
    },
    shift_end: {
      enabled: true,
      variant: "summary_card",
      show_sparkline: true,
      show_thank_you: true,
      show_share_export: true,
    },
    error_recovery: {
      enabled: true,
      variant: "branded_boundary",
      show_offline_radar: true,
      preserve_last_state: true,
      show_retry_cta: true,
    },
  },
  respect_reduce_motion: true,
  respect_driving_lock: true,
};

// Safe fallback returned by resolveHeroMoment when the policy is missing the
// requested moment entirely. Marked enabled=false so consumers default to
// "no hero" rather than rendering with placeholder values. The variant is
// intentionally an empty string and all booleans are false so accidental
// usage of this object as a real moment is visibly broken (zero motion, no
// affordances) rather than silently wrong.
const SAFE_DISABLED_MOMENT: SignInMomentConfig = {
  enabled: false,
  variant: "",
  show_biometric_pill: false,
  background_animation: "",
};

// Helpers to clone the static seed (avoid sharing mutable references).
function cloneStaticSignIn(): SignInMomentConfig {
  return { ...STATIC_BRAND_HERO.moments.sign_in };
}

function cloneStaticShiftStart(): ShiftStartMomentConfig {
  return { ...STATIC_BRAND_HERO.moments.shift_start };
}

function cloneStaticShiftEnd(): ShiftEndMomentConfig {
  return { ...STATIC_BRAND_HERO.moments.shift_end };
}

function cloneStaticErrorRecovery(): ErrorRecoveryMomentConfig {
  return { ...STATIC_BRAND_HERO.moments.error_recovery };
}

function cloneStaticMoments(): BrandHeroMoments {
  return {
    sign_in: cloneStaticSignIn(),
    shift_start: cloneStaticShiftStart(),
    shift_end: cloneStaticShiftEnd(),
    error_recovery: cloneStaticErrorRecovery(),
  };
}

// Boolean coercion: accepts strict booleans only; non-boolean values fall
// through to the supplied fallback.
function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  return fallback;
}

// String coercion: accepts non-empty strings; non-strings / empty strings
// fall through to the supplied fallback.
function readStr(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

// Numeric coercion: accepts finite numbers; returns fallback otherwise.
function readInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

function normalizeSignIn(raw: unknown): SignInMomentConfig {
  if (!raw || typeof raw !== "object") return cloneStaticSignIn();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(obj.enabled, STATIC_BRAND_HERO.moments.sign_in.enabled),
    variant: readStr(obj.variant, STATIC_BRAND_HERO.moments.sign_in.variant),
    show_biometric_pill: readBool(
      obj.show_biometric_pill,
      STATIC_BRAND_HERO.moments.sign_in.show_biometric_pill,
    ),
    background_animation: readStr(
      obj.background_animation,
      STATIC_BRAND_HERO.moments.sign_in.background_animation,
    ),
  };
}

function normalizeShiftStart(raw: unknown): ShiftStartMomentConfig {
  if (!raw || typeof raw !== "object") return cloneStaticShiftStart();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(
      obj.enabled,
      STATIC_BRAND_HERO.moments.shift_start.enabled,
    ),
    variant: readStr(
      obj.variant,
      STATIC_BRAND_HERO.moments.shift_start.variant,
    ),
    show_earnings_preview: readBool(
      obj.show_earnings_preview,
      STATIC_BRAND_HERO.moments.shift_start.show_earnings_preview,
    ),
    haptic_pattern: readStr(
      obj.haptic_pattern,
      STATIC_BRAND_HERO.moments.shift_start.haptic_pattern,
    ),
    // Clamp to >= 0 so a malformed duration cannot run animations indefinitely
    // backwards. Upper bound mirrors the schema (30s).
    duration_ms: Math.max(
      0,
      Math.min(
        30_000,
        readInt(
          obj.duration_ms,
          STATIC_BRAND_HERO.moments.shift_start.duration_ms,
        ),
      ),
    ),
  };
}

function normalizeShiftEnd(raw: unknown): ShiftEndMomentConfig {
  if (!raw || typeof raw !== "object") return cloneStaticShiftEnd();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(obj.enabled, STATIC_BRAND_HERO.moments.shift_end.enabled),
    variant: readStr(obj.variant, STATIC_BRAND_HERO.moments.shift_end.variant),
    show_sparkline: readBool(
      obj.show_sparkline,
      STATIC_BRAND_HERO.moments.shift_end.show_sparkline,
    ),
    show_thank_you: readBool(
      obj.show_thank_you,
      STATIC_BRAND_HERO.moments.shift_end.show_thank_you,
    ),
    show_share_export: readBool(
      obj.show_share_export,
      STATIC_BRAND_HERO.moments.shift_end.show_share_export,
    ),
  };
}

function normalizeErrorRecovery(raw: unknown): ErrorRecoveryMomentConfig {
  if (!raw || typeof raw !== "object") return cloneStaticErrorRecovery();
  const obj = raw as Record<string, unknown>;
  return {
    enabled: readBool(
      obj.enabled,
      STATIC_BRAND_HERO.moments.error_recovery.enabled,
    ),
    variant: readStr(
      obj.variant,
      STATIC_BRAND_HERO.moments.error_recovery.variant,
    ),
    show_offline_radar: readBool(
      obj.show_offline_radar,
      STATIC_BRAND_HERO.moments.error_recovery.show_offline_radar,
    ),
    preserve_last_state: readBool(
      obj.preserve_last_state,
      STATIC_BRAND_HERO.moments.error_recovery.preserve_last_state,
    ),
    show_retry_cta: readBool(
      obj.show_retry_cta,
      STATIC_BRAND_HERO.moments.error_recovery.show_retry_cta,
    ),
  };
}

function normalizeMoments(raw: unknown): BrandHeroMoments {
  if (!raw || typeof raw !== "object") return cloneStaticMoments();
  const obj = raw as Record<string, unknown>;
  return {
    sign_in: normalizeSignIn(obj.sign_in),
    shift_start: normalizeShiftStart(obj.shift_start),
    shift_end: normalizeShiftEnd(obj.shift_end),
    error_recovery: normalizeErrorRecovery(obj.error_recovery),
  };
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// BrandHeroPolicyValue. Defensive: malformed sub-objects fall back to the
// STATIC seed so a bad row in production cannot brick the mobile shell.
export function normalizeBrandHeroPolicy(raw: unknown): BrandHeroPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_BRAND_HERO.version,
      moments: cloneStaticMoments(),
      respect_reduce_motion: STATIC_BRAND_HERO.respect_reduce_motion,
      respect_driving_lock: STATIC_BRAND_HERO.respect_driving_lock,
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_BRAND_HERO.version;
  return {
    version,
    moments: normalizeMoments(obj.moments),
    respect_reduce_motion: readBool(
      obj.respect_reduce_motion,
      STATIC_BRAND_HERO.respect_reduce_motion,
    ),
    respect_driving_lock: readBool(
      obj.respect_driving_lock,
      STATIC_BRAND_HERO.respect_driving_lock,
    ),
  };
}

// Look up a single moment's config from the policy. If the moment is missing
// from the policy entirely (e.g. a partially-normalized row), returns the
// SAFE_DISABLED_MOMENT default so the caller can treat it as "no hero" and
// move on. The returned object is a fresh shallow clone — caller mutation
// will not poison the policy.
export function resolveHeroMoment(
  policy: BrandHeroPolicyValue,
  moment: BrandHeroMoment,
): BrandHeroMomentConfig {
  const moments = policy.moments;
  if (!moments || typeof moments !== "object") {
    return { ...SAFE_DISABLED_MOMENT };
  }
  switch (moment) {
    case "sign_in":
      return moments.sign_in
        ? { ...moments.sign_in }
        : { ...SAFE_DISABLED_MOMENT };
    case "shift_start":
      return moments.shift_start
        ? { ...moments.shift_start }
        : { ...SAFE_DISABLED_MOMENT };
    case "shift_end":
      return moments.shift_end
        ? { ...moments.shift_end }
        : { ...SAFE_DISABLED_MOMENT };
    case "error_recovery":
      return moments.error_recovery
        ? { ...moments.error_recovery }
        : { ...SAFE_DISABLED_MOMENT };
    default:
      return { ...SAFE_DISABLED_MOMENT };
  }
}

// Options for shouldShowHeroMoment. Both flags default to false (i.e. a
// caller that doesn't know reduce-motion / driving-lock state assumes
// neither is active). This matches a fresh app boot where these signals
// haven't been wired up yet.
export type ShouldShowHeroMomentOptions = {
  reduceMotion?: boolean;
  drivingLockActive?: boolean;
};

// Returns true iff the requested hero moment should render right now.
//
// Rules (all must hold for `true`):
//   - moment.enabled === true
//   - AND not (options.reduceMotion === true && policy.respect_reduce_motion === true)
//   - AND not (options.drivingLockActive === true && policy.respect_driving_lock === true)
//
// Semantics: respect flags are advisory — if a tenant explicitly sets
// `respect_reduce_motion: false` they are saying "I want my hero moments to
// run even when the user has reduce-motion on" (rare, but supported for
// brand-critical surfaces). Same for driving-lock. Default policy enables
// both respect flags.
export function shouldShowHeroMoment(
  policy: BrandHeroPolicyValue,
  moment: BrandHeroMoment,
  options: ShouldShowHeroMomentOptions = {},
): boolean {
  const config = resolveHeroMoment(policy, moment);
  if (!config.enabled) return false;
  if (options.reduceMotion === true && policy.respect_reduce_motion === true) {
    return false;
  }
  if (
    options.drivingLockActive === true &&
    policy.respect_driving_lock === true
  ) {
    return false;
  }
  return true;
}
