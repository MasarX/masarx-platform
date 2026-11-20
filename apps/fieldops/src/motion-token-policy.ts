// Resolve application motion from motion_token_policy.
//
// Contract: the resolver `public.resolve_motion_token_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     duration: { instant: 0, micro: 120, short: 200, medium: 320, long: 480, hero: 640 },
//     easing: {
//       linear:     "linear",
//       standard:   "cubic-bezier(0.2,0,0,1)",
//       decelerate: "cubic-bezier(0,0,0,1)",
//       accelerate: "cubic-bezier(0.3,0,1,1)",
//       emphasis:   "cubic-bezier(0.2,0,0,1)",
//       expressive: "cubic-bezier(0.34,1.56,0.64,1)"
//     },
//     reduce_motion_strategy: "disable_loops" | "respect" | "ignore"
//   }
//
// This module:
//  1. Defines the typed shape (MotionTokenPolicyValue)
//  2. Normalizes the JSONB into a strict-typed object (defensive parse)
//  3. Provides the pure resolvers `resolveMotionDuration` and
//     `resolveMotionEasing` that consumers (Skeleton opacity loop, screen
//     transitions, micro-interactions, …) call instead of inlining literal
//     ms / cubic-bezier values.
//  4. Ships a STATIC fallback that mirrors the global default seed, so
//     consumers stay legible while the network query is in flight or offline.
//
//
// behavior must read through resolver functions, not hardcoded code-side maps.
// Callers apply the configured durations and easing to the relevant animations.

export type MotionDurationKey =
  | "instant"
  | "micro"
  | "short"
  | "medium"
  | "long"
  | "hero";

export type MotionEasingKey =
  | "linear"
  | "standard"
  | "decelerate"
  | "accelerate"
  | "emphasis"
  | "expressive";

export type ReduceMotionStrategy = "disable_loops" | "respect" | "ignore";

export type MotionTokenPolicyValue = {
  version: number;
  duration: Record<MotionDurationKey, number>;
  easing: Record<MotionEasingKey, string>;
  reduce_motion_strategy: ReduceMotionStrategy;
};

const DURATION_KEYS: ReadonlyArray<MotionDurationKey> = [
  "instant",
  "micro",
  "short",
  "medium",
  "long",
  "hero",
];

const EASING_KEYS: ReadonlyArray<MotionEasingKey> = [
  "linear",
  "standard",
  "decelerate",
  "accelerate",
  "emphasis",
  "expressive",
];

const VALID_REDUCE_STRATEGIES: ReadonlySet<ReduceMotionStrategy> = new Set([
  "disable_loops",
  "respect",
  "ignore",
]);

// Loop-relevant duration keys: when reduce_motion_strategy="disable_loops"
// AND the OS reports prefersReducedMotion=true, durations resolved by these
// keys collapse to 0 ms. This is the lever the Skeleton opacity pulse, any
// breathing/heartbeat indicators, and other repeating animations key off so
// users with reduced-motion preference do not see a continuous loop.
//
// One-shot durations (short/medium/long/hero) remain intact even under
// disable_loops because they represent transient transitions a user expects
// to see for affordance/feedback (e.g. screen push, dialog enter), not
// continuous motion.
const LOOP_RELEVANT_DURATION_KEYS: ReadonlySet<MotionDurationKey> = new Set([
  "instant",
  "micro",
]);

function coerceReduceMotionStrategy(
  input: unknown,
  fallback: ReduceMotionStrategy,
): ReduceMotionStrategy {
  if (typeof input !== "string") return fallback;
  return VALID_REDUCE_STRATEGIES.has(input as ReduceMotionStrategy)
    ? (input as ReduceMotionStrategy)
    : fallback;
}

function coerceDurationMs(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  // Clamp to non-negative; durations cannot run backwards.
  return input < 0 ? 0 : input;
}

function coerceEasingString(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  return input;
}

