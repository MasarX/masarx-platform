// Mobile V2 Lookup screen — pixel-faithful port of design source
// flow-network.jsx ScrLookup. Universal shipment search with scan
// affordance + recent lookups + cross-domain match rendering.

import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2LookupRecordKind = "stop" | "pickup";

export interface MobileV2LookupRecord {
  readonly id: string;
  readonly kind: MobileV2LookupRecordKind;
  readonly parcel: string;
  readonly customer: string;
  readonly area: string;
  readonly status: string;
}

export interface MobileV2LookupRecent {
  readonly wb: string;
  readonly customer: string;
  readonly stage: string;
  /** ISO timestamp; UI formats minutes-ago. */
  readonly atIso: string;
}

export interface MobileV2LookupScreenProps {
  readonly theme: MobileV2Theme;
  readonly records: ReadonlyArray<MobileV2LookupRecord>;
  readonly recent: ReadonlyArray<MobileV2LookupRecent>;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly onScanPress?: () => void;
  readonly onOpenRecord: (record: MobileV2LookupRecord) => void;
  readonly onOpenRecent?: (recent: MobileV2LookupRecent) => void;
  readonly style?: StyleProp<ViewStyle>;
}

function minutesAgo(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  const m = Math.max(0, Math.round((Date.now() - d) / 60000));
  return `${m}m`;
}

export function MobileV2LookupScreen(props: MobileV2LookupScreenProps): React.ReactElement {
  const { theme } = props;
  const trimmed = props.query.trim().toLowerCase();

  const matches = React.useMemo(() => {
    if (trimmed.length === 0) return [] as ReadonlyArray<MobileV2LookupRecord>;
    return props.records
      .filter((r) => `${r.id} ${r.parcel} ${r.customer} ${r.area}`.toLowerCase().includes(trimmed))
      .slice(0, 10);
  }, [props.records, trimmed]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["3xl"], rowGap: MOBILE_V2_SPACING["3xl"], paddingBottom: 96 }}>
        {/* Search bar with inline yellow Scan label button */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: theme.surfaceAlt,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: MOBILE_V2_RADII.button,
            paddingLeft: MOBILE_V2_SPACING["2xl"],
            columnGap: MOBILE_V2_SPACING.lg,
            overflow: "hidden",
          }}
        >
          <FxIcon name="search" size={16} color={theme.muted} />
          <TextInput
            value={props.query}
            onChangeText={props.onQueryChange}
            placeholder="Waybill · parcel ID · customer · merchant"
            placeholderTextColor={theme.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Search shipments"
            style={{
              flex: 1,
              paddingVertical: MOBILE_V2_SPACING["2xl"],
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
            }}
          />
          <Pressable
            onPress={props.onScanPress}
            accessibilityRole="button"
            accessibilityLabel="Scan label"
            style={{
              backgroundColor: theme.accent,
              paddingHorizontal: MOBILE_V2_SPACING["2xl"],
              paddingVertical: MOBILE_V2_SPACING.lg,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              columnGap: MOBILE_V2_SPACING.sm,
            }}
          >
            <FxIcon name="scan" size={14} color={theme.accentInk} />
            <Text
              style={{
                color: theme.accentInk,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.chip,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              Scan label
            </Text>
          </Pressable>
        </View>

        {trimmed.length === 0 ? (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
              Recent lookups
            </Text>
            <FxCard theme={theme} padding={0}>
              {props.recent.length === 0 ? (
                <View style={{ padding: MOBILE_V2_SPACING["4xl"], alignItems: "center" }}>
                  <FxIcon name="search" size={28} color={theme.mutedSoft} />
                  <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS, marginTop: MOBILE_V2_SPACING.lg }}>
                    Scan or search to start tracking
                  </Text>
                </View>
              ) : (
                props.recent.map((r, idx) => (
                  <Pressable
                    key={r.wb}
                    onPress={props.onOpenRecent !== undefined ? () => props.onOpenRecent!(r) : undefined}
                    accessibilityRole="button"
                    accessibilityLabel={`Open recent lookup ${r.wb}`}
                  >
                    <FxRow
                      gap={MOBILE_V2_SPACING.lg}
                      align="center"
                      style={{
                        paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                        paddingVertical: MOBILE_V2_SPACING.xl,
                        borderBottomColor: theme.border,
                        borderBottomWidth: idx === props.recent.length - 1 ? 0 : StyleSheet.hairlineWidth,
                      }}
                    >
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 9,
                          backgroundColor: theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon name="package" size={16} color={theme.ink} />
                      </View>
                      <FxCol gap={2} style={{ flex: 1 }}>
                        <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: theme.ink, fontFamily: MOBILE_V2_FONT_MONO }}>
                          {r.wb}
                        </Text>
                        <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }} numberOfLines={1}>
                          {r.customer} · {r.stage}
                        </Text>
                      </FxCol>
                      <Text style={{ fontSize: 10.5, color: theme.muted, fontFamily: MOBILE_V2_FONT_MONO }}>
                        {minutesAgo(r.atIso)}
                      </Text>
                    </FxRow>
                  </Pressable>
                ))
              )}
            </FxCard>
          </FxCol>
        ) : (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
              {matches.length} match{matches.length === 1 ? "" : "es"}
            </Text>
            <FxCard theme={theme} padding={0}>
              {matches.length === 0 ? (
                <View style={{ padding: MOBILE_V2_SPACING["4xl"], alignItems: "center" }}>
                  <Text style={{ fontSize: 12, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                    No shipment matches "{props.query}"
                  </Text>
                </View>
              ) : (
                matches.map((m, idx) => (
                  <Pressable
                    key={m.id}
                    onPress={() => props.onOpenRecord(m)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${m.parcel} ${m.customer}`}
                  >
                    <FxRow
                      gap={MOBILE_V2_SPACING.lg}
                      align="center"
                      style={{
                        paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                        paddingVertical: MOBILE_V2_SPACING.xl,
                        borderBottomColor: theme.border,
                        borderBottomWidth: idx === matches.length - 1 ? 0 : StyleSheet.hairlineWidth,
                      }}
                    >
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 9,
                          backgroundColor: m.kind === "pickup" ? theme.infoSoft : theme.accentSoft,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon
                          name={m.kind === "pickup" ? "package" : "pin"}
                          size={15}
                          color={m.kind === "pickup" ? theme.info : theme.accent}
                        />
                      </View>
                      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <FxRow gap={MOBILE_V2_SPACING.md}>
                          <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: theme.ink, fontFamily: MOBILE_V2_FONT_MONO }}>
                            {m.parcel}
                          </Text>
                          <FxChip theme={theme} tone="neutral" dense>
                            {m.kind === "pickup" ? "First-mile" : "Last-mile"}
                          </FxChip>
                        </FxRow>
                        <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }} numberOfLines={1}>
                          {m.customer} · {m.area}
                        </Text>
                      </FxCol>
                      <FxIcon name="chevron-right" size={16} color={theme.muted} />
                    </FxRow>
                  </Pressable>
                ))
              )}
            </FxCard>
          </FxCol>
        )}
      </ScrollView>
    </View>
  );
}
