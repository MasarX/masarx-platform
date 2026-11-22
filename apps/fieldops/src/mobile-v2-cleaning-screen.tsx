// Mobile V2 Vehicle Cleaning screen — pixel-faithful port of design
// source flow-onboard.jsx ScrCleaning. Step 4 of 4: daily cleaning
// attestation. Items are data-driven (cabin/cargo/glass/odour/plate
// etc.) and submission is gated until every item is checked AND a
// proof photo of the cargo bay is captured. The captured photo tile
// renders a faux cargo-bay silhouette + a time/GPS stamp passed in
// via props (zero-hardcoding for stamps).

import * as React from "react";
import { redactOutboxErrorText } from "@masarx/mobile-core";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import Svg, { Circle, G, Rect, Text as SvgText } from "react-native-svg";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2CleaningItem {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
}

export interface MobileV2CleaningReadbackCard {
  readonly checkId: string;
  readonly decisionLogId: string;
  readonly state: string;
  readonly itemCount: number;
  readonly submittedAt?: string | null;
}

export interface MobileV2CleaningPhotoCapture {
  readonly base64: string;
  readonly mimeType: "image/jpeg";
  readonly extension: "jpg";
  readonly capturedAt: string;
}

export interface MobileV2CleaningScreenProps {
  readonly theme: MobileV2Theme;
  readonly items: ReadonlyArray<MobileV2CleaningItem>;
  readonly checkedIds: ReadonlyArray<string>;
  readonly photoCaptured: boolean;
  /**
   * Stamp rendered on the captured photo specimen (e.g. "2026-05-02 · 06:42 · 24.71°N 46.67°E").
   * Required when `photoCaptured` is true; ignored otherwise.
   */
  readonly photoStamp?: string;
  readonly onToggleItem: (id: string) => void;
  readonly onCapturePhoto: (capture?: MobileV2CleaningPhotoCapture) => void | Promise<void>;
  readonly onSubmit: () => void;
  readonly onBack?: () => void;
  readonly latestReadback?: MobileV2CleaningReadbackCard | null;
  readonly readbackError?: string | null;
  readonly submitting?: boolean;
  readonly requireCameraCapture?: boolean;
  readonly captureBusy?: boolean;
  readonly captureError?: string | null;
  readonly style?: StyleProp<ViewStyle>;
}

function CargoBaySilhouette(props: {
  readonly chrome: string;
  readonly onChrome: string;
  readonly stamp?: string;
}): React.ReactElement {
  const { chrome, onChrome, stamp } = props;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 320 140">
      <Rect x={0} y={0} width={320} height={140} fill={chrome} />
      <G opacity={0.5} fill="none" stroke={onChrome} strokeWidth={1.5}>
        <Rect x={80} y={50} width={160} height={60} rx={8} />
        <Rect x={92} y={62} width={136} height={36} rx={2} />
        <Circle cx={108} cy={118} r={10} />
        <Circle cx={212} cy={118} r={10} />
      </G>
      {stamp !== undefined && stamp.length > 0 ? (
        <SvgText
          x={16}
          y={128}
          fontSize={10}
          fill={onChrome}
          opacity={0.7}
          fontFamily={MOBILE_V2_FONT_MONO}
        >
          {stamp}
        </SvgText>
      ) : null}
    </Svg>
  );
}

