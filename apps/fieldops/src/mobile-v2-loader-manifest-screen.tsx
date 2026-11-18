// Mobile V2 Loader Manifest screen — pixel-faithful port of design source
// flow-loader.jsx ScrLoaderManifest. Wave-level manifest grouped by stop
// destination: top chip strip (cold-chain, weight, scanned, pending) and
// per-destination cards with header (stop id, parcels, kg) + scanned ratio
// chip + parcel rows (mono id, sku · size · kg, optional Cold chip).
//
// Parcels and totals are computed from input props — caller resolves the
// manifest source upstream (no inline business literals here).

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

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

export interface MobileV2LoaderManifestParcel {
  readonly id: string;
  readonly sku: string;
  readonly destStopId: string;
  readonly size: string;
  readonly weightKg: number;
  readonly cold: boolean;
  readonly scanned: boolean;
}

export interface MobileV2LoaderManifestScreenProps {
  readonly theme: MobileV2Theme;
  readonly parcels: ReadonlyArray<MobileV2LoaderManifestParcel>;
  readonly style?: StyleProp<ViewStyle>;
}

interface ManifestGroup {
  readonly stopId: string;
  readonly items: ReadonlyArray<MobileV2LoaderManifestParcel>;
  readonly weightKg: number;
  readonly scannedCount: number;
}

function groupByDest(
  parcels: ReadonlyArray<MobileV2LoaderManifestParcel>,
): ReadonlyArray<ManifestGroup> {
  const map = new Map<string, MobileV2LoaderManifestParcel[]>();
  for (const p of parcels) {
    const arr = map.get(p.destStopId);
    if (arr === undefined) {
      map.set(p.destStopId, [p]);
    } else {
      arr.push(p);
    }
  }
  const stops = Array.from(map.keys()).sort();
  return stops.map((stopId) => {
    const items = map.get(stopId) ?? [];
    const weightKg = items.reduce((n, p) => n + p.weightKg, 0);
    const scannedCount = items.filter((p) => p.scanned).length;
    return { stopId, items, weightKg, scannedCount };
  });
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
};

export function MobileV2LoaderManifestScreen(
  props: MobileV2LoaderManifestScreenProps,
): React.ReactElement {
  const { theme, parcels } = props;
  const groups = React.useMemo(() => groupByDest(parcels), [parcels]);
  const coldCount = parcels.filter((p) => p.cold).length;
  const totalWeight = parcels.reduce((n, p) => n + p.weightKg, 0);
  const scanned = parcels.filter((p) => p.scanned).length;
  const pending = parcels.length - scanned;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          // Design splits the screen into a chip block (padding 12px 16px)
          // and a card block (padding 4px 16px 16px): screen top is 12px
          // and the chip-row→card-column gap nets to 12+4=16px.
          paddingTop: MOBILE_V2_SPACING["2xl"],
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["4xl"],
          paddingBottom: 96,
        }}
      >
        {/* Summary chips — design canvas s-loader-manifest fits all 4
            chips on one row (Cold-chain N · Total Xkg · Scanned N ·
            Pending N). Use the smaller `sm` gap so chips don't wrap to
            a 2nd row inside the 380px artboard, matching the design's
            single-line chip strip. */}
        <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
          <FxChip theme={theme} tone="info" dense icon="package">
            {`Cold-chain ${coldCount}`}
          </FxChip>
          <FxChip theme={theme} dense>
            {`Total ${totalWeight.toFixed(1)} kg`}
          </FxChip>
          <FxChip theme={theme} tone="success" dense icon="check">
            {`Scanned ${scanned}`}
          </FxChip>
          <FxChip theme={theme} tone="warning" dense>
            {`Pending ${pending}`}
          </FxChip>
        </FxRow>

        {/* Grouped cards */}
        <FxCol gap={MOBILE_V2_SPACING["2xl"]}>
          {groups.map((g) => (
            <FxCard key={g.stopId} theme={theme} padding={0}>
              {/* Group header */}
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  backgroundColor: theme.surfaceAlt,
                  borderBottomColor: theme.border,
                  borderBottomWidth: 1,
                  borderTopLeftRadius: MOBILE_V2_RADII.card - 1,
                  borderTopRightRadius: MOBILE_V2_RADII.card - 1,
                }}
              >
                <FxRow justify="space-between" align="center">
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                      numberOfLines={1}
                    >
                      {g.stopId}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      {g.items.length} parcels · {g.weightKg.toFixed(1)} kg
                    </Text>
                  </FxCol>
                  <FxChip
                    theme={theme}
                    tone={g.scannedCount === g.items.length ? "success" : "warning"}
                    dense
                    mono
                  >
                    {`${g.scannedCount}/${g.items.length}`}
                  </FxChip>
                </FxRow>
              </View>

              {/* Parcel rows — design source gives EVERY row (incl. the
                  last) a 1px bottom border, so the card is 1px taller per
                  group than a last-row-borderless variant. */}
              <FxCol>
                {g.items.map((p) => (
                  <View
                    key={p.id}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      borderBottomColor: theme.border,
                      borderBottomWidth: 1,
                    }}
                  >
                    <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
                      <View
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          backgroundColor: p.scanned ? theme.successSoft : theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon
                          name={p.scanned ? "check" : "package"}
                          size={14}
                          color={p.scanned ? theme.success : theme.muted}
                          stroke={2.2}
                        />
                      </View>
                      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={{
                            fontSize: 12.5,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            fontFamily: MOBILE_V2_FONT_MONO,
                            color: theme.ink,
                          }}
                          numberOfLines={1}
                        >
                          {p.id}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          numberOfLines={1}
                        >
                          {p.sku} · {p.size} · {p.weightKg}kg
                        </Text>
                      </FxCol>
                      {p.cold ? (
                        <FxChip theme={theme} tone="info" dense icon="package">
                          Cold
                        </FxChip>
                      ) : null}
                    </FxRow>
                  </View>
                ))}
              </FxCol>
            </FxCard>
          ))}

          {groups.length === 0 ? (
            <FxCard theme={theme} padding={24}>
              <Text
                style={{
                  textAlign: "center",
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Manifest is empty.
              </Text>
            </FxCard>
          ) : null}
        </FxCol>

        {/* Design canvas s-loader-manifest artboard ends after the
            grouped cards with no trailing summary line. Earlier "N
            parcels · M stops" footer was an audit placeholder that
            inflated the artboard footer area and dominated bottom-
            tile pixel-diff. */}
      </ScrollView>
    </View>
  );
}
