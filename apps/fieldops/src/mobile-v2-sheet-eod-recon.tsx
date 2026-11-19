// Mobile V2 EOD Reconciliation sheet — pixel-faithful port of design source
// flow-extras.jsx SheetEODRecon. Loader end-of-day inventory reconciliation:
// one tone-coded row per inventory category (inbound received / outbound
// loaded / returns to shelf / damage-hold / inter-hub transfer) showing
// count-vs-expected, then a variance summary that auto-routes to the
// supervisor, and a single "Submit & sign off shift" CTA.
//
// The rows are caller-supplied (resolved from `mobile_loader_eod_v1` in
// production) so the sheet hardcodes no counts or category list — the
// orchestrator owns the data, the sheet owns the presentation.

import * as React from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

/** Reconciliation outcome tone for one inventory line. */
export type MobileV2EODReconTone = "success" | "warning" | "danger";

export interface MobileV2EODReconRow {
  readonly id: string;
  /** Category label, e.g. "Inbound received". */
  readonly label: string;
  /** Actual reconciled count. */
  readonly count: number;
  /** Expected count for the category. */
  readonly expected: number;
  /** Tone — resolved by the orchestrator (count===expected is not always
   *  "success": a damage-hold category expects 0, so any count is danger). */
  readonly tone: MobileV2EODReconTone;
}

export interface MobileV2EODReconSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Inventory reconciliation lines. Resolved from `mobile_loader_eod_v1`
   *  in production — never hardcoded inside the sheet. */
  readonly rows: ReadonlyArray<MobileV2EODReconRow>;
  /** Sign-off action — wired by the host to the EOD recon write path. */
  readonly onConfirm: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function toneIcon(tone: MobileV2EODReconTone): MobileV2IconName {
  return tone === "success" ? "check" : tone === "warning" ? "alert" : "x";
}

function toneFg(theme: MobileV2Theme, tone: MobileV2EODReconTone): string {
  return tone === "success" ? theme.success : tone === "warning" ? theme.warning : theme.danger;
}

function toneBg(theme: MobileV2Theme, tone: MobileV2EODReconTone): string {
  return tone === "success"
    ? theme.successSoft
    : tone === "warning"
      ? theme.warningSoft
      : theme.dangerSoft;
}

export function MobileV2EODReconSheet(
  props: MobileV2EODReconSheetProps,
): React.ReactElement {
  const { theme, rows } = props;
  const varianceCount = rows.filter((r) => r.count !== r.expected).length;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="End of day · reconciliation"
      subtitle="Review counts → close shift"
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant="success"
          full
          size="lg"
          icon="check-double"
          onPress={props.onConfirm}
          accessibilityLabel="Submit and sign off shift"
        >
          Submit &amp; sign off shift
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {rows.map((row) => {
          const fg = toneFg(theme, row.tone);
          return (
            <FxRow
              key={row.id}
              gap={MOBILE_V2_SPACING.xl}
              align="center"
              style={{
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: theme.surface,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: MOBILE_V2_RADII.button,
              }}
            >
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  backgroundColor: toneBg(theme, row.tone),
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name={toneIcon(row.tone)} size={14} color={fg} />
              </View>
              <Text
                style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {row.label}
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: fg,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {row.count}
                <Text
                  style={{
                    color: theme.muted,
                    fontSize: 11,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {" "}
                  / {row.expected}
                </Text>
              </Text>
            </FxRow>
          );
        })}

        <FxCard theme={theme} soft>
          <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
            <FxIcon name="info" size={14} color={theme.muted} />
            <Text
              style={{
                flex: 1,
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Variances ({varianceCount}) auto-route to supervisor for sign-off.
            </Text>
          </FxRow>
        </FxCard>
      </FxCol>
    </MobileV2BottomSheet>
  );
}
