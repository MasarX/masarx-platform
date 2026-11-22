// Mobile V2 KYC Vehicle Photos screen — pixel-faithful port of design
// source flow-onboard.jsx ScrKycVehiclePhotos. Step 3 of 4: capture 4
// angle photos of the vehicle (front, rear, left, right). Each captured
// tile renders a stroked silhouette of the vehicle for that angle plus
// a "Captured" chip, matching the source SVG specimens.
//
// Stateless: parent owns the set of captured angle keys and the snap
// callback; submit is gated until all 4 are present.

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
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2VehicleAngleId = "front" | "rear" | "left" | "right";

export interface MobileV2VehicleAngle {
  readonly id: MobileV2VehicleAngleId;
  readonly label: string;
  readonly hint: string;
}

export interface MobileV2VehiclePhotoCapture {
  readonly base64: string;
  readonly mimeType: "image/jpeg";
  readonly extension: "jpg";
  readonly capturedAt: string;
}

export interface MobileV2VehiclePhotosReadbackCard {
  readonly photoSetId: string;
  readonly decisionLogId: string;
  readonly state: string;
  readonly photoCount: number;
  readonly submittedAt?: string | null;
}

export interface MobileV2KycVehiclePhotosScreenProps {
  readonly theme: MobileV2Theme;
  /**
   * Source list of all four angles — matches the design source vocabulary.
   * Pass the canonical 4-angle list via props so per-tenant fleets (e.g.
   * trailer vs. van) can extend without UI changes.
   */
  readonly angles: ReadonlyArray<MobileV2VehicleAngle>;
  readonly capturedAngleIds: ReadonlyArray<MobileV2VehicleAngleId>;
  readonly onSnap: (id: MobileV2VehicleAngleId, capture?: MobileV2VehiclePhotoCapture) => void | Promise<void>;
  readonly onSubmit: () => void;
  readonly onContinue?: () => void;
  readonly onBack?: () => void;
  readonly requireCameraCapture?: boolean;
  readonly captureBusyAngleId?: MobileV2VehicleAngleId | null;
  readonly captureError?: string | null;
  readonly submitting?: boolean;
  readonly readbackError?: string | null;
  readonly latestReadback?: MobileV2VehiclePhotosReadbackCard | null;
  readonly style?: StyleProp<ViewStyle>;
}

function VehicleSilhouette(props: {
  readonly angle: MobileV2VehicleAngleId;
  readonly chrome: string;
  readonly onChrome: string;
}): React.ReactElement {
  const { angle, chrome, onChrome } = props;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 200 110">
      <Rect x={0} y={0} width={200} height={110} fill={chrome} />
      <G opacity={0.5} fill="none" stroke={onChrome} strokeWidth={1.5}>
        {angle === "front" ? (
          <>
            <Rect x={55} y={35} width={90} height={50} rx={6} />
            <Rect x={62} y={50} width={76} height={20} />
            <Circle cx={68} cy={85} r={6} />
            <Circle cx={132} cy={85} r={6} />
            <Rect x={78} y={74} width={44} height={6} rx={2} />
          </>
        ) : null}
        {angle === "rear" ? (
          <>
            <Rect x={55} y={35} width={90} height={50} rx={6} />
            <Rect x={62} y={50} width={76} height={22} />
            <Circle cx={68} cy={85} r={6} />
            <Circle cx={132} cy={85} r={6} />
            <Rect x={78} y={76} width={44} height={6} rx={2} />
            <Circle cx={64} cy={50} r={3} />
            <Circle cx={136} cy={50} r={3} />
          </>
        ) : null}
        {angle === "left" ? (
          <>
            <Path d="M30 70 L40 50 L120 50 L140 35 L170 35 L170 70" />
            <Circle cx={55} cy={78} r={9} />
            <Circle cx={155} cy={78} r={9} />
          </>
        ) : null}
        {angle === "right" ? (
          <>
            <Path d="M170 70 L160 50 L80 50 L60 35 L30 35 L30 70" />
            <Circle cx={55} cy={78} r={9} />
            <Circle cx={155} cy={78} r={9} />
          </>
        ) : null}
      </G>
    </Svg>
  );
}

