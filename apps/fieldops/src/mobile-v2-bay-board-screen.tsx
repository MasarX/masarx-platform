// Mobile V2 Bay Board screen — pixel-faithful port of design source
// flow-loader.jsx ScrBayBoard. Loader-side dock overview: one card per
// bay with letter tile, driver + route line, tone-coded status chip,
// and (when loading) an accent-fill progress bar at the bottom.
//
// Bays + statuses arrive as data props — caller resolves them from the
// canonical bay registry / shift state. No bay literals here.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2BayStatus = "free" | "loading" | "waiting" | "maint";

export interface MobileV2BayEntry {
  readonly id: string;
  readonly driver: string;
  readonly route: string | null;
  readonly status: MobileV2BayStatus;
  readonly pct: number;
}

export interface MobileV2BayBoardScreenProps {
  readonly theme: MobileV2Theme;
  readonly bays: ReadonlyArray<MobileV2BayEntry>;
  readonly style?: StyleProp<ViewStyle>;
}

interface BayStatusMeta {
  readonly tone: "success" | "info" | "warning" | "neutral";
  readonly label: string;
}

const BAY_STATUS_META: Readonly<Record<MobileV2BayStatus, BayStatusMeta>> = Object.freeze({
  free: { tone: "success", label: "Free" },
  loading: { tone: "info", label: "Loading" },
  waiting: { tone: "warning", label: "Waiting" },
  maint: { tone: "neutral", label: "Maintenance" },
});

export function MobileV2BayBoardScreen(
  props: MobileV2BayBoardScreenProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING.xl,
          paddingBottom: 96,
        }}
      >
        {props.bays.map((b) => {
          const m = BAY_STATUS_META[b.status];
          return (
            <FxCard key={b.id} theme={theme} padding={14}>
              <FxRow gap={MOBILE_V2_SPACING["2xl"]} align="center">
                {/* Letter tile */}
                <View
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 12,
                    backgroundColor: theme.surfaceAlt,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 20,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      color: theme.ink,
                    }}
                  >
                    {b.id}
                  </Text>
                </View>

                <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                  <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
                    <Text
                      style={{
                        fontSize: 13.5,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      Bay {b.id}
                    </Text>
                    <FxChip theme={theme} tone={m.tone} dense>
                      {m.label}
                    </FxChip>
                  </FxRow>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                    numberOfLines={1}
                  >
                    {b.driver}
                    {b.route !== null ? ` · ${b.route}` : ""}
                  </Text>
                  {b.status === "loading" ? (
                    <View
                      style={{
                        height: 5,
                        backgroundColor: theme.surfaceAlt,
                        borderRadius: 3,
                        marginTop: 4,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${Math.max(0, Math.min(100, b.pct))}%`,
                          backgroundColor: theme.accent,
                        }}
                      />
                    </View>
                  ) : null}
                </FxCol>
              </FxRow>
            </FxCard>
          );
        })}

        {props.bays.length === 0 ? (
          <FxCard theme={theme} padding={24}>
            <Text
              style={{
                textAlign: "center",
                fontSize: 12,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              No bays configured.
            </Text>
          </FxCard>
        ) : null}
      </ScrollView>
    </View>
  );
}
