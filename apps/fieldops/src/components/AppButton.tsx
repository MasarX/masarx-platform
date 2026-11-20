import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import type {
  AppButtonProps,
  AppButtonSize,
  AppButtonVariant,
} from "./AppButton.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { AppButton, type AppButtonProps } from ".../AppButton"` without
// remembering the sibling `.types` file. The canonical declaration still
// lives in `AppButton.types.ts` so non-rendering consumers do not pull JSX.
export type {
  AppButtonProps,
  AppButtonSize,
  AppButtonVariant,
} from "./AppButton.types";

// Keep the touch target at least 44 density-independent pixels.
const MIN_TOUCH_TARGET = 44 as const;

/**
 * Per-variant tone palette resolved from the active theme tokens.
 *
 *  - primary     → solid accent fill with its paired label color
 *  - secondary   → cardBg fill with accent border + accent label
 *  - ghost       → transparent fill, accent label (text-only inline action)
 *  - destructive → solid danger fill with control-tinted label
 *                  CONFIRM PATTERN: callers should pair this variant with a
 *                  Confirm dialog or a swipe-to-confirm gesture so a single
 *                  accidental tap cannot perform a destructive action. The
 *                  AppButton itself is intentionally not in the business of
 *                  running confirm dialogs (that policy lives in the
 *                  ux_safety_policy ladder); this comment exists so future
 *                  migration sweeps wire confirm flows correctly.
 *  - swipe-cta   → solid successFg fill for swipe-to-confirm actions.
 */
type VariantPalette = {
  background: string;
  foreground: string;
  border: string;
  /**
   * Border thickness for outlined variants (secondary). 0 for filled
   * variants so we get a clean fill without an extra hairline.
   */
  borderWidth: number;
};

function buildVariantPalette(
  tokens: ThemeTokens,
): Record<AppButtonVariant, VariantPalette> {
  return {
    primary: {
      background: tokens.color.accent,
      foreground: tokens.color.accentText,
      border: tokens.color.accent,
      borderWidth: 0,
    },
    secondary: {
      background: tokens.color.cardBg,
      foreground: tokens.color.accent,
      border: tokens.color.accent,
      borderWidth: 1,
    },
    ghost: {
      background: "transparent",
      foreground: tokens.color.accent,
      border: "transparent",
      borderWidth: 0,
    },
    destructive: {
      background: tokens.color.danger,
      foreground: tokens.color.control,
      border: tokens.color.danger,
      borderWidth: 0,
    },
    "swipe-cta": {
      background: tokens.color.successFg,
      foreground: tokens.color.control,
      border: tokens.color.successFg,
      borderWidth: 0,
    },
  };
}

/**
 * Per-size dimensional preset. Heights honor the WCAG 2.5.5 floor — `md`
 * sits exactly at the policy minimum, `lg` exceeds it, and `sm` is clamped
 * up to the floor by the component (see `MIN_TOUCH_TARGET` usage below).
 *
 * Padding/font-size mappings follow the established token ramp:
 *   sm → padding=spacing.md (12), font=scale.sm  (12)
 *   md → padding=spacing.lg (16), font=scale.lg  (16)
 *   lg → padding=spacing.xl (24)/2-aligned (20), font=scale.xl (17)
 *
 * Note: sized padding values intentionally use the canonical spacing ramp
 * (no hardcoded 12/16/20) so dark-mode/density theme experiments can
 * adjust them in one place without touching this file.
 */
type SizePreset = {
  height: number;
  paddingHorizontal: number;
  fontSize: number;
};

function buildSizePreset(tokens: ThemeTokens): Record<AppButtonSize, SizePreset> {
  return {
    sm: {
      height: 36,
      paddingHorizontal: tokens.spacing.md,
      fontSize: tokens.font.scale.sm,
    },
    md: {
      // 44dp — sits exactly at the WCAG 2.5.5 floor. Most callers want this.
      height: MIN_TOUCH_TARGET,
      paddingHorizontal: tokens.spacing.lg,
      fontSize: tokens.font.scale.lg,
    },
    lg: {
      height: 52,
      paddingHorizontal: tokens.spacing.xl,
      fontSize: tokens.font.scale.xl,
    },
  };
}