export function MobileV2KycVehiclePhotosScreen(
  props: MobileV2KycVehiclePhotosScreenProps,
): React.ReactElement {
  const { theme, angles, capturedAngleIds } = props;
  const [cameraAngle, setCameraAngle] = React.useState<MobileV2VehicleAngleId | null>(null);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const capturedSet = React.useMemo(() => new Set(capturedAngleIds), [capturedAngleIds]);
  const allDone = angles.length > 0 && angles.every((a) => capturedSet.has(a.id));
  const captureCount = capturedAngleIds.length;
  const totalCount = angles.length;
  const hasBackendReadback = props.latestReadback !== null && props.latestReadback !== undefined;
  const submitCtaLabel = hasBackendReadback ? "Continue to cleaning" : "Submit photos - continue";
  const submitAccessibilityLabel = hasBackendReadback
    ? "Continue to cleaning"
    : "Submit photos and continue";
  const busy =
    props.submitting === true
    || (props.captureBusyAngleId !== null && props.captureBusyAngleId !== undefined);
  const captureError = props.captureError ?? cameraError;
  const handleAnglePress = React.useCallback(async (angle: MobileV2VehicleAngleId): Promise<void> => {
    if (busy) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await props.onSnap(angle);
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture vehicle evidence.");
        return;
      }
    }
    setCameraAngle(angle);
  }, [busy, cameraPermission?.granted, props, requestCameraPermission]);
  const captureCameraPhoto = React.useCallback(async (): Promise<void> => {
    if (busy || cameraAngle === null) return;
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
      await props.onSnap(cameraAngle, {
        base64,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
      });
      setCameraAngle(null);
    } catch (error) {
      setCameraError(error instanceof Error ? redactOutboxErrorText(error.message) : "Unable to capture vehicle evidence.");
    }
  }, [busy, cameraAngle, props]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Vehicle photos", sub "Step 3 of 4 · 4 angles"). */}
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <FxCol gap={12} style={{ padding: 16 }}>
          <FxCard theme={theme} soft padding={12}>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="camera" size={16} color={theme.muted} />
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
                Daylight · clean vehicle · plate clearly visible. Photos are time-stamped and
                geo-tagged so we don't need a re-shoot every time you're audited.
              </Text>
            </FxRow>
          </FxCard>

          {cameraAngle !== null ? (
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
                    {busy ? "Registering..." : `Capture ${cameraAngle}`}
                  </FxButton>
                  <FxButton
                    theme={theme}
                    variant="ghost"
                    size="md"
                    icon="x"
                    disabled={busy}
                    onPress={() => setCameraAngle(null)}
                  >
                    Cancel
                  </FxButton>
                  {busy ? <ActivityIndicator color={theme.accent} /> : null}
                </FxRow>
              </View>
            </FxCard>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              margin: -5,
            }}
          >
            {angles.map((a) => {
              const has = capturedSet.has(a.id);
              return (
                <View
                  key={a.id}
                  style={{ width: "50%", padding: 5 }}
                >
                  <Pressable
                    onPress={() => { void handleAnglePress(a.id); }}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Capture ${a.label} angle — ${a.hint}`}
                    accessibilityState={{ selected: has }}
                  >
                    <FxCard theme={theme} padding={0} style={{ overflow: "hidden" }}>
                      <View
                        style={{
                          height: 110,
                          backgroundColor: has ? theme.chrome : theme.surfaceAlt,
                          alignItems: "center",
                          justifyContent: "center",
                          position: "relative",
                        }}
                      >
                        {has ? (
                          <>
                            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
                              <VehicleSilhouette
                                angle={a.id}
                                chrome={theme.chrome}
                                onChrome={theme.onChrome}
                              />
                            </View>
                            <View style={{ position: "absolute", top: 6, right: 6 }}>
                              <FxChip theme={theme} tone="success" dense icon="check">
                                Captured
                              </FxChip>
                            </View>
                          </>
                        ) : (
                          <FxCol gap={4} style={{ alignItems: "center" }}>
                            <FxIcon name="camera" size={22} color={theme.muted} />
                            <Text
                              style={{
                                fontSize: 11,
                                color: theme.muted,
                                fontFamily: MOBILE_V2_FONT_SANS,
                              }}
                            >
                              Tap to capture
                            </Text>
                          </FxCol>
                        )}
                      </View>
                      <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          {a.label}
                        </Text>
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          {a.hint}
                        </Text>
                      </View>
                    </FxCard>
                  </Pressable>
                </View>
              );
            })}
          </View>

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

          {props.readbackError !== null && props.readbackError !== undefined ? (
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
          ) : null}

          {props.latestReadback !== null && props.latestReadback !== undefined ? (
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
                    Photo update confirmed
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {props.latestReadback.state} - {props.latestReadback.photoCount} photos
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
          variant={allDone ? "chrome" : "soft"}
          full
          size="lg"
          iconRight="arrow-right"
          disabled={!allDone || props.submitting === true}
          onPress={() => {
            if (!allDone || props.submitting === true) return;
            if (hasBackendReadback && props.onContinue !== undefined) {
              props.onContinue();
              return;
            }
            props.onSubmit();
          }}
          accessibilityLabel={
            allDone
              ? submitAccessibilityLabel
              : `Capture all ${totalCount} angles, ${captureCount} so far`
          }
        >
          {props.submitting === true
            ? "Saving photos..."
            : allDone
              ? submitCtaLabel
              : `Capture all ${totalCount} angles (${captureCount}/${totalCount})`}
        </FxButton>
      </View>
    </View>
  );
}
