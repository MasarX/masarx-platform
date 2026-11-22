// Mobile V2 POD wizard screen — pixel-faithful port of design source
// flow-pod.jsx ScrPOD. Proof of delivery is a multi-step wizard: an
// app-bar showing the active step's title + "Step N of M · <customer>",
// a segmented progress bar (one 4px bar per step, filled up to the
// current step), one step body, and a sticky-footer primary CTA
// labelled "Capture & continue" (non-final steps) or "Commit POD"
// (final step).
//
// The wizard step SEQUENCE is data-driven from policy.methods (the
// design's reqSteps = stop.proofReq) so there is zero hardcoding of
// the step list. Per-step icon/title/sub copy is static UI metadata.
// The sticky footer keeps a secondary "Fail" affordance that opens
// the inline fail-reason flow (filterPodFailReasons / resolvePodSubmitGate).

import * as React from "react";
import { redactDisplayErrorText } from "./mobile-display-error";
import {
  ActivityIndicator,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import Svg, { Path } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  buildMobileV2SignatureArtifactCaptureInput,
  formatMobileV2PodArtifactMethodList,
  listMissingMobileV2PodArtifactMethods,
  type MobileV2PodArtifactCaptureInput,
  type MobileV2PodArtifactKind,
  type MobileV2PodCapturedArtifact,
  type MobileV2SignaturePoint,
} from "./mobile-v2-pod-artifacts";
import {
  FxButton,
  FxCard,
  FxChip,
  FxCol,
  FxPhotoCapture,
  FxRow,
  FxSectionHead,
} from "./mobile-v2-primitives";
import {
  filterPodFailReasons,
  resolvePodSubmitGate,
  type MobileV2PodFailReason,
  type MobileV2PodMethod,
  type MobileV2PodPolicy,
} from "./mobile-v2-pod-policy";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

// ---------------------------------------------------------------------------
// Per-step app-bar title — port of the `meta` map in design ScrPOD. The step
// SEQUENCE is config-driven (policy.methods); this map is only the static
// title copy each method renders in the app-bar. The design `meta` map also
// carries `icon`/`sub` fields, but ScrPOD's render only consumes the title
// (the app-bar sub-line is the computed "Step N of M · <customer>"), so the
// faithful port keeps only what ScrPOD actually renders.
// ---------------------------------------------------------------------------

const POD_STEP_TITLE: Readonly<Record<MobileV2PodMethod, string>> = Object.freeze({
  scan: "Scan parcel barcode",
  photo: "Parcel photo",
  sig: "Customer signature",
  otp: "Enter OTP",
  id: "ID verification",
  cod: "Collect cash",
});

interface PodWizardContext {
  readonly customer: string;
  readonly phone: string;
  readonly codAmount: number;
  readonly codCurrency: string;
}

export interface MobileV2PodScanParcel {
  readonly id: string;
  readonly code: string;
  readonly boxNumber?: number | null;
}

export interface MobileV2PodCommitContext {
  readonly outcome: "delivered" | "partial";
  readonly artifactIds: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>;
  readonly scanCodes: ReadonlyArray<string>;
  readonly deliveredBoxIds: ReadonlyArray<string>;
  readonly deliveredBoxNumbers: ReadonlyArray<number>;
  readonly otpCode: string | null;
  readonly codTenderedAmount: number | null;
}

