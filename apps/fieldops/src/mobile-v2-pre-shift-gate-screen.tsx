// Mobile V2 Pre-shift Gate screen — pixel-faithful port of design source
// flow-onboard.jsx ScrPreShift. Daily/weekly readiness gate driven by
// unmet preShift requirements computed upstream from
// appConfig.preShift cadences. Each blocker tile links to its
// remediation screen (vehicle photos, cleaning, KYC, etc.).
//
// Stateless: parent supplies the resolved blockers + cadence summary
// + whether health attestation is required + current attestation
// state. The CTA flips success ↔ soft based on readiness.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2PreShiftBlockerSeverity = "high" | "med" | "low";

export interface MobileV2PreShiftBlocker {
  readonly id: string;
  readonly icon: MobileV2IconName;
  readonly title: string;
  readonly sub: string;
  readonly cta: string;
  readonly severity: MobileV2PreShiftBlockerSeverity;
  /** Marker that downstream remediation will route to (route key/id). */
  readonly route: string;
}

export interface MobileV2PreShiftCadenceSummary {
  /** Days between vehicle photo refreshes (e.g. 7d). */
  readonly photoCadenceDays: number;
  /**
   * Cleaning cadence label fragment: when 0, render "every shift";
   * else render `every ${hours}h`. Pre-formatted upstream so the
   * screen doesn't make policy decisions about cadence vocabulary.
   */
  readonly cleaningCadenceLabel: string;
  /** When true, render the fit-to-drive attestation block. */
  readonly healthAttestation: boolean;
}

export interface MobileV2PreShiftReadbackCard {
  readonly passId: string;
  readonly decisionLogId: string;
  readonly shiftId: string;
  readonly state: string;
  readonly submittedAt?: string | null;
}

