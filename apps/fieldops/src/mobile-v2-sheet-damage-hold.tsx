// Mobile V2 DamageHold sheet — pixel-faithful port of design source
// flow-extras.jsx SheetDamageHold. Quarantines a damaged parcel with
// severity-tagged reason chips, a free-text note, and a required photo.
// The severity drives chip + CTA tone via the discriminated union
// ("danger" → red CTA, "warning"/"info" → softer paths). The orchestrator
// resolves the severities registry from `mobile_damage_severity_policy`.

import * as React from "react";
import { redactDisplayErrorText } from "./mobile-display-error";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  isMobileV2DamageHoldReady,
  resolveMobileV2DamageHoldCtaTone,
} from "./mobile-v2-sheet-readiness";
import type { MobileV2DamageHoldReadback } from "./mobile-v2-rpc-hooks";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2DamageColor = "danger" | "warning" | "info";

export interface MobileV2DamageSeverity {
  readonly id: string;
  readonly label: string;
  readonly color: MobileV2DamageColor;
}

export interface MobileV2DamageHoldPhotoCapture {
  readonly mimeType: string;
  readonly base64: string;
  readonly capturedAt: string;
}

export interface MobileV2DamageHoldSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly parcelId: string;
  readonly severities: ReadonlyArray<MobileV2DamageSeverity>;
  readonly selectedSeverityId: string | null;
  readonly note: string;
  readonly photoCaptured: boolean;
  readonly onSelectSeverity: (id: string) => void;
  readonly onNoteChange: (next: string) => void;
  readonly onTogglePhoto: (capture?: MobileV2DamageHoldPhotoCapture) => void | Promise<void>;
  readonly onConfirm: () => void;
  readonly submitting?: boolean;
  readonly requireCameraCapture?: boolean;
  readonly captureBusy?: boolean;
  readonly captureError?: string | null;
  readonly latestDamageHold?: MobileV2DamageHoldReadback | null;
  readonly readbackError?: string | null;
  /** Optional title override (default "Damage hold"). */
  readonly title?: string;
  /** Optional subtitle override (default `Parcel <id> · quarantine + supervisor sign-off`). */
  readonly subtitle?: string;
  /**
   * When true, renders a parcel-barcode scan input row above the damage
   * type chips, matching the design canvas s-sheet-damage-hold artboard.
   * Defaults false (no scan row; legacy contract).
   */
  readonly showParcelScan?: boolean;
  readonly parcelBarcode?: string;
  readonly onParcelBarcodeChange?: (next: string) => void;
  readonly onParcelScan?: () => void;
  /**
   * When false, hides the "What's wrong with the parcel?" free-text note
   * field. The CTA gate switches to "photo + category" only. Defaults
   * true (note field shown, note required).
   */
  readonly showNote?: boolean;
  /**
   * When false, hides the "Parcel routes to Bay Q · supervisor notified"
   * info row beneath the photo card. Defaults true.
   */
  readonly showRouteHint?: boolean;
  /**
   * Photo capture card layout — "button" is the inline row with leading
   * icon + label (legacy contract). "card" is a tall empty-state card
   * with centered "Add photo" prompt, matching the design canvas
   * artboard. Defaults "button".
   */
  readonly photoCardLayout?: "button" | "card";
  readonly style?: StyleProp<ViewStyle>;
}

function chipToneForColor(c: MobileV2DamageColor): FxChipTone {
  return c;
}

