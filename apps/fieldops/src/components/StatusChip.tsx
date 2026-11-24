import * as React from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { getTokensForTheme, type ThemeTokens } from "../mobile-theme";
import { useTheme } from "../mobile-theme-context";
import { resolveToneFromPolicy, STATIC_STATUS_THEME, type StatusTone } from "../status-theme-policy";

export type { StatusTone } from "../status-theme-policy";

export type StatusChipProps = {
  label: string;
  tone?: StatusTone;
  icon?: React.ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function resolveStatusTone(status: string | null | undefined): StatusTone {
  return resolveToneFromPolicy(STATIC_STATUS_THEME, status);
}

export function getStatusChipPalette(tone: StatusTone, tokens: ThemeTokens = getTokensForTheme("light", "native")) {
  const c = tokens.color;
  const entries: Record<StatusTone, [string, string, string]> = {
    neutral: [c.borderMuted, c.border, c.metaFg],
    info: [c.infoSoft, c.infoBorder, c.infoFg],
    success: [c.successSoft, c.success, c.successFg],
    warning: [c.warningSoft, c.warning, c.warningFg],
    danger: [c.dangerSoft, c.danger, c.dangerFg],
    meta: [c.metaSoft, c.metaBorder, c.metaFg],
  };
  const [background, border, foreground] = entries[tone] ?? entries.neutral;
  return { background, border, foreground };
}

export function StatusChip({ label, tone = "neutral", icon, testID = "status-chip", accessibilityLabel, style }: StatusChipProps) {
  const { tokens } = useTheme();
  const { background, border, foreground } = getStatusChipPalette(tone, tokens);
  return (
    <View testID={testID} accessibilityRole="text" accessibilityLabel={accessibilityLabel ?? label} style={[
      {
        flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: tokens.spacing.xs,
        borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: border, backgroundColor: background,
        paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.xs,
      },
      style,
    ]}>
      {icon ? <View testID={`${testID}-icon`}>{icon}</View> : null}
      <Text testID={`${testID}-label`} numberOfLines={1} style={{ color: foreground, fontSize: tokens.font.scale.xs }}>
        {label}
      </Text>
    </View>
  );
}