export interface MobileV2PreShiftGateScreenProps {
  readonly theme: MobileV2Theme;
  /** Shift identifier (e.g. "RTE-2026-05-04-RUH-08"). */
  readonly shiftId: string;
  /** Stop count, used in the subtitle "<n> stops". */
  readonly stopCount: number;
  /** All blockers — health is filtered out and rendered inline. */
  readonly blockers: ReadonlyArray<MobileV2PreShiftBlocker>;
  readonly cadence: MobileV2PreShiftCadenceSummary;
  readonly healthOk: boolean;
  readonly onToggleHealth: (next: boolean) => void;
  readonly onOpenBlocker: (blocker: MobileV2PreShiftBlocker) => void;
  readonly onStart: () => void;
  readonly onBack?: () => void;
  readonly latestReadback?: MobileV2PreShiftReadbackCard | null;
  readonly readbackError?: string | null;
  readonly submitting?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

function resolveSoftPair(
  theme: MobileV2Theme,
  severity: MobileV2PreShiftBlockerSeverity,
): { readonly bg: string; readonly fg: string } {
  switch (severity) {
    case "high":
      return { bg: theme.dangerSoft, fg: theme.danger };
    case "med":
      return { bg: theme.warningSoft, fg: theme.warning };
    case "low":
    default:
      return { bg: theme.accentSoft, fg: theme.accent };
  }
}

export function MobileV2PreShiftGateScreen(
  props: MobileV2PreShiftGateScreenProps,
): React.ReactElement {
  const { theme, blockers, cadence, healthOk } = props;
  // "health" is a synthetic blocker handled inline.
  const externalBlockers = blockers.filter((b) => b.id !== "health");
  const hasHealthBlocker = blockers.some((b) => b.id === "health");
  const allExternalCleared = externalBlockers.length === 0;
  const ready =
    allExternalCleared && (!hasHealthBlocker || !cadence.healthAttestation || healthOk);
  const canStart = ready && props.submitting !== true;
  const remainingCount =
    externalBlockers.length + (cadence.healthAttestation && !healthOk && hasHealthBlocker ? 1 : 0);
  const ctaLabel = props.submitting
    ? "Starting route..."
    : ready
      ? "Start route"
      : `${remainingCount} step${remainingCount === 1 ? "" : "s"} remaining`;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Before you start", sub `Shift <shiftId> · <n> stop(s)`). */}
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <FxCol gap={12} style={{ padding: 16 }}>
          <FxCard theme={theme} soft padding={12}>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="info" size={16} color={theme.muted} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Daily readiness
                </Text>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    lineHeight: 17,
                  }}
                >
                  Cadences set by your hub admin · photos every {cadence.photoCadenceDays}d, cleaning {cadence.cleaningCadenceLabel}.
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>

          {/* External blockers */}
          {externalBlockers.map((b) => {
            const pair = resolveSoftPair(theme, b.severity);
            return (
              <Pressable
                key={b.id}
                onPress={() => props.onOpenBlocker(b)}
                accessibilityRole="button"
                accessibilityLabel={`${b.title} — ${b.sub}. Required. ${b.cta}.`}
              >
                <FxCard theme={theme} padding={14}>
                  <FxRow gap={12} align="center">
                    <View
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 11,
                        backgroundColor: pair.bg,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <FxIcon name={b.icon} size={20} color={pair.fg} stroke={2.2} />
                    </View>
                    <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                      <FxRow justify="space-between" align="center">
                        <Text
                          style={{
                            fontSize: 14,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                            color: theme.ink,
                            fontFamily: MOBILE_V2_FONT_SANS,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {b.title}
                        </Text>
                        <FxChip
                          theme={theme}
                          dense
                          tone={b.severity === "high" ? "danger" : b.severity === "med" ? "warning" : "neutral"}
                        >
                          required
                        </FxChip>
                      </FxRow>
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.muted,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                      >
                        {b.sub}
                      </Text>
                      <FxRow gap={MOBILE_V2_SPACING.md} align="center" style={{ marginTop: MOBILE_V2_SPACING.md }}>
                        <Text
                          style={{
                            fontSize: 11.5,
                            color: theme.accent,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            fontFamily: MOBILE_V2_FONT_SANS,
                          }}
                        >
                          {b.cta}
                        </Text>
                        <FxIcon name="arrow-right" size={14} color={theme.accent} />
                      </FxRow>
                    </FxCol>
                  </FxRow>
                </FxCard>
              </Pressable>
            );
          })}

          {/* Health attestation — inline */}
          {cadence.healthAttestation ? (
            <FxCard theme={theme}>
              <FxRow gap={12} align="flex-start">
                <View
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 11,
                    backgroundColor: theme.successSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon name="shield" size={20} color={theme.success} />
                </View>
                <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Fit-to-drive attestation
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      lineHeight: 18,
                    }}
                  >
                    Confirm: rested, hydrated, no alcohol or medication that affects driving.
                  </Text>
                </FxCol>
              </FxRow>
              <Pressable
                onPress={() => props.onToggleHealth(!healthOk)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: healthOk }}
                accessibilityLabel="I confirm I am fit to drive"
                style={{
                  flexDirection: "row",
                  gap: 10,
                  alignItems: "center",
                  marginTop: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  backgroundColor: healthOk ? theme.successSoft : theme.surfaceAlt,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: healthOk ? theme.success : theme.border,
                }}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    backgroundColor: healthOk ? theme.success : "transparent",
                    borderWidth: 1.5,
                    borderColor: healthOk ? theme.success : theme.border,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {healthOk ? <FxIcon name="check" size={14} color="#FFFFFF" stroke={2.6} /> : null}
                </View>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: healthOk ? theme.success : theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  I confirm I'm fit to drive
                </Text>
              </Pressable>
            </FxCard>
          ) : null}

          {/* Already-OK summary */}
          {allExternalCleared && (!cadence.healthAttestation || healthOk) ? (
            <FxCard
              theme={theme}
              padding={16}
              style={{
                backgroundColor: theme.successSoft,
                borderColor: theme.success,
              }}
            >
              <FxRow gap={12} align="center">
                <FxIcon name="check-double" size={26} color={theme.success} />
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    You're cleared to start
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.success,
                      opacity: 0.85,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Photos fresh · cleaning logged · vehicle ready
                  </Text>
                </FxCol>
              </FxRow>
            </FxCard>
          ) : null}

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
                    Shift start saved
                  </Text>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.success,
                      lineHeight: 17,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Shift saved - {props.latestReadback.state}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.success,
                      opacity: 0.8,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Shift check recorded
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
          variant={canStart ? "success" : "soft"}
          full
          size="lg"
          icon={canStart ? "flag" : "alert"}
          iconRight={canStart ? "arrow-right" : undefined}
          disabled={!canStart}
          onPress={() => canStart && props.onStart()}
          accessibilityLabel={
            props.submitting
              ? "Starting route"
              : ready
                ? "Start route"
                : `${remainingCount} step${remainingCount === 1 ? "" : "s"} remaining`
          }
        >
          {ctaLabel}
        </FxButton>
      </View>
    </View>
  );
}