function shortDamageHoldReadbackId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function formatDamageHoldSubmittedAt(value: string | null | undefined): string {
  if (!value) return "Just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MobileV2DamageHoldSheet(
  props: MobileV2DamageHoldSheetProps,
): React.ReactElement {
  const { theme } = props;
  const picked = props.severities.find((s) => s.id === props.selectedSeverityId);
  const showNote = props.showNote !== false;
  const showRouteHint = props.showRouteHint !== false;
  const showParcelScan = props.showParcelScan === true;
  const photoCardLayout = props.photoCardLayout ?? "button";
  const ready = isMobileV2DamageHoldReady({
    severities: props.severities,
    selectedSeverityId: props.selectedSeverityId,
    note: props.note,
    photoCaptured: props.photoCaptured,
    noteRequired: showNote,
  });
  const ctaTone = resolveMobileV2DamageHoldCtaTone({
    severities: props.severities,
    selectedSeverityId: props.selectedSeverityId,
    note: props.note,
    photoCaptured: props.photoCaptured,
    noteRequired: showNote,
  });
  const ctaVariant: "danger" | "soft" = ctaTone === "danger" ? "danger" : "soft";
  const ctaPrimary = ctaTone === "primary";
  const title = props.title ?? "Damage hold";
  const subtitle =
    props.subtitle ?? `Parcel ${props.parcelId} · quarantine + supervisor sign-off`;

  const busy = props.submitting === true || props.captureBusy === true;
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const captureError = props.captureError ?? cameraError;
  const openPhotoCapture = React.useCallback(async (): Promise<void> => {
    if (busy) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await Promise.resolve(props.onTogglePhoto());
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture damage evidence.");
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
      await Promise.resolve(props.onTogglePhoto({
        mimeType: "image/jpeg",
        base64,
        capturedAt: new Date().toISOString(),
      }));
      setCameraOpen(false);
    } catch (error) {
      setCameraError(redactDisplayErrorText(
        error instanceof Error ? error.message : undefined,
        "Unable to capture damage evidence.",
      ));
    }
  }, [busy, props]);

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={title}
      subtitle={subtitle}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={ctaPrimary ? "primary" : ctaVariant}
          full
          size="lg"
          icon="alert"
          disabled={!ready || props.submitting === true}
          onPress={props.onConfirm}
          accessibilityLabel="Quarantine parcel"
        >
          Quarantine · notify supervisor
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING["2xl"]} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {showParcelScan ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Parcel barcode
            </Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "stretch",
                columnGap: MOBILE_V2_SPACING.lg,
              }}
            >
              <TextInput
                value={props.parcelBarcode ?? ""}
                onChangeText={props.onParcelBarcodeChange ?? (() => {})}
                placeholder="Scan or type"
                placeholderTextColor={theme.muted}
                style={{
                  flex: 1,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: MOBILE_V2_RADII.input,
                  backgroundColor: theme.surface,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                  paddingVertical: MOBILE_V2_SPACING.xl,
                }}
              />
              <Pressable
                onPress={props.onParcelScan ?? (() => {})}
                accessibilityRole="button"
                accessibilityLabel="Scan parcel barcode"
                style={{
                  width: 44,
                  alignItems: "center",
                  justifyContent: "center",
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: MOBILE_V2_RADII.button,
                  backgroundColor: theme.surface,
                }}
              >
                <FxIcon name="scan" size={18} color={theme.muted} />
              </Pressable>
            </View>
          </FxCol>
        ) : null}

        {/* Severity picker chips */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Damage type
          </Text>
          <FxRow gap={MOBILE_V2_SPACING.md} wrap>
            {props.severities.map((s) => {
              const on = props.selectedSeverityId === s.id;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => props.onSelectSeverity(s.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select damage type ${s.label}`}
                  accessibilityState={{ selected: on }}
                >
                  <FxChip
                    theme={theme}
                    tone={on ? chipToneForColor(s.color) : "neutral"}
                  >
                    {s.label}
                  </FxChip>
                </Pressable>
              );
            })}
          </FxRow>
        </FxCol>

        {/* Note */}
        {showNote ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              What's wrong with the parcel?
            </Text>
            <TextInput
              value={props.note}
              onChangeText={props.onNoteChange}
              placeholder="Describe the damage briefly"
              placeholderTextColor={theme.muted}
              multiline
              numberOfLines={3}
              style={{
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
                backgroundColor: theme.surface,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                padding: MOBILE_V2_SPACING["2xl"],
                minHeight: 72,
                textAlignVertical: "top",
              }}
            />
          </FxCol>
        ) : null}

        {/* Photo capture */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Damage photo · required
          </Text>
          {photoCardLayout === "card" ? (
            <Pressable
              onPress={() => { void openPhotoCapture(); }}
              accessibilityRole="button"
              accessibilityLabel={
                props.photoCaptured
                  ? "Damage photo captured — tap to retake"
                  : "Add damage photo"
              }
              style={{
                minHeight: 120,
                paddingVertical: MOBILE_V2_SPACING["3xl"],
                paddingHorizontal: MOBILE_V2_SPACING.lg,
                backgroundColor: props.photoCaptured ? theme.successSoft : theme.surfaceAlt,
                borderColor: props.photoCaptured ? theme.success : theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                columnGap: MOBILE_V2_SPACING.lg,
              }}
            >
              <FxIcon
                name={props.photoCaptured ? "check-double" : "camera"}
                size={props.photoCaptured ? 26 : 20}
                color={props.photoCaptured ? theme.success : theme.muted}
              />
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: props.photoCaptured ? theme.success : theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {props.photoCaptured ? "Captured · GPS + timestamp" : "Add photo"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => { void openPhotoCapture(); }}
              accessibilityRole="button"
              accessibilityLabel={
                props.photoCaptured
                  ? "Damage photo captured — tap to retake"
                  : "Capture damage photo"
              }
              style={{
                paddingVertical: MOBILE_V2_SPACING["3xl"],
                paddingHorizontal: MOBILE_V2_SPACING.lg,
                backgroundColor: props.photoCaptured ? theme.successSoft : theme.surfaceAlt,
                borderColor: props.photoCaptured ? theme.success : theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING.md,
              }}
            >
              <FxIcon
                name={props.photoCaptured ? "check" : "camera"}
                size={18}
                color={props.photoCaptured ? theme.success : theme.muted}
              />
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  color: props.photoCaptured ? theme.success : theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {props.photoCaptured ? "Photo captured · tap to retake" : "Capture damage photo"}
              </Text>
            </Pressable>
          )}
        </FxCol>

        {captureError ? (
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.caption,
              color: theme.danger,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            {captureError}
          </Text>
        ) : null}

        {cameraOpen ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <View
              style={{
                height: 220,
                borderRadius: MOBILE_V2_RADII.button,
                overflow: "hidden",
                backgroundColor: theme.surfaceAlt,
                borderColor: theme.border,
                borderWidth: 1,
              }}
            >
              <CameraView
                ref={cameraRef as unknown as React.Ref<CameraView>}
                style={{ flex: 1 }}
                facing="back"
              />
            </View>
            <FxRow gap={MOBILE_V2_SPACING.md}>
              <FxButton
                theme={theme}
                variant="danger"
                icon="camera"
                size="md"
                onPress={() => { void captureCameraPhoto(); }}
                disabled={busy}
                style={{ flex: 1 } as never}
              >
                Capture damage photo
              </FxButton>
              <FxButton
                theme={theme}
                variant="ghost"
                size="md"
                onPress={() => setCameraOpen(false)}
                disabled={busy}
              >
                Cancel
              </FxButton>
            </FxRow>
          </FxCol>
        ) : null}

        {showRouteHint ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              columnGap: MOBILE_V2_SPACING.md,
            }}
          >
            <FxIcon name="info" size={12} color={theme.muted} />
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_MONO,
                flex: 1,
              }}
            >
              Parcel routes to Bay Q · supervisor notified.
            </Text>
          </View>
        ) : null}

        {props.readbackError ? (
          <FxCard
            theme={theme}
            padding={MOBILE_V2_SPACING["2xl"]}
            style={{
              backgroundColor: theme.dangerSoft,
              borderColor: theme.danger,
            }}
          >
            <FxRow gap={MOBILE_V2_SPACING.md} align="flex-start">
              <FxIcon name="alert" size={18} color={theme.danger} />
              <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.danger,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                Damage hold saved, confirming
                </Text>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.caption,
                    color: theme.danger,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {props.readbackError}
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>
        ) : null}

        {props.latestDamageHold ? (
          <FxCard
            theme={theme}
            padding={MOBILE_V2_SPACING["2xl"]}
            style={{
              backgroundColor: theme.successSoft,
              borderColor: theme.success,
            }}
          >
            <FxRow gap={MOBILE_V2_SPACING.md} align="flex-start">
              <FxIcon name="check" size={18} color={theme.success} />
              <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Hold queue confirmed
                </Text>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.caption,
                    color: theme.inkSoft,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {picked?.label ?? props.latestDamageHold.severityId} - {props.latestDamageHold.state}
                </Text>
                {props.latestDamageHold.note ? (
                  <Text
                    style={{
                      fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {props.latestDamageHold.note}
                  </Text>
                ) : null}
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.caption,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Hold {shortDamageHoldReadbackId(props.latestDamageHold.holdId)} - decision{" "}
                  {shortDamageHoldReadbackId(props.latestDamageHold.decisionLogId)} -{" "}
                  {formatDamageHoldSubmittedAt(props.latestDamageHold.submittedAt)}
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>
        ) : null}

      </FxCol>
    </MobileV2BottomSheet>
  );
}
