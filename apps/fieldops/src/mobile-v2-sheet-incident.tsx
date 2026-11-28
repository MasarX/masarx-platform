// Mobile V2 Incident sheet — pixel-faithful port of design source
// flow-extras.jsx SheetIncident. Collision / theft / breakdown /
// complaint report with severity-aware UX: high-severity types open a
// danger banner + danger-tone primary CTA; low-severity types use the
// neutral path. Required artefacts (photo, statement) gate the submit
// button by composing flags from the incident-type registry.

import * as React from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import { MobileV2ListStateView } from "./mobile-v2-list-state-view";
import { isMobileV2IncidentReady } from "./mobile-v2-sheet-readiness";
// Incident-type contract lives in the RN-free `mobile-v2-incident-types`
// module so the RPC hooks layer + this sheet share one definition.
// Re-exported here for backward compatibility with existing importers.
import type {
  MobileV2IncidentNeed,
  MobileV2IncidentType,
} from "./mobile-v2-incident-types";
import type { MobileV2IncidentReadback } from "./mobile-v2-rpc-hooks";

export type {
  MobileV2IncidentNeed,
  MobileV2IncidentSeverity,
  MobileV2IncidentType,
} from "./mobile-v2-incident-types";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2IncidentSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly types: ReadonlyArray<MobileV2IncidentType>;
  readonly selectedTypeId: string | null;
  readonly photoCaptured: boolean;
  readonly statement: string;
  readonly onSelectType: (id: string) => void;
  readonly onTogglePhoto: () => void;
  readonly onStatementChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly submitting?: boolean;
  readonly latestIncident?: MobileV2IncidentReadback | null;
  readonly readbackError?: string | null;
  /** #600: the live type read's state; the picker shows loading or error-with-retry instead of a list. */
  readonly typesState?: {
    readonly isLoading: boolean;
    readonly isError: boolean;
    readonly errorMessage: string;
    readonly retryLabel: string;
    readonly onRetry: () => void;
  };
  readonly style?: StyleProp<ViewStyle>;
}

function chipToneForNeed(need: MobileV2IncidentNeed): FxChipTone {
  return need === "call_112" || need === "call_999" ? "danger" : "info";
}

