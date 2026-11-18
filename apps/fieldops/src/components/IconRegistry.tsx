import * as React from "react";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";

import { useTheme } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";
import { useIsRTL } from "../mobile-shell-rtl";
import {
  ICON_GLYPH,
  ICON_MIRRORS_RTL,
  ICON_SIZE_PX,
  type IconName,
  type IconSize,
  type IconTone,
} from "./IconRegistry.types";

export type { IconName, IconSize, IconTone } from "./IconRegistry.types";
export {
  ICON_GLYPH,
  ICON_MIRRORS_RTL,
  ICON_NAMES,
  ICON_SIZE_PX,
  ICON_SIZES,
  ICON_TONES,
} from "./IconRegistry.types";

/**
 * Resolve a tone alias to a palette foreground color. Centralised here so
 * the mapping table stays adjacent to the React component (the only file
 * that imports `useTheme()` for color lookup).
 *
 * Tone names are stable design vocabulary; the underlying palette key
 * each one resolves to may shift as the theme evolves (for example
 * `default` could move from `text` to a dedicated `iconFg` token without
 * a breaking change for callers).
 */
function resolveToneColor(tone: IconTone, tokens: ThemeTokens): string {
  switch (tone) {
    case "default":
      return tokens.color.text;
    case "muted":
      return tokens.color.textMuted;
    case "accent":
      return tokens.color.accent;
    case "success":
      return tokens.color.success;
    case "warning":
      return tokens.color.warning;
    case "danger":
      return tokens.color.danger;
    case "info":
      return tokens.color.info;
    case "inverse":
      return tokens.color.control;
    default: {
      // Exhaustive switch guard: if a new IconTone is added, TypeScript
      // will fail to narrow `_exhaustive` to `never` and surface the
      // missing case at compile time. Defensive runtime fallback returns
      // the default text color so production cannot crash on an unknown
      // alias.
      const _exhaustive: never = tone;
      void _exhaustive;
      return tokens.color.text;
    }
  }
}

export type IconProps = {
  /** Icon alias from the curated set in `IconName`. */
  name: IconName;
  /**
   * Size ramp step. Defaults to `md` (20px) which aligns visually with
   * body-sized text in the active typography scale.
   */
  size?: IconSize;
  /**
   * Tone alias resolved against the active theme palette. Defaults to
   * `default` (primary surface text color).
   */
  tone?: IconTone;
  /**
   * Optional override color. When provided, takes precedence over the
   * tone-resolved color. Use sparingly -- token-driven tones are the
   * preferred path for dark-mode safety.
   */
  color?: string;
  /**
   * Optional accessibility label. When omitted, the icon renders as
   * decorative (`accessibilityElementsHidden`) so screen readers do not
   * announce the bare glyph.
   */
  accessibilityLabel?: string;
  /** Test selector for unit / E2E tests. */
  testID?: string;
  /**
   * Optional style override. Merged after the size + color computation
   * so callers can adjust margin / lineHeight without re-implementing
   * the resolver.
   */
  style?: StyleProp<TextStyle>;
};

/**
 * Renders a curated icon glyph as a `<Text>` node.
 *
 * Accessibility:
 *   - When `accessibilityLabel` is omitted the glyph is hidden from
 *     assistive tech (decorative usage). Callers presenting the icon as
 *     the sole affordance for an action MUST pass an explicit label.
 *   - The rendered `<Text>` is not focusable on its own; wrap in a
 *     `<Pressable>` for tap targets.
 */
export function Icon(props: IconProps): React.JSX.Element {
  const { name, size = "md", tone = "default", color, accessibilityLabel, testID, style } = props;
  const { tokens } = useTheme();
  // Mirror direction-bearing icons in RTL while leaving nondirectional glyphs unchanged.
  const isRTL = useIsRTL();
  const shouldMirrorRtl = isRTL && ICON_MIRRORS_RTL.has(name);
  const fontSize = ICON_SIZE_PX[size];
  const resolvedColor = typeof color === "string" && color.length > 0
    ? color
    : resolveToneColor(tone, tokens);
  const glyph = ICON_GLYPH[name];
  const isDecorative = typeof accessibilityLabel !== "string"
    || accessibilityLabel.length === 0;

  // Compose the inline style. Keep `lineHeight === fontSize` so the glyph
  // box is square and tab-bar / drawer layouts can rely on a predictable
  // bounding box. `textAlign: "center"` gives the same visual centering
  // SVG icons would offer when nested inside a Pressable hit area.
  // The optional `transform: [{ scaleX: -1 }]` flips direction-bearing
  // glyphs horizontally for RTL layouts; it is omitted entirely (not set
  // to identity) for the LTR / non-mirrored path so style snapshots stay
  // stable for callers that diff transform arrays.
  const computedStyle: TextStyle = {
    fontSize,
    lineHeight: fontSize,
    color: resolvedColor,
    textAlign: "center",
    // includeFontPadding is Android-only; explicit `false` removes the
    // extra glyph metric padding that otherwise misaligns icons relative
    // to adjacent labels. RN-Web ignores the prop without warning.
    includeFontPadding: false as unknown as TextStyle["includeFontPadding"],
    ...(shouldMirrorRtl ? { transform: [{ scaleX: -1 }] } : {}),
  };

  return (
    <Text
      testID={testID}
      accessible={!isDecorative}
      accessibilityRole={isDecorative ? "none" : "image"}
      accessibilityLabel={isDecorative ? undefined : accessibilityLabel}
      accessibilityElementsHidden={isDecorative}
      importantForAccessibility={isDecorative ? "no-hide-descendants" : "yes"}
      allowFontScaling={false}
      maxFontSizeMultiplier={1}
      style={[styles.glyph, computedStyle, style]}
    >
      {glyph}
    </Text>
  );
}

// Module-scope stylesheet keeps the static defaults referenced by every
// render (no per-render allocations). `selectable: false` mirrors the
// SVG-icon expectation that glyphs are not text-selectable on web.
const styles = StyleSheet.create({
  glyph: {
    // Disable text selection on RN-Web so icons behave like images.
    // RN-native ignores the prop without warning.
    ...(({ userSelect: "none" } as unknown) as TextStyle),
  },
});

export default Icon;
