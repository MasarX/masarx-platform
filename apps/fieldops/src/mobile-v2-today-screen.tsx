// Mobile V2 Today (start) screen — pixel-faithful port of design source
// flow-today.jsx ScrToday. Driver home with shift progress hero + SLA
// risk banner + Continue card pointing at the active stop.
// Reference: docs/ops/evidence/2026-05-10/mobile-v2/reference/01-start.png

import * as React from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2TodayPreShiftBlocker {
  readonly key: string;
  readonly title: string;
}

export interface MobileV2TodayActiveStop {
  readonly id: string;
  readonly seq: number;
  readonly customer: string;
  readonly address: string;
  readonly sla: string;
  readonly cod: number;
  readonly fragile: boolean;
  /** Omitted when the live route read carries no parcel count. */
  readonly parcels?: number;
}

export interface MobileV2TodayScreenProps {
  readonly theme: MobileV2Theme;
  readonly done: number;
  readonly total: number;
  readonly pending: number;
  readonly failed: number;
  readonly slaRisk: number;
  readonly etaFinish: string;
  /** `null` when no live distance is known; the screen shows a dash. */
  readonly distanceKm: number | null;
  readonly codExpected: number;
  readonly codCurrency: string;
  readonly blockers: ReadonlyArray<MobileV2TodayPreShiftBlocker>;
  readonly activeStop: MobileV2TodayActiveStop | null;
  readonly onOpenPreShift?: () => void;
  readonly onOptimizeRoute?: () => void;
  readonly onContinueStop?: (stopId: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

/** The Today values one route read supplies (#600: live, or the showcase fixture). */
export type MobileV2TodaySummary = Pick<
  MobileV2TodayScreenProps,
  "done" | "total" | "pending" | "failed" | "slaRisk" | "etaFinish" | "distanceKm" | "codExpected" | "codCurrency" | "activeStop"
>;

export function MobileV2TodayScreen(props: MobileV2TodayScreenProps): React.ReactElement {
  const { theme } = props;
  const pct = props.total > 0 ? Math.round((props.done / props.total) * 100) : 0;
  const circumference = 2 * Math.PI * 26;
  const dashLen = (pct / 100) * circumference;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["4xl"], rowGap: MOBILE_V2_SPACING["3xl"], paddingBottom: 96 }}>
        {/* Pre-shift gate banner */}
        {props.blockers.length > 0 ? (
          <Pressable
            onPress={props.onOpenPreShift}
            accessibilityRole="button"
            accessibilityLabel="Open pre-shift checks"
          >
            <View
              style={{
                backgroundColor: theme.warningSoft,
                borderColor: theme.warning,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.card,
                padding: MOBILE_V2_SPACING["3xl"],
                flexDirection: "row",
                alignItems: "flex-start",
                columnGap: MOBILE_V2_SPACING.lg,
              }}
            >
              <FxIcon name="alert" size={20} color={theme.warning} />
              <FxCol gap={2} style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: theme.warning, fontFamily: MOBILE_V2_FONT_SANS }}>
                  Pre-shift checks needed · {props.blockers.length}
                </Text>
                <Text style={{ fontSize: 11.5, color: theme.warning, opacity: 0.85, fontFamily: MOBILE_V2_FONT_SANS }}>
                  {props.blockers.map((b) => b.title).join(" · ")}
                </Text>
              </FxCol>
              <FxIcon name="chevron-right" size={18} color={theme.warning} />
            </View>
          </Pressable>
        ) : null}

        {/* Hero progress on chrome */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: MOBILE_V2_RADII.card,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={4} style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: theme.onChrome, opacity: 0.7, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, fontFamily: MOBILE_V2_FONT_SANS }}>
                Today's route
              </Text>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={{ fontSize: 32, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome, letterSpacing: -1 }}>
                  {props.done}
                </Text>
                <Text style={{ fontSize: 32, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome, opacity: 0.5, letterSpacing: -1 }}>
                  /{props.total}
                </Text>
              </View>
              <Text style={{ fontSize: 12, color: theme.onChrome, opacity: 0.7, fontFamily: MOBILE_V2_FONT_SANS }}>
                {props.pending} pending · {props.failed} failed
              </Text>
            </FxCol>

            <View
              style={{
                width: MOBILE_V2_DIMENSIONS.progressRing,
                height: MOBILE_V2_DIMENSIONS.progressRing,
                position: "relative",
              }}
            >
              <Svg width={64} height={64} viewBox="0 0 64 64">
                <Circle cx={32} cy={32} r={26} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={6} />
                <Circle
                  cx={32}
                  cy={32}
                  r={26}
                  fill="none"
                  stroke={theme.accent}
                  strokeWidth={6}
                  strokeDasharray={`${dashLen} ${circumference}`}
                  strokeLinecap="round"
                  transform="rotate(-90 32 32)"
                />
              </Svg>
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                  }}
                >
                  {pct}%
                </Text>
              </View>
            </View>
          </FxRow>

          <View
            style={{
              height: 1,
              backgroundColor: "rgba(255,255,255,0.1)",
              marginVertical: MOBILE_V2_SPACING["2xl"],
            }}
          />

          <FxRow gap={MOBILE_V2_SPACING["4xl"]}>
            <FxCol gap={2}>
              <Text style={{ fontSize: 10, color: theme.onChrome, opacity: 0.6, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                ETA finish
              </Text>
              <Text style={{ fontSize: 14, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome }}>
                {props.etaFinish === "" ? "—" : props.etaFinish}
              </Text>
            </FxCol>
            <FxCol gap={2}>
              <Text style={{ fontSize: 10, color: theme.onChrome, opacity: 0.6, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                Distance
              </Text>
              <Text style={{ fontSize: 14, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome }}>
                {props.distanceKm === null ? "—" : `${props.distanceKm} km`}
              </Text>
            </FxCol>
            <FxCol gap={2}>
              <Text style={{ fontSize: 10, color: theme.onChrome, opacity: 0.6, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                COD due
              </Text>
              {/* Pin LTR so the strong-RTL rial sign ﷼ (U+FDFC) cannot
                  flip the amount to symbol-first. react-native-web
                  forwards `dir` to the DOM node; RN's TextProps omits it. */}
              <Text
                // @ts-expect-error — `dir` is a valid RN-Web Text prop.
                dir="ltr"
                style={{ fontSize: 14, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome }}
              >
                {formatMobileV2CurrencyCompact(props.codExpected, props.codCurrency)}
              </Text>
            </FxCol>
          </FxRow>
        </View>

        {/* SLA risk banner */}
        {props.slaRisk > 0 ? (
          <View
            style={{
              backgroundColor: theme.warningSoft,
              borderColor: theme.warning,
              borderWidth: 1,
              borderRadius: MOBILE_V2_RADII.card,
              padding: MOBILE_V2_SPACING["3xl"],
              flexDirection: "row",
              alignItems: "center",
              columnGap: MOBILE_V2_SPACING.lg,
            }}
          >
            <FxIcon name="alert" size={18} color={theme.warning} />
            <FxCol gap={2} style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: theme.warning, fontFamily: MOBILE_V2_FONT_SANS }}>
                {props.slaRisk} stop{props.slaRisk === 1 ? "" : "s"} at SLA risk
              </Text>
              <Text style={{ fontSize: 11.5, color: theme.warning, opacity: 0.85, fontFamily: MOBILE_V2_FONT_SANS }}>
                Resequence saves ~22 min · tap to optimize
              </Text>
            </FxCol>
            <FxButton theme={theme} variant="soft" size="sm" iconRight="arrow-right" onPress={props.onOptimizeRoute}>
              Fix
            </FxButton>
          </View>
        ) : null}

        {/* Continue card */}
        {props.activeStop !== null ? (
          <Pressable
            onPress={() => props.onContinueStop?.(props.activeStop!.id)}
            accessibilityRole="button"
            accessibilityLabel={`Continue to stop ${props.activeStop.seq}`}
          >
            <FxCard theme={theme} accent>
              <FxRow justify="space-between">
                <Text
                  style={{
                    fontSize: 10,
                    color: theme.accent,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Continue · stop {props.activeStop.seq}
                </Text>
                <FxIcon name="arrow-right" size={18} color={theme.accent} />
              </FxRow>
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  marginTop: MOBILE_V2_SPACING.md,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {props.activeStop.customer}
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  marginTop: 2,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {props.activeStop.address}
              </Text>
              <FxRow gap={MOBILE_V2_SPACING.md} wrap style={{ marginTop: MOBILE_V2_SPACING.lg }}>
                <FxChip theme={theme} tone="neutral" dense mono>
                  SLA {props.activeStop.sla}
                </FxChip>
                {props.activeStop.cod > 0 ? (
                  <FxChip theme={theme} tone="accent" icon="cash" dense mono>
                    {formatMobileV2CurrencyCompact(props.activeStop.cod, props.codCurrency)}
                  </FxChip>
                ) : null}
                {props.activeStop.fragile ? (
                  <FxChip theme={theme} tone="info" icon="package" dense>
                    Fragile
                  </FxChip>
                ) : null}
                {props.activeStop.parcels !== undefined ? (
                  <FxChip theme={theme} tone="neutral" dense mono>
                    {props.activeStop.parcels}× parcel
                  </FxChip>
                ) : null}
              </FxRow>
            </FxCard>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
