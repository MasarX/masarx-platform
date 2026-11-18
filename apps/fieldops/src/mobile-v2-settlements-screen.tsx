// Mobile V2 settlement ledger screen. Drivers see the backend-confirmed
// settlement batches they are allowed to read through settlement access policy.

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  FxButton,
  FxCard,
  FxCol,
  FxRow,
  FxSectionHead,
  FxStatusDot,
} from "./mobile-v2-primitives";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2SettlementLedgerRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly scopeType: string;
  readonly status: string;
  readonly expectedAmount: number;
  readonly collectedAmount: number;
  readonly remittedAmount: number;
  readonly varianceAmount: number;
  readonly currency: string;
  readonly windowLabel: string;
  readonly updatedAt: string | null;
}

export interface MobileV2SettlementLedgerSummary {
  readonly count: number;
  readonly expectedAmount: number;
  readonly collectedAmount: number;
  readonly remittedAmount: number;
  readonly varianceAmount: number;
  readonly currency: string;
}

export interface MobileV2SettlementLedgerReadback {
  readonly source: string;
  readonly count: number;
  readonly resolvedAt: string | null;
}

export interface MobileV2SettlementLedgerEnvelope {
  readonly settlements: ReadonlyArray<MobileV2SettlementLedgerRow>;
  readonly summary: MobileV2SettlementLedgerSummary;
  readonly readback: MobileV2SettlementLedgerReadback;
}

export const EMPTY_MOBILE_V2_SETTLEMENT_LEDGER: MobileV2SettlementLedgerEnvelope = Object.freeze({
  settlements: Object.freeze([]),
  summary: Object.freeze({
    count: 0,
    expectedAmount: 0,
    collectedAmount: 0,
    remittedAmount: 0,
    varianceAmount: 0,
    currency: "SAR",
  }),
  readback: Object.freeze({
    source: "resolve_fieldops_settlements_v1",
    count: 0,
    resolvedAt: null,
  }),
});

