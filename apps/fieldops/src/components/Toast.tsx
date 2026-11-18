import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import { Icon } from "./IconRegistry";
import type { IconName, IconTone } from "./IconRegistry.types";

import {
  TOAST_DEFAULT_DURATION_MS,
  type ToastProps,
  type ToastTone,
} from "./Toast.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { Toast, type ToastProps } from ".../Toast"` without remembering
// the sibling `.types` file. The canonical declaration still lives in
// `Toast.types.ts` so non-rendering consumers do not pull JSX.
export type {
  ToastAction,
  ToastEnqueueOptions,
  ToastProps,
  ToastQueueEntry,
  ToastTone,
} from "./Toast.types";
export { TOAST_DEFAULT_DURATION_MS, TOAST_TONES } from "./Toast.types";

/** Use the shared button touch target dimensions for toast actions. */
const MIN_TOUCH_TARGET = 44 as const;

/**
 * Per-tone palette resolved from the active theme tokens. Each tone uses
 * the matching `*Soft` background and `*Fg` foreground pair from the
 * theme palette — both pairs are WCAG AA verified per `mobile-theme.ts`.
 */
type TonePalette = {
  background: string;
  foreground: string;
  border: string;
};

function buildTonePalette(tokens: ThemeTokens): Record<ToastTone, TonePalette> {
  return {
    info: {
      background: tokens.color.infoSoft,
      foreground: tokens.color.infoFg,
      border: tokens.color.infoBorder,
    },
    success: {
      background: tokens.color.successSoft,
      foreground: tokens.color.successFg,
      border: tokens.color.success,
    },
    warning: {
      background: tokens.color.warningSoft,
      foreground: tokens.color.warningFg,
      border: tokens.color.warning,
    },
    danger: {
      background: tokens.color.dangerSoft,
      foreground: tokens.color.dangerFg,
      border: tokens.color.danger,
    },
  };
}

/** Toast icons use the shared registry and follow the active theme. */
const TONE_ICON: Record<ToastTone, IconName> = {
  info: "bell",
  success: "check",
  warning: "bell",
  danger: "close",
};

/**
 * Tone -> IconTone map for the leading icon. Mirrors the foreground tone
 * vocabulary so the icon and message share a color family.
 */
const TONE_ICON_TONE: Record<ToastTone, IconTone> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};

/**
 * Tone -> accessibilityRole map. The WAI-ARIA Live Region split is:
 *   - polite (`status`) for info + success
 *   - assertive (`alert`) for warning + danger
 *
 * Assertive announcements interrupt the screen reader queue, so we reserve
 * them for tones that require immediate user awareness.
 */
const TONE_ROLE: Record<ToastTone, "status" | "alert"> = {
  info: "status",
  success: "status",
  warning: "alert",
  danger: "alert",
};

/**
 * Stylesheet factory — invoked through `useThemedStyles` so styles refresh
 * whenever the active tokens change (theme mode swap, density swap, etc.).
 * Keeps the component body focused on layout and lets the theme system
 * stay the single source of truth for visual values.
 */
