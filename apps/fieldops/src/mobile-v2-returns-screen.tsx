// Mobile V2 Returns to hub screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrReturns. Driver returns failed/RTO stops to
// the hub: chrome hero (count + scan), failed list with mark-returned,
// returned list (read-only), empty state, and cash-drop CTA at bottom.
// Inputs are row-driven via props; production sources via
// resolve_fieldops_returns_v1.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2ReturnsStop {
  readonly id: string;
  readonly seq: number;
  readonly customer: string;
  readonly addr: string;
  readonly parcels: number;
  readonly failReason: string;
}

export interface MobileV2ReturnsRtoStop {
  readonly id: string;
  readonly stopId?: string;
  readonly customer: string;
  readonly parcels: number;
}

export interface MobileV2ReturnsReadback {
  readonly decisionLogId: string;
  readonly stopId: string;
  readonly returnedId: string;
  readonly customer: string;
  readonly parcels: number;
}

export interface MobileV2ReturnsScreenProps {
  readonly theme: MobileV2Theme;
  readonly failed: ReadonlyArray<MobileV2ReturnsStop>;
  readonly returned: ReadonlyArray<MobileV2ReturnsRtoStop>;
  readonly latestReturn?: MobileV2ReturnsReadback | null;
  readonly returningStopId?: string | null;
  /** Amount of cash collected today (raw number). Currency-agnostic. */
  readonly codCollected: number;
  /** ISO currency code, defaults to "SAR". Resolved upstream via policy. */
  readonly currency?: string;
  readonly onMarkReturned: (stopId: string) => void;
  readonly onScanPress?: () => void;
  readonly onCashDropPress?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
  paddingHorizontal: MOBILE_V2_SPACING.xs,
};

