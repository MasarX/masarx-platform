// Mobile V2 COD Ledger screen — pixel-faithful port of design source
// flow-pod.jsx ScrCOD. Driver inspects collected vs expected cash with a
// chrome hero (Collected / Expected / Variance trio), a per-stop ledger
// list keyed by paid/pending state, and a primary "Hand over to cashier"
// CTA. All amounts arrive as props (resolver output); the screen formats
// via formatMobileV2CurrencyCompact so no currency symbol is hardcoded.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxCol, FxRow, FxSectionHead, FxStatusDot } from "./mobile-v2-primitives";
import type { MobileV2CashDropLastDrop } from "./mobile-v2-cash-drop-screen";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2CodStopState = "pending" | "paid";

export interface MobileV2CodLedgerStop {
  readonly id: string;
  /** Sequence number within the route (e.g. "stop 17"). */
  readonly seq: number;
  readonly customer: string;
  /** Amount due in the configured currency. */
  readonly amount: number;
  readonly state: MobileV2CodStopState;
}

export interface MobileV2CodLedgerScreenProps {
  readonly theme: MobileV2Theme;
  /** Cash actually collected so far (sum of paid stops). */
  readonly collected: number;
  /**
   * Total expected for the whole route (sum of every COD stop). Drives
   * the headline "Expected" tile and the subtitle total — this is the
   * driver's end-of-day target.
   */
  readonly expected: number;
  /**
   * Cash *that should have been collected by now* given the stops the
   * driver has completed. Variance is computed against this, not the
   * total `expected`, so the driver sees variance=0 (green) at the
   * start of the day and only sees red when actual collected ≠ what
   * completed stops imply. Defaults to 0 (no completed stops yet).
   * Design canvas equivalent: `state.cod.expected`.
   */
  readonly armedExpected?: number;
  readonly stops: ReadonlyArray<MobileV2CodLedgerStop>;
  readonly lastHandoff?: MobileV2CashDropLastDrop | null;
  /** ISO currency code (defaults to "SAR"). */
  readonly currency?: string;
  readonly onHandOver?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function formatVariance(variance: number): string {
  const sign = variance > 0 ? "+" : "";
  return `${sign}${variance.toLocaleString()}`;
}

function formatHandoffState(state: string): string {
  return state
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatHandoffSubmittedAt(value: string | null | undefined): string {
  if (!value) return "Just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Just now";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortHandoffDecisionId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

export function MobileV2CodLedgerScreen(
  props: MobileV2CodLedgerScreenProps,
): React.ReactElement {
  const { theme, collected, expected, stops } = props;
  const lastHandoff = props.lastHandoff ?? null;
  const currency = props.currency ?? "SAR";
  // Variance compares against the *armed* expected (cash that completed
  // stops imply you should hold), not the route total. At day start the
  // armed value is 0, so variance=0 (green/success) — the driver only
  // sees warning color when actual collected diverges from what their
  // completed stops imply. Matches design canvas ScrCOD semantics.
  const armedExpected = props.armedExpected ?? 0;
  const variance = collected - armedExpected;
  const varianceColor = variance === 0 ? theme.success : theme.warning;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
        }}
      >
        {/* In-body header strip stripped — the gallery / host ScreenShell now
            renders the title ("COD ledger") and subtitle (cash stops count +
            expected total) via FxAppBar. */}

        {/* Chrome hero: Collected / Expected / Variance */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 14,
            padding: 14,
          }}
        >
          <FxRow gap={20} align="flex-start">
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Collected
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.onChrome,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {collected.toLocaleString()}
              </Text>
            </FxCol>
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Expected
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {expected.toLocaleString()}
              </Text>
            </FxCol>
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  fontSize: 10,
                  color: theme.onChrome,
                  opacity: 0.6,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Variance
              </Text>
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: varianceColor,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {formatVariance(variance)}
              </Text>
            </FxCol>
          </FxRow>
        </View>

