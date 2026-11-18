// Mobile V2 Hold Queue screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrHold. Exceptions awaiting a decision. Each
// row card: tone-coded icon, mono parcel id + reason chip, free-form
// note, "Nm on hold" mono ribbon, and action footer (Re-induct / Return
// to merchant / Destroy). Reason metadata is data-driven (parsed from
// row.reason against a resolved registry) so new reasons can be added
// by config without UI changes.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import { minutesSinceMs } from "./mobile-v2-ops-helpers";

export type MobileV2HoldReason = "addr" | "damage" | "wrong_route" | "other";
export type MobileV2HoldAction = "requeue" | "rto" | "destroy";

export interface MobileV2HoldItem {
  readonly id: string;
  readonly parcel: string;
  readonly reason: MobileV2HoldReason;
  readonly note: string;
  /** Epoch ms when the item entered the hold queue. */
  readonly atMs: number;
}

export interface MobileV2HoldDecisionSummary {
  readonly holdId: string;
  readonly action: "reinduct" | "escalate" | "discard";
  readonly status: "resolved" | "escalated" | "discarded";
  readonly decisionLogId: string;
}

export interface MobileV2HoldScreenProps {
  readonly theme: MobileV2Theme;
  readonly items: ReadonlyArray<MobileV2HoldItem>;
  readonly onResolve: (id: string, action: MobileV2HoldAction) => void;
  readonly latestDecision?: MobileV2HoldDecisionSummary | null;
  readonly resolving?: boolean;
  readonly readbackError?: string | null;
  readonly style?: StyleProp<ViewStyle>;
}

interface ReasonMeta {
  readonly label: string;
  readonly icon: MobileV2IconName;
  readonly tone: FxChipTone;
}

const REASON_REGISTRY: Readonly<Record<MobileV2HoldReason, ReasonMeta>> = Object.freeze({
  addr: Object.freeze({ label: "Address unresolved", icon: "pin", tone: "warning" }),
  damage: Object.freeze({ label: "Damaged parcel", icon: "alert", tone: "danger" }),
  wrong_route: Object.freeze({ label: "Mis-sorted", icon: "route", tone: "warning" }),
  other: Object.freeze({ label: "Hold", icon: "flag", tone: "neutral" }),
});

function resolveSoftColors(theme: MobileV2Theme, tone: FxChipTone): { bg: string; fg: string } {
  switch (tone) {
    case "danger":
      return { bg: theme.dangerSoft, fg: theme.danger };
    case "warning":
      return { bg: theme.warningSoft, fg: theme.warning };
    case "success":
      return { bg: theme.successSoft, fg: theme.success };
    case "info":
      return { bg: theme.infoSoft, fg: theme.info };
    case "accent":
      return { bg: theme.accentSoft, fg: theme.accent };
    default:
      return { bg: theme.surfaceAlt, fg: theme.muted };
  }
}

function formatDecisionAction(action: MobileV2HoldDecisionSummary["action"]): string {
  if (action === "reinduct") return "Re-inducted";
  if (action === "escalate") return "Returned to merchant";
  return "Destroyed";
}

function shortHoldDecisionId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

