// Mobile V2 Trip Nav screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrTripNav. Live in-transit nav for line-haul
// drivers: full-bleed map placeholder, floating chrome ETA card (top),
// floating next-instruction card (above the bottom action row), and
// dual-button action footer (Report incident / I have arrived).

import * as React from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import { formatMobileV2Eta } from "./mobile-v2-ops-helpers";

export interface MobileV2TripNavTrip {
  readonly id: string;
  readonly vehicle: string;
  readonly destName: string;
  /** Minutes until arrival; 0 means "Now". */
  readonly etaMin: number;
  readonly distanceKm: number;
  readonly plannedArrive: string;
  readonly nextInstructionPrimary: string;
  readonly nextInstructionSecondary: string;
}

export interface MobileV2TripNavScreenProps {
  readonly theme: MobileV2Theme;
  readonly trip: MobileV2TripNavTrip;
  readonly onCallHub?: () => void;
  readonly onReportIncident?: () => void;
  readonly onArrived?: () => void;
  readonly isArriving?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2TripNavScreen(
  props: MobileV2TripNavScreenProps,
): React.ReactElement {
  const { theme, trip } = props;
  return (
    <View style={[{ flex: 1, backgroundColor: theme.surfaceAlt }, props.style]}>
      {/* Map placeholder full-bleed */}
      <View
        style={{
          flex: 1,
          backgroundColor: theme.surfaceAlt,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FxIcon name="route" size={80} color={theme.muted} />
        <Text
          style={{
            marginTop: MOBILE_V2_SPACING.md,
            color: theme.muted,
            fontSize: 11,
            fontFamily: MOBILE_V2_FONT_SANS,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          }}
        >
          Map · {trip.destName}
        </Text>
      </View>

      {/* Top ETA card */}
      <View style={{ position: "absolute", top: 14, left: 14, right: 14 }}>
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 18,
            padding: MOBILE_V2_SPACING["2xl"],
          }}
        >
          <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.lg}>
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.7,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
                numberOfLines={1}
              >
                ETA · {trip.destName}
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                }}
              >
                {formatMobileV2Eta(trip.etaMin)}
              </Text>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {trip.distanceKm} km · arrive ~{trip.plannedArrive}
              </Text>
            </FxCol>
            <View
              style={{
                width: 54,
                height: 54,
                borderRadius: 14,
                backgroundColor: "rgba(255,255,255,0.14)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FxIcon name="truck" size={26} color={theme.onChrome} />
            </View>
          </FxRow>
        </View>
      </View>

      {/* Floating next-instruction card */}
      <View style={{ position: "absolute", bottom: 96, left: 14, right: 14 }}>
        <FxCard theme={theme} padding={14}>
          <FxRow gap={MOBILE_V2_SPACING.md} align="center">
            <View
              style={{
                width: 42,
                height: 42,
                borderRadius: 11,
                backgroundColor: theme.accentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FxIcon name="arrow-up" size={22} color={theme.accent} />
            </View>
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
                numberOfLines={1}
              >
                {trip.nextInstructionPrimary}
              </Text>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
                numberOfLines={2}
              >
                {trip.nextInstructionSecondary}
              </Text>
            </FxCol>
            <FxButton
              theme={theme}
              variant="ghost"
              size="sm"
              icon="phone"
              onPress={props.onCallHub}
              accessibilityLabel="Call hub"
            >
              Hub
            </FxButton>
          </FxRow>
        </FxCard>
      </View>

      {/* Bottom action row */}
      <View style={{ position: "absolute", bottom: 14, left: 14, right: 14 }}>
        <FxRow gap={MOBILE_V2_SPACING.sm} align="stretch">
          <View style={{ flex: 1 }}>
            <FxButton
              theme={theme}
              variant="soft"
              size="lg"
              icon="alert"
              full
              onPress={props.onReportIncident}
              accessibilityLabel="Report incident"
            >
              Report incident
            </FxButton>
          </View>
          <View style={{ flex: 2 }}>
            <FxButton
              theme={theme}
              variant="success"
              size="lg"
              icon="pin"
              full
              onPress={props.onArrived}
              disabled={props.isArriving === true}
              accessibilityLabel="I have arrived"
            >
              I have arrived
            </FxButton>
          </View>
        </FxRow>
      </View>
    </View>
  );
}