function shortIncidentReadbackId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function formatIncidentSubmittedAt(value: string | null | undefined): string {
  if (!value) return "Just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MobileV2IncidentSheet(
  props: MobileV2IncidentSheetProps,
): React.ReactElement {
  const { theme, types } = props;
  const picked = types.find((x) => x.id === props.selectedTypeId);
  const latestIncidentType = types.find((x) => x.id === props.latestIncident?.typeId);
  const reqPhoto = picked?.needs.includes("photo") ?? false;
  const reqStatement = picked?.needs.includes("statement") ?? false;
  const ready = isMobileV2IncidentReady({
    types,
    selectedTypeId: props.selectedTypeId,
    photoCaptured: props.photoCaptured,
    statement: props.statement,
  });

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Report incident"
      subtitle="Dispatch + insurance get notified instantly"
      style={props.style}
      primary={
        picked !== undefined ? (
          <FxButton
            theme={theme}
            variant={ready ? "danger" : "soft"}
            full
            size="lg"
            icon="alert"
            disabled={!ready || props.submitting === true}
            onPress={props.onSubmit}
            accessibilityLabel="Submit incident report"
          >
            {props.submitting === true
              ? "Saving incident..."
              : ready
              ? picked.severity === "high"
                ? "Submit · call dispatcher now"
                : "Submit incident report"
              : "Complete required fields"}
          </FxButton>
        ) : undefined
      }
    >
      {/* Type picker — full-bleed rows separated by 1px borders. The
          negative side margin escapes the sheet content's 14px inset so
          the rows reach the panel edges, matching design SheetIncident. */}
      <MobileV2ListStateView
        theme={theme}
        isLoading={props.typesState?.isLoading ?? false}
        isError={props.typesState?.isError ?? false}
        errorMessage={props.typesState?.errorMessage}
        retryLabel={props.typesState?.retryLabel}
        onRetry={props.typesState?.onRetry}
      >
      <View
        style={{
          marginHorizontal: -MOBILE_V2_SPACING["3xl"],
          backgroundColor: theme.border,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: theme.border,
          rowGap: 1,
        }}
      >
        {types.map((i) => {
          const on = props.selectedTypeId === i.id;
          const iconBg =
            i.severity === "high"
              ? theme.dangerSoft
              : i.severity === "med"
                ? theme.warningSoft
                : theme.surfaceAlt;
          const iconFg =
            i.severity === "high"
              ? theme.danger
              : i.severity === "med"
                ? theme.warning
                : theme.muted;
          return (
            <Pressable
              key={i.id}
              onPress={() => props.onSelectType(i.id)}
              accessibilityRole="button"
              accessibilityLabel={`Select ${i.label} incident type`}
              style={{
                backgroundColor: theme.surface,
                paddingVertical: MOBILE_V2_SPACING["3xl"],
                paddingHorizontal: MOBILE_V2_SPACING["4xl"],
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
              }}
            >
              <View
                style={{
                  width: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  height: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  borderRadius: MOBILE_V2_RADII.iconDisk,
                  backgroundColor: iconBg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name={i.icon} size={16} color={iconFg} />
              </View>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.rowLabel,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {i.label}
                </Text>
                <FxRow gap={4} wrap>
                  {i.needs.map((n) => (
                    <FxChip key={n} theme={theme} tone={chipToneForNeed(n)} dense>
                      {n.replace("_", " ")}
                    </FxChip>
                  ))}
                </FxRow>
              </FxCol>
              {on ? <FxIcon name="check" size={18} color={theme.danger} /> : null}
            </Pressable>
          );
        })}
      </View>
      </MobileV2ListStateView>

      {/* Detail / required-fields panel — only shown after a type is picked */}
      {props.readbackError ? (
        <FxCard
          theme={theme}
          padding={MOBILE_V2_SPACING["2xl"]}
          style={{
            backgroundColor: theme.dangerSoft,
            borderColor: theme.danger,
            marginTop: MOBILE_V2_SPACING["2xl"],
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
                Incident saved, confirming
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

      {props.latestIncident ? (
        <FxCard
          theme={theme}
          padding={MOBILE_V2_SPACING["2xl"]}
          style={{
            backgroundColor: theme.successSoft,
            borderColor: theme.success,
            marginTop: MOBILE_V2_SPACING["2xl"],
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
                Latest incident saved
              </Text>
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: theme.inkSoft,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {latestIncidentType?.label ?? props.latestIncident.typeId} - severity{" "}
                {props.latestIncident.severity}
              </Text>
              {props.latestIncident.statement ? (
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.caption,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {props.latestIncident.statement}
                </Text>
              ) : null}
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Incident {shortIncidentReadbackId(props.latestIncident.incidentId)} - decision{" "}
                {shortIncidentReadbackId(props.latestIncident.decisionLogId)} -{" "}
                {formatIncidentSubmittedAt(props.latestIncident.submittedAt)}
              </Text>
            </FxCol>
          </FxRow>
        </FxCard>
      ) : null}

      {picked !== undefined ? (
        <FxCol gap={MOBILE_V2_SPACING["2xl"]} style={{ paddingTop: MOBILE_V2_SPACING["3xl"] }}>
          {picked.severity === "high" ? (
            <FxCard
              theme={theme}
              padding={MOBILE_V2_SPACING["2xl"]}
              style={{
                backgroundColor: theme.dangerSoft,
                borderColor: theme.danger,
              }}
            >
              <FxRow gap={MOBILE_V2_SPACING.xl} align="flex-start">
                <FxIcon name="alert" size={18} color={theme.danger} />
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: MOBILE_V2_TYPE_SIZES.body,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.danger,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Are you safe?
                  </Text>
                  <Text
                    style={{
                      fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      color: theme.danger,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    If anyone is injured, call 911/997 first. Dispatch will be paged automatically when you submit.
                  </Text>
                </FxCol>
              </FxRow>
            </FxCard>
          ) : null}
          {reqPhoto ? (
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
                Photos (vehicle + scene)
              </Text>
              <Pressable
                onPress={props.onTogglePhoto}
                accessibilityRole="button"
                accessibilityLabel={props.photoCaptured ? "Photo captured — tap to retake" : "Capture damage / scene"}
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
                  {props.photoCaptured ? "Photo captured · tap to retake" : "Capture damage / scene"}
                </Text>
              </Pressable>
            </FxCol>
          ) : null}
          {reqStatement ? (
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
                What happened? · required
              </Text>
              <TextInput
                value={props.statement}
                onChangeText={props.onStatementChange}
                placeholder="Brief, factual account · time, place, who's involved."
                placeholderTextColor={theme.muted}
                multiline
                numberOfLines={4}
                style={{
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: MOBILE_V2_RADII.button,
                  backgroundColor: theme.surface,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  padding: MOBILE_V2_SPACING["2xl"],
                  minHeight: 88,
                  textAlignVertical: "top",
                }}
              />
            </FxCol>
          ) : null}
          <FxRow gap={MOBILE_V2_SPACING.md} wrap>
            <FxChip theme={theme} icon="phone" tone="danger">
              Call dispatch
            </FxChip>
            <FxChip theme={theme} icon="message" tone="info">
              Open chat
            </FxChip>
            <FxChip theme={theme} icon="pin" tone="info">
              Share location
            </FxChip>
          </FxRow>
        </FxCol>
      ) : null}

    </MobileV2BottomSheet>
  );
}