export function MobileV2ReturnsScreen(
  props: MobileV2ReturnsScreenProps,
): React.ReactElement {
  const { theme, failed, returned } = props;
  const failParcels = failed.reduce((n, s) => n + s.parcels, 0);
  const rtoParcels = returned.reduce((n, s) => n + s.parcels, 0);
  const totalStops = failed.length + returned.length;
  const totalParcels = failParcels + rtoParcels;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING["3xl"],
          paddingBottom: 96,
        }}
      >
        {/* Chrome hero */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 22,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
            <FxCol gap={MOBILE_V2_SPACING.xs} style={{ flex: 1, minWidth: 0 }}>
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
                Bring back to hub
              </Text>
              <FxRow gap={6} align="flex-end">
                <Text
                  style={{
                    fontSize: 32,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    letterSpacing: -1,
                  }}
                >
                  {totalStops}
                </Text>
                <Text
                  style={{
                    fontSize: 18,
                    color: theme.onChrome,
                    opacity: 0.45,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    paddingBottom: 4,
                  }}
                >
                  {" "}
                  stops
                </Text>
              </FxRow>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {totalParcels} parcels · scan each one at the return desk
              </Text>
            </FxCol>
            <FxButton
              theme={theme}
              variant="primary"
              size="sm"
              icon="scan"
              onPress={props.onScanPress}
              accessibilityLabel="Scan parcel at return desk"
            >
              Scan
            </FxButton>
          </FxRow>
        </View>

        {/* Failed delivery section */}
        {failed.length > 0 ? (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>
              Failed delivery · {failed.length}
            </Text>
            <FxCol gap={MOBILE_V2_SPACING.sm}>
              {failed.map((s) => (
                <FxCard key={s.id} theme={theme} padding={0}>
                  <FxRow
                    gap={MOBILE_V2_SPACING.md}
                    align="center"
                    style={{ paddingHorizontal: 14, paddingVertical: 12 }}
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        backgroundColor: theme.warningSoft,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text
                        style={{
                          color: theme.warning,
                          fontFamily: MOBILE_V2_FONT_MONO,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          fontSize: 13,
                        }}
                      >
                        {s.seq}
                      </Text>
                    </View>
                    <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          fontSize: 13.5,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          color: theme.ink,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {s.customer}
                      </Text>
                      <Text
                        style={{
                          fontSize: 11.5,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {s.addr}
                      </Text>
                      <Text
                        style={{
                          fontSize: 10.5,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_MONO,
                        }}
                        numberOfLines={1}
                      >
                        {s.parcels} parcel{s.parcels === 1 ? "" : "s"} · {s.failReason}
                      </Text>
                    </FxCol>
                    <FxButton
                      theme={theme}
                      variant="primary"
                      size="sm"
                      icon="check"
                      onPress={() => props.onMarkReturned(s.id)}
                      disabled={props.returningStopId === s.id}
                      accessibilityLabel={`Mark ${s.customer} returned`}
                    >
                      {props.returningStopId === s.id ? "Saving" : "Mark returned"}
                    </FxButton>
                  </FxRow>
                </FxCard>
              ))}
            </FxCol>
          </FxCol>
        ) : null}

        {/* Returned section */}
        {returned.length > 0 ? (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>
              Returned · {returned.length}
            </Text>
            <FxCard theme={theme} padding={0}>
              {returned.map((s, idx) => (
                <FxRow
                  key={s.id}
                  gap={MOBILE_V2_SPACING.md}
                  align="center"
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderBottomColor: theme.border,
                    borderBottomWidth: idx === returned.length - 1 ? 0 : 1,
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      backgroundColor: theme.successSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name="check" size={14} color={theme.success} />
                  </View>
                  <FxCol gap={1} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 12.5,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      {s.customer}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                      numberOfLines={1}
                    >
                      {s.id} · {s.parcels} parcel{s.parcels === 1 ? "" : "s"}
                    </Text>
                  </FxCol>
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Returned
                  </Text>
                </FxRow>
              ))}
            </FxCard>
          </FxCol>
        ) : null}

        {/* Same-context confirmation for the latest returned stop */}
        {props.latestReturn !== undefined && props.latestReturn !== null ? (
          <FxCard theme={theme} padding={MOBILE_V2_SPACING["3xl"]} accent>
            <FxRow gap={MOBILE_V2_SPACING.lg} align="flex-start">
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: theme.successSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="check" size={16} color={theme.success} />
              </View>
              <FxCol gap={MOBILE_V2_SPACING.sm} style={{ flex: 1, minWidth: 0 }}>
                <FxRow gap={MOBILE_V2_SPACING.sm} align="center" wrap>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Latest return saved
                  </Text>
                  <FxChip theme={theme} tone="success" dense>
                    Returned
                  </FxChip>
                </FxRow>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                  numberOfLines={2}
                >
                  {props.latestReturn.customer} · {props.latestReturn.returnedId} · {props.latestReturn.parcels} parcel{props.latestReturn.parcels === 1 ? "" : "s"}
                </Text>
                <Text
                  style={{
                    fontSize: 10.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                  numberOfLines={1}
                >
                  Decision {props.latestReturn.decisionLogId.slice(0, 8)} · stop {props.latestReturn.stopId.slice(0, 8)}
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>
        ) : null}

        {/* Empty state */}
        {failed.length === 0 && returned.length === 0 ? (
          <FxCard theme={theme} padding={20}>
            <FxCol gap={MOBILE_V2_SPACING.md} style={{ alignItems: "center" }}>
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  backgroundColor: theme.successSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="check" size={22} color={theme.success} />
              </View>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Nothing to return
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  textAlign: "center",
                }}
              >
                All stops were delivered or rescheduled.
              </Text>
            </FxCol>
          </FxCard>
        ) : null}

        {/* Divider + cash drop */}
        <View style={{ height: 1, backgroundColor: theme.border, marginVertical: 4 }} />
        <FxButton
          theme={theme}
          variant="soft"
          full
          icon="cash"
          onPress={props.onCashDropPress}
          accessibilityLabel="Open cash drop"
        >
          Cash drop · {formatMobileV2CurrencyCompact(props.codCollected, props.currency ?? "SAR")}
        </FxButton>
      </ScrollView>
    </View>
  );
}
