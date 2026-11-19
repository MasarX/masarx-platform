// Mobile V2 Wallet screen — pixel-faithful port of design source
// flow-network-extras.jsx ScrWallet. Driver pay + earnings view with
// chrome hero (today balance), 7-day bar chart, today's breakdown,
// and statement download CTA. Row-driven inputs (no hardcoded SAR values
// in the screen — caller supplies wallet, weekBars, breakdown from
// resolve_fieldops_wallet_v1).

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2WalletBalance {
  readonly balanceSar: number;
  readonly weekToDateSar: number;
  readonly postsToBankLabel: string;
}

export interface MobileV2WalletWeekBar {
  /**
   * Short day label fallback (Sat/Sun/Mon/…) used when locale isn't
   * provided or when Intl.DateTimeFormat is unavailable on the runtime.
   */
  readonly day: string;
  /**
   * 0..6 weekday index (0=Sun, 1=Mon, …, 6=Sat). When present, the
   * screen renders the day label via Intl.DateTimeFormat(locale,
   * { weekday: "short" }) so Arabic/Urdu locales render localized
   * abbreviations instead of the English fallback.
   */
  readonly weekdayIndex?: number;
  readonly sar: number;
}

export interface MobileV2WalletBreakdownRow {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
  readonly sar: number;
}

export interface MobileV2WalletWithdrawal {
  readonly decisionLogId: string;
  readonly requestId: string;
  readonly state: string;
  readonly amountSar: number;
  readonly requestedAt: string | null;
}

export interface MobileV2WalletScreenProps {
  readonly theme: MobileV2Theme;
  readonly wallet: MobileV2WalletBalance;
  readonly week: ReadonlyArray<MobileV2WalletWeekBar>;
  readonly breakdown: ReadonlyArray<MobileV2WalletBreakdownRow>;
  readonly latestWithdrawal?: MobileV2WalletWithdrawal | null;
  /** Optional BCP-47 locale; controls weekday-label formatting. */
  readonly locale?: string;
  /**
   * ISO currency code. Defaults to "SAR". Per AGENTS.md zero-hardcoding,
   * the currency symbol is resolved via formatMobileV2CurrencyCompact
   * keyed by this code.
   */
  readonly currency?: string;
  /**
   * Currency display mode for in-screen value suffixes.
   *
   * - `"symbol"` (default, legacy contract): uses the symbol resolved by
   *   `formatMobileV2CurrencyCompact` (e.g. SAR → "﷼"). Matches the
   *   row-driven canonical currency rendering used by the route / COD /
   *   today surfaces.
   * - `"code"`: prints the ISO code literal (e.g. "SAR"). Mirrors the
   *   design `ScrWallet` artboard which renders "SAR" plainly alongside
   *   the value rather than the rial sign.
   */
  readonly currencyDisplay?: "symbol" | "code";
  readonly withdrawDisabled?: boolean;
  readonly onWithdrawPress?: () => void;
  readonly onStatementPress?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Resolve a weekday label for the wallet chart. When the row carries a
 * `weekdayIndex` (0=Sun..6=Sat) and Intl.DateTimeFormat is available,
 * format with `{ weekday: "short" }` so Arabic / Urdu / other locales
 * render localized abbreviations. Falls back to the row's literal
 * `day` string otherwise.
 */
export function resolveMobileV2WalletDayLabel(
  bar: MobileV2WalletWeekBar,
  locale: string | undefined,
): string {
  if (bar.weekdayIndex === undefined || locale === undefined) return bar.day;
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return bar.day;
  }
  const idx = ((bar.weekdayIndex % 7) + 7) % 7;
  // 2024-01-07 is a Sunday; offset by idx to land on the target weekday.
  const sundayUtc = new Date(Date.UTC(2024, 0, 7));
  sundayUtc.setUTCDate(sundayUtc.getUTCDate() + idx);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(sundayUtc);
  } catch {
    return bar.day;
  }
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
  paddingHorizontal: MOBILE_V2_SPACING.sm,
};