// Mirror of the migration seed (see supabase/migrations/202604241800_motion_token_policy_v1.sql).
// Kept in sync intentionally: when offline / pre-fetch, motion timing should
// match the global default the server would have returned.
export const STATIC_MOTION_TOKEN: MotionTokenPolicyValue = {
  version: 1,
  duration: {
    instant: 0,
    micro: 120,
    short: 200,
    medium: 320,
    long: 480,
    hero: 640,
  },
  easing: {
    linear: "linear",
    standard: "cubic-bezier(0.2,0,0,1)",
    decelerate: "cubic-bezier(0,0,0,1)",
    accelerate: "cubic-bezier(0.3,0,1,1)",
    emphasis: "cubic-bezier(0.2,0,0,1)",
    expressive: "cubic-bezier(0.34,1.56,0.64,1)",
  },
  reduce_motion_strategy: "disable_loops",
};

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// MotionTokenPolicyValue. Defensive: any malformed/missing key falls back to
// the static seed value for that slot so a partial row in production cannot
// blank out motion tokens.
export function normalizeMotionTokenPolicy(
  raw: unknown,
): MotionTokenPolicyValue {
  if (!raw || typeof raw !== "object") return STATIC_MOTION_TOKEN;
  const obj = raw as Record<string, unknown>;

  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? versionRaw
      : 1;

  const rawDuration =
    obj.duration && typeof obj.duration === "object"
      ? (obj.duration as Record<string, unknown>)
      : {};
  const duration = {} as Record<MotionDurationKey, number>;
  for (const key of DURATION_KEYS) {
    duration[key] = coerceDurationMs(
      rawDuration[key],
      STATIC_MOTION_TOKEN.duration[key],
    );
  }

  const rawEasing =
    obj.easing && typeof obj.easing === "object"
      ? (obj.easing as Record<string, unknown>)
      : {};
  const easing = {} as Record<MotionEasingKey, string>;
  for (const key of EASING_KEYS) {
    easing[key] = coerceEasingString(
      rawEasing[key],
      STATIC_MOTION_TOKEN.easing[key],
    );
  }

  const reduce_motion_strategy = coerceReduceMotionStrategy(
    obj.reduce_motion_strategy,
    STATIC_MOTION_TOKEN.reduce_motion_strategy,
  );

  return { version, duration, easing, reduce_motion_strategy };
}

// Pure resolver: resolve a duration in milliseconds for a named bucket.
//
// Reduce-motion handling:
//   - When `prefersReducedMotion` is true AND
//     `policy.reduce_motion_strategy === "disable_loops"` AND
//     `key` is loop-relevant (instant / micro), returns 0.
//   - When `policy.reduce_motion_strategy === "ignore"`, the OS preference
//     is intentionally ignored (test harness use only).
//   - Otherwise (`"respect"`, or non-loop keys, or no reduced-motion
//     preference), returns the policy's configured duration.
//
// Unknown keys fall back to the policy's `short` duration so unexpected
// callers still produce a reasonable value rather than NaN/undefined.
export function resolveMotionDuration(
  policy: MotionTokenPolicyValue,
  key: MotionDurationKey,
  prefersReducedMotion: boolean = false,
): number {
  const isKnownKey = (DURATION_KEYS as ReadonlyArray<string>).includes(key);
  const effectiveKey: MotionDurationKey = isKnownKey ? key : "short";

  if (
    prefersReducedMotion &&
    policy.reduce_motion_strategy === "disable_loops" &&
    LOOP_RELEVANT_DURATION_KEYS.has(effectiveKey)
  ) {
    return 0;
  }

  return policy.duration[effectiveKey];
}

// Pure resolver: resolve a named easing curve string. Unknown keys fall back
// to "standard" so callers always get a usable curve.
export function resolveMotionEasing(
  policy: MotionTokenPolicyValue,
  key: MotionEasingKey,
): string {
  const isKnownKey = (EASING_KEYS as ReadonlyArray<string>).includes(key);
  const effectiveKey: MotionEasingKey = isKnownKey ? key : "standard";
  return policy.easing[effectiveKey];
}