        {/* Latest backend handoff readback */}
        {lastHandoff !== null ? (
          <FxCard theme={theme} padding={14} style={{ marginTop: MOBILE_V2_SPACING.lg }}>
            <FxCol gap={MOBILE_V2_SPACING.md}>
              <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
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
                    Latest COD handoff saved
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      color: theme.ink,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {formatHandoffState(lastHandoff.state)}
                  </Text>
                </FxCol>
                <Text
                  style={{
                    fontSize: 18,
                    color: theme.ink,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {formatMobileV2CurrencyCompact(lastHandoff.actualSar, currency)}
                </Text>
              </FxRow>
              <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Expected {formatMobileV2CurrencyCompact(lastHandoff.expectedSar, currency)}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: lastHandoff.varianceSar === 0 ? theme.success : theme.warning,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Variance {formatVariance(lastHandoff.varianceSar)}
                </Text>
              </FxRow>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Decision {shortHandoffDecisionId(lastHandoff.decisionLogId)} saved{" "}
                {formatHandoffSubmittedAt(lastHandoff.submittedAt)}
              </Text>
            </FxCol>
          </FxCard>
        ) : null}

        {/* Per-stop ledger — design FxSectionHead carries its own
            "14px 16px 6px" inset (the impl primitive only has a small
            paddingVertical), so apply the design padding locally. */}
        <FxSectionHead
          theme={theme}
          label="Per-stop ledger"
          style={{ paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 }}
        />
        <View
          style={{
            backgroundColor: theme.border,
            borderRadius: 14,
            overflow: "hidden",
            rowGap: 1,
          }}
        >
          {stops.map((s) => {
            const isPaid = s.state === "paid";
            return (
              <View
                key={s.id}
                style={{
                  backgroundColor: theme.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: MOBILE_V2_SPACING.xl,
                }}
              >
                <FxStatusDot theme={theme} kind={isPaid ? "done" : "pending"} />
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {s.customer}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {s.id} · stop {s.seq}
                  </Text>
                </FxCol>
                <Text
                  // Pin the currency run LTR so the strong-RTL rial sign
                  // ﷼ (U+FDFC) cannot flip the amount to symbol-first.
                  // react-native-web forwards `dir` to the DOM node;
                  // RN's TextProps omits it, hence the @ts-expect-error.
                  // @ts-expect-error — `dir` is a valid RN-Web Text prop.
                  dir="ltr"
                  style={{
                    fontSize: 14,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: isPaid ? theme.success : theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {/* Design ScrCOD (flow-pod.jsx:308) renders the per-stop
                      amount as a grouped value + ﷼
                      (`{s.cod.toLocaleString()} ﷼`). */}
                  {formatMobileV2CurrencyCompact(s.amount, currency)}
                </Text>
              </View>
            );
          })}
        </View>

      </ScrollView>
      {/* Primary CTA — pinned footer. The design ScrCOD artboard shows
          the CTA fully visible above the bottom tab bar; an in-scroll
          CTA was being occluded by BottomTabs once the ledger filled
          the frame. Pinning it as a sibling of the ScrollView keeps it
          reachable regardless of ledger length. */}
      <View
        style={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING["5xl"],
          paddingBottom: MOBILE_V2_SPACING["4xl"],
          backgroundColor: theme.bg,
        }}
      >
        <FxButton
          theme={theme}
          variant="success"
          full
          size="lg"
          icon="check-double"
          onPress={props.onHandOver}
          accessibilityLabel="Hand over collected cash to cashier"
        >
          Hand over to cashier
        </FxButton>
      </View>
    </View>
  );
}

/** Helpers exported for tests / preview wiring. */
export function computeMobileV2CodVariance(collected: number, expected: number): number {
  const safeCollected = Number.isFinite(collected) ? collected : 0;
  const safeExpected = Number.isFinite(expected) ? expected : 0;
  return safeCollected - safeExpected;
}