export interface MobileV2PodFailSubmitContext {
  readonly note: string | null;
  readonly photoCaptured: boolean;
  readonly escalateAcknowledged: boolean;
  readonly artifactIds: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Component contract
// ---------------------------------------------------------------------------

export interface MobileV2PodScreenProps {
  readonly theme: MobileV2Theme;
  readonly policy: MobileV2PodPolicy;
  readonly hasCod?: boolean;
  readonly contextKey?: string;
  readonly scanExpectedCodes?: ReadonlyArray<string>;
  readonly scanExpectedParcels?: ReadonlyArray<MobileV2PodScanParcel>;
  readonly initialArtifacts?: ReadonlyArray<MobileV2PodCapturedArtifact>;
  /** Recipient name shown in the app-bar sub + sig/cod/id step bodies. */
  readonly customerName?: string;
  /** Recipient phone shown in the OTP step sub-line. */
  readonly customerPhone?: string;
  /** COD amount due, rendered in the COD step. */
  readonly codAmount?: number;
  /** True while the final write + same-context confirmation is pending. */
  readonly submitting?: boolean;
  /** When set, the fail-reason sheet renders inline at the bottom. */
  /**
   * When true the inline fail-reason flow renders. It is entered from the
   * Stop screen's "Can't deliver" affordance (design ScrPOD is the success
   * wizard; the fail flow is a separate entry), not from the POD footer.
   */
  readonly failSheetOpen: boolean;
  readonly onCloseFailSheet: () => void;
  /** Fired by the final-step "Commit POD" CTA. */
  readonly onCommit: (context: MobileV2PodCommitContext) => void;
  /** Registers a captured POD artifact through the native shell/backend bridge. */
  readonly onCaptureArtifact?: (
    input: MobileV2PodArtifactCaptureInput,
  ) => Promise<MobileV2PodCapturedArtifact>;
  readonly onArtifactsChange?: (artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>) => void;
  /**
   * Fired by the app-bar back affordance — exits the POD wizard (design
   * ScrPOD `onBack` pops the screen; steps are forward-only via the CTA).
   */
  readonly onExit: () => void;
  readonly onSubmitFail: (
    reason: MobileV2PodFailReason,
    context: MobileV2PodFailSubmitContext,
  ) => void;
  readonly style?: StyleProp<ViewStyle>;
}

const EMPTY_MOBILE_V2_POD_ARTIFACTS: ReadonlyArray<MobileV2PodCapturedArtifact> = Object.freeze([]);

export function MobileV2PodScreen(props: MobileV2PodScreenProps): React.ReactElement {
  const { theme, policy } = props;
  const t = theme;
  const hasCod = props.hasCod ?? false;
  const customer = props.customerName ?? "the recipient";
  const phone = props.customerPhone ?? "the recipient";
  const codAmount = props.codAmount ?? 0;
  const scanParcels = React.useMemo(() => {
    const source: ReadonlyArray<MobileV2PodScanParcel> =
      props.scanExpectedParcels !== undefined
        ? props.scanExpectedParcels
        : (props.scanExpectedCodes ?? []).map((code) => ({ id: code, code, boxNumber: null }));
    const seen = new Set<string>();
    const rows: MobileV2PodScanParcel[] = [];
    for (const parcel of source) {
      const code = parcel.code.trim();
      if (code === "" || seen.has(code)) continue;
      seen.add(code);
      rows.push(Object.freeze({
        id: parcel.id.trim() !== "" ? parcel.id.trim() : code,
        code,
        boxNumber: parcel.boxNumber ?? null,
      }));
    }
    return Object.freeze(rows);
  }, [props.scanExpectedCodes, props.scanExpectedParcels]);
  const scanExpectedCodes = React.useMemo(
    () => Object.freeze(scanParcels.map((parcel) => parcel.code)),
    [scanParcels],
  );
  const wizardCtx: PodWizardContext = {
    customer,
    phone,
    codAmount,
    codCurrency: policy.codCurrency,
  };

  // Wizard step sequence is the policy.methods order (config-driven).
  const steps = policy.methods;
  const stepCount = Math.max(steps.length, 1);
  const [stepIndex, setStepIndex] = React.useState(0);
  const safeIndex = Math.min(stepIndex, stepCount - 1);
  const activeStep: MobileV2PodMethod = steps[safeIndex] ?? "scan";
  const isFinalStep = safeIndex >= stepCount - 1;
  const stepTitle = POD_STEP_TITLE[activeStep];

  // Fail-flow state (preserved from the prior screen contract).
  const [hasPhoto, setHasPhoto] = React.useState(false);
  const [failNoteText, setFailNoteText] = React.useState("");
  const [escalateAck, setEscalateAck] = React.useState(false);
  const [activeReasonCode, setActiveReasonCode] = React.useState<string | null>(null);
  const [scannedCodes, setScannedCodes] = React.useState<ReadonlyArray<string>>([]);
  const [otpCode, setOtpCode] = React.useState("");
  const [codTenderedAmount, setCodTenderedAmount] = React.useState(codAmount);
  const initialArtifacts = props.initialArtifacts ?? EMPTY_MOBILE_V2_POD_ARTIFACTS;
  const initialArtifactsKey = React.useMemo(
    () => initialArtifacts.map((artifact) => artifact.artifactId).join("|"),
    [initialArtifacts],
  );
  const [artifacts, setArtifacts] = React.useState<ReadonlyArray<MobileV2PodCapturedArtifact>>(
    () => initialArtifacts,
  );
  const [captureError, setCaptureError] = React.useState<string | null>(null);
  const [artifactGateMessage, setArtifactGateMessage] = React.useState<string | null>(null);
  const [capturingKind, setCapturingKind] = React.useState<MobileV2PodArtifactKind | null>(null);
  const [cameraCapture, setCameraCapture] = React.useState<{
    readonly method: MobileV2PodMethod;
    readonly kind: MobileV2PodArtifactKind;
    readonly usage: "pod" | "fail";
  } | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = React.useRef<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>(null);

  const visibleReasons = React.useMemo(
    () => filterPodFailReasons(policy, { hasCod }),
    [policy, hasCod],
  );
  const activeReason = visibleReasons.find((r) => r.code === activeReasonCode) ?? null;
  const hasNote = failNoteText.trim().length > 0;
  const submitGate = activeReason !== null
    ? resolvePodSubmitGate(activeReason, { hasPhoto, hasNote, escalateAcknowledged: escalateAck })
    : null;

  React.useEffect(() => {
    setArtifacts(initialArtifacts);
  }, [initialArtifacts, initialArtifactsKey]);
  React.useEffect(() => {
    setScannedCodes([]);
    setOtpCode("");
    setCodTenderedAmount(codAmount);
    setHasPhoto(false);
    setFailNoteText("");
    setEscalateAck(false);
    setActiveReasonCode(null);
  }, [props.contextKey, codAmount]);

  const replaceArtifact = React.useCallback((artifact: MobileV2PodCapturedArtifact): void => {
    setArtifacts((current) => {
      const next = Object.freeze([
        ...current.filter((entry) => !(entry.kind === artifact.kind && entry.method === artifact.method)),
        artifact,
      ]);
      props.onArtifactsChange?.(next);
      return next;
    });
  }, [props.onArtifactsChange]);

  const registerArtifact = React.useCallback(async (
    input: MobileV2PodArtifactCaptureInput,
  ): Promise<MobileV2PodCapturedArtifact> => {
    setCaptureError(null);
    setCapturingKind(input.kind);
    try {
      let artifact: MobileV2PodCapturedArtifact;
      if (props.onCaptureArtifact !== undefined) {
        artifact = await props.onCaptureArtifact(input);
      } else {
        artifact = {
          artifactId: `preview-${input.kind}-${input.capturedAt}`,
          kind: input.kind,
          method: input.method,
          capturedAt: input.capturedAt,
          storageKey: null,
        };
      }
      replaceArtifact(artifact);
      return artifact;
    } catch (error) {
      const message = redactDisplayErrorText(
        error instanceof Error ? error.message : undefined,
        "Unable to register POD artifact.",
      );
      setCaptureError(message);
      throw error;
    } finally {
      setCapturingKind(null);
    }
  }, [props.onCaptureArtifact, replaceArtifact]);

  const openCameraCapture = React.useCallback(async (
    method: MobileV2PodMethod,
    kind: MobileV2PodArtifactKind,
    usage: "pod" | "fail" = "pod",
  ): Promise<void> => {
    setCaptureError(null);
    if (cameraPermission?.granted !== true) {
      const nextPermission = await requestCameraPermission();
      if (nextPermission.granted !== true) {
        setCaptureError("Camera permission is required to capture POD evidence.");
        return;
      }
    }
    setCameraCapture({ method, kind, usage });
  }, [cameraPermission?.granted, requestCameraPermission]);

  const captureCameraArtifact = React.useCallback(async (): Promise<void> => {
    if (cameraCapture === null || capturingKind !== null) return;
    const camera = cameraRef.current;
    if (camera?.takePictureAsync === undefined) {
      setCaptureError("Camera is not ready yet.");
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
      await registerArtifact({
        kind: cameraCapture.kind,
        method: cameraCapture.method,
        mimeType: "image/jpeg",
        extension: "jpg",
        capturedAt: new Date().toISOString(),
        base64,
        metadata: {
          proof_type: cameraCapture.method,
          artifact_kind: cameraCapture.kind,
          capture_usage: cameraCapture.usage,
        },
      });
      if (cameraCapture.usage === "fail") {
        setHasPhoto(true);
      }
      setCameraCapture(null);
    } catch (error) {
      setCaptureError(redactDisplayErrorText(
        error instanceof Error ? error.message : undefined,
        "Unable to capture POD evidence.",
      ));
    }
  }, [cameraCapture, capturingKind, registerArtifact]);

  const captureSignatureArtifact = React.useCallback(async (input: {
    readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
    readonly width: number;
    readonly height: number;
  }): Promise<void> => {
    const capturedAt = new Date().toISOString();
    await registerArtifact(buildMobileV2SignatureArtifactCaptureInput({ ...input, capturedAt }));
  }, [registerArtifact]);

  const artifactIds = React.useMemo(
    () => Object.freeze(artifacts.map((artifact) => artifact.artifactId)),
    [artifacts],
  );
  const activeMissingArtifactMethods = React.useMemo(
    () => listMissingMobileV2PodArtifactMethods([activeStep], artifacts),
    [activeStep, artifacts],
  );
  const allMissingArtifactMethods = React.useMemo(
    () => listMissingMobileV2PodArtifactMethods(steps, artifacts),
    [steps, artifacts],
  );
  const artifactGateHint = React.useMemo(() => {
    const missing = isFinalStep ? allMissingArtifactMethods : activeMissingArtifactMethods;
    if (missing.length === 0) return null;
    const missingList = formatMobileV2PodArtifactMethodList(missing);
    return isFinalStep
      ? `Register required POD artifacts before commit: ${missingList}.`
      : `Register ${missingList} before continuing.`;
  }, [activeMissingArtifactMethods, allMissingArtifactMethods, isFinalStep]);
  const scanGateHint = React.useMemo(() => {
    if (activeStep !== "scan") return null;
    if (scanExpectedCodes.length === 0) return "No parcel barcode is available for scan proof.";
    return scannedCodes.length > 0
      ? null
      : `Confirm at least one parcel barcode. Full delivery needs all ${scanExpectedCodes.length}; a strict subset commits partial delivery.`;
  }, [activeStep, scanExpectedCodes, scannedCodes.length]);
  const otpGateHint = React.useMemo(() => {
    if (activeStep !== "otp") return null;
    return otpCode.length >= 4 ? null : "Enter the recipient OTP before continuing.";
  }, [activeStep, otpCode.length]);
  const stepGateHint = artifactGateHint ?? scanGateHint ?? otpGateHint;

  React.useEffect(() => {
    if (artifactGateHint === null) {
      setArtifactGateMessage(null);
    }
  }, [artifactGateHint]);

  const goNext = (): void => {
    if (stepGateHint !== null) {
      setArtifactGateMessage(stepGateHint);
      return;
    }
    if (isFinalStep) {
      if (props.submitting === true) return;
      const scannedSet = new Set(scannedCodes);
      const deliveredParcels = scanParcels.filter((parcel) => scannedSet.has(parcel.code));
      const deliveredBoxNumbers = Object.freeze(
        deliveredParcels
          .map((parcel) => parcel.boxNumber)
          .filter((boxNumber): boxNumber is number =>
            typeof boxNumber === "number" && Number.isSafeInteger(boxNumber) && boxNumber > 0,
          ),
      );
      props.onCommit({
        outcome:
          scanExpectedCodes.length > 1
          && scannedCodes.length > 0
          && scannedCodes.length < scanExpectedCodes.length
            ? "partial"
            : "delivered",
        artifactIds,
        artifacts,
        scanCodes: scannedCodes,
        deliveredBoxIds: Object.freeze(deliveredParcels.map((parcel) => parcel.id)),
        deliveredBoxNumbers,
        otpCode: otpCode.length > 0 ? otpCode : null,
        codTenderedAmount: hasCod ? codTenderedAmount : null,
      });
      return;
    }
    setStepIndex((i) => Math.min(stepCount - 1, i + 1));
  };

  const sansSemibold = {
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  } as const;

  return (
    <View style={[{ flex: 1, backgroundColor: t.bg }, props.style]}>
      {/* App-bar — port of ScreenShell FxAppBar. Title is the active step's
          title; sub is "Step N of M · <customer>". The wizard owns this
          header because the title changes per step. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          columnGap: MOBILE_V2_SPACING.xl,
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING.lg,
          paddingBottom: MOBILE_V2_SPACING["3xl"],
          borderBottomColor: t.border,
          borderBottomWidth: 1,
          backgroundColor: t.bg,
        }}
      >
        <Pressable
          onPress={props.onExit}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{
            width: 36,
            height: 36,
            marginLeft: -8,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name="arrow-left" size={22} color={t.ink} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.appBarTitle,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.appBarTitle,
              color: t.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            {stepTitle}
          </Text>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.appBarSubtitle,
              color: t.muted,
              marginTop: 2,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            {`Step ${safeIndex + 1} of ${stepCount} · ${customer}`}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: 150,
        }}
      >
        {/* Segmented progress bar — one 4px bar per step, filled up to the
            current step in theme.accent (design: i<=stepIdx ? accent). */}
        <View
          style={{
            paddingHorizontal: MOBILE_V2_SPACING["4xl"],
            paddingTop: MOBILE_V2_SPACING["2xl"],
            paddingBottom: MOBILE_V2_SPACING.lg,
          }}
        >
          <FxRow gap={MOBILE_V2_SPACING.sm}>
            {steps.map((stepKey, i) => (
              <View
                key={stepKey}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: i <= safeIndex ? t.accent : t.surfaceAlt,
                }}
              />
            ))}
          </FxRow>
        </View>

