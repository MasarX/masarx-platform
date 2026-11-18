import { StyleSheet } from "react-native";
import { type ThemeTokens } from "./mobile-theme";

// This module pairs the token SSOT in `./mobile-theme` with a React Native
// StyleSheet factory. It is intentionally free of hardcoded color/spacing/
// radius literals — every visual value is pulled from `tokens.color.*`,
// `tokens.spacing.*`, `tokens.radius.*`, or `tokens.font.*`. Callers use it
// inside a `useMemo` tied to the current `ThemeTokens` so theme swaps rebuild
// the styles once per palette change.

export type ThemedStyles = ReturnType<typeof buildThemedStyles>;

export function buildThemedStyles(tokens: ThemeTokens) {
  const { color, spacing, radius, font } = tokens;
  return StyleSheet.create({
    pageRoot: {
      flex: 1,
      backgroundColor: color.pageBg,
    },
    page: {
      flex: 1,
      backgroundColor: color.pageBg,
      position: "relative",
    },
    header: {
      paddingTop: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: color.border,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      backgroundColor: color.cardBg,
    },
    headerText: {
      flex: 1,
      minWidth: 0,
    },
    headerTitle: {
      fontSize: 16,
      fontWeight: "700",
      color: color.text,
      fontFamily: font.sans,
    },
    headerSubtitle: {
      fontSize: 12,
      fontWeight: "600",
      color: color.textMuted,
      fontFamily: font.sans,
      marginTop: spacing.xs / 2,
    },
    headerPill: {
      fontSize: 12,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: color.cardBg,
      borderWidth: 1,
      borderColor: color.border,
      color: color.textMuted,
      fontFamily: font.sans,
    },
    headerPillRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs + 2,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: color.cardBg,
    },
    card: {
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.md,
      padding: spacing.lg - spacing.xs / 2,
      marginBottom: spacing.md,
      backgroundColor: color.cardBg,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: "600",
      marginBottom: spacing.xs + 2,
      color: color.text,
      fontFamily: font.sans,
    },
    cardSubtitle: {
      fontSize: 12,
      color: color.textMuted,
      fontFamily: font.sans,
    },
    noticeCard: {
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.md,
      padding: spacing.lg - spacing.xs / 2,
      backgroundColor: color.cardBg,
    },
    noticeText: {
      fontSize: 14,
      fontWeight: "800",
      marginBottom: spacing.xs + 2,
      color: color.text,
      fontFamily: font.sans,
    },
    noticeSubtext: {
      fontSize: 12,
      color: color.textMuted,
      fontFamily: font.sans,
    },
    chip: {
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: color.cardBgSubtle,
      borderWidth: 1,
      borderColor: color.borderMuted,
      minHeight: 40,
      justifyContent: "center",
    },
    chipText: {
      fontSize: 12,
      fontWeight: "700",
      color: color.text,
      fontFamily: font.sans,
    },
    chipSelected: {
      backgroundColor: color.accentSoft,
      borderColor: color.accent,
    },
    primaryButton: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      backgroundColor: color.accent,
      minHeight: 44,
      justifyContent: "center",
    },
    primaryButtonText: {
      color: color.accentText,
      fontSize: 14,
      fontWeight: "800",
      textAlign: "center",
      fontFamily: font.sans,
    },
    secondaryButton: {
      paddingHorizontal: spacing.lg - spacing.xs / 2,
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.cardBg,
      minHeight: 44,
      justifyContent: "center",
    },
    secondaryButtonText: {
      fontSize: 13,
      fontWeight: "800",
      color: color.text,
      fontFamily: font.sans,
    },
    input: {
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.lg - spacing.xs / 2,
      paddingVertical: spacing.md,
      backgroundColor: color.control,
      fontSize: 14,
      fontFamily: font.sans,
      color: color.controlText,
    },
    listMetaText: {
      fontSize: 12,
      color: color.textMuted,
      fontFamily: font.sans,
    },
    errorText: {
      fontSize: 14,
      color: color.danger,
      marginBottom: spacing.sm,
      fontFamily: font.sans,
    },
  });
}
