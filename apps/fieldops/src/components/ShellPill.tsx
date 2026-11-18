import * as React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

export type ShellPillTone = "positive" | "neutral" | "warning" | "offline";

export type ShellPillProps = {
  label: string;
  tone?: ShellPillTone;
  /**
   * Render a small colored circle before the label. Used for the
   * connectivity Online/Degraded/Offline indicator so the dot stays
   * visible at a glance even when the label is short ("Online" → 6 chars).
   */
  dot?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: any;
};

type TonePalette = {
  background: string;
  border: string;
  foreground: string;
  /**
   * Dot color is intentionally separate from the foreground/border so
   * "positive + dot" can use the saturated success swatch (the green
   * status dot) on top of the soft success background, mirroring the
   * legacy `headerPillDotOnline` behavior.
   */
  dot: string;
};

/**
 * Resolve the pill palette per tone from the active theme tokens.
 *
 *  - positive → success family (green dot + soft green bg + AA fg)
 *  - neutral  → meta family (subtle border bg + meta fg, used for
 *               counters like "Outbox: 3")
 *  - warning  → warning family (degraded connectivity)
 *  - offline  → danger family (offline / unrecoverable failures)
 */
function buildTonePalette(tokens: ThemeTokens): Record<ShellPillTone, TonePalette> {
  return {
    positive: {
      background: tokens.color.successSoft,
      border: tokens.color.success,
      foreground: tokens.color.successFg,
      dot: tokens.color.success,
    },
    neutral: {
      background: tokens.color.cardBg,
      border: tokens.color.border,
      foreground: tokens.color.metaFg,
      dot: tokens.color.metaFg,
    },
    warning: {
      background: tokens.color.warningSoft,
      border: tokens.color.warning,
      foreground: tokens.color.warningFg,
      dot: tokens.color.warning,
    },
    offline: {
      background: tokens.color.dangerSoft,
      border: tokens.color.danger,
      foreground: tokens.color.dangerFg,
      dot: tokens.color.danger,
    },
  };
}

export function ShellPill(props: ShellPillProps): React.JSX.Element {
  const {
    label,
    tone = "neutral",
    dot = false,
    testID = "shell-pill",
    accessibilityLabel,
    style,
  } = props;
  const palettes = useThemedStyles(buildTonePalette);
  const styles = useThemedStyles(buildStyles);
  const palette = palettes[tone] ?? palettes.neutral;
  return (
    <View
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        styles.pill,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
        },
        style,
      ]}
    >
      {dot ? (
        <View
          testID={`${testID}-dot`}
          style={[styles.dot, { backgroundColor: palette.dot }]}
        />
      ) : null}
      <Text
        testID={`${testID}-label`}
        style={[styles.label, { color: palette.foreground }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

function buildStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderRadius: tokens.radius.pill,
      paddingHorizontal: tokens.spacing.sm,
      paddingVertical: tokens.spacing.xs,
      gap: tokens.spacing.xs,
      alignSelf: "flex-start",
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 999,
    },
    label: {
      fontSize: tokens.font.scale.xs,
      fontWeight: "700",
      letterSpacing: 0.2,
      fontFamily: tokens.font.sans,
    },
  });
}