/**
 * Stylesheet factory — invoked through `useThemedStyles` so styles refresh
 * whenever the active tokens change (theme mode swap, density swap, etc.).
 * Keeps the component body focused on layout and lets the theme system
 * stay the single source of truth for visual values.
 */
export function buildAppButtonStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: tokens.radius.md,
      borderStyle: "solid",
      // Gap between icon(s) and label. Using `gap` keeps the layout tidy
      // even when only one icon is supplied (no extra margin offsets to
      // reason about per slot).
      gap: tokens.spacing.sm,
    },
    pressed: {
      opacity: 0.85,
    },
    disabled: {
      opacity: 0.5,
    },
    label: {
      fontWeight: "600",
      letterSpacing: 0.2,
      fontFamily: tokens.font.sans,
      // textAlign for the multi-line edge case so a wrapped label stays
      // centered under the row even though we always expect single-line.
      textAlign: "center",
    },
    loadingDot: {
      // Width/height ties to font.scale.md so the dot scales naturally with
      // the label font. Padding stays consistent because we replace the
      // label inline (preserving the parent row's measured height).
      width: tokens.font.scale.md / 2,
      height: tokens.font.scale.md / 2,
      borderRadius: tokens.font.scale.md,
    },
    iconSlot: {
      // Slot wrapper exists so the gap rule above always sees a sibling
      // (an empty fragment would not get gapped).
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

/**
 * AppButton — the canonical primitive. See module header for invariants.
 */
export function AppButton(props: AppButtonProps): React.JSX.Element {
  const {
    label,
    variant = "primary",
    size = "md",
    onPress,
    disabled = false,
    loading = false,
    leftIcon,
    rightIcon,
    testID = "app-button",
    accessibilityLabel,
    fullWidth = false,
  } = props;

  const styles = useThemedStyles(buildAppButtonStyles);
  const variantPalettes = useThemedStyles(buildVariantPalette);
  const sizePresets = useThemedStyles(buildSizePreset);

  const palette = variantPalettes[variant] ?? variantPalettes.primary;
  const dims = sizePresets[size] ?? sizePresets.md;

  // Clamp to the WCAG 2.5.5 floor regardless of size token. `sm` therefore
  // visually compresses padding but keeps the hit-target safe.
  const effectiveHeight = Math.max(dims.height, MIN_TOUCH_TARGET);

  // Inert when disabled OR loading. We collapse both into a single press
  // gate so callers do not have to defensively guard against double-tap
  // during in-flight work.
  const inert = disabled || loading;

  // NOTE: this closure is intentionally NOT wrapped in `React.useCallback`.
  // The Pressable below recreates its `style` callback on every render
  // anyway (the array varies with `pressed`), so memoizing the press
  // handler buys nothing and would force every consumer test to render
  // through `react-test-renderer` instead of the lightweight function-call
  // pattern used by the rest of the FieldOps unit suite.
  const handlePress = (): void => {
    if (inert) return;
    onPress();
  };

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      onPress={handlePress}
      // `disabled` on Pressable disables the native press feedback ripple
      // (Android) AND the synthetic onPress. Belt-and-suspenders with the
      // inert check inside `handlePress` so the no-op holds even if the
      // platform fires a delayed press event.
      disabled={inert}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderWidth: palette.borderWidth,
          minHeight: effectiveHeight,
          paddingHorizontal: dims.paddingHorizontal,
          width: fullWidth ? "100%" : undefined,
          alignSelf: fullWidth ? "stretch" : "flex-start",
        },
        pressed && !inert ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {leftIcon && !loading ? (
        <View testID={`${testID}-icon-left`} style={styles.iconSlot}>
          {leftIcon}
        </View>
      ) : null}
      {loading ? (
        <View
          testID={`${testID}-loading`}
          style={[styles.loadingDot, { backgroundColor: palette.foreground }]}
        />
      ) : (
        <Text
          testID={`${testID}-label`}
          style={[
            styles.label,
            { color: palette.foreground, fontSize: dims.fontSize },
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
      {rightIcon && !loading ? (
        <View testID={`${testID}-icon-right`} style={styles.iconSlot}>
          {rightIcon}
        </View>
      ) : null}
    </Pressable>
  );
}
