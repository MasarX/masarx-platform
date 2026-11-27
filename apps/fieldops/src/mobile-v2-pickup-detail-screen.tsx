// Mobile V2 Pickup detail screen — pixel-faithful port of design source
// flow-network.jsx ScrPickupDetail. Match against
// docs/ops/evidence/2026-05-10/mobile-v2/reference/07-pickup-detail.png.
//
// Hero: chrome-bg card with SCANNED mono numeric + circular SVG progress
// ring + 3-col metadata strip (waybill / area / seal).
// Address card: pin chip + address + go button + Call/WhatsApp/Note row.
// Scan parcels card: section head + hint + count chip + giant primary
// scan button + chip row (bulk / manual / mismatch).
// Footer: confirm-or-continue + cannot-pick-up.

import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS,
  getMobileV2PickupFailureReasonLabel,
} from "./mobile-v2-pickup-policy";
import type { MobileV2Pickup } from "./mobile-v2-pickups-screen";
import { getStrings, resolveLocaleCode } from "./i18n";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2PickupDetailScreenProps {
  readonly theme: MobileV2Theme;
  readonly pickup: MobileV2Pickup;
  readonly onGo?: () => void;
  readonly onCall?: () => void;
  readonly onWhatsApp?: () => void;
  readonly onNote?: () => void;
  readonly onScanParcel?: () => void;
  readonly onAddManually?: () => void;
  readonly onConfirm?: () => void;
  readonly onFail?: () => void;
  readonly locale?: string;
  readonly style?: StyleProp<ViewStyle>;
}

