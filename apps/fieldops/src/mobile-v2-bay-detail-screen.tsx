// Mobile V2 Bay Detail screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrBayDetail. Single sortation bay deep view:
// chrome hero with "Inducted into bay" count/capacity + large circular
// progress ring + remaining slots, then a duo of action buttons
// (Continue induction / View trip, Seal bay), and a "Recent inductions
// in this bay" card listing parcel id + dest + relative-seconds badge.
//
// Bay state + recent-induction list are pure props. The screen does not
// embed any business literals beyond display chrome.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2BayDetailInduction {
  readonly id: string;
  readonly parcel: string;
  readonly dest: string;
  /** Milliseconds since induction. Displayed as `${seconds}s`. */
  readonly ageMs: number;
}

export interface MobileV2BayDetailScreenProps {
  readonly theme: MobileV2Theme;
  readonly bayId: string;
  readonly bayLabel: string;
  readonly routeId: string | null;
  readonly transfer: boolean;
  readonly exception: boolean;
  readonly count: number;
  readonly capacity: number;
  readonly recent: ReadonlyArray<MobileV2BayDetailInduction>;
  readonly onContinue?: () => void;
  readonly onSealBay?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
  paddingHorizontal: MOBILE_V2_SPACING.sm,
};

export function MobileV2BayDetailScreen(
  props: MobileV2BayDetailScreenProps,
): React.ReactElement {
  const { theme } = props;
  const pct =
    props.capacity > 0
      ? Math.max(0, Math.min(100, Math.round((props.count / props.capacity) * 100)))
      : 0;
  const remaining = Math.max(0, props.capacity - props.count);
  // Match design source: outer ring r=42, stroke 6 → circumference 2π·42 ≈ 263.89
  const circumference = 2 * Math.PI * 42;
  const dashLen = (pct / 100) * circumference;

  const headerSub =
    props.routeId !== null
      ? props.routeId
      : props.transfer
      ? "Inter-hub transfer"
      : "Exception · review";
  const tone = props.exception ? "danger" : pct >= 90 ? "warning" : "success";
  const continueLabel = props.transfer ? "View trip" : "Continue induction";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          paddingBottom: 96,
        }}
      >
        {/* In-body header chip strip stripped — the gallery / host ScreenShell
            now renders the title ("Bay <id> · <label>") and subtitle
            (routeId | transfer/exception) via FxAppBar. The pct chip used to
            live here:

              <FxChip theme={theme} tone={tone} dense mono>
                {`${pct}%`}
              </FxChip>

            The host should re-surface that via the AppBar `right` prop. */}

        {/* Chrome hero */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: MOBILE_V2_RADII.card,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={4} style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.onChrome,
                  opacity: 0.7,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Inducted into bay
              </Text>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    letterSpacing: -1,
                  }}
                >
                  {props.count}
                </Text>
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    opacity: 0.45,
                    letterSpacing: -1,
                  }}
                >
                  /{props.capacity}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {remaining} slots remaining
              </Text>
            </FxCol>

            {/* Design source ring div is 90×90 content + 6px border under
                content-box sizing → 102×102 outer. RN Views are border-box,
                so size the View to 102 (90 inner ring) to reproduce the
                design's row-height contribution. */}
            <View
              style={{
                width: 102,
                height: 102,
                borderRadius: 51,
                borderColor: "rgba(255,255,255,0.18)",
                borderWidth: 6,
                position: "relative",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Svg
                width={102}
                height={102}
                viewBox="0 0 90 90"
                style={{ position: "absolute", top: 0, left: 0 }}
              >
                <Circle
                  cx={45}
                  cy={45}
                  r={42}
                  fill="none"
                  stroke={theme.accent}
                  strokeWidth={6}
                  strokeDasharray={`${dashLen} ${circumference}`}
                  strokeLinecap="round"
                  transform="rotate(-90 45 45)"
                />
              </Svg>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                }}
              >
                {pct}%
              </Text>
            </View>
          </FxRow>
        </View>

        {/* Action duo — design source applies marginTop:12 below the hero. */}
        <FxRow gap={MOBILE_V2_SPACING.lg} style={{ marginTop: MOBILE_V2_SPACING["2xl"] }}>
          <FxButton
            theme={theme}
            variant="primary"
            icon="truck"
            onPress={props.onContinue}
            style={{ flexGrow: 1, flexBasis: 0 }}
            accessibilityLabel={continueLabel}
          >
            {continueLabel}
          </FxButton>
          <FxButton
            theme={theme}
            variant="soft"
            icon="check"
            onPress={props.onSealBay}
            style={{ flexGrow: 1, flexBasis: 0 }}
            accessibilityLabel={`Seal bay ${props.bayId}`}
          >
            Seal bay
          </FxButton>
        </FxRow>

        {/* Recent inductions — design source section head carries
            margin:'18px 4px 8px'; the 18px top + 8px bottom are applied
            as the column marginTop and the head→card gap. */}
        <FxCol gap={MOBILE_V2_SPACING.lg} style={{ marginTop: MOBILE_V2_SPACING["5xl"] }}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>
            {`Recent inductions in this bay · ${props.recent.length}`}
          </Text>
          <FxCard theme={theme} padding={0}>
            {props.recent.length === 0 ? (
              <View style={{ padding: 20 }}>
                <Text
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  No parcels inducted to this bay yet.
                </Text>
              </View>
            ) : (
              props.recent.map((r, i) => (
                <View
                  key={r.id}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderBottomColor: theme.border,
                    borderBottomWidth: i < props.recent.length - 1 ? 1 : 0,
                  }}
                >
                  <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        backgroundColor: theme.surfaceAlt,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <FxIcon name="package" size={14} color={theme.muted} />
                    </View>
                    <FxCol gap={1} style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          fontSize: 12.5,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          fontFamily: MOBILE_V2_FONT_MONO,
                          color: theme.ink,
                        }}
                        numberOfLines={1}
                      >
                        {r.parcel}
                      </Text>
                      <Text
                        style={{
                          fontSize: 11,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {r.dest}
                      </Text>
                    </FxCol>
                    <Text
                      style={{
                        fontSize: 10.5,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {Math.max(0, Math.round(r.ageMs / 1000))}s
                    </Text>
                  </FxRow>
                </View>
              ))
            )}
          </FxCard>
        </FxCol>
      </ScrollView>
    </View>
  );
}
