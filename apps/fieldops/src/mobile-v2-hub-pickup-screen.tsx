// Mobile V2 Hub Pickup Desk — pixel-faithful port of design source
// flow-network-extras.jsx ScrHubPickup. Counter-staff workflow for
// self-collect: horizontal customer queue strip at top, selected item
// detail card (self-collect badge, parcels/COD stat strip), verify
// recipient card (scan ID + OTP entry + resend), and stacked actions
// (collect COD if any, release parcels, customer-not-present).
//
// The desktop source uses a two-pane grid; mobile parity uses a
// horizontal queue strip + vertical detail stack so single-handed
// thumb reach works without losing the contract.

import * as React from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2HubPickupPriority = "normal" | "high";

export interface MobileV2HubPickupQueueItem {
  readonly id: string;
  readonly customer: string;
  readonly phone: string;
  readonly parcels: number;
  readonly codSar: number;
  readonly heldDays: number;
  readonly priority: MobileV2HubPickupPriority;
}

export interface MobileV2HubPickupScreenProps {
  readonly theme: MobileV2Theme;
  readonly queue: ReadonlyArray<MobileV2HubPickupQueueItem>;
  readonly activeId: string | null;
  readonly otp: string;
  /** ISO currency code, defaults to SAR. Resolved via mobile_cash_policy. */
  readonly currency?: string;
  readonly onSelect: (id: string) => void;
  readonly onOtpChange: (next: string) => void;
  readonly onScanId?: () => void;
  readonly onResendOtp?: () => void;
  readonly onCollectCod?: () => void;
  readonly onRelease?: () => void;
  readonly onNotPresent?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
};