export function buildToastStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: tokens.spacing.lg,
      paddingVertical: tokens.spacing.md,
      borderRadius: tokens.radius.md,
      borderWidth: 1,
      gap: tokens.spacing.sm,
      // Self-align so the toast carries its own width inside an overlay
      // container. Callers can still wrap in a positioned `View` to anchor
      // it to the bottom of the screen (the `ToastQueue` provider does so).
      alignSelf: "stretch",
      // Subtle elevation cue so the toast lifts off underlying content. We
      // do not chain a per-platform shadow here — RN-Web ignores shadow*
      // props without warning, and native shells get a soft ambient lift
      // from the elevation token.
      elevation: 4,
    },
    iconSlot: {
      // Slot wrapper keeps the gap rule predictable when the icon node
      // varies in size (a future SVG swap might wrap the glyph in a View).
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    messageSlot: {
      // Take the remaining horizontal space so long messages wrap rather
      // than push the action button off-screen.
      flex: 1,
    },
    message: {
      fontSize: tokens.font.scale.lg,
      fontWeight: "500",
      letterSpacing: 0.1,
      fontFamily: tokens.font.sans,
    },
    actionButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: tokens.spacing.md,
      // Honor the WCAG 2.5.5 floor — the action button must remain a
      // reliable tap target even though it sits inside the toast row.
      minHeight: MIN_TOUCH_TARGET,
      minWidth: MIN_TOUCH_TARGET,
      borderRadius: tokens.radius.sm,
    },
    actionPressed: {
      opacity: 0.85,
    },
    actionLabel: {
      fontSize: tokens.font.scale.lg,
      fontWeight: "700",
      letterSpacing: 0.2,
      fontFamily: tokens.font.sans,
      textAlign: "center",
    },
  });
}

/**
 * Toast — the canonical primitive. See module header for invariants.
 */
export function Toast(props: ToastProps): React.JSX.Element {
  const {
    message,
    tone = "info",
    durationMs = TOAST_DEFAULT_DURATION_MS,
    onDismiss,
    action,
    testID = "toast",
    accessibilityLabel,
  } = props;

  const styles = useThemedStyles(buildToastStyles);
  const palettes = useThemedStyles(buildTonePalette);
  const palette = palettes[tone] ?? palettes.info;

  // Auto-dismiss timer wiring. Skipped when `durationMs <= 0` so callers
  // can opt into persistent toasts (manual dismiss required).
  //
  // The effect intentionally depends on `durationMs` and `onDismiss` so a
  // fresh callback identity / duration restarts the timer rather than
  // silently keeping a stale reference. React.useRef is not used here
  // because the timer lifecycle is fully scoped to the effect — when the
  // toast unmounts (queue rotation), cleanup tears the timer down.
  React.useEffect(() => {
    if (durationMs <= 0) {
      return undefined;
    }
    const handle = setTimeout(() => {
      onDismiss();
    }, durationMs);
    return () => {
      clearTimeout(handle);
    };
  }, [durationMs, onDismiss]);

  // Per-tone accessibility role: assertive for warning/danger, polite for
  // info/success. See WAI-ARIA Live Region guidance.
  //
  // Note: React Native's typed `AccessibilityRole` union does NOT include
  // the WAI-ARIA `"status"` value (it is iOS / RN-Web supported, but not
  // in the type surface). We cast through a precise union so the runtime
  // value carries the documented WAI-ARIA semantic without polluting the
  // public API with a broader type. The `accessibilityLiveRegion` prop
  // below is what Android's TalkBack actually reads to honor the polite/
  // assertive split — `accessibilityRole` is the iOS / web semantic hint.
  const a11yRole: "status" | "alert" = TONE_ROLE[tone] ?? "status";

  return (
    <View
      testID={testID}
      accessibilityRole={a11yRole as unknown as "alert"}
      accessibilityLabel={accessibilityLabel ?? message}
      accessibilityLiveRegion={a11yRole === "alert" ? "assertive" : "polite"}
      style={[
        styles.card,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
        },
      ]}
    >
      <View testID={`${testID}-icon`} style={styles.iconSlot}>
        <Icon
          name={TONE_ICON[tone]}
          tone={TONE_ICON_TONE[tone]}
          size="md"
        />
      </View>
      <View style={styles.messageSlot}>
        <Text
          testID={`${testID}-message`}
          style={[styles.message, { color: palette.foreground }]}
          numberOfLines={3}
        >
          {message}
        </Text>
      </View>
      {action ? (
        <Pressable
          testID={`${testID}-action`}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.actionButton,
            pressed ? styles.actionPressed : null,
          ]}
        >
          <Text
            testID={`${testID}-action-label`}
            style={[styles.actionLabel, { color: palette.foreground }]}
            numberOfLines={1}
          >
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default Toast;
