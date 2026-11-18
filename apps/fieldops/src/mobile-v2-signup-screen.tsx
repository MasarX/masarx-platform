// Mobile V2 Signup screen — pixel-faithful port of design source
// flow-auth.jsx ScrSignup. Three-step flow: phone -> OTP -> profile
// (name + employee/contractor id + role multi-select). Role catalog
// arrives as a prop so per-tenant role lists stay config-driven.
//
// Stateless: parent owns step + every field value; this screen renders
// the current step and routes Continue / Back via callbacks.

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

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2SignupStep = "phone" | "otp" | "profile";

export interface MobileV2SignupRoleOption {
  readonly id: string;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly sub: string;
}

export interface MobileV2SignupScreenProps {
  readonly theme: MobileV2Theme;
  readonly step: MobileV2SignupStep;
  readonly phone: string;
  readonly otp: string;
  readonly name: string;
  readonly email?: string;
  readonly organizationName?: string;
  readonly employeeId: string;
  readonly selectedRoleIds: ReadonlyArray<string>;
  readonly roleOptions: ReadonlyArray<MobileV2SignupRoleOption>;
  readonly errorMessage?: string | null;
  readonly autoFillHint?: string;
  readonly requireEmail?: boolean;
  readonly requireOrganizationName?: boolean;
  readonly profileSubmitLabel?: string;
  readonly profileSubmitAccessibilityLabel?: string;
  readonly onPhoneChange: (next: string) => void;
  readonly onOtpChange: (next: string) => void;
  readonly onNameChange: (next: string) => void;
  readonly onEmailChange?: (next: string) => void;
  readonly onOrganizationNameChange?: (next: string) => void;
  readonly onEmployeeIdChange: (next: string) => void;
  readonly onToggleRole: (id: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
  readonly onResend?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const SECTION_LABEL = {
  fontSize: 11,
  letterSpacing: 0.6,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
};

function validateStep(props: MobileV2SignupScreenProps): boolean {
  switch (props.step) {
    case "phone":
      return props.phone.replace(/\D/g, "").length >= 10;
    case "otp":
      return props.otp.length === 6;
    case "profile":
      return (
        props.name.trim().length > 2 &&
        (props.requireEmail !== true ||
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(props.email ?? "").trim())) &&
        (props.requireOrganizationName !== true ||
          String(props.organizationName ?? "").trim().length >= 2) &&
        props.employeeId.trim().length >= 4 &&
        props.selectedRoleIds.length > 0
      );
    default:
      return false;
  }
}

export function MobileV2SignupScreen(
  props: MobileV2SignupScreenProps,
): React.ReactElement {
  const { theme, step } = props;
  const valid = validateStep(props);
  const handleSubmit = (): void => {
    if (valid) props.onSubmit();
  };
  const handleOtpChange = (next: string): void => {
    props.onOtpChange(next.replace(/\D/g, "").slice(0, 6));
  };

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Create account", sub stepSub(step), back via onBack). */}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 22,
          paddingTop: 18,
          paddingBottom: 22,
          flexGrow: 1,
        }}
      >
        {step === "phone" ? (
          <FxCol gap={14}>
            <View>
              <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md }]}>
                Mobile number
              </Text>
              <TextInput
                value={props.phone}
                onChangeText={props.onPhoneChange}
                placeholder="+966 5• ••• ••••"
                placeholderTextColor={theme.muted}
                keyboardType="phone-pad"
                autoFocus
                returnKeyType="next"
                accessibilityLabel="Mobile number"
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
            </View>
            <FxCard theme={theme} soft>
              <FxRow gap={10} align="flex-start">
                <FxIcon name="info" size={18} color={theme.muted} />
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Why we need this
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      lineHeight: 18,
                    }}
                  >
                    We send delivery OTPs and dispatch alerts to this number. You'll verify it in the next step.
                  </Text>
                </FxCol>
              </FxRow>
            </FxCard>
          </FxCol>
        ) : null}

        {step === "otp" ? (
          <FxCol gap={14}>
            <Text
              style={{
                fontSize: 13,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Sent a 6-digit code to{" "}
              <Text style={{ color: theme.ink, fontFamily: MOBILE_V2_FONT_MONO, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold }}>
                {props.phone}
              </Text>
            </Text>
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
            {props.autoFillHint !== undefined && props.autoFillHint.length > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={{ fontSize: 12, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
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
                      Resend code
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </FxCol>
        ) : null}

        {step === "profile" ? (
          <FxCol gap={14}>
            <View>
              <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md }]}>
                Full name (as on Iqama)
              </Text>
              <TextInput
                value={props.name}
                onChangeText={props.onNameChange}
                placeholder="e.g. Omar Al-Saadi"
                placeholderTextColor={theme.muted}
                autoCapitalize="words"
                autoFocus
                returnKeyType="next"
                accessibilityLabel="Full name"
                style={{
                  width: "100%",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  fontSize: 15,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  color: theme.ink,
                }}
              />
            </View>
            {props.onEmailChange ? (
              <View>
                <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md }]}>
                  Work email
                </Text>
                <TextInput
                  value={props.email ?? ""}
                  onChangeText={(t) => props.onEmailChange?.(t.trim().toLowerCase())}
                  placeholder="lhwmilsokgrmgptsihhuoljt@example.invalid"
                  placeholderTextColor={theme.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="next"
                  accessibilityLabel="Work email"
                  style={{
                    width: "100%",
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    fontSize: 15,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderWidth: 1,
                    borderRadius: 12,
                    color: theme.ink,
                  }}
                />
              </View>
            ) : null}
            {props.onOrganizationNameChange ? (
              <View>
                <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md }]}>
                  Company / fleet
                </Text>
                <TextInput
                  value={props.organizationName ?? ""}
                  onChangeText={props.onOrganizationNameChange}
                  placeholder="e.g. Riyadh Driver Network"
                  placeholderTextColor={theme.muted}
                  autoCapitalize="words"
                  returnKeyType="next"
                  accessibilityLabel="Company or fleet"
                  style={{
                    width: "100%",
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    fontSize: 15,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderWidth: 1,
                    borderRadius: 12,
                    color: theme.ink,
                  }}
                />
              </View>
            ) : null}
            <View>
              <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md }]}>
                Employee / contractor ID
              </Text>
              <TextInput
                value={props.employeeId}
                onChangeText={(t) => props.onEmployeeIdChange(t.toUpperCase())}
                placeholder="DRV-… or LDR-…"
                placeholderTextColor={theme.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                accessibilityLabel="Employee or contractor ID"
                style={{
                  width: "100%",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  fontSize: 15,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  color: theme.ink,
                }}
              />
            </View>
            <View>
              <Text style={[SECTION_LABEL, { color: theme.muted, marginBottom: 8 }]}>
                I will work as
              </Text>
              <FxCol gap={MOBILE_V2_SPACING.lg}>
                {props.roleOptions.map((r) => {
                  const on = props.selectedRoleIds.includes(r.id);
                  return (
                    <Pressable
                      key={r.id}
                      onPress={() => props.onToggleRole(r.id)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={`${r.label} role`}
                      style={{
                        flexDirection: "row",
                        gap: 12,
                        alignItems: "center",
                        padding: 12,
                        paddingHorizontal: 14,
                        backgroundColor: on ? theme.accentSoft : theme.surface,
                        borderColor: on ? theme.accent : theme.border,
                        borderWidth: 1,
                        borderRadius: 12,
                      }}
                    >
                      <View
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          backgroundColor: on ? theme.accent : theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {on ? (
                          <FxIcon name="check" size={14} color={theme.accentInk} stroke={2.5} />
                        ) : null}
                      </View>
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          backgroundColor: theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <FxIcon name={r.icon} size={16} color={on ? theme.accent : theme.muted} />
                      </View>
                      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={{
                            fontSize: 13.5,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          {r.label}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          {r.sub}
                        </Text>
                      </FxCol>
                    </Pressable>
                  );
                })}
              </FxCol>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  marginTop: MOBILE_V2_SPACING.lg,
                }}
              >
                Pick both if you cover loading shifts as well as routes — you can switch any time from the side menu.
              </Text>
            </View>
          </FxCol>
        ) : null}

        {props.errorMessage !== null && props.errorMessage !== undefined && props.errorMessage.length > 0 ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{
              fontSize: 12,
              color: theme.danger,
              fontFamily: MOBILE_V2_FONT_SANS,
              marginTop: MOBILE_V2_SPACING["3xl"],
            }}
          >
            {props.errorMessage}
          </Text>
        ) : null}
      </ScrollView>

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
          accessibilityLabel={
            step === "profile"
              ? props.profileSubmitAccessibilityLabel ?? "Create account and upload docs"
              : "Continue"
          }
        >
          {step === "profile"
            ? props.profileSubmitLabel ?? "Create account · upload docs"
            : "Continue"}
        </FxButton>
      </View>
    </KeyboardAvoidingView>
  );
}
