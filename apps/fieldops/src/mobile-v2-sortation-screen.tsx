// Mobile V2 Sortation screen — pixel-faithful port of design source
// flow-network.jsx ScrSortation. Cross-dock parcel induction with a
// chrome hero (inducted total + throughput + capacity) + giant scan
// CTA + 2-col bay grid + recent inductions list.

import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
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

export interface MobileV2SortationBay {
  readonly id: string;
  readonly label: string;
  readonly routeId: string | null;
  readonly transfer: boolean;
  readonly exception: boolean;
  readonly count: number;
  readonly capacity: number;
}

export interface MobileV2SortationInduction {
  readonly id: string;
  readonly parcel: string;
  readonly bay: string;
  readonly dest: string;
  readonly at: string;
}

export interface MobileV2SortationScreenProps {
  readonly theme: MobileV2Theme;
  readonly bays: ReadonlyArray<MobileV2SortationBay>;
  readonly recent: ReadonlyArray<MobileV2SortationInduction>;
  readonly inductedThisSession: number;
  readonly throughputPerHour: number;
  readonly minutesElapsed: number;
  readonly onScanInduct: () => void;
  readonly onOpenBay: (bay: MobileV2SortationBay) => void;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

function BayTile({
  theme,
  bay,
  onPress,
}: {
  readonly theme: MobileV2Theme;
  readonly bay: MobileV2SortationBay;
  readonly onPress: () => void;
}): React.ReactElement {
  const pct = bay.capacity > 0 ? Math.round((bay.count / bay.capacity) * 100) : 0;
  const tone: FxChipTone = bay.exception ? "danger" : pct >= 90 ? "warning" : "success";
  const tileBg = bay.exception ? theme.dangerSoft : bay.transfer ? theme.infoSoft : theme.accentSoft;
  const tileFg = bay.exception ? theme.danger : bay.transfer ? theme.info : theme.accent;
  const barColor = bay.exception ? theme.danger : bay.transfer ? theme.info : theme.accent;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open bay ${bay.id} ${bay.label}`}
      style={{ flex: 1 }}
    >
      <View
        style={{
          backgroundColor: theme.surface,
          borderColor: bay.exception ? theme.danger : theme.border,
          borderWidth: 1,
          borderRadius: MOBILE_V2_RADII.card,
          padding: MOBILE_V2_SPACING["2xl"],
          rowGap: MOBILE_V2_SPACING.md,
        }}
      >
        <FxRow justify="space-between" align="flex-start">
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              backgroundColor: tileBg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: tileFg,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_MONO,
                fontSize: 14,
              }}
            >
              {bay.id}
            </Text>
          </View>
          <FxChip theme={theme} tone={tone} dense mono>
            {pct}%
          </FxChip>
        </FxRow>
        <Text
          style={{
            fontSize: 12.5,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            color: theme.ink,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {bay.label}
        </Text>
        <Text
          style={{
            fontSize: 10.5,
            color: theme.muted,
            fontFamily: MOBILE_V2_FONT_MONO,
          }}
          numberOfLines={1}
        >
          {bay.routeId ?? (bay.transfer ? "Inter-hub" : "Review")}
        </Text>
        <View
          style={{
            marginTop: MOBILE_V2_SPACING.sm,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.surfaceAlt,
            overflow: "hidden",
          }}
        >
          <View style={{ height: "100%", width: `${pct}%`, backgroundColor: barColor }} />
        </View>
        <Text
          style={{
            fontSize: 11,
            color: theme.muted,
            fontFamily: MOBILE_V2_FONT_MONO,
          }}
        >
          {bay.count}/{bay.capacity}
        </Text>
      </View>
    </Pressable>
  );
}

export function MobileV2SortationScreen(props: MobileV2SortationScreenProps): React.ReactElement {
  const { theme, bays, recent } = props;
  const totalIn = bays.reduce((n, b) => n + b.count, 0);
  const totalCap = bays.reduce((n, b) => n + b.capacity, 0);
  const capacityPct = totalCap > 0 ? Math.round((totalIn / totalCap) * 100) : 0;

  // Build 2-col rows
  const rows: Array<ReadonlyArray<MobileV2SortationBay>> = [];
  for (let i = 0; i < bays.length; i += 2) {
    rows.push(bays.slice(i, i + 2));
  }

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["4xl"], rowGap: MOBILE_V2_SPACING["3xl"], paddingBottom: 96 }}>
        {/* Chrome hero */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: MOBILE_V2_RADII.card,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={4}>
              <Text style={{ fontSize: 11, color: theme.onChrome, opacity: 0.7, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, fontFamily: MOBILE_V2_FONT_SANS }}>
                Inducted this session
              </Text>
              <Text style={{ fontSize: 32, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome, letterSpacing: -1 }}>
                {props.inductedThisSession}
              </Text>
              <Text style={{ fontSize: 12, color: theme.onChrome, opacity: 0.7, fontFamily: MOBILE_V2_FONT_SANS }}>
                {props.throughputPerHour}/hr throughput · {props.minutesElapsed}m elapsed
              </Text>
            </FxCol>
            <FxCol gap={2} style={{ alignItems: "flex-end" }}>
              <Text style={{ fontSize: 10, color: theme.onChrome, opacity: 0.6, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                Capacity
              </Text>
              <Text style={{ fontSize: 18, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome }}>
                {totalIn}/{totalCap}
              </Text>
              <Text style={{ fontSize: 11, color: theme.onChrome, opacity: 0.6, fontFamily: MOBILE_V2_FONT_SANS, marginTop: 2 }}>
                {capacityPct}% full
              </Text>
            </FxCol>
          </FxRow>
          <View style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}>
            <FxButton theme={theme} variant="primary" full size="lg" icon="scan" onPress={props.onScanInduct}>
              Scan parcel · auto-route
            </FxButton>
          </View>
        </View>

        {/* Bays grid */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
            Sort bays
          </Text>
          <FxCol gap={MOBILE_V2_SPACING.md}>
            {rows.map((row, i) => (
              <FxRow key={i} gap={MOBILE_V2_SPACING.md}>
                {row.map((b) => (
                  <BayTile key={b.id} theme={theme} bay={b} onPress={() => props.onOpenBay(b)} />
                ))}
                {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
              </FxRow>
            ))}
          </FxCol>
        </FxCol>

        {/* Recent inductions */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxRow justify="space-between" align="center" style={{ paddingHorizontal: MOBILE_V2_SPACING.xs }}>
            <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
              Recent inductions
            </Text>
            <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_MONO }}>
              {recent.length} this session
            </Text>
          </FxRow>
          <FxCard theme={theme} padding={0}>
            {recent.length === 0 ? (
              <View style={{ padding: MOBILE_V2_SPACING["4xl"], alignItems: "center" }}>
                <FxIcon name="package" size={28} color={theme.mutedSoft} />
                <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS, fontSize: MOBILE_V2_TYPE_SIZES.body, marginTop: MOBILE_V2_SPACING.lg }}>
                  Scan a parcel to start
                </Text>
              </View>
            ) : (
              recent.map((r, idx) => (
                <FxRow
                  key={r.id}
                  gap={MOBILE_V2_SPACING.lg}
                  align="center"
                  style={{
                    paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                    paddingVertical: MOBILE_V2_SPACING.xl,
                    borderBottomColor: theme.border,
                    borderBottomWidth: idx === recent.length - 1 ? 0 : StyleSheet.hairlineWidth,
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      backgroundColor: r.bay === "?" ? theme.dangerSoft : theme.accentSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: r.bay === "?" ? theme.danger : theme.accent, fontFamily: MOBILE_V2_FONT_MONO, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontSize: 13 }}>
                      {r.bay}
                    </Text>
                  </View>
                  <FxCol gap={2} style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, color: theme.ink, fontFamily: MOBILE_V2_FONT_MONO }}>
                      {r.parcel}
                    </Text>
                    <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }} numberOfLines={1}>
                      {r.dest}
                    </Text>
                  </FxCol>
                  <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_MONO, letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip }}>
                    {r.at}
                  </Text>
                </FxRow>
              ))
            )}
          </FxCard>
        </FxCol>
      </ScrollView>
    </View>
  );
}
