// Mobile V2 Login screen — pixel-faithful port of design source
// flow-auth.jsx ScrLogin. Employee-ID entry then 6-digit OTP, with
// device-verified + bilingual chip strip, sticky bottom action footer,
// and footer link to sign-up.
//
// Stateless: parent owns step, employee id, otp, and submission. Per
// AGENTS.md zero-hardcoding, the brand mark glyph, app version, masked
// phone, and the optional inline error string all arrive as props.

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

import { FxButton, FxChip, FxRow } from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2LoginStep = "emp" | "otp";

export interface MobileV2LoginScreenProps {
  readonly theme: MobileV2Theme;
  /** Single-character glyph rendered in the brand mark tile (e.g. "M"). */
  readonly brandGlyph: string;
  /** Current step in the login flow (employee-id vs OTP entry). */
  readonly step: MobileV2LoginStep;
  /** Current employee id value (uppercased upstream). */
  readonly employeeId: string;
  /** Current OTP value (digits only, max 6). */
  readonly otp: string;
  /** Masked tail of the phone the OTP was sent to, e.g. "•••• 4128". */
  readonly otpMaskedPhone: string;
  /** Optional inline error to display under the input (e.g. "Invalid code"). */
  readonly errorMessage?: string | null;
  /** Optional auto-fill hint shown below the OTP input. */
  readonly autoFillHint?: string;
  /** App version label rendered in the bottom footer. */
  readonly versionLabel: string;
  readonly onEmployeeIdChange: (next: string) => void;
  readonly onOtpChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onResend?: () => void;
  readonly onGoToSignup: () => void;
  readonly style?: StyleProp<ViewStyle>;
}
const SANS_SEMIBOLD = {
  fontFamily: MOBILE_V2_FONT_SANS,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
} as const;

export function MobileV2LoginScreen(
  props: MobileV2LoginScreenProps,
): React.ReactElement {
  const { theme, step } = props;
  const isEmpStep = step === "emp";
  const valid = isEmpStep ? props.employeeId.trim().length >= 4 : props.otp.length === 6;
  const handleSubmit = (): void => {
    if (valid) props.onSubmit();
  };
  const handleOtpChange = (next: string): void => {
    props.onOtpChange(next.replace(/\D/g, "").slice(0, 6));
  };
  const handleEmpChange = (next: string): void => {
    props.onEmployeeIdChange(next.toUpperCase());
  };

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1 }}
      >
        {/* Header / form body */}
        <View
          style={{
            paddingTop: 40,
            paddingHorizontal: MOBILE_V2_SPACING["6xl"],
            paddingBottom: MOBILE_V2_SPACING["6xl"],
            flexGrow: 1,
          }}
        >
          {/* Brand mark */}
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              backgroundColor: theme.chrome,
              alignItems: "center",
              justifyContent: "center",
            }}
            accessibilityRole="image"
            accessibilityLabel="MasarX brand mark"
          >
            <Text
              style={{
                color: theme.onChrome,
                fontSize: 22,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_MONO,
              }}
            >
              {props.brandGlyph}
            </Text>
          </View>

          {/* Title + subtitle */}
          <Text
            style={{
              fontSize: 26,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: -0.6,
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
              marginTop: MOBILE_V2_SPACING["6xl"],
            }}
          >
            Welcome back.
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              marginTop: MOBILE_V2_SPACING.md,
            }}
          >
            {isEmpStep
              ? "Sign in to start your shift."
              : `Enter the 6-digit code we sent to ${props.otpMaskedPhone}.`}
          </Text>

          {/* Input */}
          <View style={{ marginTop: 28 }}>
            <Text
              style={{
                fontSize: 11,
                color: theme.muted,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginBottom: MOBILE_V2_SPACING.md,
              }}
            >
              {isEmpStep ? "Employee ID" : "One-time code"}
            </Text>
            {isEmpStep ? (
              <TextInput
                value={props.employeeId}
                onChangeText={handleEmpChange}
                placeholder="DRV-…"
                placeholderTextColor={theme.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="next"
                accessibilityLabel="Employee ID"
                style={{
                  width: "100%",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  fontSize: 16,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  color: theme.ink,
                }}
              />
            ) : (
              <TextInput
                value={props.otp}
                onChangeText={handleOtpChange}
                placeholder="••••••"
                placeholderTextColor={theme.muted}
                keyboardType="number-pad"
                autoFocus
                returnKeyType="done"
                maxLength={6}
                accessibilityLabel="One-time code"
                style={{
                  width: "100%",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  fontSize: 24,
                  letterSpacing: 8,
                  textAlign: "center",
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  color: theme.ink,
                }}
              />
            )}
          </View>

          {/* Inline error */}
          {props.errorMessage !== null && props.errorMessage !== undefined && props.errorMessage.length > 0 ? (
            <Text
              style={{
                fontSize: 12,
                color: theme.danger,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginTop: MOBILE_V2_SPACING.xl,
              }}
              accessibilityLiveRegion="polite"
            >
              {props.errorMessage}
            </Text>
          ) : null}

          {/* Resend hint */}
          {!isEmpStep && props.autoFillHint !== undefined && props.autoFillHint.length > 0 ? (
            <View style={{ flexDirection: "row", marginTop: MOBILE_V2_SPACING.xl }}>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {props.autoFillHint}
                {props.onResend !== undefined ? " · " : ""}
              </Text>
              {props.onResend !== undefined ? (
                <Pressable
                  onPress={props.onResend}
                  accessibilityRole="button"
                  accessibilityLabel="Resend code"
                >
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.accent,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    }}
                  >
                    Resend
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* Trust chips */}
          <FxRow gap={MOBILE_V2_SPACING.lg} style={{ marginTop: MOBILE_V2_SPACING["5xl"] }}>
            <FxChip theme={theme} icon="shield" tone="info" dense>
              Device verified
            </FxChip>
            <FxChip theme={theme} icon="globe" tone="neutral" dense>
              EN · العربية
            </FxChip>
          </FxRow>
        </View>

        {/* Sticky footer area */}
        <View
          style={{
            paddingHorizontal: MOBILE_V2_SPACING["4xl"],
            paddingTop: MOBILE_V2_SPACING["2xl"],
            paddingBottom: MOBILE_V2_SPACING["5xl"],
          }}
        >
          <FxButton
            theme={theme}
            variant={valid ? "chrome" : "soft"}
            full
            size="lg"
            iconRight="arrow-right"
            disabled={!valid}
            onPress={handleSubmit}
            accessibilityLabel={isEmpStep ? "Send code" : "Verify and continue"}
          >
            {isEmpStep ? "Send code" : "Verify & continue"}
          </FxButton>
          <Pressable
            onPress={props.onGoToSignup}
            accessibilityRole="button"
            accessibilityLabel="Go to sign up"
            style={{ alignItems: "center", marginTop: 14 }}
          >
            <Text
              style={{
                fontSize: 13,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                textAlign: "center",
              }}
            >
              New driver or loader?{" "}
              <Text
                style={{
                  ...SANS_SEMIBOLD,
                  color: theme.accent,
                }}
              >
                Sign up
              </Text>
            </Text>
          </Pressable>
          <Text
            style={{
              fontSize: 11,
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              textAlign: "center",
              marginTop: MOBILE_V2_SPACING.xl,
            }}
          >
            {props.versionLabel}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