        {/* One step body */}
        <View style={{ padding: MOBILE_V2_SPACING["4xl"] }}>
          <PodStepBody
            step={activeStep}
            theme={theme}
            ctx={wizardCtx}
            artifacts={artifacts}
            captureError={captureError}
            capturingKind={capturingKind}
            cameraCapture={cameraCapture}
            cameraRef={cameraRef}
            scanParcels={scanParcels}
            scanExpectedCodes={scanExpectedCodes}
            scannedCodes={scannedCodes}
            onToggleScanCode={(code) => {
              setScannedCodes((current) => {
                const next = new Set(current);
                if (next.has(code)) {
                  next.delete(code);
                } else {
                  next.add(code);
                }
                return Object.freeze([...next].filter((entry) => scanExpectedCodes.includes(entry)));
              });
            }}
            onConfirmAllScans={() => setScannedCodes(scanExpectedCodes)}
            onClearScans={() => setScannedCodes(Object.freeze([]))}
            otpCode={otpCode}
            onOtpCodeChange={setOtpCode}
            codTenderedAmount={codTenderedAmount}
            onCodTenderedAmountChange={setCodTenderedAmount}
            onOpenCameraCapture={openCameraCapture}
            onCaptureCameraArtifact={captureCameraArtifact}
            onCancelCameraCapture={() => setCameraCapture(null)}
            onCaptureSignatureArtifact={captureSignatureArtifact}
          />
        </View>

