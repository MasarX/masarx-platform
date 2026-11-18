// Mobile V2 Manifest Detail screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrManifest. Single waybill from a trip: origin
// merchant card (origin label + waybill mono id + complete/short-scan
// chip), parcel rows (mono parcel id + scan state + "Mark missing" CTA
// when not yet scanned), and two stacked footer actions (Scan parcel,
// Report manifest discrepancy in danger tone).
//
// Parcel state arrives as data (scanned/missing/extra). The screen does
// not embed business literals.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

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

export type MobileV2ManifestLineStatus = "scanned" | "pending" | "missing" | "extra";

export interface MobileV2ManifestLine {
  readonly id: string;
  readonly status: MobileV2ManifestLineStatus;
  readonly note?: string;
}

export interface MobileV2ManifestDetailScreenProps {
  readonly theme: MobileV2Theme;
  readonly manifestId: string;
  readonly originMerchant: string;
  readonly originCity: string;
  readonly waybillId: string;
  readonly lines: ReadonlyArray<MobileV2ManifestLine>;
  readonly onScanParcel?: () => void;
  readonly onMarkMissing?: (parcelId: string) => void;
  readonly onReportDiscrepancy?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
};

interface LineMeta {
  readonly soft: string;
  readonly fg: string;
  readonly icon: "check" | "package" | "alert";
  readonly note: string;
}

function lineMeta(
  status: MobileV2ManifestLineStatus,
  theme: MobileV2Theme,
  customNote?: string,
): LineMeta {
  switch (status) {
    case "scanned":
      return {
        soft: theme.successSoft,
        fg: theme.success,
        icon: "check",
        note: customNote ?? "Scanned at gate-out",
      };
    case "missing":
      return {
        soft: theme.dangerSoft,
        fg: theme.danger,
        icon: "alert",
        note: customNote ?? "Marked missing · supervisor notified",
      };
    case "extra":
      return {
        soft: theme.warningSoft,
        fg: theme.warning,
        icon: "alert",
        note: customNote ?? "Extra · not on waybill",
      };
    case "pending":
      return {
        soft: theme.surfaceAlt,
        fg: theme.muted,
        icon: "package",
        note: customNote ?? "Not yet scanned",
      };
  }
}

export function MobileV2ManifestDetailScreen(
  props: MobileV2ManifestDetailScreenProps,
): React.ReactElement {
  const { theme, lines } = props;
  const total = lines.length;
  const scanned = lines.filter((l) => l.status === "scanned").length;
  const isComplete = scanned === total && total > 0;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING.lg,
        }}
      >
        {/* In-body header strip stripped — the gallery / host ScreenShell now
            renders the title (manifestId) and subtitle (Manifest · <n>
            parcels) via FxAppBar. The scanned-progress chip used to live here:

              <FxChip theme={theme} dense mono>
                {`${scanned}/${total}`}
              </FxChip>

            The host should re-surface that via the AppBar `right` prop. */}

        {/* Origin merchant */}
        <FxCard theme={theme} padding={14}>
          <FxRow justify="space-between" gap={MOBILE_V2_SPACING.lg}>
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text style={[SECTION_HEAD_STYLE, { color: theme.muted, letterSpacing: 0.6 }]}>
              Origin merchant
            </Text>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
                numberOfLines={1}
              >
                {props.originMerchant} · {props.originCity}
              </Text>
              <Text
                style={{
                  fontSize: 11.5,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
                numberOfLines={1}
              >
                {props.waybillId} · sealed at hub
              </Text>
            </FxCol>
            <FxChip
              theme={theme}
              tone={isComplete ? "success" : "warning"}
              dense
            >
              {isComplete ? "Complete" : "Short scan"}
            </FxChip>
          </FxRow>
        </FxCard>

        {/* Parcels list */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text
            style={[
              SECTION_HEAD_STYLE,
              {
                color: theme.muted,
                marginTop: MOBILE_V2_SPACING.xl,
                marginHorizontal: MOBILE_V2_SPACING.sm,
              },
            ]}
          >
            Parcels
          </Text>
          <FxCard theme={theme} padding={0}>
            {lines.length === 0 ? (
              <View style={{ padding: 20 }}>
                <Text
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Manifest has no parcels.
                </Text>
              </View>
            ) : (
              lines.map((line, i) => {
                const meta = lineMeta(line.status, theme, line.note);
                const showMissingCta = line.status !== "scanned" && line.status !== "missing";
                return (
                  <View
                    key={line.id}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      borderBottomColor: theme.border,
                      borderBottomWidth: i < lines.length - 1 ? 1 : 0,
                    }}
                  >
                    <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
                      <View
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          backgroundColor: meta.soft,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon name={meta.icon} size={14} color={meta.fg} stroke={2.2} />
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
                          {line.id}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                          numberOfLines={1}
                        >
                          {meta.note}
                        </Text>
                      </FxCol>
                      {showMissingCta ? (
                        // Design canvas "Mark missing" CTA (flow-network-
                        // extras.jsx:426) is a `soft` (neutral) button with
                        // an `alert` icon. A prior workaround used `chrome`
                        // because the impl `soft` variant was yellow-tinted;
                        // with `soft` restored to the design's neutral
                        // tokens this matches the canvas directly.
                        <FxButton
                          theme={theme}
                          variant="soft"
                          size="sm"
                          icon="alert"
                          onPress={() => props.onMarkMissing?.(line.id)}
                          accessibilityLabel={`Mark ${line.id} missing`}
                        >
                          Mark missing
                        </FxButton>
                      ) : null}
                    </FxRow>
                  </View>
                );
              })
            )}
          </FxCard>
        </FxCol>

        {/* Stacked actions */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxButton
            theme={theme}
            variant="primary"
            full
            icon="scan"
            onPress={props.onScanParcel}
            accessibilityLabel="Scan parcel"
          >
            Scan parcel
          </FxButton>
          <FxButton
            theme={theme}
            variant="outline-danger"
            full
            icon="alert"
            onPress={props.onReportDiscrepancy}
            accessibilityLabel="Report manifest discrepancy"
          >
            Report manifest discrepancy
          </FxButton>
        </FxCol>
      </ScrollView>
    </View>
  );
}
