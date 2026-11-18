import * as React from "react";
import { Animated, Easing, Text, View } from "react-native";

import { useTheme } from "../mobile-theme-context";
import {
  resolveMotionDuration,
  STATIC_MOTION_TOKEN,
} from "../motion-token-policy";

import type {
  BrandCelebrationMoment,
  BrandCelebrationProps,
} from "./BrandCelebration.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { BrandCelebration, type BrandCelebrationProps } from
// ".../BrandCelebration"` without remembering the sibling `.types` file.
// The canonical declaration still lives in `BrandCelebration.types.ts` so
// non-rendering consumers do not pull JSX.
export type {
  BrandCelebrationMoment,
  BrandCelebrationProps,
} from "./BrandCelebration.types";

/**
 * Default surface edge length in dp. Picked to match the sign-in hero glass
 * tile so a future cross-screen ceremony can compose without retuning.
 */
const DEFAULT_SIZE = 200 as const;

/**
 * Inner brand-mark size as a fraction of the outer surface. 0.4 keeps the
 * mark visually centered without crowding the ring boundary at any size.
 */
const MARK_SIZE_RATIO = 0.4 as const;

/**
 * Inner glyph font size as a fraction of the outer surface. 0.2 keeps the
 * glyph (checkmark or center dot) readable at the smallest expected size
 * (~120 dp) while staying proportional at hero size (~320 dp).
 */
const GLYPH_SIZE_RATIO = 0.2 as const;

/**
 * Ring opacity at full reveal. The ring is intentionally translucent so it
 * reads as a glow halo behind the solid brand mark — using a fraction here
 * (instead of an alpha-suffixed hex literal) keeps the rendered surface
 * tokens-only: the ring `backgroundColor` resolves to `tokens.color.accent`
 * (or successor accent token) and the alpha layering is handled by RN's
 * native opacity compositing rather than an inline hex `+ "20"` mutation.
 */
const RING_TARGET_OPACITY = 0.2 as const;

/**
 * Mark / glyph opacity at full reveal. 1.0 (solid) so the brand mark stays
 * legible against any page background once the entry animation completes.
 */
const MARK_TARGET_OPACITY = 1 as const;

/**
 * Mark fade duration ratio: the mark fades in over 60% of the total hero
 * duration so the ring expand finishes a beat after the mark settles —
 * matches the standard "ease-out-quint" feel without a sequenced timeline.
 */
const MARK_FADE_RATIO = 0.6 as const;

/**
 * "Ease-out-quint" Bezier curve. Mirrors the most-common brand-ceremony
 * easing across modern OS UI kits (Material 3 Expressive, Apple HIG 2025).
 * Not stored on the motion-token-policy because callers should treat it as
 * a presentation detail of the BrandCelebration primitive — if a future
 * tenant needs a different curve, the policy adds it as a new easing key.
 */
const EASE_OUT_QUINT = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * Resolve the per-moment accent token. Each moment maps to a different
 * semantic palette entry so the rendered hero reads with the appropriate
 * emotional tone:
 *
 *   - shift_start    → accent (welcoming brand teal)
 *   - shift_end      → success (celebratory green)
 *   - sign_in        → accent (welcoming brand teal)
 *   - error_recovery → warning (apologetic amber)
 *
 * Token-only by construction — every branch reads through `tokens.color.*`
 * so light and dark palette swaps propagate automatically.
 */
export function resolveCelebrationAccent(
  tokens: { color: { accent: string; success: string; warning: string } },
  moment: BrandCelebrationMoment,
): string {
  if (moment === "shift_end") return tokens.color.success;
  if (moment === "error_recovery") return tokens.color.warning;
  // sign_in + shift_start both share the welcoming accent tone.
  return tokens.color.accent;
}

/**
 * Resolve the per-moment soft-accent token (used as the ring fill so the
 * ring tone stays paired with the solid mark). When `accentSoft` is missing
 * from the supplied palette (defensive: callers in unit-test environments
 * may pass a partial token bag), the function falls back to the solid
 * accent — the ring opacity is then composited by `RING_TARGET_OPACITY`
 * so the visual outcome is still a soft halo.
 */
export function resolveCelebrationSoftAccent(
  tokens: {
    color: {
      accent: string;
      success: string;
      warning: string;
      accentSoft?: string;
      successSoft?: string;
      warningSoft?: string;
    };
  },
  moment: BrandCelebrationMoment,
): string {
  if (moment === "shift_end") {
    return tokens.color.successSoft ?? tokens.color.success;
  }
  if (moment === "error_recovery") {
    return tokens.color.warningSoft ?? tokens.color.warning;
  }
  // sign_in + shift_start both share the welcoming accent-soft tone.
  return tokens.color.accentSoft ?? tokens.color.accent;
}

/**
 * Resolve the per-moment inner glyph. shift_end uses a checkmark to read as
 * "task complete"; the other moments render a centered dot which keeps the
 * surface symmetric without implying a specific outcome.
 */
export function resolveCelebrationGlyph(
  moment: BrandCelebrationMoment,
): string {
  if (moment === "shift_end") return "\u2713"; // ✓ heavy check mark
  return "\u2022"; // • bullet dot
}

/**
 * BrandCelebration — the canonical brand-hero animation primitive. See
 * module header for invariants.
 */