        {/* Fail sheet (inline at bottom of scroll) — preserved fail flow. */}
        {props.failSheetOpen ? (
          <View style={{ paddingHorizontal: MOBILE_V2_SPACING["4xl"] }}>
            <FxCard theme={theme} soft>
              <FxCol gap={MOBILE_V2_SPACING["2xl"]}>
                <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
                  <FxIcon name="alert" size={20} color={t.warning} />
                  <Text style={{ ...sansSemibold, color: t.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong, flex: 1 }}>
                    Fail reason
                  </Text>
                  <Pressable onPress={props.onCloseFailSheet} accessibilityRole="button" accessibilityLabel="Close fail sheet">
                    <FxIcon name="x" size={18} color={t.muted} />
                  </Pressable>
                </FxRow>

                <FxCol gap={MOBILE_V2_SPACING.md}>
                  {visibleReasons.map((r) => {
                    const active = r.code === activeReasonCode;
                    return (
                      <Pressable
                        key={r.code}
                        onPress={() => {
                          setActiveReasonCode(r.code);
                          // reset gate inputs on reason change
                          setHasPhoto(false);
                          setFailNoteText("");
                          setEscalateAck(false);
                        }}
                        accessibilityRole="radio"
                        accessibilityLabel={r.label}
                        accessibilityState={{ selected: active }}
                        style={{
                          backgroundColor: active ? t.accentSoft : t.surface,
                          borderColor: active ? t.accent : t.border,
                          borderWidth: 1,
                          borderRadius: MOBILE_V2_RADII.card,
                          padding: MOBILE_V2_SPACING["2xl"],
                          rowGap: MOBILE_V2_SPACING.sm,
                        }}
                      >
                        <FxRow gap={MOBILE_V2_SPACING.md}>
                          <Text style={{ ...sansSemibold, color: t.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong, flex: 1 }}>
                            {r.label}
                          </Text>
                          <Text
                            style={{
                              fontFamily: MOBILE_V2_FONT_MONO,
                              color: t.muted,
                              fontSize: MOBILE_V2_TYPE_SIZES.chip,
                              letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
                            }}
                          >
                            {r.code}
                          </Text>
                        </FxRow>
                        <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
                          {r.reattempt ? <FxChip theme={theme} tone="info" dense>reattempt</FxChip> : null}
                          {r.photo ? <FxChip theme={theme} tone="warning" dense>photo</FxChip> : null}
                          {r.note ? <FxChip theme={theme} tone="info" dense>note</FxChip> : null}
                          {r.escalate ? <FxChip theme={theme} tone="danger" dense>escalate</FxChip> : null}
                          {r.codOnly ? <FxChip theme={theme} tone="info" dense>cod-only</FxChip> : null}
                        </FxRow>
                      </Pressable>
                    );
                  })}
                </FxCol>

                {activeReason !== null ? (
                  <FxCol gap={MOBILE_V2_SPACING.lg}>
                    <FxSectionHead theme={theme} label="Required artefacts" />
                    <FxRow gap={MOBILE_V2_SPACING.md} wrap>
                      {activeReason.photo ? (
                        <Pressable
                          onPress={() => { void openCameraCapture("photo", "photo", "fail"); }}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: hasPhoto }}
                        >
                          <FxChip theme={theme} tone={hasPhoto ? "success" : "warning"} icon={hasPhoto ? "check" : "camera"}>
                            {hasPhoto ? "Photo captured" : "Capture photo"}
                          </FxChip>
                        </Pressable>
                      ) : null}
                      {activeReason.note ? (
                        <FxChip theme={theme} tone={hasNote ? "success" : "info"} icon={hasNote ? "check" : "doc"}>
                          {hasNote ? "Note added" : "Note required"}
                        </FxChip>
                      ) : null}
                      {activeReason.escalate ? (
                        <Pressable onPress={() => setEscalateAck((p) => !p)} accessibilityRole="checkbox" accessibilityState={{ checked: escalateAck }}>
                          <FxChip theme={theme} tone={escalateAck ? "success" : "danger"} icon={escalateAck ? "check" : "shield"}>
                            {escalateAck ? "Escalated to dispatch" : "Acknowledge escalation"}
                          </FxChip>
                        </Pressable>
                      ) : null}
                    </FxRow>
                    {activeReason.note ? (
                      <View style={{ rowGap: MOBILE_V2_SPACING.sm }}>
                        <Text
                          style={{
                            color: t.muted,
                            fontFamily: MOBILE_V2_FONT_SANS,
                            fontSize: MOBILE_V2_TYPE_SIZES.caption,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          }}
                        >
                          Driver note
                        </Text>
                        <TextInput
                          value={failNoteText}
                          onChangeText={setFailNoteText}
                          accessibilityLabel="Failed delivery note"
                          placeholder="What happened at the stop?"
                          placeholderTextColor={t.muted}
                          multiline
                          style={{
                            minHeight: 88,
                            borderRadius: MOBILE_V2_RADII.card,
                            borderWidth: 1,
                            borderColor: hasNote ? t.success : t.border,
                            backgroundColor: t.surface,
                            color: t.ink,
                            paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                            paddingVertical: MOBILE_V2_SPACING.xl,
                            fontFamily: MOBILE_V2_FONT_SANS,
                            fontSize: MOBILE_V2_TYPE_SIZES.body,
                            textAlignVertical: "top",
                          }}
                        />
                      </View>
                    ) : null}
                    {submitGate !== null && !submitGate.canSubmit ? (
                      <Text
                        style={{
                          color: t.warning,
                          fontFamily: MOBILE_V2_FONT_SANS,
                          fontSize: MOBILE_V2_TYPE_SIZES.body,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
                        }}
                      >
                        Missing: {submitGate.missing.join(", ")}
                      </Text>
                    ) : null}
                  </FxCol>
                ) : null}

