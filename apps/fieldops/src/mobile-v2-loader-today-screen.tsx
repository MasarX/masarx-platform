// Mobile V2 Loader Today screen — pixel-faithful port of design source
// flow-loader.jsx ScrLoaderToday. Loader home dashboard: chrome hero with
// wave progress + circular ring, cut-off/cold-chain/routes stat strip,
// 2×3 quick-actions grid (Scan-out, Manifest, Bay board, Inbound dock,
// Hold queue, Sync), and drivers-in-queue list with avatar tiles.
//
// All values flow through props — zero hardcoded business literals per
// AGENTS.md. Counts/durations/ids resolve upstream.

import * as React from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  FxAvatar,
  FxCard,
  FxChip,
  FxCol,
  FxRow,
} from "./mobile-v2-primitives";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2LoaderQuickActionId =
  | "loader-scan"
  | "loader-manifest"
  | "bay-board"
  | "inbound"
  | "hold"
  | "sync";

export interface MobileV2LoaderQuickAction {
  readonly id: MobileV2LoaderQuickActionId;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly sub: string;
}

export type MobileV2LoaderDriverStatus = "loading" | "waiting";

export interface MobileV2LoaderDriverQueueEntry {
  readonly name: string;
  readonly route: string;
  readonly pct: number;
  readonly status: MobileV2LoaderDriverStatus;
}

export interface MobileV2LoaderTodayScreenProps {
  readonly theme: MobileV2Theme;
  readonly waveLabel: string;
  readonly cutOff: string;
  readonly coldChainCount: number;
  readonly liveRoutes: number;
  readonly totalParcels: number;
  readonly scannedParcels: number;
  readonly driversWaiting: number;
  readonly quickActions: ReadonlyArray<MobileV2LoaderQuickAction>;
  readonly drivers: ReadonlyArray<MobileV2LoaderDriverQueueEntry>;
  readonly onSelectAction?: (id: MobileV2LoaderQuickActionId) => void;
  readonly style?: StyleProp<ViewStyle>;
}

// Design `ScrLoaderToday` section heads (flow-loader.jsx:59,84) carry
// `margin:'18px 4px 8px'` — the 18/8 vertical gaps come from the
// surrounding rowGap + FxCol gap; the 4px horizontal inset is reproduced
// here so the head text aligns with the design (was flush at 16px → dX-4).
const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
  marginHorizontal: MOBILE_V2_SPACING.sm,
};

function initialsFrom(name: string): string {
  const parts = name.split(/\s+/).filter((p) => p.length > 0);
  return parts.map((p) => (p[0] ?? "").toUpperCase()).slice(0, 2).join("");
}

export function MobileV2LoaderTodayScreen(
  props: MobileV2LoaderTodayScreenProps,
): React.ReactElement {
  const { theme } = props;
  const pct = props.totalParcels > 0
    ? Math.round((props.scannedParcels / props.totalParcels) * 100)
    : 0;
  const remaining = props.totalParcels - props.scannedParcels;
  const circumference = 2 * Math.PI * 26;
  const dashLen = (pct / 100) * circumference;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["5xl"],
          paddingBottom: 96,
        }}
      >
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
                Wave progress
              </Text>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text
                  style={{
                    fontSize: 32,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    letterSpacing: -1,
                  }}
                >
                  {props.scannedParcels}
                </Text>
                <Text
                  style={{
                    fontSize: 32,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    opacity: 0.5,
                    letterSpacing: -1,
                  }}
                >
                  /{props.totalParcels}
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
                {remaining} parcels left · {props.driversWaiting} drivers waiting
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
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Cut-off
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                }}
              >
                {/* E6: the loader resolver honestly returns an empty
                    `cutOff` until a loader-wave source table ships — render
                    a neutral em-dash placeholder rather than a blank cell. */}
                {props.cutOff.length > 0 ? props.cutOff : "—"}
              </Text>
            </FxCol>
            <FxCol gap={2}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Cold-chain
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                }}
              >
                {props.coldChainCount} parcels
              </Text>
            </FxCol>
            <FxCol gap={2}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Routes
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                }}
              >
                {props.liveRoutes} live
              </Text>
            </FxCol>
          </FxRow>
        </View>

        {/* Quick actions */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Quick actions</Text>
          {/* Design grid (flow-loader.jsx:60) is `gap:10` with NO outer
              padding. Each cell adds `paddingVertical`/`paddingHorizontal`
              of 5 to build the 10px inter-card gutter; the negative margin
              on both axes cancels that padding at the grid's outer edges so
              the block is not 10px taller/wider than the design (was the
              source of the cumulative +10 dY on the drivers section). */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              marginHorizontal: -MOBILE_V2_SPACING.xl / 2,
              marginVertical: -MOBILE_V2_SPACING.xl / 2,
            }}
          >
            {props.quickActions.map((a) => (
              <View
                key={a.id}
                style={{
                  width: "50%",
                  paddingHorizontal: MOBILE_V2_SPACING.xl / 2,
                  paddingVertical: MOBILE_V2_SPACING.xl / 2,
                }}
              >
                <Pressable
                  onPress={() => props.onSelectAction?.(a.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.label} — ${a.sub}`}
                >
                  <FxCard theme={theme} padding={14}>
                    <FxRow gap={MOBILE_V2_SPACING.xl}>
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          backgroundColor: theme.accentSoft,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon name={a.icon} size={18} color={theme.accent} />
                      </View>
                      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          numberOfLines={1}
                        >
                          {a.label}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          numberOfLines={2}
                        >
                          {a.sub}
                        </Text>
                      </FxCol>
                    </FxRow>
                  </FxCard>
                </Pressable>
              </View>
            ))}
          </View>
        </FxCol>

        {/* Drivers in queue */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Drivers in queue</Text>
          <View
            style={{
              backgroundColor: theme.border,
              borderRadius: MOBILE_V2_RADII.card,
              overflow: "hidden",
              rowGap: 1,
            }}
          >
            {props.drivers.map((d) => (
              <View
                key={d.name + d.route}
                style={{
                  backgroundColor: theme.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }}
              >
                <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
                  <FxAvatar theme={theme} name={initialsFrom(d.name)} size={32} />
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      {d.name}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                      numberOfLines={1}
                    >
                      {d.route} · {d.pct}% loaded
                    </Text>
                  </FxCol>
                  <FxChip theme={theme} tone={d.status === "loading" ? "info" : "warning"} dense>
                    {d.status}
                  </FxChip>
                </FxRow>
              </View>
            ))}
          </View>
        </FxCol>
      </ScrollView>
    </View>
  );
}
