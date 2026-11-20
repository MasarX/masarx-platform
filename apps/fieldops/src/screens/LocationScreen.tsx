import * as React from "react";
import { Alert, Pressable, StyleSheet, Text, View, type PressableProps } from "react-native";
import * as Location from "expo-location";

import type { FieldOpsStrings } from "../i18n";
import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

const HEARTBEAT_LIVE_WINDOW_MS = 30_000;

type AccuracyPolicy = { maxAccuracyM: number | null };

export function resolveLocationAccuracyThreshold(
  locationPolicy: AccuracyPolicy,
  geofenceAccuracyThresholdM?: number,
) {
  const effectiveAccuracyThresholdM =
    geofenceAccuracyThresholdM != null &&
    Number.isFinite(geofenceAccuracyThresholdM) &&
    geofenceAccuracyThresholdM > 0
      ? Math.min(geofenceAccuracyThresholdM, locationPolicy.maxAccuracyM ?? Infinity)
      : locationPolicy.maxAccuracyM;
  return effectiveAccuracyThresholdM;
}

type BackgroundPermission = Awaited<ReturnType<typeof Location.requestBackgroundPermissionsAsync>>;
type RequestPermission = (isCurrent: () => boolean) => Promise<BackgroundPermission | null>;
type LocationScreenProps = {
  strings: FieldOpsStrings;
  locationPolicy: AccuracyPolicy;
  geofenceAccuracyThresholdM?: number;
  backgroundPolicyEnabled: boolean;
  backgroundGranted: boolean;
  openSystemSettingsSafe: () => Promise<boolean>;
  onUpgrade: (request: RequestPermission) => Promise<BackgroundPermission | null>;
  onCapture: () => Promise<number | null | undefined>;
  captureButton: Pick<PressableProps, "accessibilityRole" | "accessibilityState" | "accessibilityHint">;
  capturing: boolean;
};

export function LocationScreen({
  strings,
  locationPolicy,
  geofenceAccuracyThresholdM,
  backgroundPolicyEnabled,
  backgroundGranted,
  openSystemSettingsSafe,
  onUpgrade,
  onCapture,
  captureButton,
  capturing,
}: LocationScreenProps) {
  const localStyles = useThemedStyles(createLocationStyles);
  const [latestPing, setLatestPing] = React.useState<{ timestamp: number } | null>(null);
  const [heartbeatNow, setHeartbeatNow] = React.useState(Date.now);
  const heartbeatLive = latestPing != null && heartbeatNow - latestPing.timestamp <= HEARTBEAT_LIVE_WINDOW_MS;
  React.useEffect(() => {
    if (!heartbeatLive) return;
    const tick = setInterval(() => {
      setHeartbeatNow(Date.now());
    }, 1000);
    return () => clearInterval(tick);
  }, [heartbeatLive]);

  const effectiveAccuracyThresholdM = resolveLocationAccuracyThreshold(
    locationPolicy, geofenceAccuracyThresholdM,
  );
  const showBackgroundUpgradeCta = backgroundPolicyEnabled && !backgroundGranted;
  const handleUpgradeBackgroundPermission = async () => {
    const permission = await onUpgrade(async (isCurrent) => {
      const current = await Location.getBackgroundPermissionsAsync();
      if (!isCurrent()) return null;
      if (current.status === "granted" || !current.canAskAgain) return current;
      return Location.requestBackgroundPermissionsAsync();
    });
    if (permission && permission.status !== "granted" && !permission.canAskAgain) {
      Alert.alert(strings.location.backgroundPermissionRequired, strings.location.enableBackgroundInSettings, [
        { text: strings.confirm.cancelButton, style: "cancel" },
        { text: strings.actionAccessibility.openSettings, onPress: () => { void openSystemSettingsSafe(); } },
      ]);
    }
  };

  return (
    <View style={localStyles.controls}>
      <View style={localStyles.heartbeat} testID="mobile-location-heartbeat" accessibilityLiveRegion="polite"
        accessibilityLabel={heartbeatLive ? "Location captured recently" : "No recent location capture"}>
        <View style={[localStyles.heartbeatDot, heartbeatLive ? localStyles.heartbeatDotLive : localStyles.heartbeatDotIdle]} />
        <Text style={localStyles.accuracyCaption}>{heartbeatLive ? "Live" : "Idle"}</Text>
      </View>
      {effectiveAccuracyThresholdM != null ? (
        <Text style={localStyles.accuracyCaption}>Required: {effectiveAccuracyThresholdM}m</Text>
      ) : null}
      {showBackgroundUpgradeCta ? (
        <Pressable testID="mobile-location-upgrade-background" style={localStyles.captureButton}
          accessibilityRole="button" onPress={() => { void handleUpgradeBackgroundPermission(); }}>
          <Text style={localStyles.captureButtonText}>{strings.location.allowBackground}</Text>
        </Pressable>
      ) : null}
      <Pressable
        {...captureButton}
        testID="mobile-location-capture"
        disabled={captureButton.accessibilityState?.disabled}
        style={[localStyles.captureButton, captureButton.accessibilityState?.disabled && localStyles.disabled]}
        onPress={async () => {
          const accuracy = await onCapture();
          if (accuracy === undefined) return;
          if (effectiveAccuracyThresholdM != null && accuracy != null &&
              accuracy > effectiveAccuracyThresholdM) return;
          setLatestPing({ timestamp: Date.now() });
          setHeartbeatNow(Date.now());
        }}
      >
        <Text style={localStyles.captureButtonText}>{capturing ? "Working..." : "Capture location"}</Text>
      </Pressable>
    </View>
  );
}

function createLocationStyles({ color, spacing, radius }: ThemeTokens) {
  return StyleSheet.create({
    controls: { gap: spacing.sm },
    heartbeat: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    heartbeatDot: { width: spacing.sm, height: spacing.sm, borderRadius: radius.pill },
    heartbeatDotLive: { backgroundColor: color.success },
    heartbeatDotIdle: { backgroundColor: color.textMuted },
    accuracyCaption: { color: color.metaFg },
    captureButton: { backgroundColor: color.control, borderRadius: radius.md, padding: spacing.md },
    captureButtonText: { color: color.controlText },
    disabled: { opacity: 0.6 },
  });
}
