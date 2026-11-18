import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

// The active-stop banner uses semantic theme tokens for the background and status chip.

export type CurrentStopBannerStop = {
  stopId: string;
  sequence: number | null;
  customerName: string | null;
  addressSummary: string | null;
  etaMinutes: number | null;
  statusLabel: string;
};

export type CurrentStopBannerStrings = {
  empty_label: string;
  open_cta: string;
  navigate_cta: string;
  eta_minutes: (n: number) => string;
  sequence_prefix: (n: number) => string;
};

export type CurrentStopBannerProps = {
  stop: CurrentStopBannerStop | null;
  onOpenStop: (stopId: string) => void;
  onNavigateStop: (stopId: string) => void;
  strings: CurrentStopBannerStrings;
  style?: any;
  testID?: string;
};

export function CurrentStopBanner(
  props: CurrentStopBannerProps
): React.JSX.Element {
  const {
    stop,
    onOpenStop,
    onNavigateStop,
    strings,
    style,
    testID = "current-stop-banner",
  } = props;
  const styles = useThemedStyles(buildStyles);

  if (stop === null || stop === undefined) {
    return (
      <View
        testID={`${testID}-empty`}
        accessibilityRole="summary"
        accessibilityLabel={strings.empty_label}
        style={[styles.bannerEmpty, style]}
      >
        <Text
          testID={`${testID}-empty-label`}
          style={styles.emptyLabel}
          numberOfLines={1}
        >
          {strings.empty_label}
        </Text>
      </View>
    );
  }

  const sequenceText =
    stop.sequence !== null && stop.sequence !== undefined
      ? strings.sequence_prefix(stop.sequence)
      : null;
  const etaText =
    stop.etaMinutes !== null && stop.etaMinutes !== undefined
      ? strings.eta_minutes(stop.etaMinutes)
      : null;

  return (
    <View
      testID={testID}
      accessibilityRole="summary"
      style={[styles.banner, style]}
    >
      <View style={styles.textColumn}>
        <View style={styles.headerRow}>
          {sequenceText ? (
            <Text
              testID={`${testID}-sequence`}
              style={styles.sequence}
              numberOfLines={1}
            >
              {sequenceText}
            </Text>
          ) : null}
          <View
            testID={`${testID}-status-chip`}
            style={styles.statusChip}
          >
            <Text
              testID={`${testID}-status-label`}
              style={styles.statusLabel}
              numberOfLines={1}
            >
              {stop.statusLabel}
            </Text>
          </View>
        </View>
        {stop.customerName ? (
          <Text
            testID={`${testID}-customer`}
            style={styles.customer}
            numberOfLines={1}
          >
            {stop.customerName}
          </Text>
        ) : null}
        {stop.addressSummary ? (
          <Text
            testID={`${testID}-address`}
            style={styles.address}
            numberOfLines={1}
          >
            {stop.addressSummary}
          </Text>
        ) : null}
        {etaText ? (
          <Text
            testID={`${testID}-eta`}
            style={styles.eta}
            numberOfLines={1}
          >
            {etaText}
          </Text>
        ) : null}
      </View>
      <View style={styles.actionsColumn}>
        <Pressable
          testID={`${testID}-navigate-cta`}
          accessibilityRole="button"
          onPress={() => onNavigateStop(stop.stopId)}
          style={({ pressed }) => [
            styles.primaryAction,
            pressed ? styles.primaryActionPressed : null,
          ]}
        >
          <Text style={styles.primaryActionLabel} numberOfLines={1}>
            {strings.navigate_cta}
          </Text>
        </Pressable>
        <Pressable
          testID={`${testID}-open-cta`}
          accessibilityRole="button"
          onPress={() => onOpenStop(stop.stopId)}
          style={({ pressed }) => [
            styles.secondaryAction,
            pressed ? styles.secondaryActionPressed : null,
          ]}
        >
          <Text style={styles.secondaryActionLabel} numberOfLines={1}>
            {strings.open_cta}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function buildStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: tokens.spacing.sm,
      paddingHorizontal: tokens.spacing.md,
      borderWidth: 1,
      borderRadius: tokens.radius.md,
      backgroundColor: tokens.color.accentSoft,
      borderColor: tokens.color.accent,
    },
    bannerEmpty: {
      paddingVertical: tokens.spacing.sm,
      paddingHorizontal: tokens.spacing.md,
      borderWidth: 1,
      borderRadius: tokens.radius.md,
      backgroundColor: tokens.color.cardBgSubtle,
      borderColor: tokens.color.borderMuted,
    },
    emptyLabel: {
      fontSize: tokens.font.scale.sm,
      fontWeight: "600",
      color: tokens.color.textMuted,
      textAlign: "center",
      letterSpacing: 0.2,
      fontFamily: tokens.font.sans,
    },
    textColumn: {
      flex: 1,
      flexDirection: "column",
      marginRight: tokens.spacing.sm,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 2,
    },
    sequence: {
      fontSize: tokens.font.scale.sm,
      fontWeight: "800",
      color: tokens.color.accent,
      marginRight: tokens.spacing.sm,
      fontFamily: tokens.font.sans,
    },
    statusChip: {
      paddingHorizontal: tokens.spacing.sm,
      paddingVertical: 2,
      backgroundColor: tokens.color.infoSoft,
      borderColor: tokens.color.infoBorder,
      borderWidth: 1,
      borderRadius: tokens.radius.pill,
    },
    statusLabel: {
      fontSize: tokens.font.scale.xs,
      fontWeight: "600",
      color: tokens.color.infoFg,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      fontFamily: tokens.font.sans,
    },
    customer: {
      fontSize: tokens.font.scale.md,
      fontWeight: "700",
      color: tokens.color.text,
      fontFamily: tokens.font.sans,
    },
    address: {
      fontSize: tokens.font.scale.sm,
      color: tokens.color.text,
      marginTop: 1,
      fontFamily: tokens.font.sans,
    },
    eta: {
      fontSize: tokens.font.scale.sm,
      fontWeight: "600",
      color: tokens.color.accent,
      marginTop: 2,
      fontFamily: tokens.font.sans,
    },
    actionsColumn: {
      flexDirection: "column",
      alignItems: "stretch",
    },
    primaryAction: {
      backgroundColor: tokens.color.accent,
      paddingVertical: 6,
      paddingHorizontal: tokens.spacing.md,
      borderRadius: tokens.radius.sm,
      marginBottom: tokens.spacing.xs,
      alignItems: "center",
    },
    primaryActionPressed: {
      opacity: 0.85,
    },
    primaryActionLabel: {
      color: tokens.color.accentText,
      fontSize: tokens.font.scale.sm,
      fontWeight: "700",
      fontFamily: tokens.font.sans,
    },
    secondaryAction: {
      backgroundColor: tokens.color.cardBg,
      paddingVertical: 6,
      paddingHorizontal: tokens.spacing.md,
      borderRadius: tokens.radius.sm,
      borderWidth: 1,
      borderColor: tokens.color.accent,
      alignItems: "center",
    },
    secondaryActionPressed: {
      opacity: 0.85,
    },
    secondaryActionLabel: {
      color: tokens.color.accent,
      fontSize: tokens.font.scale.sm,
      fontWeight: "700",
      fontFamily: tokens.font.sans,
    },
  });
}
