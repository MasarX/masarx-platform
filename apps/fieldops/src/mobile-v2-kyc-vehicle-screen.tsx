// Mobile V2 KYC Vehicle screen — pixel-faithful port of design source
// flow-onboard.jsx ScrKycVehicle. Step 2 of 4: capture the Istimara
// registration card, then OCR-confirm plate, year, make/model, and VIN.
// Insurance + Mulkia expiry are pulled from MoT registry automatically.
//
// Stateless: parent owns the istimara status + every text field +
// scan callback. The submit gate matches the source (plate >= 5,
// VIN >= 8, istimara not pending).

import * as React from "react";
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

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2IstimaraStatus = "pending" | "uploaded" | "approved" | "rejected";

export interface MobileV2IstimaraCapture {
  readonly base64: string;
  readonly mimeType: "image/jpeg";
  readonly extension: "jpg";
  readonly capturedAt: string;
}

export interface MobileV2KycVehicleReadbackCard {
  readonly vehicleId: string;
  readonly plate: string;
  readonly state: string;
  readonly decisionLogId: string;
  readonly submittedAt?: string | null;
}

export interface MobileV2KycVehicleScreenProps {
  readonly theme: MobileV2Theme;
  readonly istimaraStatus: MobileV2IstimaraStatus;
  readonly plate: string;
  readonly vin: string;
  readonly year: string;
  readonly model: string;
  readonly onScanIstimara: (capture?: MobileV2IstimaraCapture) => void | Promise<void>;
  readonly onUploadIstimara: () => void;
  readonly onPlateChange: (next: string) => void;
  readonly onVinChange: (next: string) => void;
  readonly onYearChange: (next: string) => void;
  readonly onModelChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onBack?: () => void;
  readonly requireCameraCapture?: boolean;
  readonly captureBusy?: boolean;
  readonly captureError?: string | null;
  readonly submitting?: boolean;
  readonly readbackError?: string | null;
  readonly latestReadback?: MobileV2KycVehicleReadbackCard | null;
  readonly style?: StyleProp<ViewStyle>;
}

const FIELD_LABEL = {
  fontSize: 10,
  letterSpacing: 0.6,
  textTransform: "uppercase" as const,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  fontFamily: MOBILE_V2_FONT_SANS,
};

const INPUT_BASE = {
  paddingHorizontal: 14,
  paddingVertical: 12,
  borderWidth: 1,
  borderRadius: 10,
  width: "100%" as const,
};