                <FxButton
                  theme={theme}
                  variant={submitGate?.canSubmit ? "danger" : "ghost"}
                  full
                  size="md"
                  icon={submitGate?.canSubmit ? "check" : "alert"}
                  disabled={props.submitting === true || activeReason === null || !submitGate?.canSubmit}
                  onPress={() => {
                    if (props.submitting !== true && activeReason !== null && submitGate?.canSubmit) {
                      props.onSubmitFail(activeReason, {
                        note: hasNote ? failNoteText.trim() : null,
                        photoCaptured: hasPhoto,
                        escalateAcknowledged: escalateAck,
                        artifactIds,
                      });
                    }
                  }}
                >
                  {activeReason === null ? "Pick a reason" : submitGate?.canSubmit ? "Submit fail" : "Complete required artefacts"}
                </FxButton>
              </FxCol>
            </FxCard>
          </View>
        ) : null}
      </ScrollView>

      {/* Sticky footer — a single full-width CTA on a solid band, matching
          the design ScrPOD `action`. The fail flow (entered from the Stop
          screen's "Can't deliver") swaps the CTA for a Cancel control. */}
      <View
        style={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING.lg,
          paddingBottom: MOBILE_V2_SPACING["3xl"],
          borderTopWidth: 1,
          borderTopColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        {props.failSheetOpen ? (
          <FxButton
            theme={theme}
            variant="ghost"
            full
            size="lg"
            icon="x"
            onPress={props.onCloseFailSheet}
          >
            Cancel — back to delivery
          </FxButton>
        ) : (
          <FxButton
            theme={theme}
            variant="primary"
            full
            size="lg"
            iconRight={isFinalStep ? "check" : "arrow-right"}
            onPress={goNext}
            disabled={props.submitting === true || capturingKind !== null || stepGateHint !== null}
          >
            {isFinalStep && props.submitting === true
              ? "Committing..."
              : isFinalStep
                ? (scanExpectedCodes.length > 1 && scannedCodes.length > 0 && scannedCodes.length < scanExpectedCodes.length
                    ? "Commit partial POD"
                    : "Commit POD")
                : "Capture & continue"}
          </FxButton>
        )}
        {props.failSheetOpen ? null : (
          <PodArtifactGateMessage
            theme={theme}
            message={artifactGateMessage ?? stepGateHint}
          />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step bodies — faithful ports of PodScan / PodPhoto / PodSig / PodOtp /
// PodId / PodCod from design flow-pod.jsx.
// ---------------------------------------------------------------------------

function PodStepBody(props: {
  readonly step: MobileV2PodMethod;
  readonly theme: MobileV2Theme;
  readonly ctx: PodWizardContext;
  readonly artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>;
  readonly captureError: string | null;
  readonly capturingKind: MobileV2PodArtifactKind | null;
  readonly cameraCapture: { readonly method: MobileV2PodMethod; readonly kind: MobileV2PodArtifactKind } | null;
  readonly cameraRef: React.MutableRefObject<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>;
  readonly scanParcels: ReadonlyArray<MobileV2PodScanParcel>;
  readonly scanExpectedCodes: ReadonlyArray<string>;
  readonly scannedCodes: ReadonlyArray<string>;
  readonly onToggleScanCode: (code: string) => void;
  readonly onConfirmAllScans: () => void;
  readonly onClearScans: () => void;
  readonly otpCode: string;
  readonly onOtpCodeChange: (code: string) => void;
  readonly codTenderedAmount: number;
  readonly onCodTenderedAmountChange: (amount: number) => void;
  readonly onOpenCameraCapture: (method: MobileV2PodMethod, kind: MobileV2PodArtifactKind) => Promise<void>;
  readonly onCaptureCameraArtifact: () => Promise<void>;
  readonly onCancelCameraCapture: () => void;
  readonly onCaptureSignatureArtifact: (input: {
    readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
    readonly width: number;
    readonly height: number;
  }) => Promise<void>;
}): React.ReactElement {
  const hasArtifact = (method: MobileV2PodMethod, kind?: MobileV2PodArtifactKind): boolean =>
    props.artifacts.some((artifact) => artifact.method === method && (kind === undefined || artifact.kind === kind));
  switch (props.step) {
    case "scan":
      return (
        <PodScanBody
          theme={props.theme}
          parcels={props.scanParcels}
          expectedCodes={props.scanExpectedCodes}
          scannedCodes={props.scannedCodes}
          onToggleScanCode={props.onToggleScanCode}
          onConfirmAllScans={props.onConfirmAllScans}
          onClearScans={props.onClearScans}
        />
      );
    case "photo":
      return (
        <PodPhotoBody
          theme={props.theme}
          taken={hasArtifact("photo", "photo")}
          busy={props.capturingKind === "photo"}
          captureError={props.captureError}
          cameraOpen={props.cameraCapture?.method === "photo"}
          cameraRef={props.cameraRef}
          onOpenCamera={() => props.onOpenCameraCapture("photo", "photo")}
          onCaptureCameraArtifact={props.onCaptureCameraArtifact}
          onCancelCameraCapture={props.onCancelCameraCapture}
        />
      );
    case "sig":
      return (
        <PodSigBody
          theme={props.theme}
          customer={props.ctx.customer}
          captured={hasArtifact("sig", "signature")}
          busy={props.capturingKind === "signature"}
          captureError={props.captureError}
          onCaptureSignatureArtifact={props.onCaptureSignatureArtifact}
        />
      );
    case "otp":
      return <PodOtpBody theme={props.theme} code={props.otpCode} onChangeCode={props.onOtpCodeChange} />;
    case "id":
      return (
        <PodIdBody
          theme={props.theme}
          customer={props.ctx.customer}
          captured={hasArtifact("id", "identity")}
          busy={props.capturingKind === "identity"}
          captureError={props.captureError}
          cameraOpen={props.cameraCapture?.method === "id"}
          cameraRef={props.cameraRef}
          onOpenCamera={() => props.onOpenCameraCapture("id", "identity")}
          onCaptureCameraArtifact={props.onCaptureCameraArtifact}
          onCancelCameraCapture={props.onCancelCameraCapture}
        />
      );
    case "cod":
      return (
        <PodCodBody
          theme={props.theme}
          amount={props.ctx.codAmount}
          currency={props.ctx.codCurrency}
          tendered={props.codTenderedAmount}
          onTenderedChange={props.onCodTenderedAmountChange}
        />
      );
    default:
      return (
        <PodScanBody
          theme={props.theme}
          parcels={props.scanParcels}
          expectedCodes={props.scanExpectedCodes}
          scannedCodes={props.scannedCodes}
          onToggleScanCode={props.onToggleScanCode}
          onConfirmAllScans={props.onConfirmAllScans}
          onClearScans={props.onClearScans}
        />
      );
  }
}

function PodArtifactGateMessage(props: {
  readonly theme: MobileV2Theme;
  readonly message: string | null;
}): React.ReactElement | null {
  if (props.message === null) return null;
  const t = props.theme;
  return (
    <FxRow gap={MOBILE_V2_SPACING.sm} align="center" style={{ marginTop: MOBILE_V2_SPACING.md }}>
      <FxIcon name="alert" size={15} color={t.warning} />
      <Text
        accessibilityRole="alert"
        style={{
          flex: 1,
          color: t.warning,
          fontSize: MOBILE_V2_TYPE_SIZES.caption,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.message}
      </Text>
    </FxRow>
  );
}

/** PodScan — camera viewfinder card with a match chip + counter. */
function PodScanBody(props: {
  readonly theme: MobileV2Theme;
  readonly parcels: ReadonlyArray<MobileV2PodScanParcel>;
  readonly expectedCodes: ReadonlyArray<string>;
  readonly scannedCodes: ReadonlyArray<string>;
  readonly onToggleScanCode: (code: string) => void;
  readonly onConfirmAllScans: () => void;
  readonly onClearScans: () => void;
}): React.ReactElement {
  const t = props.theme;
  const expectedCount = props.expectedCodes.length;
  const scannedCount = props.scannedCodes.length;
  const primaryCode = props.expectedCodes[0] ?? "No parcel barcode";
  const allScanned = expectedCount > 0 && scannedCount >= expectedCount;
  const scannedSet = new Set(props.scannedCodes);
  const partialScanned = scannedCount > 0 && scannedCount < expectedCount;
  return (
    <FxCard theme={t} padding={0} style={{ overflow: "hidden" }}>
      <View
        style={{
          height: 240,
          backgroundColor: t.chrome,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: 200,
            height: 120,
            borderWidth: 2,
            borderColor: t.accent,
            borderRadius: 12,
            justifyContent: "center",
          }}
        >
          <View style={{ height: 2, backgroundColor: t.accent }} />
        </View>
        <View style={{ position: "absolute" }}>
          <FxIcon name="scan" size={26} color={t.onChrome} />
        </View>
        <Text
          style={{
            position: "absolute",
            bottom: 10,
            color: t.onChrome,
            fontSize: 11,
            opacity: 0.8,
            fontFamily: MOBILE_V2_FONT_MONO,
          }}
        >
          {primaryCode}
        </Text>
      </View>
      <View style={{ padding: 14 }}>
        <FxRow gap={MOBILE_V2_SPACING.lg}>
          <FxChip theme={t} tone={allScanned ? "success" : "warning"} dense icon={allScanned ? "check" : "scan"}>
            {allScanned ? "Full match" : partialScanned ? "Partial match" : "Scan pending"}
          </FxChip>
          <FxChip theme={t} dense mono>
            {`${scannedCount} of ${expectedCount}`}
          </FxChip>
        </FxRow>
        <View style={{ marginTop: 12, rowGap: 8 }}>
          {props.parcels.map((parcel, index) => {
            const scanned = scannedSet.has(parcel.code);
            return (
              <Pressable
                key={parcel.code}
                accessibilityRole="button"
                accessibilityLabel={`Parcel ${index + 1} ${parcel.code}`}
                onPress={() => props.onToggleScanCode(parcel.code)}
                style={{
                  borderWidth: 1,
                  borderColor: scanned ? t.success : t.border,
                  borderRadius: 12,
                  backgroundColor: scanned ? t.successSoft : t.surfaceAlt,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: 10,
                }}
              >
                <FxIcon name={scanned ? "check" : "scan"} size={16} color={scanned ? t.success : t.muted} />
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    color: t.ink,
                    fontSize: 12,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {parcel.code}
                </Text>
                <FxChip theme={t} tone={scanned ? "success" : "neutral"} dense>
                  {scanned ? "Scanned" : "Tap to scan"}
                </FxChip>
              </Pressable>
            );
          })}
        </View>
        {partialScanned ? (
          <Text
            style={{
              fontSize: 12,
              color: t.warning,
              marginTop: 8,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
            }}
          >
            This will commit a partial delivery for the scanned parcel subset.
          </Text>
        ) : null}
        <FxButton
          theme={t}
          variant="primary"
          full
          size="md"
          icon={allScanned ? "check" : "scan"}
          onPress={props.onConfirmAllScans}
          disabled={expectedCount === 0 || allScanned}
          style={{ marginTop: 12 }}
        >
          {allScanned ? "All scans confirmed" : "Confirm all parcels"}
        </FxButton>
        {scannedCount > 0 && !allScanned ? (
          <FxButton
            theme={t}
            variant="ghost"
            full
            size="sm"
            icon="x"
            onPress={props.onClearScans}
            style={{ marginTop: 8 }}
          >
            Clear partial scan
          </FxButton>
        ) : null}
        <Text
          style={{
            fontSize: 12,
            color: t.muted,
            marginTop: 8,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          Scan confirmation must match parcel barcodes before POD can continue.
        </Text>
      </View>
    </FxCard>
  );
}

/** PodPhoto — tap-to-capture parcel photo tile + geo-tag chips. */
function PodPhotoBody(props: {
  readonly theme: MobileV2Theme;
  readonly taken: boolean;
  readonly busy: boolean;
  readonly captureError: string | null;
  readonly cameraOpen: boolean;
  readonly cameraRef: React.MutableRefObject<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>;
  readonly onOpenCamera: () => void;
  readonly onCaptureCameraArtifact: () => Promise<void>;
  readonly onCancelCameraCapture: () => void;
}): React.ReactElement {
  const t = props.theme;
  return (
    <View style={{ rowGap: 10 }}>
      <FxPhotoCapture
        theme={t}
        taken={props.taken}
        onCapture={props.onOpenCamera}
        height={240}
        label="Tap to capture parcel photo"
        accessibilityLabel={props.taken ? "Parcel photo captured - tap to retake" : "Capture parcel photo"}
      />
      {props.cameraOpen ? (
        <PodCameraCapturePanel
          theme={t}
          cameraRef={props.cameraRef}
          busy={props.busy}
          onCapture={props.onCaptureCameraArtifact}
          onCancel={props.onCancelCameraCapture}
        />
      ) : null}
      <FxRow gap={MOBILE_V2_SPACING.lg} wrap>
        <FxChip theme={t} tone="info" dense icon="pin">
          Geo-tagged
        </FxChip>
        <FxChip theme={t} dense mono>
          26.4 N / 50.1 E
        </FxChip>
        {props.taken ? (
          <FxChip theme={t} tone="success" dense icon="check">
            Registered
          </FxChip>
        ) : null}
      </FxRow>
      {props.captureError !== null ? <PodCaptureError theme={t} message={props.captureError} /> : null}
      <Text style={{ fontSize: 12, color: t.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
        Capture registers delivery proof before commit.
      </Text>
    </View>
  );
}

function PodCameraCapturePanel(props: {
  readonly theme: MobileV2Theme;
  readonly cameraRef: React.MutableRefObject<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>;
  readonly busy: boolean;
  readonly onCapture: () => Promise<void>;
  readonly onCancel: () => void;
}): React.ReactElement {
  const t = props.theme;
  return (
    <FxCard theme={t} padding={0} style={{ overflow: "hidden" }}>
      <View style={{ height: 220, backgroundColor: t.chrome }}>
        <CameraView
          ref={props.cameraRef as unknown as React.Ref<CameraView>}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ padding: 12 }}>
        <FxRow gap={MOBILE_V2_SPACING.md}>
          <FxButton
            theme={t}
            variant="primary"
            size="md"
            icon="camera"
            onPress={() => { void props.onCapture(); }}
            disabled={props.busy}
          >
            {props.busy ? "Registering..." : "Capture evidence"}
          </FxButton>
          <FxButton
            theme={t}
            variant="ghost"
            size="md"
            icon="x"
            onPress={props.onCancel}
            disabled={props.busy}
          >
            Cancel
          </FxButton>
          {props.busy ? <ActivityIndicator color={t.accent} /> : null}
        </FxRow>
      </View>
    </FxCard>
  );
}

function PodCaptureError(props: {
  readonly theme: MobileV2Theme;
  readonly message: string;
}): React.ReactElement {
  return (
    <Text
      style={{
        color: props.theme.danger,
        fontSize: MOBILE_V2_TYPE_SIZES.body,
        fontFamily: MOBILE_V2_FONT_SANS,
        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
      }}
    >
      {props.message}
    </Text>
  );
}

/** PodSig — signature pad surface + recipient chip and clear action. */
function PodSigBody(props: {
  readonly theme: MobileV2Theme;
  readonly customer: string;
  readonly captured: boolean;
  readonly busy: boolean;
  readonly captureError: string | null;
  readonly onCaptureSignatureArtifact: (input: {
    readonly strokes: ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>;
    readonly width: number;
    readonly height: number;
  }) => Promise<void>;
}): React.ReactElement {
  const t = props.theme;
  const [strokes, setStrokes] = React.useState<ReadonlyArray<ReadonlyArray<MobileV2SignaturePoint>>>([]);
  const [activeStroke, setActiveStroke] = React.useState<ReadonlyArray<MobileV2SignaturePoint>>([]);
  const [layout, setLayout] = React.useState({ width: 320, height: 200 });
  const allStrokes = activeStroke.length > 0 ? [...strokes, activeStroke] : strokes;
  const signed = allStrokes.some((stroke) => stroke.length > 0);
  const appendPoint = React.useCallback((point: MobileV2SignaturePoint, start?: boolean): void => {
    if (start) {
      setActiveStroke([point]);
      return;
    }
    setActiveStroke((current) => [...current, point]);
  }, []);
  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          appendPoint(
            {
              x: Number(event.nativeEvent.locationX ?? 0),
              y: Number(event.nativeEvent.locationY ?? 0),
            },
            true,
          );
        },
        onPanResponderMove: (event) => {
          appendPoint({
            x: Number(event.nativeEvent.locationX ?? 0),
            y: Number(event.nativeEvent.locationY ?? 0),
          });
        },
        onPanResponderRelease: () => {
          setActiveStroke((current) => {
            if (current.length > 0) setStrokes((prev) => [...prev, current]);
            return [];
          });
        },
        onPanResponderTerminate: () => {
          setActiveStroke((current) => {
            if (current.length > 0) setStrokes((prev) => [...prev, current]);
            return [];
          });
        },
      }),
    [appendPoint],
  );
  const clear = (): void => {
    setStrokes([]);
    setActiveStroke([]);
  };
  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setLayout({ width, height });
  };
  return (
    <View style={{ rowGap: 10 }}>
      <FxCard theme={t} padding={0} style={{ overflow: "hidden" }}>
        <View
          onLayout={onLayout}
          style={{
            height: 200,
            backgroundColor: t.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
          {...responder.panHandlers}
        >
          {signed ? (
            <Svg width="100%" height="100%" viewBox={`0 0 ${layout.width} ${layout.height}`}>
              {allStrokes.map((stroke, index) => {
                const [first, ...rest] = stroke;
                if (first === undefined) return null;
                const d = [
                  `M ${Math.round(first.x * 100) / 100} ${Math.round(first.y * 100) / 100}`,
                  ...rest.map((point) => `L ${Math.round(point.x * 100) / 100} ${Math.round(point.y * 100) / 100}`),
                ].join(" ");
                return (
                  <Path
                    key={`${index}-${stroke.length}`}
                    d={d}
                    fill="none"
                    stroke={t.ink}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
            </Svg>
          ) : (
            <FxCol gap={6} style={{ alignItems: "center" }}>
              <FxIcon name="sig" size={32} color={t.mutedSoft} />
              <Text
                style={{
                  fontSize: 12,
                  color: t.muted,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Tap to draw with finger
              </Text>
            </FxCol>
          )}
        </View>
      </FxCard>
      <FxRow justify="space-between">
        <FxChip theme={t} dense>
          {`Recipient: ${props.customer}`}
        </FxChip>
        <FxButton theme={t} variant="ghost" size="sm" icon="x" onPress={clear} disabled={props.busy}>
          Clear
        </FxButton>
      </FxRow>
      <FxRow gap={MOBILE_V2_SPACING.md} wrap>
        <FxButton
          theme={t}
          variant="primary"
          size="md"
          icon={props.captured ? "check" : "sig"}
          disabled={!signed || props.busy}
          onPress={() => {
            void props.onCaptureSignatureArtifact({
              strokes: allStrokes,
              width: layout.width,
              height: layout.height,
            });
          }}
        >
          {props.busy ? "Registering..." : props.captured ? "Signature registered" : "Register signature"}
        </FxButton>
        {props.busy ? <ActivityIndicator color={t.accent} /> : null}
      </FxRow>
      {props.captureError !== null ? <PodCaptureError theme={t} message={props.captureError} /> : null}
    </View>
  );
}

/** PodOtp — 4-digit OTP entry with boxed digit cells + helper actions. */
function PodOtpBody(props: {
  readonly theme: MobileV2Theme;
  readonly code: string;
  readonly onChangeCode: (code: string) => void;
}): React.ReactElement {
  const t = props.theme;
  const inputRef = React.useRef<TextInput | null>(null);
  const code = props.code;
  const setCode = (next: string): void => {
    props.onChangeCode(next.replace(/\D/g, "").slice(0, 4));
  };
  return (
    <FxCard theme={t}>
      <Text
        style={{
          fontSize: 13,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          color: t.ink,
          marginBottom: 10,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        Enter the 4-digit OTP
      </Text>
      <Pressable
        onPress={() => inputRef.current?.focus()}
        accessibilityRole="button"
        accessibilityLabel="Enter OTP code"
      >
        <FxRow gap={MOBILE_V2_SPACING.xl} justify="center">
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={{
                width: 54,
                height: 64,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: code.length === i ? t.accent : t.border,
                backgroundColor: t.surfaceAlt,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: t.ink,
                }}
              >
                {code[i] ?? ""}
              </Text>
            </View>
          ))}
        </FxRow>
      </Pressable>
      <TextInput
        ref={inputRef}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={4}
        style={{ position: "absolute", opacity: 0, left: -9999, width: 1, height: 1 }}
      />
      <FxRow justify="space-between" style={{ marginTop: 14 }}>
        <FxButton theme={t} variant="ghost" size="sm" onPress={() => setCode("")}>
          Clear
        </FxButton>
        <FxButton theme={t} variant="ghost" size="sm" icon="message">
          Resend SMS
        </FxButton>
      </FxRow>
    </FxCard>
  );
}

/** PodId — national-ID match card with scan / in-person confirm actions. */
function PodIdBody(props: {
  readonly theme: MobileV2Theme;
  readonly customer: string;
  readonly captured: boolean;
  readonly busy: boolean;
  readonly captureError: string | null;
  readonly cameraOpen: boolean;
  readonly cameraRef: React.MutableRefObject<{ takePictureAsync?: (options?: Record<string, unknown>) => Promise<unknown> } | null>;
  readonly onOpenCamera: () => void;
  readonly onCaptureCameraArtifact: () => Promise<void>;
  readonly onCancelCameraCapture: () => void;
}): React.ReactElement {
  const t = props.theme;
  return (
    <FxCard theme={t}>
      <FxRow gap={MOBILE_V2_SPACING["2xl"]}>
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 12,
            backgroundColor: t.accentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name="id" size={26} color={t.accent} />
        </View>
        <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontSize: 14,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              color: t.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            National ID match
          </Text>
          <Text style={{ fontSize: 12, color: t.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
            Recipient must show ID matching:{" "}
            <Text style={{ color: t.ink, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold }}>
              {props.customer}
            </Text>
          </Text>
        </FxCol>
      </FxRow>
      {props.cameraOpen ? (
        <View style={{ marginTop: 12 }}>
          <PodCameraCapturePanel
            theme={t}
            cameraRef={props.cameraRef}
            busy={props.busy}
            onCapture={props.onCaptureCameraArtifact}
            onCancel={props.onCancelCameraCapture}
          />
        </View>
      ) : null}
      <FxCol gap={MOBILE_V2_SPACING.lg} style={{ marginTop: 12 }}>
        <FxButton
          theme={t}
          variant="primary"
          full
          icon={props.captured ? "check" : "camera"}
          size="md"
          disabled={props.busy}
          onPress={props.onOpenCamera}
        >
          {props.captured ? "ID artifact registered" : "Scan ID document"}
        </FxButton>
        <FxButton theme={t} variant="ghost" full icon="user" size="md">
          Confirm in-person check
        </FxButton>
      </FxCol>
      {props.captureError !== null ? (
        <View style={{ marginTop: 10 }}>
          <PodCaptureError theme={t} message={props.captureError} />
        </View>
      ) : null}
    </FxCard>
  );
}

/** PodCod — amount due hero + tendered presets + change-to-give readout. */
function PodCodBody(props: {
  readonly theme: MobileV2Theme;
  readonly amount: number;
  readonly currency: string;
  readonly tendered: number;
  readonly onTenderedChange: (amount: number) => void;
}): React.ReactElement {
  const t = props.theme;
  const amount = props.amount;
  const tendered = props.tendered;
  const change = tendered - amount;
  const presets: ReadonlyArray<number> = [amount, amount + 10, amount + 50, amount + 100, amount + 500];
  // Design PodCod (flow-pod.jsx:175-187) renders cash values as
  // `<value>.toLocaleString() ﷼` — the resolved currency symbol (SAR → ﷼)
  // sits after a grouped amount. No hardcoded symbol literal.
  const money = (n: number): string => formatMobileV2CurrencyCompact(n, props.currency);
  const labelStyle = {
    fontSize: 11,
    color: t.muted,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
    fontFamily: MOBILE_V2_FONT_SANS,
  };
  return (
    <FxCard theme={t}>
      <Text style={labelStyle}>Amount due</Text>
      <Text
        style={{
          fontSize: 36,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          fontFamily: MOBILE_V2_FONT_MONO,
          letterSpacing: -1,
          marginTop: 4,
          color: t.ink,
        }}
      >
        {money(amount)}
      </Text>
      <View style={{ height: 1, backgroundColor: t.border, marginVertical: 14 }} />
      <Text style={[labelStyle, { marginBottom: 6 }]}>Tendered</Text>
      <FxRow gap={MOBILE_V2_SPACING.md} wrap>
        {presets.map((v, i) => (
          <Pressable
            key={`${v}-${i}`}
            onPress={() => props.onTenderedChange(v)}
            accessibilityRole="button"
            accessibilityLabel={`Tendered ${money(v)}`}
            accessibilityState={{ selected: tendered === v }}
          >
            <FxChip theme={t} tone={tendered === v ? "accent" : "neutral"} mono>
              {money(v)}
            </FxChip>
          </Pressable>
        ))}
      </FxRow>
      <FxRow justify="space-between" style={{ marginTop: 14 }}>
        <Text style={{ fontSize: 12, color: t.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
          Change to give
        </Text>
        <Text
          style={{
            fontSize: 18,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            fontFamily: MOBILE_V2_FONT_MONO,
            color: change > 0 ? t.warning : t.success,
          }}
        >
          {money(change)}
        </Text>
      </FxRow>
    </FxCard>
  );
}
