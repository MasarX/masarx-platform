// Mobile V2 CashDrop inline sheet — port of design source flow-extras.jsx
// `SheetCashDrop`. The driver hands the day's COD cash to the hub safe:
// a single counted amount entered on an on-screen numberpad, an optional
// sealed-envelope photo, and an optional hub-cashier acknowledgement — all
// gated by `mobile_cash_policy` (requirePhoto / requireCounterSig come from
// props so nothing is hardcoded). Variance against the expected total is
// surfaced inline and auto-flagged for supervisor approval.

import * as React from "react";
import { Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import {
  FxButton,
  FxCard,
  FxCol,
  FxField,
  FxNumberPad,
  FxPhotoCapture,
  FxRow,
} from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  computeMobileV2CashDropVariance,
  isMobileV2CashDropReady,
} from "./mobile-v2-sheet-readiness";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2CashDropSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Total cash expected (resolved upstream from open COD). */
  readonly expectedSar: number;
  /**
   * ISO currency code resolved upstream from `mobile_cash_policy`. The
   * sheet does not embed a literal currency symbol — per AGENTS.md it
   * resolves the symbol via `formatMobileV2CurrencyCompact` keyed by
   * this code. Defaults to "SAR".
   */
  readonly currency?: string;
  /** Counted-amount digit string driving the numberpad readout. */
  readonly countedValue: string;
  readonly onCountedChange: (next: string) => void;
  /** mobile_cash_policy flags — resolved upstream, never hardcoded here. */
  readonly requirePhoto: boolean;
  readonly requireCounterSig: boolean;
  readonly photoCaptured: boolean;
  readonly onCapturePhoto: () => void;
  /** Hub-cashier employee id acknowledging the hand-over. */
  readonly cashierId: string;
  readonly onCashierIdChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2CashDropSheet(
  props: MobileV2CashDropSheetProps,
): React.ReactElement {
  const { theme } = props;
  // Currency symbol resolved through the centralized formatter (SAR → ﷼)
  // — the canonical FieldOps Mobile V2 design symbol (design SheetCashDrop
  // renders `Expected <n> ﷼`). No hardcoded symbol literal.
  const currency = props.currency ?? "SAR";
  const currencySymbol = formatMobileV2CurrencyCompact(0, currency).split(" ")[1] ?? currency;
  const counted = Number.parseInt(props.countedValue, 10);
  const countedSar = Number.isFinite(counted) && counted > 0 ? counted : 0;
  const variance = computeMobileV2CashDropVariance(countedSar, props.expectedSar);
  const exact = variance === 0;
  const ready = isMobileV2CashDropReady({
    countedSar,
    requirePhoto: props.requirePhoto,
    photoCaptured: props.photoCaptured,
    requireCounterSig: props.requireCounterSig,
    cashierId: props.cashierId,
  });

  const countedHint = exact
    ? "Exact match — no reconciliation needed"
    : variance > 0
      ? `Over by ${variance.toLocaleString()} — supervisor will review`
      : `Short by ${Math.abs(variance).toLocaleString()} — supervisor will review`;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Cash drop · hand over to hub"
      subtitle={`Expected ${props.expectedSar.toLocaleString()} ${currencySymbol} from today's COD`}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={ready ? "success" : "soft"}
          full
          size="lg"
          icon="cash"
          disabled={!ready}
          onPress={props.onSubmit}
          accessibilityLabel="Submit cash drop"
        >
          {ready ? "Submit · sealed envelope" : "Complete amount + photo + signature"}
        </FxButton>
      }
    >
      <FxCol gap={14} style={{ paddingTop: MOBILE_V2_SPACING.lg }}>
        <FxField theme={theme} label="Cash counted" hint={countedHint}>
          <FxNumberPad
            theme={theme}
            value={props.countedValue}
            onChange={props.onCountedChange}
            suffix={currencySymbol}
          />
        </FxField>

        {props.requirePhoto ? (
          <FxField theme={theme} label="Sealed envelope photo">
            <FxPhotoCapture
              theme={theme}
              taken={props.photoCaptured}
              onCapture={props.onCapturePhoto}
              label="Photograph the sealed bag with route ID visible"
              accessibilityLabel={
                props.photoCaptured
                  ? "Sealed-envelope photo captured — tap to retake"
                  : "Capture sealed-envelope photo"
              }
            />
          </FxField>
        ) : null}

        {props.requireCounterSig ? (
          <FxField theme={theme} label="Hub cashier · acknowledged by">
            <TextInput
              value={props.cashierId}
              onChangeText={props.onCashierIdChange}
              placeholder="Cashier employee ID"
              placeholderTextColor={theme.muted}
              accessibilityLabel="Hub cashier employee id"
              style={{
                paddingVertical: 10,
                paddingHorizontal: 12,
                fontSize: 13,
                fontFamily: MOBILE_V2_FONT_MONO,
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: 10,
                color: theme.ink,
              }}
            />
          </FxField>
        ) : null}

        {!exact ? (
          <FxCard
            theme={theme}
            padding={12}
            style={{ backgroundColor: theme.warningSoft, borderColor: theme.warning }}
          >
            <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
              <FxIcon name="alert" size={16} color={theme.warning} />
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: theme.warning,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  flex: 1,
                }}
              >
                {variance > 0 ? "Surplus" : "Shortage"} of{" "}
                {Math.abs(variance).toLocaleString()} {currencySymbol} — auto-flagged for supervisor approval
              </Text>
            </FxRow>
          </FxCard>
        ) : null}
      </FxCol>
    </MobileV2BottomSheet>
  );
}
