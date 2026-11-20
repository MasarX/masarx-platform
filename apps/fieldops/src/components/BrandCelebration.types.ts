/** The celebration props cover shift start and shift end, with explicit support for reduced motion. */

/**
 * Discriminator for the four canonical brand-hero moments. Mirrors the
 * `BrandHeroMoment` union exported by `brand-hero-policy.ts` so the policy
 * resolver and the rendering component share the exact same moment names.
 *
 * Each moment maps to a different inner composition + accent token:
 *
 *   - "shift_start"     → slow ring expand + brand mark fade-in (welcoming;
 *                         uses tokens.color.accent)
 *   - "shift_end"       → checkmark scale-bounce + brand mark fade-in
 *                         (celebratory; uses tokens.color.success)
 *   - "sign_in"         → soft glow pulse (already partially handled by
 *                         the sign-in hero glass tile; this is the
 *                         activation animation; uses tokens.color.accent)
 *   - "error_recovery"  → gentle slide-up (apologetic, recovers from
 *                         error state; uses tokens.color.warning)
 */
export type BrandCelebrationMoment =
  | "shift_start"
  | "shift_end"
  | "sign_in"
  | "error_recovery";

/**
 * Public prop surface for the BrandCelebration primitive.
 *
 * Notes for callers:
 *  - `moment` selects which of the four canonical compositions renders.
 *    Re-rendering with a different moment value restarts the animation.
 *  - `size` defaults to 200 (density-independent pixels). The component
 *    paints a square hero region of `size` × `size` and lays the inner
 *    ring + glyph proportionally so callers can scale the surface up/down
 *    (e.g. 120 for a chip-sized celebration; 320 for a hero overlay)
 *    without retuning ratios.
 *  - `testID` defaults to `brand-celebration`. Nested nodes derive their
 *    own testIDs by suffixing (`brand-celebration-ring`,
 *    `brand-celebration-mark`, `brand-celebration-glyph`).
 *  - `onAnimationComplete` fires after the entry animation finishes.
 *    When `reduceMotion` is true the callback is invoked synchronously
 *    inside the mount effect (no animation runs).
 *  - `reduceMotion` honors the OS reduce-motion preference. When `true`
 *    the component renders the final hero shape immediately with no
 *    motion (scale=1, opacity=1) and fires `onAnimationComplete`
 *    synchronously. Callers should pipe this through from the row-driven
 *    motion-token-policy resolver or the OS accessibility flag — the
 *    component does NOT subscribe to OS state itself so it stays a pure
 *    presentational primitive.
 */
export type BrandCelebrationProps = {
  /** Which canonical brand-hero moment to render. */
  moment: BrandCelebrationMoment;
  /** Square edge length in dp. Defaults to 200. */
  size?: number;
  /** Override the default `brand-celebration` testID. Suffixed for nested nodes. */
  testID?: string;
  /** Invoked after the entry animation completes (or synchronously when `reduceMotion=true`). */
  onAnimationComplete?: () => void;
  /** When true, render the static final state with no animation. Defaults to false. */
  reduceMotion?: boolean;
};