export function MobileV2CleaningScreen(
  props: MobileV2CleaningScreenProps,
): React.ReactElement {
  const { theme, items, checkedIds, photoCaptured } = props;
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const checkedSet = React.useMemo(() => new Set(checkedIds), [checkedIds]);
  const allItemsChecked = items.length > 0 && items.every((i) => checkedSet.has(i.id));
  const allOk = allItemsChecked && photoCaptured;
  const busy = props.submitting === true || props.captureBusy === true;
  const canSubmit = allOk && !busy;
  const captureError = props.captureError ?? cameraError;
  const submitLabel = props.submitting
    ? "Saving cleaning..."
    : allOk
      ? "Log cleaning & finish"
      : "Tick all items + add photo";
  const handlePhotoPress = React.useCallback(async (): Promise<void> => {
    if (busy) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await props.onCapturePhoto();
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture cleaning evidence.");
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
      await props.onCapturePhoto({
        base64,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
      });
      setCameraOpen(false);
    } catch (error) {
      setCameraError(error instanceof Error ? redactOutboxErrorText(error.message) : "Unable to capture cleaning evidence.");
    }
  }, [busy, props]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Vehicle cleaning", sub "Step 4 of 4 · Daily attestation"). */}
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <FxCol gap={12} style={{ padding: 16 }}>
          <FxCard theme={theme} soft>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="info" size={16} color={theme.muted} />
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  lineHeight: 18,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                Daily before first stop. We log time + GPS so the warehouse can confirm cold-chain
                readiness.
              </Text>
            </FxRow>
          </FxCard>

          {/* Photo proof */}
          <Pressable
            onPress={() => { void handlePhotoPress(); }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={
              photoCaptured ? "Cargo bay photo captured" : "Take photo of cargo bay"
            }
            accessibilityState={{ selected: photoCaptured }}
          >
            <FxCard theme={theme} padding={0} style={{ overflow: "hidden" }}>
              <View
                style={{
                  height: 140,
                  backgroundColor: photoCaptured ? theme.chrome : theme.surfaceAlt,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {photoCaptured ? (
                  <>
                    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
                      <CargoBaySilhouette
                        chrome={theme.chrome}
                        onChrome={theme.onChrome}
                        stamp={props.photoStamp}
                      />
                    </View>
                    <View style={{ position: "absolute", top: 8, right: 8 }}>
                      <FxChip theme={theme} tone="success" dense icon="check">
                        Captured
                      </FxChip>
                    </View>
                  </>
                ) : (
                  <FxCol gap={4} style={{ alignItems: "center" }}>
                    <FxIcon name="camera" size={26} color={theme.muted} />
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      Tap to take photo of cargo bay
                    </Text>
                  </FxCol>
                )}
              </View>
            </FxCard>
          </Pressable>

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
                    {busy ? "Registering..." : "Capture evidence"}
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
          ) : null}

          {/* Items list */}
          <View
            style={{
              backgroundColor: theme.border,
              borderRadius: 14,
              overflow: "hidden",
              rowGap: 1,
            }}
          >
            {items.map((i) => {
              const on = checkedSet.has(i.id);
              return (
                <Pressable
                  key={i.id}
                  onPress={() => props.onToggleItem(i.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${i.label} — ${i.sub}`}
                  style={{
                    backgroundColor: theme.surface,
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    flexDirection: "row",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      backgroundColor: on ? theme.success : theme.surfaceAlt,
                      borderColor: on ? "transparent" : theme.border,
                      borderWidth: 1,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {on ? <FxIcon name="check" size={16} color="#FFFFFF" stroke={2.5} /> : null}
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
                      {i.label}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11.5,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {i.sub}
                    </Text>
                  </FxCol>
                </Pressable>
              );
            })}
          </View>

          {props.readbackError !== undefined && props.readbackError !== null ? (
            <FxCard
              theme={theme}
              padding={14}
              style={{
                backgroundColor: theme.dangerSoft,
                borderColor: theme.danger,
              }}
            >
              <FxRow gap={10} align="flex-start">
                <FxIcon name="alert" size={18} color={theme.danger} />
                <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.danger,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Confirmation needed
                  </Text>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.danger,
                      lineHeight: 17,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {props.readbackError}
                  </Text>
                </FxCol>
              </FxRow>
            </FxCard>
          ) : props.latestReadback !== undefined && props.latestReadback !== null ? (
            <FxCard
              theme={theme}
              padding={14}
              style={{
                backgroundColor: theme.successSoft,
                borderColor: theme.success,
              }}
            >
              <FxRow gap={10} align="flex-start">
                <FxIcon name="check-double" size={18} color={theme.success} />
                <FxCol gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Cleaning saved
                  </Text>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.success,
                      lineHeight: 17,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {props.latestReadback.itemCount} item(s) logged - {props.latestReadback.state}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.success,
                      opacity: 0.8,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    Saved to cleaning checklist
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
          variant={canSubmit ? "success" : "soft"}
          full
          size="lg"
          icon={canSubmit ? "check" : "alert"}
          disabled={!canSubmit}
          onPress={() => canSubmit && props.onSubmit()}
          accessibilityLabel={
            props.submitting
              ? "Saving cleaning"
              : allOk
                ? "Log cleaning and finish"
                : "Tick all items and add photo"
          }
        >
          {submitLabel}
        </FxButton>
      </View>
    </View>
  );
}
