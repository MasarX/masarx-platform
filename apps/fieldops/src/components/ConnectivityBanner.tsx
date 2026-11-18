import * as React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

// Offline and degraded banners use the theme danger and warning color pairs.

export type ConnectivityBannerVariant = "offline" | "degraded";

export type ConnectivityBannerProps = {
  variant: ConnectivityBannerVariant;
  title: string;
  message?: string;
  testID?: string;
};

type BannerPalette = {
  background: string;
  border: string;
  titleColor: string;
  messageColor: string;
};

function buildBannerPalette(tokens: ThemeTokens): Record<ConnectivityBannerVariant, BannerPalette> {
  return {
    offline: {
      background: tokens.color.dangerSoft,
      border: tokens.color.danger,
      titleColor: tokens.color.dangerFg,
      messageColor: tokens.color.dangerFg,
    },
    degraded: {
      background: tokens.color.warningSoft,
      border: tokens.color.warning,
      titleColor: tokens.color.warningFg,
      messageColor: tokens.color.warningFg,
    },
  };
}

export function ConnectivityBanner(
  props: ConnectivityBannerProps
): React.JSX.Element {
  const { variant, title, message, testID = "connectivity-banner" } = props;
  const styles = useThemedStyles(buildStyles);
  const palettes = useThemedStyles(buildBannerPalette);
  const palette = palettes[variant] ?? palettes.degraded;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLabel={
        message && message.length > 0 ? `${title}. ${message}` : title
      }
      style={[
        styles.card,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
        },
      ]}
    >
      <Text
        testID={`${testID}-title`}
        style={[styles.title, { color: palette.titleColor }]}
        numberOfLines={2}
      >
        {title}
      </Text>
      {message ? (
        <Text
          testID={`${testID}-message`}
          style={[styles.message, { color: palette.messageColor }]}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

function buildStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    card: {
      borderWidth: 1,
      borderRadius: tokens.radius.md,
      paddingVertical: tokens.spacing.sm,
      paddingHorizontal: tokens.spacing.md,
    },
    title: {
      fontSize: tokens.font.scale.sm,
      fontWeight: "700",
      fontFamily: tokens.font.sans,
    },
    message: {
      marginTop: tokens.spacing.xs,
      fontSize: tokens.font.scale.sm,
      lineHeight: 16,
      fontFamily: tokens.font.sans,
    },
  });
}
