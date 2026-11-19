// Mobile V2 Inbound Dock screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrInbound. Loader-side dock receiving view:
// chrome hero (dock label + arrivals today + hint), then per-truck cards
// with truck-icon disk, trip id mono, tone-coded stage chip, leg title,
// vehicle/parcels/seal line, right-aligned ETA, and footer row with
// driver/planned-arrive + tone-coded CTA hint ("Verify seal · gate-out",
// "Wait for arrival", "Induct manifest").
//
// Stage labels come in as data so caller can resolve i18n upstream. The
// screen does not embed business literals — list items + dock label are
// pure props.

import * as React from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2InboundStage = "in-transit" | "arrived" | "gate-out";

export interface MobileV2InboundTruck {
  readonly id: string;
  readonly leg: string;
  readonly vehicle: string;
  readonly driver: string;
  readonly totalParcels: number;
  readonly sealNo: string | null;
  readonly stage: MobileV2InboundStage;
  readonly stageLabel: string;
  readonly etaMin: number;
  readonly plannedArrive: string;
}

export interface MobileV2InboundDockScreenProps {
  readonly theme: MobileV2Theme;
  readonly dockLabel: string;
  readonly trucks: ReadonlyArray<MobileV2InboundTruck>;
  readonly onSelectTruck?: (id: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

interface StageMeta {
  readonly tone: "info" | "warning" | "success";
  readonly cta: string;
}

const STAGE_META: Readonly<Record<MobileV2InboundStage, StageMeta>> = Object.freeze({
  "in-transit": { tone: "info", cta: "Wait for arrival" },
  arrived: { tone: "warning", cta: "Verify seal · gate-out" },
  "gate-out": { tone: "success", cta: "Induct manifest" },
});

function formatEta(etaMin: number): string {
  if (etaMin > 0) {
    const h = Math.floor(etaMin / 60);
    const m = etaMin % 60;
    return `${h}h ${m}m`;
  }
  if (etaMin === 0) {
    return "Now";
  }
  return `${Math.abs(etaMin)}m late`;
}

export function MobileV2InboundDockScreen(
  props: MobileV2InboundDockScreenProps,
): React.ReactElement {
  const { theme, trucks } = props;
  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["3xl"],
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
          <FxCol gap={4}>
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
              {props.dockLabel}
            </Text>
            <Text
              style={{
                fontSize: 24,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                color: theme.onChrome,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Today · {trucks.length} arrival{trucks.length === 1 ? "" : "s"}
            </Text>
            <Text
              style={{
                fontSize: 12,
                color: theme.onChrome,
                opacity: 0.7,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Tap a truck to gate-in · seal verify · induct manifest
            </Text>
          </FxCol>
        </View>

        {/* Truck cards */}
        <FxCol gap={MOBILE_V2_SPACING.xl}>
          {trucks.map((tr) => {
            const meta = STAGE_META[tr.stage];
            return (
              <Pressable
                key={tr.id}
                onPress={() => props.onSelectTruck?.(tr.id)}
                accessibilityRole="button"
                accessibilityLabel={`Truck ${tr.id} — ${meta.cta}`}
              >
                <FxCard theme={theme} padding={0}>
                  {/* Body — design source FxRow uses the default center
                      cross-axis alignment, so the truck-icon disk and the
                      ETA column sit centered against the multi-line middle
                      content (not pinned to the top). */}
                  <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
                    <FxRow gap={MOBILE_V2_SPACING["2xl"]}>
                      <View
                        style={{
                          width: 42,
                          height: 42,
                          borderRadius: 11,
                          backgroundColor: theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon name="truck" size={20} color={theme.muted} />
                      </View>
                      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                          <Text
                            style={{
                              fontSize: 10.5,
                              color: theme.muted,
                              fontFamily: MOBILE_V2_FONT_MONO,
                              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                            }}
                            numberOfLines={1}
                          >
                            {tr.id}
                          </Text>
                          <FxChip theme={theme} tone={meta.tone} dense>
                            {tr.stageLabel}
                          </FxChip>
                        </FxRow>
                        <Text
                          style={{
                            fontSize: 13.5,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                            marginTop: 2,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          numberOfLines={2}
                        >
                          {tr.leg}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11.5,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          // Design canvas ScrInbound wraps the
                          // vehicle/parcels/seal line to a second
                          // visual line at narrow card widths (e.g.
                          // "TR-8821 · 412 parcels · seal SEAL-44102"
                          // breaks before the seal id). Allow up to 2
                          // lines instead of truncating with ellipsis
                          // so impl mirrors design wrap behavior.
                          numberOfLines={2}
                        >
                          {tr.vehicle} · {tr.totalParcels} parcels · seal {tr.sealNo ?? "pending"}
                        </Text>
                      </FxCol>
                      <FxCol gap={2} style={{ alignItems: "flex-end" }}>
                        <Text
                          style={{
                            fontSize: 10,
                            color: theme.muted,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                            letterSpacing: 0.6,
                            textTransform: "uppercase",
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          ETA
                        </Text>
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_MONO,
                          }}
                        >
                          {formatEta(tr.etaMin)}
                        </Text>
                      </FxCol>
                    </FxRow>
                  </View>

                  {/* Footer hint row */}
                  <View
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      backgroundColor: theme.surfaceAlt,
                      borderTopColor: theme.border,
                      borderTopWidth: 1,
                      borderBottomLeftRadius: MOBILE_V2_RADII.card - 1,
                      borderBottomRightRadius: MOBILE_V2_RADII.card - 1,
                    }}
                  >
                    <FxRow justify="space-between" align="center">
                      <Text
                        style={{
                          fontSize: 11,
                          color: theme.muted,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          fontFamily: MOBILE_V2_FONT_SANS,
                          flex: 1,
                          minWidth: 0,
                        }}
                        numberOfLines={1}
                      >
                        {tr.driver} · planned {tr.plannedArrive}
                      </Text>
                      <Text
                        style={{
                          fontSize: 11.5,
                          color: theme.accent,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                      >
                        {meta.cta} →
                      </Text>
                    </FxRow>
                  </View>
                </FxCard>
              </Pressable>
            );
          })}

          {trucks.length === 0 ? (
            <FxCard theme={theme} padding={20}>
              <FxCol gap={MOBILE_V2_SPACING.sm} style={{ alignItems: "center" }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  No trucks expected
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Inbound dock is clear.
                </Text>
              </FxCol>
            </FxCard>
          ) : null}
        </FxCol>
      </ScrollView>
    </View>
  );
}
