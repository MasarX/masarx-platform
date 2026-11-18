// Mobile V2 Driving Lock View — focused safety screen rendered ABOVE the
// normal shell when current speed >= driver_safety_policy.lock_threshold_kph.
// Per AGENTS.md Mobile Field Ops Policy Contract: "When driving lock is
// active, the shell collapses to a focused safety view (map + next-stop
// only); list/data screens are suspended until below the threshold or an
// explicit safety bypass is logged via decision_log."

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { FxButton, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import {
  formatMobileV2Speed,
  type MobileV2UnitSystem,
} from "./mobile-v2-ops-helpers";

export interface MobileV2DrivingLockNextStop {
  readonly tracking: string;
  readonly addressLine1: string;
  readonly etaMinutes: number;
  readonly distanceKm: number;
  readonly window: string;
}

export interface MobileV2DrivingLockProps {
  readonly theme: MobileV2Theme;
  readonly currentSpeedKph: number;
  readonly thresholdKph: number;
  readonly nextStop: MobileV2DrivingLockNextStop;
  /**
   * Unit system resolved upstream from `localization_policy.unit_system`.
   * Defaults to "metric" (kph). Per AGENTS.md zero-hardcoding, the screen
   * never embeds a unit literal — `formatMobileV2Speed` resolves it.
   */
  readonly unitSystem?: MobileV2UnitSystem;
  readonly onNavigate?: () => void;
  /** Logs a safety-bypass via decision_log + collapses the lock view. */
  readonly onSafetyBypass?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2DrivingLockScreen(props: MobileV2DrivingLockProps): React.ReactElement {
  const { theme, currentSpeedKph, thresholdKph, nextStop } = props;
  const lockLabel = `speed ${formatMobileV2Speed(currentSpeedKph, props.unitSystem)} · lock ≥ ${formatMobileV2Speed(thresholdKph, props.unitSystem)}`;

  const sansSemibold = {
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  } as const;
  const monoBold = {
    fontFamily: MOBILE_V2_FONT_MONO,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  } as const;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* Hazard banner */}
      <View
        style={{
          backgroundColor: theme.danger,
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING["3xl"],
          paddingBottom: MOBILE_V2_SPACING["3xl"],
          flexDirection: "row",
          alignItems: "center",
          columnGap: MOBILE_V2_SPACING.lg,
        }}
        accessibilityRole="alert"
      >
        <FxIcon name="shield" size={26} color="#FFFFFF" stroke={2.2} />
        <View style={{ flex: 1 }}>
          <Text
            style={{
              ...sansSemibold,
              color: "#FFFFFF",
              fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.appBarTitle,
            }}
          >
            Driving · do not interact
          </Text>
          <Text
            style={{
              fontFamily: MOBILE_V2_FONT_MONO,
              color: "rgba(255,255,255,0.85)",
              fontSize: MOBILE_V2_TYPE_SIZES.chip,
              marginTop: 2,
              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
            }}
          >
            {lockLabel}
          </Text>
        </View>
      </View>

      {/* Map placeholder consuming theme.mapBg + theme.mapRoute */}
      <View
        style={{
          flex: 1,
          backgroundColor: theme.mapBg,
          margin: MOBILE_V2_SPACING["4xl"],
          borderRadius: MOBILE_V2_RADII.card,
          borderColor: theme.borderStrong,
          borderWidth: 1,
          overflow: "hidden",
          position: "relative",
        }}
        accessibilityRole="image"
        accessibilityLabel="Active route map"
      >
        {/* Faux route polyline using border to evoke a path; production wires
            react-native-maps + map_policy.clustering. */}
        <View
          style={{
            position: "absolute",
            top: "30%",
            left: "10%",
            right: "10%",
            height: 4,
            backgroundColor: theme.mapRoute,
            transform: [{ rotate: "-12deg" }],
            borderRadius: 4,
          }}
        />
        <View
          style={{
            position: "absolute",
            top: "55%",
            left: "20%",
            right: "20%",
            height: 4,
            backgroundColor: theme.mapRoute,
            transform: [{ rotate: "8deg" }],
            borderRadius: 4,
          }}
        />
        {/* Driver pin — accent dot */}
        <View
          style={{
            position: "absolute",
            top: "30%",
            left: "10%",
            width: 14,
            height: 14,
            borderRadius: 999,
            backgroundColor: theme.accent,
            borderWidth: 3,
            borderColor: theme.bg,
            marginLeft: -7,
            marginTop: -7,
          }}
        />
        {/* Next stop pin */}
        <View
          style={{
            position: "absolute",
            top: "55%",
            right: "20%",
            width: 14,
            height: 14,
            borderRadius: 999,
            backgroundColor: theme.success,
            borderWidth: 3,
            borderColor: theme.bg,
            marginRight: -7,
            marginTop: -7,
          }}
        />
        <View
          style={{
            position: "absolute",
            bottom: MOBILE_V2_SPACING["3xl"],
            left: MOBILE_V2_SPACING["3xl"],
            backgroundColor: theme.surface,
            paddingHorizontal: MOBILE_V2_SPACING["2xl"],
            paddingVertical: MOBILE_V2_SPACING.md,
            borderRadius: MOBILE_V2_RADII.button,
            borderColor: theme.border,
            borderWidth: 1,
            flexDirection: "row",
            alignItems: "center",
            columnGap: MOBILE_V2_SPACING.md,
          }}
        >
          <FxIcon name="navigate" size={14} color={theme.muted} />
          <Text
            style={{
              ...monoBold,
              color: theme.ink,
              fontSize: MOBILE_V2_TYPE_SIZES.chip,
              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
            }}
          >
            {nextStop.distanceKm.toFixed(1)} km · {nextStop.etaMinutes} min
          </Text>
        </View>
      </View>

      {/* Next-stop card */}
      <View
        style={{
          marginHorizontal: MOBILE_V2_SPACING["4xl"],
          marginBottom: MOBILE_V2_SPACING["4xl"],
          backgroundColor: theme.surface,
          borderColor: theme.borderStrong,
          borderWidth: 1,
          borderRadius: MOBILE_V2_RADII.card,
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING.lg,
        }}
      >
        <FxRow gap={MOBILE_V2_SPACING.md} align="center">
          <FxIcon name="pin" size={18} color={theme.accent} />
          <Text style={{ ...sansSemibold, color: theme.muted, fontSize: MOBILE_V2_TYPE_SIZES.sectionHead, letterSpacing: 0.8, textTransform: "uppercase" }}>
            Next stop
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={{ ...monoBold, color: theme.accent, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong }}>
            {nextStop.tracking}
          </Text>
        </FxRow>

        <Text style={{ ...sansSemibold, color: theme.ink, fontSize: 22 }}>
          {nextStop.addressLine1}
        </Text>

        <FxRow gap={MOBILE_V2_SPACING["3xl"]}>
          <View>
            <Text style={{ color: theme.muted, fontSize: MOBILE_V2_TYPE_SIZES.chip, fontFamily: MOBILE_V2_FONT_SANS }}>
              ETA
            </Text>
            <Text style={{ ...monoBold, color: theme.ink, fontSize: 28 }}>
              {nextStop.etaMinutes}
              <Text style={{ fontSize: 14, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium }}> min</Text>
            </Text>
          </View>
          <View>
            <Text style={{ color: theme.muted, fontSize: MOBILE_V2_TYPE_SIZES.chip, fontFamily: MOBILE_V2_FONT_SANS }}>
              Distance
            </Text>
            <Text style={{ ...monoBold, color: theme.ink, fontSize: 28 }}>
              {nextStop.distanceKm.toFixed(1)}
              <Text style={{ fontSize: 14, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium }}> km</Text>
            </Text>
          </View>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Text style={{ color: theme.muted, fontSize: MOBILE_V2_TYPE_SIZES.chip, fontFamily: MOBILE_V2_FONT_SANS }}>
              Window
            </Text>
            <Text style={{ ...monoBold, color: theme.ink, fontSize: 18 }}>
              {nextStop.window}
            </Text>
          </View>
        </FxRow>

        <FxButton theme={theme} variant="primary" full size="lg" icon="navigate" onPress={props.onNavigate}>
          Navigate
        </FxButton>

        <Pressable onPress={props.onSafetyBypass} accessibilityRole="button" accessibilityLabel="Safety bypass">
          <Text
            style={{
              textAlign: "center",
              color: theme.mutedSoft,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.chip,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
              textTransform: "uppercase",
            }}
          >
            Slow down to interact · Safety bypass is recorded
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