function formatWalletWithdrawalState(state: string): string {
  const normalized = state.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (normalized.length === 0) return "Requested";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatWalletWithdrawalRequestedAt(value: string | null): string {
  if (value === null) return "Just now";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Just now";
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return new Date(timestamp).toISOString();
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function shortWalletReadbackId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

export function MobileV2WalletScreen(props: MobileV2WalletScreenProps): React.ReactElement {
  const { theme, wallet, week, breakdown } = props;
  const latestWithdrawal = props.latestWithdrawal ?? null;
  const currency = props.currency ?? "SAR";
  const currencyDisplay = props.currencyDisplay ?? "symbol";
  const currencySuffix =
    currencyDisplay === "code"
      ? currency
      : formatMobileV2CurrencyCompact(0, currency).split(" ")[1] ?? currency;
  const formatAmount = (n: number): string =>
    currencyDisplay === "code"
      ? `${n} ${currency}`
      : formatMobileV2CurrencyCompact(n, currency);
  const maxSar = React.useMemo(() => {
    let m = 1;
    for (const w of week) {
      if (w.sar > m) m = w.sar;
    }
    return m;
  }, [week]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          rowGap: 18,
          paddingBottom: 96,
        }}
      >
        {/* Chrome hero — Today balance + Withdraw */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 22,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
            <FxCol gap={MOBILE_V2_SPACING.sm} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.onChrome,
                  opacity: 0.7,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Today
              </Text>
              <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.onChrome,
                    letterSpacing: -1,
                  }}
                >
                  {wallet.balanceSar}
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: theme.onChrome,
                    opacity: 0.6,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {currencySuffix}
                </Text>
              </FxRow>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {wallet.postsToBankLabel} ·{" "}
                {formatAmount(wallet.weekToDateSar)} week to date
              </Text>
            </FxCol>
            <FxButton
              theme={theme}
              variant="primary"
              size="sm"
              icon="arrow-up-right"
              disabled={props.withdrawDisabled}
              onPress={props.onWithdrawPress}
              accessibilityLabel="Withdraw earnings"
            >
              Withdraw
            </FxButton>
          </FxRow>
        </View>

        {/* Latest withdrawal readback */}
        {latestWithdrawal !== null ? (
          <FxCard theme={theme} padding={14}>
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
                    Latest withdrawal requested
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      color: theme.ink,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {formatWalletWithdrawalState(latestWithdrawal.state)}
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
                  {formatAmount(latestWithdrawal.amountSar)}
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
                  Request {shortWalletReadbackId(latestWithdrawal.requestId)}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Decision {shortWalletReadbackId(latestWithdrawal.decisionLogId)}
                </Text>
              </FxRow>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Saved {formatWalletWithdrawalRequestedAt(latestWithdrawal.requestedAt)}
              </Text>
            </FxCol>
          </FxCard>
        ) : null}

        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>This week</Text>
          <FxCard theme={theme} padding={14}>
            <FxRow gap={MOBILE_V2_SPACING.sm} align="flex-end" style={{ height: 80 }}>
              {week.map((d) => {
                const pct = Math.max(4, (d.sar / maxSar) * 100);
                const filled = d.sar > 0;
                const label = resolveMobileV2WalletDayLabel(d, props.locale);
                return (
                  <View
                    key={`${d.weekdayIndex ?? "x"}-${d.day}`}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      justifyContent: "flex-end",
                      height: "100%",
                      rowGap: 4,
                    }}
                  >
                    <View
                      style={{
                        width: "100%",
                        maxWidth: 24,
                        height: `${pct}%`,
                        backgroundColor: filled ? theme.accent : theme.surfaceAlt,
                        borderTopLeftRadius: 4,
                        borderTopRightRadius: 4,
                        minHeight: 4,
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 10,
                        color: theme.muted,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                );
              })}
            </FxRow>
          </FxCard>
        </FxCol>

        {/* Today's breakdown */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Today&apos;s breakdown</Text>
          <FxCard theme={theme} padding={0}>
            {breakdown.map((b, idx) => (
              <FxRow
                key={b.id}
                justify="space-between"
                align="center"
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderBottomColor: theme.border,
                  borderBottomWidth: idx === breakdown.length - 1 ? 0 : 1,
                }}
              >
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {b.label}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {b.meta}
                  </Text>
                </FxCol>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.ink,
                  }}
                >
                  +{b.sar}
                </Text>
              </FxRow>
            ))}
          </FxCard>
        </FxCol>

        {/* Statement CTA — design places an 8px spacer before the button,
            so cancel 10px of the 18px section rowGap. */}
        <FxButton
          theme={theme}
          variant="ghost"
          full
          icon="doc"
          onPress={props.onStatementPress}
          accessibilityLabel="Download statement PDF"
          style={{ marginTop: -10 }}
        >
          Statement · download PDF
        </FxButton>
      </ScrollView>
    </View>
  );
}
