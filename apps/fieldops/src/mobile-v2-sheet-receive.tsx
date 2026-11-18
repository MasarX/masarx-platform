// Mobile V2 Receive sheet — pixel-faithful port of design source
// flow-extras.jsx SheetReceive (lines 564-591). Loader inbound-truck
// receive flow: a Supplier / line-haul ID input, a counter card with an
// embedded "Scan next parcel" button + progress bar, and a 3-chip
// reconciliation row (missing / surplus / verified). The primary CTA
// closes the manifest and seals the pallets.
//
// The screen stays render-pure: the supplier value, scanned/expected
// counts, and the missing/surplus/verified tallies are all caller-
// supplied. Production cutover binds these to the inbound-manifest
// resolver; the gallery / preview supplies a fixture.

import * as React from "react";
import { Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  resolveMobileV2ReceiveSubtitle,
} from "./mobile-v2-sheet-readiness";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2ReceiveSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Supplier / line-haul identifier shown in the editable field. */
  readonly supplier: string;
  readonly onSupplierChange: (next: string) => void;
  /** Total parcels expected on the inbound manifest. */
  readonly expectedCount: number;
  /** Parcels scanned so far. */
  readonly scannedCount: number;
  /** Records the next scanned parcel (the in-card "Scan next parcel" CTA). */
  readonly onScanParcel: () => void;
  /** Closes the manifest + seals the pallets (primary footer CTA). */
  readonly onConfirm: () => void;
  /** Parcels expected but not yet scanned — drives the "N missing" chip. */
  readonly missingCount: number;
  /** Parcels scanned beyond the manifest — drives the "N surplus" chip. */
  readonly surplusCount: number;
  /** Parcels reconciled clean — drives the "N verified" chip. */
  readonly verifiedCount: number;
  /**
   * Optional subtitle override. Caller composes the subtitle string based
   * on its own state context. If omitted, falls back to a manifest-style
   * label derived from the supplier id.
   */
  readonly subtitle?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2ReceiveSheet(
  props: MobileV2ReceiveSheetProps,
): React.ReactElement {
  const { theme } = props;
  const pct =
    props.expectedCount > 0
      ? Math.min(1, Math.max(0, props.scannedCount / props.expectedCount))
      : 0;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Receive inbound truck"
      subtitle={resolveMobileV2ReceiveSubtitle({
        subtitle: props.subtitle,
        manifestId: props.supplier,
      })}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant="success"
          full
          size="lg"
          icon="check"
          onPress={props.onConfirm}
          accessibilityLabel="Close manifest and seal pallets"
        >
          Close manifest · seal pallets
        </FxButton>
      }
    >
      {/* Design SheetReceive body: FxCol gap={12}, padding 8px 16px. The
          MobileV2BottomSheet ScrollView already applies a 14px side inset;
          the design wants 16px so we add a 2px nudge on each side. */}
      <FxCol gap={MOBILE_V2_SPACING["2xl"]} style={{ paddingHorizontal: MOBILE_V2_SPACING.xs }}>
        {/* Supplier / line-haul ID — design FxField (label + mono input) */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Supplier / line-haul ID
          </Text>
          <TextInput
            value={props.supplier}
            onChangeText={props.onSupplierChange}
            accessibilityLabel="Supplier or line-haul ID"
            placeholderTextColor={theme.muted}
            style={{
              width: "100%",
              borderColor: theme.border,
              borderWidth: 1,
              borderRadius: MOBILE_V2_RADII.input,
              backgroundColor: theme.surface,
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_MONO,
              fontSize: MOBILE_V2_TYPE_SIZES.body,
              paddingHorizontal: MOBILE_V2_SPACING["2xl"],
              paddingVertical: MOBILE_V2_SPACING.xl,
            }}
          />
        </FxCol>

        {/* Counter card — Scanned / total + progress bar + in-card
            "Scan next parcel" button (design SheetReceive FxCard). */}
        <FxCard theme={theme}>
          <FxRow justify="space-between" align="center">
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Scanned
            </Text>
            <Text
              style={{
                fontSize: 24,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_MONO,
                color: theme.ink,
              }}
            >
              {props.scannedCount}
              <Text
                style={{
                  color: theme.muted,
                  fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
                }}
              >
                {" "}
                / {props.expectedCount}
              </Text>
            </Text>
          </FxRow>
          <View
            style={{
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.surfaceAlt,
              overflow: "hidden",
              marginTop: MOBILE_V2_SPACING.xl,
            }}
          >
            <View
              style={{
                width: `${Math.round(pct * 100)}%`,
                height: "100%",
                backgroundColor: theme.success,
              }}
            />
          </View>
          <FxButton
            theme={theme}
            variant="primary"
            full
            icon="scan"
            onPress={props.onScanParcel}
            accessibilityLabel="Scan next parcel"
            style={{ marginTop: MOBILE_V2_SPACING["2xl"] }}
          >
            Scan next parcel
          </FxButton>
        </FxCard>

        {/* Reconciliation chip row — missing / surplus / verified. */}
        <FxRow gap={MOBILE_V2_SPACING.md} wrap>
          <FxChip theme={theme} dense tone="warning">
            {`${props.missingCount} missing`}
          </FxChip>
          <FxChip theme={theme} dense tone="info">
            {`${props.surplusCount} surplus → check`}
          </FxChip>
          <FxChip theme={theme} dense tone="success">
            {`${props.verifiedCount} verified`}
          </FxChip>
        </FxRow>
      </FxCol>
    </MobileV2BottomSheet>
  );
}