export function MobileV2KycVehicleScreen(
  props: MobileV2KycVehicleScreenProps,
): React.ReactElement {
  const { theme, istimaraStatus, plate, vin, year, model } = props;
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const busy = props.submitting === true || props.captureBusy === true;
  const valid =
    plate.trim().length >= 5 && vin.length >= 8 && istimaraStatus !== "pending" && !busy;
  const captureError = props.captureError ?? cameraError;
  const handleScanPress = React.useCallback(async (): Promise<void> => {
    if (busy) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await props.onScanIstimara();
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture Istimara evidence.");
        return;
      }
    }
    setCameraOpen(true);
  }, [busy, cameraPermission?.granted, props, requestCameraPermission]);
  const captureCameraPhoto = React.useCallback(async (): Promise<void> => {
    if (busy) return;
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
      await props.onScanIstimara({
        base64,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
      });
      setCameraOpen(false);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "Unable to capture Istimara evidence.");
    }
  }, [busy, props]);
  const statusTone =
    istimaraStatus === "approved"
      ? "success"
      : istimaraStatus === "uploaded"
        ? "info"
        : istimaraStatus === "rejected"
          ? "danger"
          : "warning";
  const statusLabel =
    istimaraStatus === "approved"
      ? "Approved"
      : istimaraStatus === "uploaded"
        ? "Scanned"
        : istimaraStatus === "rejected"
          ? "Rejected"
          : "Required";

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Vehicle registration", sub "Step 2 of 4 · Istimara"). */}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 140 }}
      >
        <FxCol gap={12} style={{ padding: 16 }}>
          {/* Istimara scan card */}
          <FxCard theme={theme}>
            <FxRow justify="space-between" align="center">
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Istimara (registration card)
              </Text>
              <FxChip theme={theme} tone={statusTone} dense>
                {statusLabel}
              </FxChip>
            </FxRow>
            <View
              style={{
                // Height 122 = the design's rendered box: the design canvas
                // uses content-box, so its `height:120` div + 1px dashed
                // borders occupies 122px. RN borders are inside the box, so
                // the impl needs height:122 for the same vertical footprint.
                height: 122,
                marginTop: MOBILE_V2_SPACING.xl,
                borderRadius: 10,
                backgroundColor: theme.surfaceAlt,
                borderColor: theme.border,
                borderWidth: 1,
                borderStyle: "dashed",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {istimaraStatus === "pending" ? (
                <FxCol gap={4} style={{ alignItems: "center" }}>
                  <FxIcon name="scan" size={28} color={theme.muted} />
                  <Text style={{ fontSize: 12, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                    Tap to scan card
                  </Text>
                </FxCol>
              ) : (
                <FxCol gap={4} style={{ alignItems: "center" }}>
                  <FxIcon name="check" size={28} color={theme.success} stroke={2.4} />
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Captured · OCR filled fields below
                  </Text>
                </FxCol>
              )}
            </View>
            <FxRow gap={MOBILE_V2_SPACING.lg} style={{ marginTop: MOBILE_V2_SPACING.xl }}>
              <FxButton
                theme={theme}
                variant="chrome"
                size="sm"
                icon="scan"
                disabled={busy}
                onPress={() => { void handleScanPress(); }}
                accessibilityLabel="Scan Istimara card"
                style={{ flex: 1 }}
              >
                Scan card
              </FxButton>
              <FxButton
                theme={theme}
                variant="ghost"
                size="sm"
                icon="doc"
                disabled={busy}
                onPress={props.onUploadIstimara}
                accessibilityLabel="Upload Istimara document"
              >
                Upload
              </FxButton>
            </FxRow>
          </FxCard>

          {cameraOpen ? (
            <FxCard theme={theme} padding={0} style={{ overflow: "hidden" }}>
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
                    disabled={busy}
                    onPress={() => { void captureCameraPhoto(); }}
                  >
                    {busy ? "Registering..." : "Capture Istimara"}
                  </FxButton>
                  <FxButton
                    theme={theme}
                    variant="ghost"
                    size="md"
                    icon="x"
                    disabled={busy}
                    onPress={() => setCameraOpen(false)}
                  >
                    Cancel
                  </FxButton>
                  {busy ? <ActivityIndicator color={theme.accent} /> : null}
                </FxRow>
              </View>
            </FxCard>
          ) : null}

          {/* OCR-filled fields */}
          <FxCol gap={MOBILE_V2_SPACING.xl}>
            <View>
              <Text style={[FIELD_LABEL, { color: theme.muted, marginBottom: 4 }]}>
                Plate number
              </Text>
              <TextInput
                value={plate}
                onChangeText={(t) => props.onPlateChange(t.toUpperCase())}
                placeholder="XXX-0000"
                placeholderTextColor={theme.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Plate number"
                style={[
                  INPUT_BASE,
                  {
                    fontSize: 15,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    color: theme.ink,
                  },
                ]}
              />
            </View>
            <FxRow gap={MOBILE_V2_SPACING.xl}>
              <View style={{ flex: 1 }}>
                <Text style={[FIELD_LABEL, { color: theme.muted, marginBottom: 4 }]}>
                  Year
                </Text>
                <TextInput
                  value={year}
                  onChangeText={(t) => props.onYearChange(t.replace(/\D/g, "").slice(0, 4))}
                  keyboardType="number-pad"
                  accessibilityLabel="Vehicle year"
                  style={[
                    INPUT_BASE,
                    {
                      fontSize: 15,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                      color: theme.ink,
                    },
                  ]}
                />
              </View>
              <View style={{ flex: 2 }}>
                <Text style={[FIELD_LABEL, { color: theme.muted, marginBottom: 4 }]}>
                  Make / model
                </Text>
                <TextInput
                  value={model}
                  onChangeText={props.onModelChange}
                  accessibilityLabel="Vehicle make and model"
                  style={[
                    INPUT_BASE,
                    {
                      fontSize: 14,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                      color: theme.ink,
                    },
                  ]}
                />
              </View>
            </FxRow>
            <View>
              <Text style={[FIELD_LABEL, { color: theme.muted, marginBottom: 4 }]}>
                VIN / Chassis
              </Text>
              <TextInput
                value={vin}
                onChangeText={(t) => props.onVinChange(t.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Vehicle identification number"
                style={[
                  INPUT_BASE,
                  {
                    fontSize: 13,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    color: theme.ink,
                  },
                ]}
              />
            </View>
          </FxCol>

          <FxCard theme={theme} soft padding={12}>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="info" size={16} color={theme.muted} />
              <Text
                style={{
                  fontSize: 11.5,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  lineHeight: 17,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                Insurance and Mulkia expiry are pulled from MoT registry and refreshed nightly — no
                upload needed if your Istimara is on file.
              </Text>
            </FxRow>
          </FxCard>

          {captureError !== null && captureError !== undefined ? (
            <FxCard
              theme={theme}
              padding={12}
              style={{ backgroundColor: theme.dangerSoft, borderColor: theme.danger }}
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
          ) : props.readbackError !== null && props.readbackError !== undefined ? (
            <FxCard
              theme={theme}
              padding={12}
              style={{ backgroundColor: theme.dangerSoft, borderColor: theme.danger }}
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
                  {props.readbackError}
                </Text>
              </FxRow>
            </FxCard>
          ) : props.latestReadback !== null && props.latestReadback !== undefined ? (
            <FxCard
              theme={theme}
              padding={12}
              style={{ backgroundColor: theme.successSoft, borderColor: theme.success }}
            >
              <FxRow gap={10} align="flex-start">
                <FxIcon name="check" size={16} color={theme.success} />
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Vehicle update confirmed
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {props.latestReadback.plate} - {props.latestReadback.state}
                  </Text>
                </FxCol>
              </FxRow>
            </FxCard>
          ) : null}
        </FxCol>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: MOBILE_V2_SPACING["2xl"],
          paddingBottom: 14,
          borderTopColor: theme.border,
          borderTopWidth: 1,
          backgroundColor: theme.surface,
        }}
      >
        <FxButton
          theme={theme}
          variant={valid ? "chrome" : "soft"}
          full
          size="lg"
          iconRight="arrow-right"
          disabled={!valid}
          onPress={() => valid && props.onSubmit()}
          accessibilityLabel="Submit vehicle details and continue to photos"
        >
          Submit & continue · vehicle photos
        </FxButton>
      </View>
    </KeyboardAvoidingView>
  );
}
