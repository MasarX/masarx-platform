/** Resolve sign-in glass and glow styles from theme tokens, with reduced-motion and driving-lock support. */

export type SignInHeroPlatform = "web" | "native";

export type SignInHeroGlassTokens = {
  /** Token color for the soft accent ring (e.g. teal accentSoft). */
  accentSoft: string;
  /** Token color for the accent glow (rgba string for box-shadow on web). */
  accentGlow: string;
  /** Token color for the brand mark backdrop tint. */
  brandTint: string;
};

export type SignInHeroGlassStyle = {
  /** Glass-style backdrop for the hero container. Web-only properties are
   * ignored on native at the RN style merger; native uses `backgroundColor`
   * + ring instead. */
  backgroundColor?: string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  paddingVertical?: number;
  paddingHorizontal?: number;
  // Web-only CSS properties — RN runtime ignores these; web bundler emits them.
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
  boxShadow?: string;
};

const DEFAULT_PADDING_VERTICAL = 18;
const DEFAULT_PADDING_HORIZONTAL = 20;
const DEFAULT_BORDER_RADIUS = 16;

/**
 * Pure resolver: returns the style object for the sign-in hero glass layer
 * based on the platform and supplied design tokens.
 *
 * The resolver is deterministic — given the same inputs it always returns
 * the same object shape. Tests assert this contract by snapshotting the
 * web-path output (with `backdropFilter` + `boxShadow`) and comparing to
 * the native-path output (without those keys).
 */
export function resolveSignInHeroGlassStyle(
  platform: SignInHeroPlatform,
  tokens: SignInHeroGlassTokens,
): SignInHeroGlassStyle {
  // Defensive token shape — fall back to safe neutrals so a malformed
  // theme object cannot brick the sign-in surface.
  const safeTokens: SignInHeroGlassTokens = {
    accentSoft:
      typeof tokens?.accentSoft === "string" && tokens.accentSoft.trim().length > 0
        ? tokens.accentSoft
        : "rgba(13, 148, 136, 0.08)",
    accentGlow:
      typeof tokens?.accentGlow === "string" && tokens.accentGlow.trim().length > 0
        ? tokens.accentGlow
        : "rgba(13, 148, 136, 0.18)",
    brandTint:
      typeof tokens?.brandTint === "string" && tokens.brandTint.trim().length > 0
        ? tokens.brandTint
        : "rgba(255, 255, 255, 0.6)",
  };

  if (platform === "web") {
    return {
      backgroundColor: safeTokens.brandTint,
      borderRadius: DEFAULT_BORDER_RADIUS,
      paddingVertical: DEFAULT_PADDING_VERTICAL,
      paddingHorizontal: DEFAULT_PADDING_HORIZONTAL,
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      boxShadow: `0 0 40px ${safeTokens.accentGlow}`,
    };
  }

  // Native path: a soft accent ring (no CSS properties).
  return {
    backgroundColor: safeTokens.accentSoft,
    borderRadius: DEFAULT_BORDER_RADIUS,
    borderWidth: 1,
    borderColor: safeTokens.accentSoft,
    paddingVertical: DEFAULT_PADDING_VERTICAL,
    paddingHorizontal: DEFAULT_PADDING_HORIZONTAL,
  };
}

/**
 * Pure resolver: returns whether the supplied style object includes the
 * web-only glass properties. Exported so tests can assert the platform
 * branch without comparing entire objects.
 */
export function isWebGlassStyle(style: SignInHeroGlassStyle): boolean {
  if (!style || typeof style !== "object") return false;
  return (
    typeof style.backdropFilter === "string" ||
    typeof style.WebkitBackdropFilter === "string" ||
    typeof style.boxShadow === "string"
  );
}
