// Mobile V2 KYC Documents screen — pixel-faithful port of design source
// flow-onboard.jsx ScrKycDocs. Step 1 of 4 of the post-signup onboarding
// flow: capture National ID/Iqama, optional driving licence, and Iqama
// (work permit). Driver-only licence row is suppressed when the active
// role excludes "driver" (e.g. loader-only contractors).
//
// Stateless: parent owns each doc status, busy-key during upload, and
// dispatches scan/upload callbacks. Status tone + label mapping matches
// the source DocCard primitive.

import * as React from "react";
import { redactOutboxErrorText } from "@masarx/mobile-core";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2KycDocStatus = "pending" | "uploaded" | "approved" | "rejected";

export interface MobileV2KycDocSpec {
  readonly key: string;
  readonly icon: MobileV2IconName;
  readonly title: string;
  readonly sub: string;
  readonly hint?: string;
  readonly status: MobileV2KycDocStatus;
  /** When true, this doc is required to advance past Continue. */
  readonly required: boolean;
}

export interface MobileV2KycDocumentCapture {
  readonly base64: string;
  readonly mimeType: "image/jpeg";
  readonly extension: "jpg";
  readonly capturedAt: string;
}

export interface MobileV2KycDocsScreenProps {
  readonly theme: MobileV2Theme;
  readonly docs: ReadonlyArray<MobileV2KycDocSpec>;
  /** Key currently uploading (for optimistic UI). */
  readonly busyKey?: string | null;
  readonly onScan: (key: string, capture?: MobileV2KycDocumentCapture) => void | Promise<void>;
  readonly onUpload: (key: string) => void;
  readonly onContinue: () => void;
  readonly onBack?: () => void;
  readonly requireCameraCapture?: boolean;
  readonly captureError?: string | null;
  readonly style?: StyleProp<ViewStyle>;
}

interface StatusMeta {
  readonly tone: FxChipTone;
  readonly label: string;
}

function statusMeta(s: MobileV2KycDocStatus): StatusMeta {
  switch (s) {
    case "approved":
      return { tone: "success", label: "Approved" };
    case "uploaded":
      return { tone: "info", label: "In review" };
    case "rejected":
      return { tone: "danger", label: "Rejected · re-upload" };
    case "pending":
    default:
      return { tone: "warning", label: "Required" };
  }
}

function isDocSatisfied(status: MobileV2KycDocStatus): boolean {
  return status === "approved" || status === "uploaded";
}

interface DocCardProps {
  readonly theme: MobileV2Theme;
  readonly doc: MobileV2KycDocSpec;
  readonly busy: boolean;
  readonly onScan: () => void;
  readonly onUpload: () => void;
}

