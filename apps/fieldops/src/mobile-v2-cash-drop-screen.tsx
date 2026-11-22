// Mobile V2 Cash Drop screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrCashDrop. Driver drops collected COD at
// the hub safe: chrome hero (counted vs expected + variance), nudger
// pad (±100/10/1 + Reset to expected), variance card that appears only
// when counted ≠ expected (supervisor name + envelope photo capture),
// and submit CTA that flips success ↔ primary based on variance.
//
// Variance gating is policy-driven via mobile_cash_policy: callers
// supply expectedSar (resolver output) so no SAR is hardcoded.

import * as React from "react";
import { redactOutboxErrorText } from "@masarx/mobile-core";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import {
  applyMobileV2CashAdjust,
  computeMobileV2CashVariance,
  formatMobileV2CurrencyCompact,
} from "./mobile-v2-ops-helpers";

export interface MobileV2CashDropLastDrop {
  readonly decisionLogId: string;
  readonly state: string;
  readonly expectedSar: number;
  readonly actualSar: number;
  readonly varianceSar: number;
  readonly supervisorName?: string | null;
  readonly submittedAt?: string | null;
  readonly photoId?: string | null;
  readonly photoArtifactRegistered?: boolean | null;
  readonly photoStorageKey?: string | null;
}

export interface MobileV2CashDropPhotoCapture {
  readonly base64: string;
  readonly mimeType: "image/jpeg";
  readonly extension: "jpg";
  readonly capturedAt: string;
}

export interface MobileV2CashDropScreenProps {
  readonly theme: MobileV2Theme;
  readonly expectedSar: number;
  readonly countedSar: number;
  readonly supervisorName: string;
  readonly safeLocation: string;
  readonly lastDrop?: MobileV2CashDropLastDrop | null;
  /**
   * ISO currency code resolved upstream from `mobile_cash_policy`. The
   * screen does not embed a literal currency symbol — per AGENTS.md the
   * symbol comes from `formatMobileV2CurrencyCompact` keyed by this code.
   * Defaults to "SAR" for backward compat.
   */
  readonly currency?: string;
  /** When true, an envelope photo has been captured (variance approval). */
  readonly photoCaptured?: boolean;
  readonly photoArtifactId?: string | null;
  readonly photoCaptureBusy?: boolean;
  readonly photoCaptureError?: string | null;
  readonly requireCameraCapture?: boolean;
  readonly onCountedChange: (next: number) => void;
  readonly onSupervisorChange: (next: string) => void;
  readonly onCapturePhoto?: (capture?: MobileV2CashDropPhotoCapture) => void | Promise<void>;
  readonly onSubmit?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const ADJUST_DELTAS: ReadonlyArray<number> = Object.freeze([-100, -10, -1, 1, 10, 100]);

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
};