export function BrandCelebration(
  props: BrandCelebrationProps,
): React.JSX.Element {
  const {
    moment,
    size = DEFAULT_SIZE,
    testID = "brand-celebration",
    onAnimationComplete,
    reduceMotion = false,
  } = props;

  const { tokens } = useTheme();

  // Token-driven accent + a11y label resolved up front so subsequent
  // render branches share the same wiring.
  const accent = resolveCelebrationAccent(tokens, moment);
  const accessibilityLabel = `Brand celebration: ${moment}`;

  // Animated values for the entry animation. Both start at 0 (invisible)
  // and animate to their final state (scale=1, opacity=1) on mount and on
  // moment change. We use refs so re-renders triggered by state higher up
  // do not reset the animation timeline.
  const scale = React.useRef(new Animated.Value(0)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;
  const ringOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (reduceMotion) {
      // Reduce-motion path: snap to the final hero state with no animation
      // and fire the completion callback synchronously. Matches the
      // row-driven motion-token-policy's `reduce_motion_strategy`
      // contract — callers pipe the OS preference through `reduceMotion`
      // and the component cooperates without subscribing to OS state.
      scale.setValue(1);
      opacity.setValue(MARK_TARGET_OPACITY);
      ringOpacity.setValue(RING_TARGET_OPACITY);
      if (typeof onAnimationComplete === "function") {
        onAnimationComplete();
      }
      return;
    }

    // Reset animation values whenever the moment changes so a re-render
    // with a new moment restarts the entry animation from zero (rather
    // than appearing fully formed because the refs still hold the prior
    // moment's final state).
    scale.setValue(0);
    opacity.setValue(0);
    ringOpacity.setValue(0);

    const heroDuration = resolveMotionDuration(
      STATIC_MOTION_TOKEN,
      "hero",
    );
    const markFadeDuration = Math.max(
      0,
      Math.floor(heroDuration * MARK_FADE_RATIO),
    );

    let cancelled = false;
    let animation: ReturnType<typeof Animated.parallel> | null = null;

    try {
      animation = Animated.parallel([
        Animated.timing(scale, {
          toValue: 1,
          duration: heroDuration,
          easing: EASE_OUT_QUINT,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: MARK_TARGET_OPACITY,
          duration: markFadeDuration,
          easing: EASE_OUT_QUINT,
          useNativeDriver: true,
        }),
        Animated.timing(ringOpacity, {
          toValue: RING_TARGET_OPACITY,
          duration: heroDuration,
          easing: EASE_OUT_QUINT,
          useNativeDriver: true,
        }),
      ]);
      animation.start((result) => {
        if (cancelled) return;
        // Animated.timing fires its callback with `{ finished: boolean }`
        // — we only invoke the user callback when the animation actually
        // completed (vs being interrupted by a moment change while the
        // first run was still in flight).
        const finished = result && (result as { finished?: boolean }).finished;
        if (finished && typeof onAnimationComplete === "function") {
          onAnimationComplete();
        }
      });
    } catch {
      // Defensive: in unit-test environments where `Animated.timing` is
      // a no-op stub, the start call may throw. We swallow so the static
      // visual state still renders and tests can assert layout without
      // wiring the full RN animation backing.
      if (!cancelled && typeof onAnimationComplete === "function") {
        onAnimationComplete();
      }
    }

    return () => {
      cancelled = true;
      if (animation && typeof animation.stop === "function") {
        try {
          animation.stop();
        } catch {
          // noop — same defensive rationale as above.
        }
      }
    };
    // We intentionally depend on `moment` + `reduceMotion` so a moment
    // change restarts the animation. The Animated.Value refs are stable
    // (created once with `useRef`) and are listed for ESLint completeness.
  }, [moment, reduceMotion, scale, opacity, ringOpacity, onAnimationComplete]);

  // Token-driven inner sizing. Computed inline (not memoised) because the
  // multiplications are trivial and React.memo on the surrounding component
  // would force the caller to remember to wrap the props in useMemo to
  // benefit — preferring zero hidden caching contracts. `accent` and
  // `accessibilityLabel` are resolved earlier so the render below uses the
  // same token + a11y wiring.
  const ringFill = resolveCelebrationSoftAccent(tokens, moment);
  const glyph = resolveCelebrationGlyph(moment);
  const markSize = size * MARK_SIZE_RATIO;
  const glyphSize = size * GLYPH_SIZE_RATIO;

  return (
    <View
      testID={testID}
      accessible={true}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/*
        Outer ring: full surface, soft accent fill, animated scale + opacity.
        Acts as the "halo" behind the solid brand mark. Background reads
        through `resolveCelebrationSoftAccent` so the ring tone stays paired
        with the solid mark while remaining tokens-only. The opacity caps at
        `RING_TARGET_OPACITY` (0.2) so the halo reads as a subtle glow
        rather than a solid disc.
      */}
      <Animated.View
        testID={`${testID}-ring`}
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: ringFill,
          opacity: ringOpacity,
          transform: [{ scale }],
        }}
      />
      {/*
        Solid brand mark: 40% of the outer surface, full accent fill,
        animated scale + opacity. The inner glyph (checkmark or dot) reads
        on `tokens.color.controlText` so it stays legible against any
        accent tone (light and dark palettes all maintain AA
        contrast between the controlText and the accent surface family).
      */}
      <Animated.View
        testID={`${testID}-mark`}
        style={{
          width: markSize,
          height: markSize,
          borderRadius: markSize / 2,
          backgroundColor: accent,
          alignItems: "center",
          justifyContent: "center",
          opacity: opacity,
          transform: [{ scale }],
        }}
      >
        <Text
          testID={`${testID}-glyph`}
          style={{
            color: tokens.color.controlText,
            fontSize: glyphSize,
            fontWeight: "700",
            lineHeight: glyphSize + 4,
            textAlign: "center",
          }}
        >
          {glyph}
        </Text>
      </Animated.View>
    </View>
  );
}
