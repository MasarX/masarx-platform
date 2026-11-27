// Mobile V2 Loader multi-action scan screen — config-driven from
// mobile_loader_policy. Single/bulk segmented toggle, per-hub action
// picker, recent scan log, undo affordance, and bulk-confirm gate
// triggered via shouldConfirmLoaderBulkSubmit.

import * as React from "react";
import { Pressable, ScrollView, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import {
  FxButton,
  FxCard,
  FxChip,
  FxCol,
  FxRow,
  FxSectionHead,
  FxStatusDot,
  FxStickyAction,
} from "./mobile-v2-primitives";
import {
  getEnabledLoaderActions,
  loaderActionLabel,
  resolveEffectiveLoaderAction,
  type MobileV2LoaderPolicy,
  type MobileV2LoaderScanMode,
} from "./mobile-v2-loader-policy";
import { isMobileV2LoaderReadbackScanEntry } from "./mobile-v2-loader-readback";
import { normalizeMobileV2LoaderBarcodeInput } from "./mobile-v2-loader-scan-input";
import { buildMobileV2LoaderSubmitControlState } from "./mobile-v2-loader-submit-control";
import { getStrings, resolveLocaleCode } from "./i18n";
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

export interface MobileV2LoaderScanEntry {
  readonly id: string;
  readonly code: string;
  readonly action: string;
  readonly mode: MobileV2LoaderScanMode;
  readonly status: "ok" | "duplicate" | "error";
  readonly time: string;
}

export interface MobileV2LoaderScanScreenProps {
  readonly theme: MobileV2Theme;
  readonly policy: MobileV2LoaderPolicy;
  readonly mode: MobileV2LoaderScanMode;
  readonly onChangeMode: (mode: MobileV2LoaderScanMode) => void;
  readonly activeActionKey: string;
  readonly onChangeActionKey: (key: string) => void;
  readonly contextLabels: { readonly route?: string; readonly bay?: string };
  readonly recentScans: ReadonlyArray<MobileV2LoaderScanEntry>;
  readonly onUndoLast?: () => void;
  readonly onSimulateScan: () => void;
  readonly onBarcodeEntry?: (code: string) => void;
  readonly onSubmit: () => void;
  readonly locale?: string;
  readonly style?: StyleProp<ViewStyle>;
}

const LOADER_SCAN_STICKY_BOTTOM_SPACE = 260;

function statusKindFromStatus(s: MobileV2LoaderScanEntry["status"]): "done" | "current" | "pending" | "failed" | "sla" {
  switch (s) {
    case "ok":
      return "done";
    case "duplicate":
      return "sla";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

export function MobileV2LoaderScanScreen(props: MobileV2LoaderScanScreenProps): React.ReactElement {
  const { theme, policy } = props;
  const strings = getStrings(resolveLocaleCode(props.locale));
  const copy = strings.loaderScan;
  const enabledActions = React.useMemo(() => getEnabledLoaderActions(policy), [policy]);
  const effectiveAction = resolveEffectiveLoaderAction(policy, props.activeActionKey);
  const activeActionRecord = enabledActions.find((a) => a.key === effectiveAction) ?? enabledActions[0];
  const onBarcodeEntry = props.onBarcodeEntry;
  const barcodeInputRef = React.useRef<TextInput>(null);
  const [barcodeValue, setBarcodeValue] = React.useState("");

  const scanCount = props.recentScans.length;
  const confirmedScanCount = props.recentScans.filter(isMobileV2LoaderReadbackScanEntry).length;
  const submitControl = buildMobileV2LoaderSubmitControlState({
    policy,
    mode: props.mode,
    scanCount,
    confirmedScanCount,
  });
  const pendingScanCount = submitControl.pendingScanCount;
  const allVisibleScansConfirmed = submitControl.allVisibleScansConfirmed;
  const willConfirmBulk = submitControl.willConfirmBulk;
  const submitDisabled = submitControl.disabled;
  // Same wording as submitControl.label, from the catalog.
  const submitLabel = allVisibleScansConfirmed
    ? copy.scansConfirmed
    : (willConfirmBulk ? copy.confirmScans : pendingScanCount === 1 ? copy.submitScanOne : copy.submitScanOther)
        .replace("{count}", () => String(pendingScanCount));
  const barcodeReady =
    onBarcodeEntry !== undefined && normalizeMobileV2LoaderBarcodeInput(barcodeValue).length > 0;
  const submitTouchHandledRef = React.useRef(false);
  const onSubmit = props.onSubmit;
  const submitBarcode = React.useCallback(
    (value?: string) => {
      if (onBarcodeEntry === undefined) return;
      const code = normalizeMobileV2LoaderBarcodeInput(value ?? barcodeValue);
      if (code.length === 0) return;
      onBarcodeEntry(code);
      setBarcodeValue("");
      barcodeInputRef.current?.blur();
    },
    [barcodeValue, onBarcodeEntry],
  );
  const handleSubmitPress = React.useCallback(() => {
    if (submitDisabled || submitTouchHandledRef.current) return;
    submitTouchHandledRef.current = true;
    onSubmit();
    setTimeout(() => {
      submitTouchHandledRef.current = false;
    }, 250);
  }, [onSubmit, submitDisabled]);

  const sansSemibold = {
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  } as const;
  const monoBold = {
    fontFamily: MOBILE_V2_FONT_MONO,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  } as const;
  const renderSubmitButton = (testID: string, accessibilityLabel = submitLabel) => (
    <FxButton
      theme={theme}
      variant="primary"
      size="lg"
      icon="check"
      full
      disabled={submitDisabled}
      onPress={handleSubmitPress}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={{ flex: 1 }}
    >
      {submitLabel}
    </FxButton>
  );

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["3xl"],
          paddingBottom: LOADER_SCAN_STICKY_BOTTOM_SPACE,
        }}
      >
        {/* Mode segmented control */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxSectionHead theme={theme} label={copy.modeHeading.replace("{count}", () => String(policy.scanModes.length))} />
          <FxRow gap={MOBILE_V2_SPACING.md}>
            {policy.scanModes.map((m) => {
              const active = m === props.mode;
              return (
                <Pressable
                  key={m}
                  onPress={() => props.onChangeMode(m)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={{
                    flex: 1,
                    backgroundColor: active ? theme.accent : theme.surfaceAlt,
                    borderColor: active ? theme.accent : theme.border,
                    borderWidth: 1,
                    borderRadius: MOBILE_V2_RADII.button,
                    paddingVertical: MOBILE_V2_SPACING["3xl"],
                    paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                    alignItems: "center",
                    columnGap: MOBILE_V2_SPACING.md,
                    flexDirection: "row",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon
                    name={m === "bulk" ? "layers" : "scan"}
                    size={18}
                    color={active ? theme.accentInk : theme.muted}
                  />
                  <Text
                    style={{
                      ...sansSemibold,
                      color: active ? theme.accentInk : theme.ink,
                      fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                    }}
                  >
                    {m === "bulk" ? copy.modeBulk : copy.modeSingle}
                  </Text>
                </Pressable>
              );
            })}
          </FxRow>
        </FxCol>

        {/* Active action */}
        <FxCard theme={theme} accent>
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
              {activeActionRecord !== undefined ? (
                <FxIcon name={activeActionRecord.icon} size={22} color={theme.accent} />
              ) : null}
              <Text style={{ ...sansSemibold, color: theme.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong, flex: 1 }}>
                {activeActionRecord !== undefined ? loaderActionLabel(activeActionRecord, strings) : effectiveAction}
              </Text>
              <FxChip theme={theme} tone="accent" dense mono>
                {effectiveAction}
              </FxChip>
            </FxRow>
            <Text
              style={{
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
              }}
            >
              {props.mode === "bulk" ? copy.bulkHint : copy.singleHint}
            </Text>
          </FxCol>
        </FxCard>

        {/* Action picker — only enabled actions from policy */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxSectionHead
            theme={theme}
            label={copy.actionsHeading
              .replace("{enabled}", () => String(enabledActions.length))
              .replace("{total}", () => String(policy.actions.length))}
          />
          <FxRow gap={MOBILE_V2_SPACING.md} wrap>
            {enabledActions.map((action) => {
              const active = action.key === effectiveAction;
              return (
                <Pressable
                  key={action.key}
                  onPress={() => props.onChangeActionKey(action.key)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <FxChip theme={theme} tone={active ? "accent" : "neutral"} icon={action.icon}>
                    {loaderActionLabel(action, strings)}
                  </FxChip>
                </Pressable>
              );
            })}
          </FxRow>
        </FxCol>

        {/* Context chips */}
        {policy.contextChips.length > 0 ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <FxSectionHead theme={theme} label={copy.context} />
            <FxRow gap={MOBILE_V2_SPACING.md} wrap>
              {policy.contextChips.includes("route") ? (
                <FxChip theme={theme} tone="info" icon="route" mono>
                  {props.contextLabels.route ?? "—"}
                </FxChip>
              ) : null}
              {policy.contextChips.includes("bay") ? (
                <FxChip theme={theme} tone="info" icon="layers" mono>
                  {copy.bay.replace("{bay}", () => props.contextLabels.bay ?? "—")}
                </FxChip>
              ) : null}
            </FxRow>
          </FxCol>
        ) : null}

        {/* Scan area placeholder */}
        <Pressable
          onPress={props.onSimulateScan}
          accessibilityRole="button"
          accessibilityLabel={copy.simulateScan}
        >
          <FxCard theme={theme} soft>
            <View
              style={{
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: MOBILE_V2_SPACING["7xl"],
                rowGap: MOBILE_V2_SPACING.lg,
              }}
            >
              <FxIcon name="scan" size={56} color={theme.accent} stroke={2.0} />
              <Text style={{ ...sansSemibold, color: theme.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong }}>
                {copy.tapToScan}
              </Text>
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontSize: MOBILE_V2_TYPE_SIZES.chip,
                  letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
                }}
              >
                {props.mode.toUpperCase()} · {effectiveAction.toUpperCase()}
              </Text>
            </View>
          </FxCard>
        </Pressable>

        {submitControl.inlineVisible ? (
          <FxCard theme={theme} accent>
            <FxCol gap={MOBILE_V2_SPACING.lg}>
              <FxSectionHead theme={theme} label={copy.readyToSubmit} />
              <FxRow gap={MOBILE_V2_SPACING.lg}>{renderSubmitButton(submitControl.inlineTestId, copy.submitScans)}</FxRow>
            </FxCol>
          </FxCard>
        ) : null}

        <FxCard theme={theme} soft>
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <FxSectionHead theme={theme} label={copy.scannerInput} />
            <FxRow gap={MOBILE_V2_SPACING.md} align="stretch">
              <TextInput
                ref={barcodeInputRef}
                value={barcodeValue}
                onChangeText={setBarcodeValue}
                onSubmitEditing={(event) => submitBarcode(event.nativeEvent.text)}
                placeholder={copy.barcodePlaceholder}
                placeholderTextColor={theme.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                blurOnSubmit
                accessibilityLabel={copy.barcodeInput}
                testID="mobile-v2-loader-barcode-input"
                style={{
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: MOBILE_V2_RADII.input,
                  color: theme.ink,
                  flex: 1,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  minHeight: 50,
                  minWidth: 0,
                  paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                  paddingVertical: MOBILE_V2_SPACING["2xl"],
                }}
              />
              <FxButton
                theme={theme}
                variant="soft"
                size="md"
                icon="scan"
                onPress={() => submitBarcode()}
                disabled={!barcodeReady}
                accessibilityLabel={copy.addScanLabel}
                testID="mobile-v2-loader-add-barcode"
              >
                {copy.addScan}
              </FxButton>
            </FxRow>
          </FxCol>
        </FxCard>

        {/* Recent scan log */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxSectionHead
            theme={theme}
            label={
              confirmedScanCount > 0
                ? copy.confirmedHeading
                    .replace("{confirmed}", () => String(confirmedScanCount))
                    .replace("{total}", () => String(scanCount))
                : copy.recentHeading.replace("{count}", () => String(scanCount))
            }
            right={
              props.onUndoLast !== undefined && scanCount > 0 && !allVisibleScansConfirmed ? (
                <Pressable onPress={props.onUndoLast} accessibilityRole="button" accessibilityLabel={copy.undoLast}>
                  <FxRow gap={MOBILE_V2_SPACING.sm} align="center">
                    <FxIcon name="refresh" size={14} color={theme.muted} />
                    <Text
                      style={{
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        fontSize: MOBILE_V2_TYPE_SIZES.chip,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      }}
                    >
                      {copy.undo}
                    </Text>
                  </FxRow>
                </Pressable>
              ) : undefined
            }
          />
          {scanCount === 0 ? (
            <FxCard theme={theme} soft>
              <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                {copy.empty}
              </Text>
            </FxCard>
          ) : (
            <FxCol gap={MOBILE_V2_SPACING.md}>
              {props.recentScans.map((entry) => (
                <FxRow
                  key={entry.id}
                  gap={MOBILE_V2_SPACING.lg}
                  align="center"
                  style={{
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderWidth: 1,
                    borderRadius: MOBILE_V2_RADII.card,
                    padding: MOBILE_V2_SPACING["2xl"],
                  }}
                >
                  <FxStatusDot theme={theme} kind={statusKindFromStatus(entry.status)} size={10} />
                  <Text style={{ ...monoBold, color: theme.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong, flex: 1 }}>
                    {entry.code}
                  </Text>
                  {isMobileV2LoaderReadbackScanEntry(entry) ? (
                    <FxChip theme={theme} tone="success" dense>
                      {copy.confirmed}
                    </FxChip>
                  ) : null}
                  <FxChip
                    theme={theme}
                    tone={entry.status === "ok" ? "success" : entry.status === "duplicate" ? "warning" : "danger"}
                    dense
                  >
                    {entry.action}
                  </FxChip>
                  <Text
                    style={{
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      fontSize: MOBILE_V2_TYPE_SIZES.chip,
                    }}
                  >
                    {entry.time}
                  </Text>
                </FxRow>
              ))}
            </FxCol>
          )}
        </FxCol>
      </ScrollView>

      <FxStickyAction
        theme={theme}
        sub={`${copy.stickySub
          .replace("{mode}", () => (props.mode === "bulk" ? copy.modeBulkLower : copy.modeSingleLower))
          .replace("{pending}", () => String(pendingScanCount))
          .replace("{actions}", () => String(enabledActions.length))}${
          willConfirmBulk ? copy.stickyConfirmAbove.replace("{threshold}", () => String(policy.confirmThreshold)) : ""
        }${allVisibleScansConfirmed ? copy.stickySaved : ""}`}
      >
        <FxRow gap={MOBILE_V2_SPACING.lg}>
          <FxButton
            theme={theme}
            variant="ghost"
            size="md"
            icon="refresh"
            onPress={props.onUndoLast}
            disabled={scanCount === 0 || allVisibleScansConfirmed}
          >
            {copy.undo}
          </FxButton>
          {renderSubmitButton(submitControl.stickyTestId)}
        </FxRow>
      </FxStickyAction>
    </View>
  );
}