function formatCashDropState(state: string): string {
  return state
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCashDropSubmittedAt(value: string | null | undefined): string {
  if (!value) return "Just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortDecisionId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

export function MobileV2CashDropScreen(
  props: MobileV2CashDropScreenProps,
): React.ReactElement {
  const { theme, expectedSar, countedSar } = props;
  const { variance, hasVariance } = computeMobileV2CashVariance(countedSar, expectedSar);
  // Zero-hardcoding: currency symbol resolved through the centralized
  // formatter keyed by the ladder-resolved currency code (default SAR).
  const currency = props.currency ?? "SAR";
  const currencySuffix = formatMobileV2CurrencyCompact(0, currency).split(" ")[1] ?? currency;
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const captureBusy = props.photoCaptureBusy === true;
  const captureError = props.photoCaptureError ?? cameraError;
  const photoStatusId = props.photoArtifactId ?? props.lastDrop?.photoId ?? null;

  const handlePhotoPress = React.useCallback(async (): Promise<void> => {
    if (captureBusy || props.onCapturePhoto === undefined) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await props.onCapturePhoto();
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture cash-drop evidence.");
        return;
      }
    }
    setCameraOpen(true);
  }, [cameraPermission?.granted, captureBusy, props, requestCameraPermission]);

  const captureCameraPhoto = React.useCallback(async (): Promise<void> => {
    if (captureBusy || props.onCapturePhoto === undefined) return;
    const camera = cameraRef.current;
    if (camera?.takePictureAsync === undefined) {
      setCameraError("Camera is not ready yet.");
      return;
    }
    try {
      const photo = await camera.takePictureAsync({
        quality: 0.55,
        base64: true,
        skipProcessing: true,
      }) as Record<string, unknown>;
      const base64 = typeof photo.base64 === "string" ? photo.base64 : null;
      if (base64 === null || base64.trim() === "") {
        throw new Error("Camera capture did not return image data.");
      }
      await props.onCapturePhoto({
        base64,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
      });
      setCameraOpen(false);
    } catch (error) {
      setCameraError(error instanceof Error ? redactOutboxErrorText(error.message) : "Unable to capture cash-drop evidence.");
    }
  }, [captureBusy, props]);

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING.lg,
          paddingBottom: 96,
        }}
      >
        {/* Chrome hero: counted */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 22,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxCol gap={MOBILE_V2_SPACING.xs}>
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
              Counted
            </Text>
            <FxRow gap={MOBILE_V2_SPACING.sm} align="flex-end">
              <Text
                style={{
                  fontSize: 46,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.onChrome,
                  letterSpacing: -1.5,
                }}
              >
                {countedSar}
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  paddingBottom: 6,
                }}
              >
                {currencySuffix}
              </Text>
            </FxRow>
            <Text
              style={{
                fontSize: 12,
                color: theme.onChrome,
                opacity: 0.7,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Expected {formatMobileV2CurrencyCompact(expectedSar, currency)} · variance{" "}
              {variance >= 0 ? "+" : ""}
              {variance}
            </Text>
          </FxCol>
        </View>

        {/* Adjust counted */}
        <FxCard theme={theme} padding={14}>
          <Text
            style={[
              SECTION_HEAD_STYLE,
              { color: theme.muted, marginBottom: MOBILE_V2_SPACING.md },
            ]}
          >
            Adjust counted
          </Text>
          <FxRow gap={MOBILE_V2_SPACING.sm} align="center">
            {ADJUST_DELTAS.map((d) => (
              <FxButton
                key={d}
                theme={theme}
                variant="soft"
                size="sm"
                onPress={() =>
                  props.onCountedChange(applyMobileV2CashAdjust(countedSar, d))
                }
                accessibilityLabel={`Adjust counted by ${d}`}
              >
                {d > 0 ? `+${d}` : `${d}`}
              </FxButton>
            ))}
          </FxRow>
          <FxButton
            theme={theme}
            variant="ghost"
            size="sm"
            full
            onPress={() => props.onCountedChange(expectedSar)}
            accessibilityLabel="Reset counted to expected"
            style={{ marginTop: MOBILE_V2_SPACING.md }}
          >
            Reset to expected
          </FxButton>
        </FxCard>

        {props.lastDrop ? (
          <FxCard theme={theme} padding={14}>
            <FxRow gap={MOBILE_V2_SPACING.md} align="flex-start">
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.successSoft,
                }}
              >
                <FxIcon name="check" size={18} color={theme.success} />
              </View>
              <FxCol gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Latest cash drop saved
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.inkSoft,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {formatMobileV2CurrencyCompact(props.lastDrop.actualSar, currency)} {" "}
                  {formatCashDropState(props.lastDrop.state)}
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Expected {formatMobileV2CurrencyCompact(props.lastDrop.expectedSar, currency)}
                  {" "}variance {props.lastDrop.varianceSar >= 0 ? "+" : ""}
                  {props.lastDrop.varianceSar}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  Decision {shortDecisionId(props.lastDrop.decisionLogId)} {" "}
                  {formatCashDropSubmittedAt(props.lastDrop.submittedAt)}
                </Text>
                {props.lastDrop.photoArtifactRegistered === true && props.lastDrop.photoId ? (
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    Envelope photo {shortDecisionId(props.lastDrop.photoId)}
                  </Text>
                ) : null}
              </FxCol>
            </FxRow>
          </FxCard>
        ) : null}

        {/* Variance card */}
        {hasVariance ? (
          <View
            style={{
              borderRadius: 18,
              borderColor: theme.warning,
              borderWidth: 1,
              backgroundColor: theme.warningSoft,
              padding: 14,
            }}
          >
            <FxRow gap={MOBILE_V2_SPACING.md} align="flex-start">
              <FxIcon name="alert" size={20} color={theme.warning} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.warning,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Variance · supervisor approval needed
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.warning,
                    opacity: 0.85,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Capture supervisor name + photo of envelope. Goes to approval queue.
                </Text>
              </FxCol>
            </FxRow>
            <TextInput
              value={props.supervisorName}
              onChangeText={props.onSupervisorChange}
              placeholder="Supervisor name"
              placeholderTextColor={theme.muted}
              autoCapitalize="words"
              returnKeyType="done"
              maxLength={64}
              accessibilityLabel="Supervisor name"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderColor: theme.warning,
                borderWidth: 1,
                borderRadius: 10,
                fontSize: 13,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginTop: MOBILE_V2_SPACING.md,
                backgroundColor: theme.surface,
                color: theme.ink,
              }}
            />
            <FxButton
              theme={theme}
              variant="soft"
              size="sm"
              full
              icon="camera"
              disabled={captureBusy || props.onCapturePhoto === undefined}
              onPress={() => { void handlePhotoPress(); }}
              accessibilityLabel="Capture envelope photo"
              style={{ marginTop: MOBILE_V2_SPACING.sm }}
            >
              {captureBusy ? "Registering envelope photo..." : "Capture envelope photo"}
            </FxButton>
            {props.photoCaptured === true ? (
              <Text
                style={{
                  fontSize: 11,
                  color: theme.success,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  marginTop: MOBILE_V2_SPACING.xs,
                }}
              >
                Envelope photo registered
                {photoStatusId !== null ? ` ${shortDecisionId(photoStatusId)}` : ""}
              </Text>
            ) : null}
            {cameraOpen ? (
              <FxCard theme={theme} padding={0} style={{ overflow: "hidden", marginTop: MOBILE_V2_SPACING.sm }}>
                <View style={{ height: 220, backgroundColor: theme.chrome }}>
                  <CameraView
                    ref={cameraRef as unknown as React.Ref<CameraView>}
                    style={{ flex: 1 }}
                  />
                </View>
                <View style={{ padding: 12 }}>
                  <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                    <FxButton
                      theme={theme}
                      variant="primary"
                      size="md"
                      icon="camera"
                      disabled={captureBusy}
                      onPress={() => { void captureCameraPhoto(); }}
                    >
                      {captureBusy ? "Registering..." : "Capture evidence"}
                    </FxButton>
                    <FxButton
                      theme={theme}
                      variant="ghost"
                      size="md"
                      icon="x"
                      disabled={captureBusy}
                      onPress={() => setCameraOpen(false)}
                    >
                      Cancel
                    </FxButton>
                    {captureBusy ? <ActivityIndicator color={theme.accent} /> : null}
                  </FxRow>
                </View>
              </FxCard>
            ) : null}
            {captureError !== null && captureError !== undefined ? (
              <FxCard
                theme={theme}
                padding={12}
                style={{
                  backgroundColor: theme.dangerSoft,
                  borderColor: theme.danger,
                  marginTop: MOBILE_V2_SPACING.sm,
                }}
              >
                <FxRow gap={10} align="flex-start">
                  <FxIcon name="alert" size={16} color={theme.danger} />
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.danger,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      lineHeight: 17,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {captureError}
                  </Text>
                </FxRow>
              </FxCard>
            ) : null}
          </View>
        ) : null}

        {/* Submit — P1 audit fix: when variance is non-zero, both
            supervisor name AND envelope photo are required before submit
            is enabled. This prevents a driver from submitting a +500 SAR
            variance without sign-off. */}
        {(() => {
          const submitBlocked =
            hasVariance &&
            (props.supervisorName.trim().length === 0 || props.photoCaptured !== true);
          return (
            <>
              <FxButton
                theme={theme}
                variant={hasVariance ? "primary" : "success"}
                full
                size="lg"
                icon="check"
                disabled={submitBlocked}
                onPress={props.onSubmit}
                accessibilityLabel={`Submit cash drop ${formatMobileV2CurrencyCompact(countedSar, currency)}`}
              >
                Submit drop · {formatMobileV2CurrencyCompact(countedSar, currency)}
              </FxButton>
              {submitBlocked ? (
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.warning,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    textAlign: "center",
                    marginTop: MOBILE_V2_SPACING.xs,
                  }}
                >
                  Supervisor name + envelope photo required before submission
                </Text>
              ) : null}
            </>
          );
        })()}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