export function MobileV2HoldQueueScreen(
  props: MobileV2HoldScreenProps,
): React.ReactElement {
  const { theme, items } = props;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING.md,
          paddingBottom: 96,
        }}
      >
        {props.latestDecision ? (
          <FxCard theme={theme} padding={14}>
            <FxCol gap={MOBILE_V2_SPACING.sm}>
              <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
                <Text
                  style={{
                    fontSize: 10.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    textTransform: "uppercase",
                  }}
                >
                  Latest hold decision saved
                </Text>
                <FxChip
                  theme={theme}
                  tone={props.latestDecision.status === "discarded" ? "warning" : "success"}
                  dense
                >
                  {props.latestDecision.status}
                </FxChip>
              </FxRow>
              <Text
                style={{
                  fontSize: 13,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {formatDecisionAction(props.latestDecision.action)} hold{" "}
                {shortHoldDecisionId(props.latestDecision.holdId)}
              </Text>
              <Text
                style={{
                  fontSize: 10.5,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                Decision {shortHoldDecisionId(props.latestDecision.decisionLogId)}
              </Text>
            </FxCol>
          </FxCard>
        ) : null}
        {props.resolving === true ? (
          <FxCard theme={theme} padding={14}>
            <Text
              style={{
                fontSize: 12,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Confirming hold decision...
            </Text>
          </FxCard>
        ) : null}
        {props.readbackError ? (
          <FxCard theme={theme} padding={14}>
            <Text
              style={{
                fontSize: 12,
                color: theme.danger,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {props.readbackError}
            </Text>
          </FxCard>
        ) : null}
        {items.length > 0 ? (
          items.map((h) => {
            const meta = REASON_REGISTRY[h.reason] ?? REASON_REGISTRY.other;
            const colors = resolveSoftColors(theme, meta.tone);
            return (
              <FxCard key={h.id} theme={theme} padding={0}>
                {/* Body */}
                <FxRow
                  gap={MOBILE_V2_SPACING.md}
                  align="flex-start"
                  style={{ paddingHorizontal: 14, paddingVertical: 12 }}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      backgroundColor: colors.bg,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name={meta.icon} size={18} color={colors.fg} />
                  </View>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <FxRow gap={MOBILE_V2_SPACING.sm} align="center">
                      <Text
                        style={{
                          fontSize: 10.5,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_MONO,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        }}
                      >
                        {h.parcel}
                      </Text>
                      <FxChip theme={theme} tone={meta.tone} dense>
                        {meta.label}
                      </FxChip>
                    </FxRow>
                    <Text
                      style={{
                        fontSize: 12.5,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        marginTop: 2,
                      }}
                    >
                      {h.note}
                    </Text>
                    <Text
                      style={{
                        fontSize: 10.5,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                        marginTop: 2,
                      }}
                    >
                      {minutesSinceMs(h.atMs)}m on hold
                    </Text>
                  </FxCol>
                </FxRow>
                {/* Footer actions */}
                <FxRow
                  gap={MOBILE_V2_SPACING.sm}
                  align="center"
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    backgroundColor: theme.surfaceAlt,
                    borderTopColor: theme.border,
                    borderTopWidth: 1,
                  }}
                >
                  <FxButton
                    theme={theme}
                    variant="soft"
                    size="sm"
                    icon="route"
                    onPress={() => props.onResolve(h.id, "requeue")}
                    accessibilityLabel={`Re-induct ${h.parcel}`}
                  >
                    Re-induct
                  </FxButton>
                  <FxButton
                    theme={theme}
                    variant="soft"
                    size="sm"
                    icon="arrow-left"
                    onPress={() => props.onResolve(h.id, "rto")}
                    accessibilityLabel={`Return ${h.parcel} to merchant`}
                  >
                    Return to merchant
                  </FxButton>
                  <View style={{ flex: 1 }} />
                  <FxButton
                    theme={theme}
                    variant="ghost"
                    size="sm"
                    icon="x"
                    onPress={() => props.onResolve(h.id, "destroy")}
                    accessibilityLabel={`Destroy ${h.parcel}`}
                  >
                    Destroy
                  </FxButton>
                </FxRow>
              </FxCard>
            );
          })
        ) : (
          <FxCard theme={theme} padding={20}>
            <FxCol gap={MOBILE_V2_SPACING.md} style={{ alignItems: "center" }}>
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  backgroundColor: theme.successSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="check" size={22} color={theme.success} />
              </View>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                No holds
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  textAlign: "center",
                }}
              >
                All exceptions resolved.
              </Text>
            </FxCol>
          </FxCard>
        )}
      </ScrollView>
    </View>
  );
}