function MetadataCell({
  label,
  value,
  mono,
  onChrome,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly onChrome: string;
}): React.ReactElement {
  return (
    <View style={{ rowGap: 2 }}>
      <Text
        style={{
          fontSize: 10,
          color: onChrome,
          opacity: 0.6,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: onChrome,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          fontFamily: mono ? MOBILE_V2_FONT_MONO : MOBILE_V2_FONT_SANS,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function MobileV2PickupDetailScreen(
  props: MobileV2PickupDetailScreenProps,
): React.ReactElement {
  const { theme, pickup } = props;
  const strings = getStrings(resolveLocaleCode(props.locale));
  const failureReasons: Readonly<Record<string, unknown>> = strings.pickupDetail.failureReasons;
  const pct = pickup.expectedQty > 0 ? Math.round((pickup.picked / pickup.expectedQty) * 100) : 0;
  const remaining = Math.max(0, pickup.expectedQty - pickup.picked);
  const canCapture = pickup.status === "pending";
  const canCommit = pickup.expectedQty > 0 && pickup.picked >= pickup.expectedQty && pickup.status === "pending";
  const catalogReasonLabel = pickup.failureReason ? failureReasons[pickup.failureReason] : undefined;
  const failureReasonLabel = pickup.failureReason
    ? typeof catalogReasonLabel === "string"
      ? catalogReasonLabel
      : getMobileV2PickupFailureReasonLabel(pickup.failureReason, MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS)
    : null;
  // Circle math: r=26 -> circumference ≈ 163.36
  const circumference = 2 * Math.PI * 26;
  const dashLen = (pct / 100) * circumference;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["2xl"],
          paddingBottom: 120,
        }}
      >
        {/* Hero on chrome */}
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
                {strings.routeLoad.scanned}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    letterSpacing: 0,
                  }}
                >
                  {pickup.picked}
                </Text>
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    opacity: 0.45,
                    letterSpacing: 0,
                  }}
                >
                  /{pickup.expectedQty}
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
                {(remaining === 1 ? strings.pickupDetail.parcelsRemainingOne : strings.pickupDetail.parcelsRemainingOther).replace(
                  "{n}",
                  () => String(remaining),
                )}
              </Text>
            </FxCol>

            {/* Circular SVG progress */}
            <View
              style={{
                width: MOBILE_V2_DIMENSIONS.progressRing,
                height: MOBILE_V2_DIMENSIONS.progressRing,
                position: "relative",
              }}
            >
              <Svg width={64} height={64} viewBox="0 0 64 64">
                <Circle
                  cx={32}
                  cy={32}
                  r={26}
                  fill="none"
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth={6}
                />
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

          <FxRow gap={MOBILE_V2_SPACING["3xl"]}>
            <MetadataCell label={strings.pickupDetail.waybill} value={pickup.wb} mono onChrome={theme.onChrome} />
            <MetadataCell label={strings.pickupDetail.area} value={pickup.area} mono={false} onChrome={theme.onChrome} />
            <MetadataCell
              label={strings.pickupDetail.seal}
              value={pickup.sealRequired ? strings.pickupDetail.sealRequired : strings.pickupDetail.sealOptional}
              mono
              onChrome={theme.onChrome}
            />
          </FxRow>
        </View>

        {/* Address & contact */}
        <FxCard theme={theme} padding={0}>
          <FxRow
            gap={MOBILE_V2_SPACING.lg}
            style={{ paddingVertical: MOBILE_V2_SPACING["2xl"], paddingHorizontal: MOBILE_V2_SPACING["3xl"] }}
            align="center"
          >
            <View
              style={{
                width: MOBILE_V2_DIMENSIONS.avatarTile,
                height: MOBILE_V2_DIMENSIONS.avatarTile,
                borderRadius: MOBILE_V2_RADII.tile,
                backgroundColor: theme.surfaceAlt,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FxIcon name="pin" size={18} color={theme.muted} />
            </View>
            <FxCol gap={2} style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {pickup.address}
              </Text>
              {pickup.instructions !== undefined ? (
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {pickup.instructions}
                </Text>
              ) : null}
            </FxCol>
            {/* Design canvas ScrPickupDetail (flow-network.jsx:215)
                renders the inline "Go" CTA as a `soft` (neutral) button.
                A prior workaround used `chrome` because the impl `soft`
                variant was yellow-tinted; with `soft` restored to the
                design's neutral tokens this matches the canvas. */}
            <FxButton theme={theme} variant="soft" size="sm" icon="map" onPress={props.onGo}>
              {strings.pickupDetail.go}
            </FxButton>
          </FxRow>

          <View style={{ height: 1, backgroundColor: theme.border }} />

          <FxRow gap={MOBILE_V2_SPACING.lg} style={{ paddingHorizontal: MOBILE_V2_SPACING["3xl"], paddingVertical: MOBILE_V2_SPACING.xl }}>
            <FxButton theme={theme} variant="ghost" size="sm" icon="phone" onPress={props.onCall}>
              {strings.detail.call}
            </FxButton>
            <FxButton theme={theme} variant="ghost" size="sm" icon="whatsapp" onPress={props.onWhatsApp}>
              {strings.stop.whatsapp}
            </FxButton>
            <View style={{ flex: 1 }} />
            <FxButton theme={theme} variant="ghost" size="sm" icon="message" onPress={props.onNote}>
              {strings.pickupDetail.note}
            </FxButton>
          </FxRow>
        </FxCard>

        {pickup.status === "failed" ? (
          <FxCard theme={theme} padding={14}>
            <FxRow justify="space-between" align="flex-start" style={{ marginBottom: MOBILE_V2_SPACING.lg }}>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 10,
                    color: theme.danger,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {strings.pickupDetail.pickupFailure}
                </Text>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                    color: theme.ink,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {failureReasonLabel ?? strings.pickupDetail.failureRecorded}
                </Text>
              </FxCol>
              <FxChip theme={theme} tone="danger" icon="alert" dense>
                {strings.pickupDetail.failed}
              </FxChip>
            </FxRow>
            {pickup.failureNote ? (
              <Text
                style={{
                  fontSize: 12.5,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  lineHeight: 18,
                }}
              >
                {pickup.failureNote}
              </Text>
            ) : null}
          </FxCard>
        ) : null}

        {/* Scan parcels */}
        <FxCard theme={theme} padding={14}>
          <FxRow justify="space-between" align="flex-start" style={{ marginBottom: MOBILE_V2_SPACING.xl }}>
            {/* flex:1 + minWidth:0 so the hint line wraps to two lines as
                in the design source (a CSS flex column shrinks by default;
                RN needs the constraint to be explicit). */}
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.muted,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {strings.pickupDetail.scanParcels}
              </Text>
              <Text
                style={{
                  fontSize: 12.5,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {strings.pickupDetail.scanHint}
              </Text>
            </FxCol>
            <FxChip theme={theme} tone="neutral" dense mono>
              {strings.pickupDetail.pickedOfExpected
                .replace("{picked}", () => String(pickup.picked))
                .replace("{expected}", () => String(pickup.expectedQty))}
            </FxChip>
          </FxRow>

          <FxButton
            theme={theme}
            variant="primary"
            full
            size="lg"
            icon="scan"
            onPress={props.onScanParcel}
            disabled={!canCapture}
          >
            {strings.pickupDetail.scanParcelBarcode}
          </FxButton>

          <FxRow gap={MOBILE_V2_SPACING.md} style={{ marginTop: MOBILE_V2_SPACING.lg }} wrap>
            <FxChip theme={theme} icon="qr" dense>
              {strings.pickupDetail.bulkQr}
            </FxChip>
            <Pressable
              onPress={canCapture ? props.onAddManually : undefined}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canCapture }}
              disabled={!canCapture}
              style={{ opacity: canCapture ? 1 : 0.45 }}
            >
              <FxChip theme={theme} icon="plus" dense>
                {strings.pickupDetail.addManually}
              </FxChip>
            </Pressable>
            <FxChip
              theme={theme}
              icon="alert"
              tone={pickup.picked > pickup.expectedQty ? "warning" : "neutral"}
              dense
            >
              {strings.pickupDetail.mismatch}
            </FxChip>
          </FxRow>
        </FxCard>

        {/* Footer actions */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          {pickup.status === "pending" ? (
            <FxButton
              theme={theme}
              variant="success"
              full
              size="lg"
              icon="check-double"
              onPress={props.onConfirm}
              testID="mobile-action-tasks.complete"
            >
              {strings.pickupDetail.pickupHandoff}
            </FxButton>
          ) : null}

          {pickup.status === "pending" && !canCommit ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="scan" onPress={props.onScanParcel}>
              {strings.pickupDetail.continueScanning.replace("{n}", () => String(remaining))}
            </FxButton>
          ) : null}

          {pickup.status === "pending" ? (
            <FxButton
              theme={theme}
              variant="outline-danger"
              full
              icon="alert"
              onPress={props.onFail}
              testID="mobile-action-tasks.exception"
            >
              {strings.pickupDetail.pickupFailure}
            </FxButton>
          ) : (
            <FxButton theme={theme} variant="soft" full icon="check" onPress={props.onGo}>
              {strings.pickupDetail.doneBackToPickups}
            </FxButton>
          )}
        </FxCol>
      </ScrollView>
    </View>
  );
}