function DocCard(props: DocCardProps): React.ReactElement {
  const { theme, doc } = props;
  // Optimistic display: while busy, render as uploaded.
  const effectiveStatus: MobileV2KycDocStatus = props.busy ? "uploaded" : doc.status;
  const meta = statusMeta(effectiveStatus);
  const showCta = effectiveStatus === "pending" || effectiveStatus === "rejected";

  return (
    <FxCard theme={theme} padding={14}>
      <FxRow gap={12} align="flex-start">
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: theme.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name={doc.icon} size={20} color={theme.muted} />
        </View>
        <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
          <FxRow justify="space-between" align="center">
            <Text
              style={{
                fontSize: 14,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                flex: 1,
                minWidth: 0,
              }}
            >
              {doc.title}
            </Text>
            <FxChip theme={theme} tone={meta.tone} dense>
              {meta.label}
            </FxChip>
          </FxRow>
          <Text
            style={{
              fontSize: 11.5,
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            {doc.sub}
          </Text>
          {doc.hint !== undefined ? (
            <Text
              style={{
                fontSize: 11,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontStyle: "italic",
                marginTop: 2,
              }}
            >
              {doc.hint}
            </Text>
          ) : null}
        </FxCol>
      </FxRow>
      {showCta ? (
        <FxRow gap={MOBILE_V2_SPACING.lg} style={{ marginTop: 12 }}>
          <FxButton
            theme={theme}
            variant="chrome"
            size="sm"
            icon="scan"
            onPress={props.onScan}
            accessibilityLabel={`Scan ${doc.title} with camera`}
            style={{ flex: 1 }}
          >
            Scan with camera
          </FxButton>
          <FxButton
            theme={theme}
            variant="ghost"
            size="sm"
            icon="doc"
            onPress={props.onUpload}
            accessibilityLabel={`Upload ${doc.title} file`}
          >
            Upload
          </FxButton>
        </FxRow>
      ) : null}
      {effectiveStatus === "uploaded" ? (
        <Text
          style={{
            fontSize: 11,
            color: theme.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
            marginTop: MOBILE_V2_SPACING.lg,
            paddingHorizontal: 10,
            paddingVertical: 8,
            backgroundColor: theme.surfaceAlt,
            borderRadius: 8,
          }}
        >
          Verifier reviews within 1 business hour. You'll be notified.
        </Text>
      ) : null}
    </FxCard>
  );
}

export function MobileV2KycDocsScreen(
  props: MobileV2KycDocsScreenProps,
): React.ReactElement {
  const { theme, docs } = props;
  const [cameraDocKey, setCameraDocKey] = React.useState<string | null>(null);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);
  const requiredDocs = docs.filter((d) => d.required);
  const allDone =
    requiredDocs.length > 0 && requiredDocs.every((d) => isDocSatisfied(d.status));
  const busy = props.busyKey !== null && props.busyKey !== undefined;
  const captureError = props.captureError ?? cameraError;
  const activeCameraDoc = cameraDocKey === null ? null : docs.find((doc) => doc.key === cameraDocKey) ?? null;
  const handleScanPress = React.useCallback(async (key: string): Promise<void> => {
    if (busy) return;
    setCameraError(null);
    if (props.requireCameraCapture !== true) {
      await props.onScan(key);
      return;
    }
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCameraError("Camera permission is required to capture identity evidence.");
        return;
      }
    }
    setCameraDocKey(key);
  }, [busy, cameraPermission?.granted, props, requestCameraPermission]);
  const captureCameraPhoto = React.useCallback(async (): Promise<void> => {
    if (busy || cameraDocKey === null) return;
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
      await props.onScan(cameraDocKey, {
        base64,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
      });
      setCameraDocKey(null);
    } catch (error) {
      setCameraError(error instanceof Error ? redactOutboxErrorText(error.message) : "Unable to capture identity evidence.");
    }
  }, [busy, cameraDocKey, props]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Identity & documents", sub "Step 1 of 4 · KYC"). */}
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <FxCol gap={10} style={{ padding: 16 }}>
          <FxCard theme={theme} soft>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="shield" size={18} color={theme.muted} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Why we collect this
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    lineHeight: 18,
                  }}
                >
                  SAMA + Ministry of Transport require verified identity for COD handling and on-road
                  driver eligibility. Encrypted in transit, stored only as long as you're active.
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>

          {docs.map((d) => (
            <DocCard
              key={d.key}
              theme={theme}
              doc={d}
              busy={props.busyKey === d.key}
              onScan={() => { void handleScanPress(d.key); }}
              onUpload={() => props.onUpload(d.key)}
            />
          ))}

          {cameraDocKey !== null ? (
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
                    {busy ? "Registering..." : `Capture ${activeCameraDoc?.title ?? "document"}`}
                  </FxButton>
                  <FxButton
                    theme={theme}
                    variant="ghost"
                    size="md"
                    icon="x"
                    disabled={busy}
                    onPress={() => setCameraDocKey(null)}
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

          <FxCol gap={MOBILE_V2_SPACING.md} style={{ marginTop: MOBILE_V2_SPACING.md }}>
            <Text
              style={{
                fontSize: 10,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Tips
            </Text>
            <FxCol gap={0} style={{ paddingLeft: 18 }}>
              <Text style={{ color: theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS, lineHeight: 19 }}>
                • Place document on a flat, dark surface
              </Text>
              <Text style={{ color: theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS, lineHeight: 19 }}>
                • Use natural light · avoid flash glare
              </Text>
              <Text style={{ color: theme.muted, fontSize: 12, fontFamily: MOBILE_V2_FONT_SANS, lineHeight: 19 }}>
                • OCR fills your name + ID number automatically
              </Text>
            </FxCol>
          </FxCol>
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
          disabled={!allDone}
          onPress={() => allDone && props.onContinue()}
          accessibilityLabel={
            allDone ? "Continue to vehicle registration" : "Upload required documents"
          }
        >
          {allDone ? "Continue · vehicle registration" : "Upload required documents"}
        </FxButton>
      </View>
    </View>
  );
}