export function MobileV2HubPickupScreen(
  props: MobileV2HubPickupScreenProps,
): React.ReactElement {
  const { theme, queue, otp } = props;
  const currency = props.currency ?? "SAR";
  const active =
    queue.find((q) => q.id === props.activeId) ?? (queue.length > 0 ? queue[0]! : null);

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingBottom: 96,
          rowGap: MOBILE_V2_SPACING["2xl"],
        }}
      >
        {/* Horizontal queue strip */}
        {queue.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: MOBILE_V2_SPACING["3xl"],
              paddingTop: MOBILE_V2_SPACING["2xl"],
              columnGap: MOBILE_V2_SPACING.md,
            }}
          >
            {queue.map((q) => {
              const on = active !== null && active.id === q.id;
              return (
                <Pressable
                  key={q.id}
                  onPress={() => props.onSelect(q.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${q.customer}`}
                  style={{
                    backgroundColor: on ? theme.accentSoft : theme.surface,
                    borderColor: on ? theme.accent : theme.border,
                    borderWidth: 1,
                    borderRadius: 14,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    minWidth: 180,
                  }}
                >
                  <FxRow gap={MOBILE_V2_SPACING.sm} align="flex-start">
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        backgroundColor:
                          q.priority === "high" ? theme.warningSoft : theme.surfaceAlt,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text
                        style={{
                          color: q.priority === "high" ? theme.warning : theme.muted,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          fontSize: 11,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                      >
                        {q.heldDays}d
                      </Text>
                    </View>
                    <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          color: theme.ink,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {q.customer}
                      </Text>
                      <Text
                        style={{
                          fontSize: 10.5,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_MONO,
                        }}
                        numberOfLines={1}
                      >
                        {q.id}
                      </Text>
                      <Text
                        style={{
                          fontSize: 10,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {q.parcels} parcel{q.parcels === 1 ? "" : "s"}
                        {q.codSar > 0 ? (
                          <Text style={{ color: theme.warning, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold }}>
                            {" · "}
                            {formatMobileV2CurrencyCompact(q.codSar, currency)} COD
                          </Text>
                        ) : null}
                      </Text>
                    </FxCol>
                  </FxRow>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {/* Detail panel */}
        <View style={{ paddingHorizontal: MOBILE_V2_SPACING["3xl"], rowGap: MOBILE_V2_SPACING.lg }}>
          {active !== null ? (
            <>
              <FxCard theme={theme} accent>
                <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 9,
                        color: theme.accent,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      Self-collect
                    </Text>
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      {active.customer}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11.5,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                      numberOfLines={1}
                    >
                      {active.id} · {active.phone}
                    </Text>
                  </FxCol>
                  <FxChip
                    theme={theme}
                    dense
                    tone={active.priority === "high" ? "warning" : "neutral"}
                  >
                    {active.heldDays}d held
                  </FxChip>
                </FxRow>
                <View style={{ height: 1, backgroundColor: theme.border, marginVertical: 10 }} />
                <FxRow gap={MOBILE_V2_SPACING["2xl"]}>
                  <FxCol gap={2}>
                    <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Parcels</Text>
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {active.parcels}
                    </Text>
                  </FxCol>
                  {active.codSar > 0 ? (
                    <FxCol gap={2}>
                      <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>COD</Text>
                      <Text
                        style={{
                          fontSize: 14,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          color: theme.warning,
                          fontFamily: MOBILE_V2_FONT_MONO,
                        }}
                      >
                        {formatMobileV2CurrencyCompact(active.codSar, currency)}
                      </Text>
                    </FxCol>
                  ) : null}
                </FxRow>
              </FxCard>

              {/* Verify recipient */}
              <FxCard theme={theme} padding={14}>
                <Text
                  style={[
                    SECTION_HEAD_STYLE,
                    { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md },
                  ]}
                >
                  Verify recipient
                </Text>
                <FxButton
                  theme={theme}
                  variant="soft"
                  full
                  icon="scan"
                  onPress={props.onScanId}
                  accessibilityLabel="Scan ID or IQAMA"
                  style={{ marginBottom: MOBILE_V2_SPACING.md }}
                >
                  Scan ID card · IQAMA
                </FxButton>
                <TextInput
                  value={otp}
                  onChangeText={props.onOtpChange}
                  placeholder="Or enter SMS OTP"
                  placeholderTextColor={theme.muted}
                  inputMode="numeric"
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="done"
                  accessibilityLabel="Enter SMS OTP"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderColor: theme.border,
                    borderWidth: 1,
                    borderRadius: 10,
                    fontSize: 14,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    letterSpacing: 4,
                    textAlign: "center",
                    color: theme.ink,
                    backgroundColor: theme.surface,
                  }}
                />
                <FxButton
                  theme={theme}
                  variant="ghost"
                  size="sm"
                  icon="message"
                  full
                  onPress={props.onResendOtp}
                  accessibilityLabel="Resend OTP"
                  style={{ marginTop: 6 }}
                >
                  Resend OTP to {active.phone.slice(-4)}
                </FxButton>
              </FxCard>

              {/* Stacked actions */}
              <FxCol gap={MOBILE_V2_SPACING.sm}>
                {active.codSar > 0 ? (
                  <FxButton
                    theme={theme}
                    variant="primary"
                    full
                    size="lg"
                    icon="cash"
                    onPress={props.onCollectCod}
                    accessibilityLabel={`Collect ${formatMobileV2CurrencyCompact(active.codSar, currency)}`}
                  >
                    Collect {formatMobileV2CurrencyCompact(active.codSar, currency)} · cash or card
                  </FxButton>
                ) : null}
                <FxButton
                  theme={theme}
                  variant="success"
                  full
                  size="lg"
                  icon="check"
                  onPress={props.onRelease}
                  accessibilityLabel={`Release ${active.parcels} parcels`}
                >
                  Release {active.parcels} parcel{active.parcels === 1 ? "" : "s"}
                </FxButton>
                <FxButton
                  theme={theme}
                  variant="ghost"
                  full
                  icon="x"
                  onPress={props.onNotPresent}
                  accessibilityLabel="Customer not present"
                >
                  Customer not present
                </FxButton>
              </FxCol>
            </>
          ) : (
            <FxCard theme={theme} padding={24}>
              <FxCol gap={MOBILE_V2_SPACING.sm} style={{ alignItems: "center" }}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Queue empty
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    textAlign: "center",
                  }}
                >
                  All customers served.
                </Text>
              </FxCol>
            </FxCard>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
