// Mobile V2 End-of-Route screen — pixel-faithful port of design source
// flow-system.jsx ScrEOR. Driver wraps the shift at the hub: summary
// metric strip (Delivered / Failed / On-time%), hand-back checklist
// (returned parcels, COD handover, devices, final sync), shift-performance
// callout, and primary CTA that flips success when all checks are done.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxCol, FxMetric, FxRow, FxSectionHead } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2EorChecklistItem {
  readonly id: string;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly sub: string;
}

export interface MobileV2EorSummary {
  readonly delivered: number;
  readonly total: number;
  readonly failed: number;
}

export interface MobileV2EorLastReconView {
  readonly decisionLogId: string;
  readonly state: string;
  readonly parcelsCount: number;
  readonly mismatchCount: number;
  readonly cashDeclared: number;
  readonly cashCounted: number;
  readonly cashVariance: number;
  readonly walletStatus: string;
  readonly submittedAt: string | null;
}

export interface MobileV2EorScreenProps {
  readonly theme: MobileV2Theme;
  readonly summary: MobileV2EorSummary;
  readonly checklist: ReadonlyArray<MobileV2EorChecklistItem>;
  readonly checked: ReadonlySet<string>;
  readonly lastRecon?: MobileV2EorLastReconView | null;
  readonly currency?: string;
  readonly performanceNote?: string;
  readonly isCompleting?: boolean;
  readonly onToggle: (id: string) => void;
  readonly onComplete?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function humanizeEorReconState(value: string): string {
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatReconSubmittedAt(value: string | null): string {
  if (value === null) return "Just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MobileV2EorScreen(props: MobileV2EorScreenProps): React.ReactElement {
  const { theme, summary, checklist, checked } = props;
  const allDone = checklist.every((i) => checked.has(i.id));
  const denom = Math.max(1, summary.delivered + summary.failed);
  const onTimePct = Math.round((summary.delivered / denom) * 100);
  const lastRecon = props.lastRecon ?? null;
  const currency = props.currency ?? "SAR";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING.lg,
          paddingBottom: 140,
        }}
      >
        {/* Summary metric strip */}
        <FxRow gap={MOBILE_V2_SPACING.sm} align="stretch">
          <FxCard theme={theme} padding={12} style={{ flex: 1 }}>
            <View style={{ alignItems: "center" }}>
              <FxMetric
                theme={theme}
                label="Delivered"
                value={String(summary.delivered)}
                unit={`/${summary.total}`}
                tone="success"
              />
            </View>
          </FxCard>
          <FxCard theme={theme} padding={12} style={{ flex: 1 }}>
            <View style={{ alignItems: "center" }}>
              <FxMetric
                theme={theme}
                label="Failed"
                value={String(summary.failed)}
                tone="danger"
              />
            </View>
          </FxCard>
          <FxCard theme={theme} padding={12} style={{ flex: 1 }}>
            <View style={{ alignItems: "center" }}>
              <FxMetric
                theme={theme}
                label="On-time"
                value={String(onTimePct)}
                unit="%"
                tone="accent"
              />
            </View>
          </FxCard>
        </FxRow>

        {/* Hand-back checklist */}
        <FxSectionHead theme={theme} label="Hand-back checklist" />
        <View
          style={{
            backgroundColor: theme.border,
            borderRadius: 14,
            overflow: "hidden",
            rowGap: 1,
          }}
        >
          {checklist.map((item) => {
            const on = checked.has(item.id);
            return (
              <Pressable
                key={item.id}
                onPress={() => props.onToggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityLabel={item.label}
                accessibilityState={{ checked: on }}
                style={{
                  backgroundColor: theme.surface,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: MOBILE_V2_SPACING.md,
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
                  {on ? <FxIcon name="check" size={16} color={theme.bg === "#0E0E10" ? "#0E0E10" : "#FFFFFF"} /> : null}
                </View>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 9,
                    backgroundColor: theme.surfaceAlt,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon name={item.icon} size={16} color={theme.muted} />
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {item.label}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {item.sub}
                  </Text>
                </FxCol>
              </Pressable>
            );
          })}
        </View>

        {lastRecon !== null ? (
          <FxCard theme={theme} accent testID="mobile-v2-eor-last-recon">
            <FxCol gap={MOBILE_V2_SPACING.md}>
              <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    backgroundColor: theme.success,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon name="check-double" size={18} color={theme.bg === "#0E0E10" ? "#0E0E10" : "#FFFFFF"} />
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Latest reconciliation saved
                  </Text>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {`${humanizeEorReconState(lastRecon.state)} · ${formatReconSubmittedAt(lastRecon.submittedAt)}`}
                  </Text>
                </FxCol>
              </FxRow>

              <FxRow gap={MOBILE_V2_SPACING.sm} align="stretch">
                <FxCard theme={theme} soft padding={10} style={{ flex: 1 }}>
                  <FxMetric
                    theme={theme}
                    label="Parcels"
                    value={String(lastRecon.parcelsCount)}
                    unit={lastRecon.mismatchCount > 0 ? `/${lastRecon.mismatchCount} mismatch` : ""}
                    tone={lastRecon.mismatchCount > 0 ? "warning" : "success"}
                  />
                </FxCard>
                <FxCard theme={theme} soft padding={10} style={{ flex: 1 }}>
                  <FxMetric
                    theme={theme}
                    label="Cash variance"
                    value={formatMobileV2CurrencyCompact(lastRecon.cashVariance, currency)}
                    tone={lastRecon.cashVariance === 0 ? "success" : "warning"}
                  />
                </FxCard>
              </FxRow>

              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {`Declared ${formatMobileV2CurrencyCompact(lastRecon.cashDeclared, currency)} · counted ${formatMobileV2CurrencyCompact(lastRecon.cashCounted, currency)} · wallet ${lastRecon.walletStatus}`}
              </Text>
            </FxCol>
          </FxCard>
        ) : null}

        {/* Shift performance callout */}
        {props.performanceNote !== undefined ? (
          <FxCard theme={theme} soft>
            <FxRow gap={MOBILE_V2_SPACING.md} align="center">
              <FxIcon name="star" size={18} color={theme.ink} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Shift performance
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {props.performanceNote}
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>
        ) : null}

        {/* Primary CTA */}
        <FxButton
          theme={theme}
          variant={allDone ? "success" : "soft"}
          full
          size="lg"
          icon={allDone ? "check-double" : "alert"}
          onPress={props.onComplete}
          disabled={props.isCompleting === true}
          accessibilityLabel={allDone ? "Hand back and end shift" : "Complete checklist to finish"}
          style={{ marginTop: MOBILE_V2_SPACING.md }}
        >
          {props.isCompleting === true
            ? "Saving reconciliation"
            : allDone
              ? "Hand back & end shift"
              : "Complete checklist to finish"}
        </FxButton>
      </ScrollView>
    </View>
  );
}