export interface MobileV2SettlementsScreenProps {
  readonly theme: MobileV2Theme;
  readonly data: MobileV2SettlementLedgerEnvelope;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function statusLabel(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusKind(status: string): "done" | "current" | "pending" | "failed" | "sla" {
  const normalized = status.trim().toLowerCase();
  if (normalized === "posted" || normalized === "approved") return "done";
  if (normalized === "locked") return "current";
  if (normalized === "canceled" || normalized === "rejected" || normalized === "failed") {
    return "failed";
  }
  return "pending";
}

function formatUpdatedAt(value: string | null): string {
  if (value === null || value.trim().length === 0) return "Update pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Update pending";
  return parsed.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatVariance(value: number, currency: string): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMobileV2CurrencyCompact(value, currency)}`;
}

export function MobileV2SettlementsScreen(
  props: MobileV2SettlementsScreenProps,
): React.ReactElement {
  const { theme, data } = props;
  const currency = data.summary.currency;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING.lg,
        }}
      >
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 14,
            padding: 14,
          }}
        >
          <FxRow gap={18} align="flex-start" wrap>
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  color: theme.onChrome,
                  opacity: 0.65,
                  fontSize: 10,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Expected
              </Text>
              <Text
                style={{
                  color: theme.onChrome,
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {formatMobileV2CurrencyCompact(data.summary.expectedAmount, currency)}
              </Text>
            </FxCol>
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  color: theme.onChrome,
                  opacity: 0.65,
                  fontSize: 10,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Remitted
              </Text>
              <Text
                style={{
                  color: theme.onChrome,
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {formatMobileV2CurrencyCompact(data.summary.remittedAmount, currency)}
              </Text>
            </FxCol>
            <FxCol gap={MOBILE_V2_SPACING.xs}>
              <Text
                style={{
                  color: theme.onChrome,
                  opacity: 0.65,
                  fontSize: 10,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Variance
              </Text>
              <Text
                style={{
                  color: data.summary.varianceAmount === 0 ? theme.success : theme.warning,
                  fontSize: 24,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {formatVariance(data.summary.varianceAmount, currency)}
              </Text>
            </FxCol>
          </FxRow>
        </View>

        <FxCard theme={theme} padding={14} testID="mobile-v2-settlements-readback-card">
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.lg}>
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
                  Settlement update confirmed
                </Text>
                <Text
                  style={{
                    fontSize: 13,
                    color: theme.ink,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Latest status includes {data.readback.count} batch
                  {data.readback.count === 1 ? "" : "es"}
                </Text>
              </FxCol>
              <FxButton
                theme={theme}
                variant="ghost"
                size="sm"
                icon="refresh"
                disabled={props.refreshing === true}
                onPress={props.onRefresh}
                accessibilityLabel="Refresh settlement status"
              >
                Refresh
              </FxButton>
            </FxRow>
            <Text
              style={{
                fontSize: 11,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Last resolved {formatUpdatedAt(data.readback.resolvedAt)}
            </Text>
          </FxCol>
        </FxCard>

        <FxSectionHead theme={theme} label="Settlement batches" />
        {data.settlements.length === 0 ? (
          <FxCard theme={theme} soft padding={16}>
            <FxCol gap={MOBILE_V2_SPACING.sm}>
              <Text
                style={{
                  color: theme.ink,
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                No settlement batches
              </Text>
              <Text
                style={{
                  color: theme.muted,
                  fontSize: 12,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Settlement status is live. New driver settlement batches appear here
                when policy makes them visible to this Mobile V2 user.
              </Text>
            </FxCol>
          </FxCard>
        ) : (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            {data.settlements.map((row) => (
              <FxCard key={row.id} theme={theme} padding={14}>
                <FxCol gap={MOBILE_V2_SPACING.md}>
                  <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
                    <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          color: theme.ink,
                          fontSize: 14,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={2}
                      >
                        {row.title}
                      </Text>
                      <Text
                        style={{
                          color: theme.muted,
                          fontSize: 11,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                        numberOfLines={1}
                      >
                        {row.kind} / {row.scopeType} / {row.windowLabel}
                      </Text>
                    </FxCol>
                    <FxRow gap={MOBILE_V2_SPACING.sm} align="center">
                      <FxStatusDot theme={theme} kind={statusKind(row.status)} />
                      <Text
                        style={{
                          color: theme.muted,
                          fontSize: 11,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          fontFamily: MOBILE_V2_FONT_SANS,
                        }}
                      >
                        {statusLabel(row.status)}
                      </Text>
                    </FxRow>
                  </FxRow>
                  <FxRow justify="space-between" gap={MOBILE_V2_SPACING.lg} wrap>
                    <AmountColumn theme={theme} label="Expected" value={row.expectedAmount} currency={row.currency} />
                    <AmountColumn theme={theme} label="Collected" value={row.collectedAmount} currency={row.currency} />
                    <AmountColumn theme={theme} label="Remitted" value={row.remittedAmount} currency={row.currency} />
                    <AmountColumn
                      theme={theme}
                      label="Variance"
                      value={row.varianceAmount}
                      currency={row.currency}
                      tone={row.varianceAmount === 0 ? "success" : "warning"}
                      signed
                    />
                  </FxRow>
                  <Text
                    style={{
                      color: theme.muted,
                      fontSize: 11,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Settlement batch {row.id.slice(0, 8)} updated {formatUpdatedAt(row.updatedAt)}
                  </Text>
                </FxCol>
              </FxCard>
            ))}
          </FxCol>
        )}
      </ScrollView>
    </View>
  );
}

function AmountColumn(props: {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly value: number;
  readonly currency: string;
  readonly tone?: "success" | "warning";
  readonly signed?: boolean;
}): React.ReactElement {
  const color =
    props.tone === "success"
      ? props.theme.success
      : props.tone === "warning"
        ? props.theme.warning
        : props.theme.ink;
  const value = props.signed === true
    ? formatVariance(props.value, props.currency)
    : formatMobileV2CurrencyCompact(props.value, props.currency);
  return (
    <FxCol gap={MOBILE_V2_SPACING.xs} style={{ minWidth: 96 }}>
      <Text
        style={{
          color: props.theme.muted,
          fontSize: 10,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.label}
      </Text>
      <Text
        style={{
          color,
          fontSize: 14,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          fontFamily: MOBILE_V2_FONT_MONO,
        }}
      >
        {value}
      </Text>
    </FxCol>
  );
}
