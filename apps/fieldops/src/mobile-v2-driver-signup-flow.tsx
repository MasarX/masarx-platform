import * as React from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import {
  buildMobileV2DriverApplicationFollowUp,
  formatMobileV2DriverApplicationStatusCopy,
  readMobileV2DriverApplicationStatus,
  submitMobileV2DriverSignup,
  type MobileV2DriverApplicationStatus,
  type MobileV2DriverSignupResult,
} from "./mobile-v2-driver-signup";
import {
  MobileV2SignupScreen,
  type MobileV2SignupRoleOption,
  type MobileV2SignupStep,
} from "./mobile-v2-signup-screen";
import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2DriverSignupFlowProps = {
  readonly theme: MobileV2Theme;
  readonly signupEndpoint: string;
  readonly statusEndpoint: string;
  readonly anonKey: string;
  readonly origin: string;
  readonly locale?: string | null;
  readonly roleOptions: ReadonlyArray<MobileV2SignupRoleOption>;
  readonly onBack: () => void;
};

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "driver_signup_failed";
}

export function MobileV2DriverSignupFlow(
  props: MobileV2DriverSignupFlowProps,
): React.ReactElement {
  const [step, setStep] = React.useState<MobileV2SignupStep>("phone");
  const [phone, setPhone] = React.useState("+966 ");
  const [otp, setOtp] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [organizationName, setOrganizationName] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [selectedRoleIds, setSelectedRoleIds] = React.useState<ReadonlyArray<string>>(() => {
    const first = props.roleOptions[0]?.id;
    return first ? [first] : [];
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [checkingStatus, setCheckingStatus] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [signupResult, setSignupResult] = React.useState<MobileV2DriverSignupResult | null>(null);
  const [applicationStatus, setApplicationStatus] =
    React.useState<MobileV2DriverApplicationStatus | null>(null);
  const applicationFollowUp = buildMobileV2DriverApplicationFollowUp(applicationStatus);

  React.useEffect(() => {
    setSelectedRoleIds((current) => {
      const validIds = new Set(props.roleOptions.map((role) => role.id));
      const next = current.filter((id) => validIds.has(id));
      const first = props.roleOptions[0]?.id;
      return next.length || !first ? next : [first];
    });
  }, [props.roleOptions]);

  const handleToggleRole = React.useCallback((id: string) => {
    setSelectedRoleIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }, []);

  const readStatus = React.useCallback(
    async (token: string): Promise<MobileV2DriverApplicationStatus> => {
      return readMobileV2DriverApplicationStatus({
        endpoint: props.statusEndpoint,
        anonKey: props.anonKey,
        origin: props.origin,
        token,
      });
    },
    [props.anonKey, props.origin, props.statusEndpoint],
  );

  const handleSubmit = React.useCallback(async () => {
    setErrorMessage(null);
    if (step === "phone") {
      setStep("profile");
      return;
    }
    if (step !== "profile" || submitting) return;

    setSubmitting(true);
    try {
      const result = await submitMobileV2DriverSignup({
        endpoint: props.signupEndpoint,
        anonKey: props.anonKey,
        origin: props.origin,
        locale: props.locale,
        draft: {
          email,
          fullName: name,
          phone,
          organizationName,
          employeeOrContractorId: employeeId,
          selectedRoleIds,
        },
      });
      const readback = await readStatus(result.applicationStatusToken);
      setSignupResult(result);
      setApplicationStatus(readback);
      setStep("profile");
    } catch (error) {
      setErrorMessage(formatError(error));
    } finally {
      setSubmitting(false);
    }
  }, [
    email,
    employeeId,
    name,
    organizationName,
    phone,
    props.anonKey,
    props.locale,
    props.origin,
    props.signupEndpoint,
    readStatus,
    selectedRoleIds,
    step,
    submitting,
  ]);

  const handleCheckStatus = React.useCallback(async () => {
    const token = signupResult?.applicationStatusToken;
    if (!token || checkingStatus) return;
    setCheckingStatus(true);
    setErrorMessage(null);
    try {
      setApplicationStatus(await readStatus(token));
    } catch (error) {
      setErrorMessage(formatError(error));
    } finally {
      setCheckingStatus(false);
    }
  }, [checkingStatus, readStatus, signupResult?.applicationStatusToken]);

  if (signupResult) {
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING["6xl"],
          paddingBottom: MOBILE_V2_SPACING["6xl"],
          backgroundColor: props.theme.bg,
        }}
      >
        <FxCol gap={MOBILE_V2_SPACING["4xl"]}>
          <FxButton
            theme={props.theme}
            variant="ghost"
            size="sm"
            icon="arrow-left"
            onPress={props.onBack}
            accessibilityLabel="Back to sign in"
          >
            Back to sign in
          </FxButton>

          <FxCard theme={props.theme}>
            <FxCol gap={MOBILE_V2_SPACING["3xl"]}>
              <FxRow gap={12} align="center">
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    backgroundColor: props.theme.accentSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon name="check" size={18} color={props.theme.accent} stroke={2.5} />
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      color: props.theme.ink,
                      fontSize: 18,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Application sent
                  </Text>
                  <Text
                    style={{
                      color: props.theme.muted,
                      fontSize: 12,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {signupResult.deduped ? "Existing application matched" : "New application created"}
                  </Text>
                </FxCol>
              </FxRow>

              <FxCol gap={8}>
                <Text style={{ color: props.theme.muted, fontSize: 11, fontFamily: MOBILE_V2_FONT_SANS }}>
                  Request
                </Text>
                <Text
                  selectable
                  style={{
                    color: props.theme.ink,
                    fontSize: 12,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {signupResult.id}
                </Text>
              </FxCol>

              <FxCol gap={8}>
                <Text style={{ color: props.theme.muted, fontSize: 11, fontFamily: MOBILE_V2_FONT_SANS }}>
                  Application status
                </Text>
                <Text
                  style={{
                    color: props.theme.ink,
                    fontSize: 14,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {applicationStatus?.status ?? signupResult.status}
                </Text>
                <Text style={{ color: props.theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS }}>
                  {formatMobileV2DriverApplicationStatusCopy(applicationStatus)}
                </Text>
              </FxCol>

              {applicationStatus?.status === "approved" ? (
                <FxCol gap={8}>
                  <Text style={{ color: props.theme.muted, fontSize: 11, fontFamily: MOBILE_V2_FONT_SANS }}>
                    Profile handoff
                  </Text>
                  <Text
                    style={{
                      color: applicationStatus.profileHandoff.ready ? props.theme.success : props.theme.warning,
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {applicationStatus.profileHandoff.ready ? "Ready for Mobile V2 login" : "Waiting for approval handoff"}
                  </Text>
                  {applicationStatus.profileHandoff.participantProfileId ? (
                    <Text
                      selectable
                      style={{
                        color: props.theme.muted,
                        fontSize: 11,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {applicationStatus.profileHandoff.participantProfileId}
                    </Text>
                  ) : null}
                </FxCol>
              ) : null}

              {applicationFollowUp ? (
                <FxCol gap={8}>
                  <Text style={{ color: props.theme.muted, fontSize: 11, fontFamily: MOBILE_V2_FONT_SANS }}>
                    Application follow-up
                  </Text>
                  <Text
                    style={{
                      color:
                        applicationFollowUp.tone === "danger"
                          ? props.theme.danger
                          : applicationFollowUp.tone === "warning"
                            ? props.theme.warning
                            : props.theme.ink,
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {applicationFollowUp.title}
                  </Text>
                  {applicationFollowUp.reason ? (
                    <Text style={{ color: props.theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS }}>
                      {applicationFollowUp.reason}
                    </Text>
                  ) : null}
                  {applicationFollowUp.requestedDocuments.length ? (
                    <Text
                      selectable
                      style={{
                        color: props.theme.muted,
                        fontSize: 11,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {applicationFollowUp.requestedDocuments.join(", ")}
                    </Text>
                  ) : null}
                </FxCol>
              ) : null}

              {errorMessage ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={{
                    color: props.theme.danger,
                    fontSize: 12,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {errorMessage}
                </Text>
              ) : null}

              <FxButton
                theme={props.theme}
                variant="chrome"
                size="lg"
                full
                iconRight="refresh"
                disabled={checkingStatus}
                onPress={handleCheckStatus}
                accessibilityLabel="Check application status"
              >
                {checkingStatus ? "Checking..." : "Check status"}
              </FxButton>
            </FxCol>
          </FxCard>
        </FxCol>
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: props.theme.bg }}>
      <View style={{ paddingHorizontal: MOBILE_V2_SPACING["4xl"], paddingTop: MOBILE_V2_SPACING["4xl"] }}>
        <FxButton
          theme={props.theme}
          variant="ghost"
          size="sm"
          icon="arrow-left"
          onPress={step === "phone" ? props.onBack : () => setStep("phone")}
          accessibilityLabel={step === "phone" ? "Back to sign in" : "Back to mobile number"}
        >
          {step === "phone" ? "Back to sign in" : "Back"}
        </FxButton>
      </View>
      <MobileV2SignupScreen
        theme={props.theme}
        step={step}
        phone={phone}
        otp={otp}
        name={name}
        email={email}
        organizationName={organizationName}
        employeeId={employeeId}
        selectedRoleIds={selectedRoleIds}
        roleOptions={props.roleOptions}
        errorMessage={errorMessage}
        onPhoneChange={(next) => {
          setPhone(next);
          setErrorMessage(null);
        }}
        onOtpChange={setOtp}
        onNameChange={(next) => {
          setName(next);
          setErrorMessage(null);
        }}
        onEmailChange={(next) => {
          setEmail(next);
          setErrorMessage(null);
        }}
        onOrganizationNameChange={(next) => {
          setOrganizationName(next);
          setErrorMessage(null);
        }}
        onEmployeeIdChange={(next) => {
          setEmployeeId(next);
          setErrorMessage(null);
        }}
        onToggleRole={handleToggleRole}
        onBack={step === "phone" ? props.onBack : () => setStep("phone")}
        onSubmit={handleSubmit}
        requireEmail
        requireOrganizationName
        profileSubmitLabel={submitting ? "Submitting..." : "Submit application"}
        profileSubmitAccessibilityLabel="Submit driver application"
        style={{ flex: 1 }}
      />
      {submitting ? (
        <View
          style={{
            position: "absolute",
            right: MOBILE_V2_SPACING["4xl"],
            bottom: MOBILE_V2_SPACING["4xl"],
            flexDirection: "row",
            alignItems: "center",
            gap: MOBILE_V2_SPACING.lg,
          }}
        >
          <ActivityIndicator color={props.theme.accent} />
          <Text style={{ color: props.theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS }}>
            Saving application...
          </Text>
        </View>
      ) : null}
    </View>
  );
}
