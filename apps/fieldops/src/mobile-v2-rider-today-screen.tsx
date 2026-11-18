// Mobile V2 Rider Today screen — pixel-faithful port of design source
// flow-extras.jsx ScrRiderToday. Bike rider home: chrome hero (earnings
// today + trip count + rating + shift duration), active ticket card
// with pickup→drop vertical timeline, navigate + comm action row, and
// "Up next" queue list. All values arrive as props (no synthetic data).

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow, FxSectionHead } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2RiderTicketKind = "food" | "pharmacy" | "parcel";
export type MobileV2RiderTicketStatus = "active" | "queued";

export interface MobileV2RiderTicket {
  readonly id: string;
  readonly kind: MobileV2RiderTicketKind;
  readonly vendor: string;
  readonly pickup: string;
  readonly drop: string;
  readonly payout: number;
  readonly etaMin: number;
  readonly status: MobileV2RiderTicketStatus;
  readonly cod: number;
}

export interface MobileV2RiderTodayScreenProps {
  readonly theme: MobileV2Theme;
  readonly greetingName: string;
  readonly employeeId: string;
  readonly online: boolean;
  readonly earningsToday: number;
  readonly tripsCompleted: number;
  readonly rating: number;
  readonly shiftDuration: string;
  readonly active: MobileV2RiderTicket | null;
  readonly upcoming: ReadonlyArray<MobileV2RiderTicket>;
  /** ISO currency code, defaults to "SAR". */
  readonly currency?: string;
  readonly onNavigatePickup?: () => void;
  readonly onCallVendor?: () => void;
  readonly onMessageVendor?: () => void;
  readonly onPauseQueue?: () => void;
  readonly onSelectUpcoming?: (id: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

// Design `ScrRiderToday` (flow-extras.jsx:932) stacks sections as direct
// siblings inside a single `<div style={{padding:16}}>` with NO inter-section
// gap — all section spacing comes from the design `FxSectionHead`'s own
// `padding:'14px 16px 6px'` (_kit.jsx:367). The impl `FxSectionHead`
// primitive carries only a small symmetric `paddingVertical`, so the screen
// re-applies the full design inset locally and drops the ScrollView rowGap
// (was rowGap:14 + the primitive's pad → cumulative +4/+16/+20/+32 dY drift).
const SECTION_HEAD_INSET = {
  paddingTop: MOBILE_V2_SPACING["3xl"],
  paddingHorizontal: MOBILE_V2_SPACING["4xl"],
  paddingBottom: MOBILE_V2_SPACING.md,
} as const;

function resolveKindIcon(kind: MobileV2RiderTicketKind): MobileV2IconName {
  switch (kind) {
    case "food":
      return "package";
    case "pharmacy":
      return "shield";
    case "parcel":
    default:
      return "box";
  }
}

export function MobileV2RiderTodayScreen(
  props: MobileV2RiderTodayScreenProps,
): React.ReactElement {
  const { theme, active, upcoming } = props;
  const currency = props.currency ?? "SAR";
  // Currency symbol resolved through the centralized formatter (SAR → ﷼)
  // — the canonical FieldOps Mobile V2 design symbol. No per-screen
  // currency-word override; production cutover keeps it row-driven via
  // `mobile_wallet_locale_policy`.
  const currencyLabel = formatMobileV2CurrencyCompact(0, currency).split(" ")[1] ?? currency;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* No rowGap: section spacing is owned by each FxSectionHead's inset
          (SECTION_HEAD_INSET) to mirror the design's sibling-stacked layout
          inside a single `padding:16` container. */}
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          paddingBottom: 96,
        }}
      >
        {/* In-body header strip stripped — the gallery / host ScreenShell now
            renders the title ("Hello, <name>") and subtitle (Bike · employeeId
            · online/offline) via FxAppBar. The online-indicator chip used to
            live here:

              <FxChip
                theme={theme}
                tone={props.online ? "success" : "neutral"}
                icon={props.online ? "check" : "wifi-off"}
                dense
              >
                {props.online ? "Online" : "Offline"}
              </FxChip>

            The host should re-surface that via the AppBar `right` prop. */}

        {/* Earnings chrome hero */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: 14,
            padding: 14,
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={MOBILE_V2_SPACING.xs} style={{ flex: 1, minWidth: 0 }}>
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
                Earnings today
              </Text>
              {/* Single LTR-pinned run: value then currency symbol. A
                  two-Text FxRow whose trailing child is the strong-RTL
                  rial sign ﷼ (U+FDFC) resolves RTL under RN-Web's
                  `dir="auto"` and renders symbol-first. Collapsing to one
                  `dir="ltr"` Text with nested styled spans keeps the
                  design's value-then-symbol order. react-native-web
                  forwards `dir` to the DOM node; RN's TextProps omits it. */}
              <Text
                // @ts-expect-error — `dir` is a valid RN-Web Text prop.
                dir="ltr"
                style={{
                  fontSize: 32,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.onChrome,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  letterSpacing: -0.5,
                }}
              >
                {props.earningsToday}
                <Text
                  style={{
                    fontSize: 14,
                    color: theme.onChrome,
                    opacity: 0.6,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.regular,
                    letterSpacing: 0,
                  }}
                >
                  {`  ${currencyLabel}`}
                </Text>
              </Text>
              <FxRow gap={MOBILE_V2_SPACING.md} style={{ marginTop: MOBILE_V2_SPACING.md }}>
                <FxChip theme={theme} dense mono>
                  {props.tripsCompleted} trips
                </FxChip>
                <FxChip theme={theme} tone="info" dense mono icon="star">
                  {`${props.rating.toFixed(1)}★`}
                </FxChip>
              </FxRow>
            </FxCol>
            <FxCol gap={MOBILE_V2_SPACING.sm} style={{ alignItems: "flex-end" }}>
              <FxIcon name="bike" size={28} color={theme.onChrome} />
              <Text
                style={{
                  fontSize: 11,
                  color: theme.onChrome,
                  opacity: 0.7,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {props.shiftDuration}
              </Text>
            </FxCol>
          </FxRow>
        </View>

        {/* Active ticket — Express chip uses canonical `bolt` icon per
            design canvas s-rider-today (flow-extras.jsx:952). Impl
            previously fell back to `sparkle`; catalog entry for
            `bolt` added 2026-05-13 in `mobile-v2-icon-specs.ts`. */}
        <FxSectionHead
          theme={theme}
          label="Active ticket"
          style={SECTION_HEAD_INSET}
          right={
            <FxChip theme={theme} tone="accent" icon="bolt" dense>
              Express
            </FxChip>
          }
        />
        {active !== null ? (
          <FxCard theme={theme} accent>
            <FxRow justify="space-between" align="flex-start">
              <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 9,
                    color: theme.accent,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {active.id} · {active.kind}
                </Text>
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {active.vendor}
                </Text>
              </FxCol>
              {/* Pin the payout run LTR so the `+` sign and amount stay
                  before the strong-RTL rial sign ﷼ (U+FDFC). Without
                  `dir="ltr"`, "+18 ﷼" resolves RTL and renders
                  symbol-first. react-native-web forwards `dir` to the DOM
                  node; RN's TextProps omits it. */}
              <Text
                // @ts-expect-error — `dir` is a valid RN-Web Text prop.
                dir="ltr"
                style={{
                  fontSize: 18,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.success,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {`+${active.payout} ${currencyLabel}`}
              </Text>
            </FxRow>

            {/* Pickup → drop vertical timeline */}
            <FxRow gap={MOBILE_V2_SPACING["2xl"]} align="flex-start" style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}>
              <FxCol gap={MOBILE_V2_SPACING.sm} style={{ alignItems: "center", paddingTop: 4 }}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: theme.success,
                  }}
                />
                <View
                  style={{
                    width: 2,
                    minHeight: 30,
                    flex: 1,
                    backgroundColor: theme.border,
                  }}
                />
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: theme.danger,
                  }}
                />
              </FxCol>
              <FxCol gap={MOBILE_V2_SPACING["3xl"]} style={{ flex: 1 }}>
                <FxCol gap={2}>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Pickup · 4 min
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {active.pickup}
                  </Text>
                </FxCol>
                <FxCol gap={2}>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.muted,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Drop · {active.etaMin} min total
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {active.drop}
                  </Text>
                  {active.cod > 0 ? (
                    <FxChip theme={theme} tone="accent" dense icon="cash" mono>
                      Collect {formatMobileV2CurrencyCompact(active.cod, currency)}
                    </FxChip>
                  ) : null}
                </FxCol>
              </FxCol>
            </FxRow>

            <FxRow gap={MOBILE_V2_SPACING.md} style={{ marginTop: MOBILE_V2_SPACING["2xl"] }}>
              <FxButton
                theme={theme}
                variant="primary"
                size="md"
                full
                icon="navigate"
                onPress={props.onNavigatePickup}
                accessibilityLabel="Navigate to pickup"
                style={{ flex: 1 }}
              >
                Navigate to pickup
              </FxButton>
              <FxButton
                theme={theme}
                variant="ghost"
                size="md"
                icon="phone"
                onPress={props.onCallVendor}
                accessibilityLabel="Call vendor"
              >
                {""}
              </FxButton>
              <FxButton
                theme={theme}
                variant="ghost"
                size="md"
                icon="message"
                onPress={props.onMessageVendor}
                accessibilityLabel="Message vendor"
              >
                {""}
              </FxButton>
            </FxRow>
          </FxCard>
        ) : (
          <FxCard theme={theme} padding={20}>
            <Text
              style={{
                fontSize: 13,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                textAlign: "center",
              }}
            >
              No active ticket. Stand by — dispatch will assign the next one.
            </Text>
          </FxCard>
        )}

        {/* Up next */}
        <FxSectionHead
          theme={theme}
          label="Up next"
          style={SECTION_HEAD_INSET}
          right={
            <Text
              onPress={props.onPauseQueue}
              suppressHighlighting
              style={{
                fontSize: 11,
                color: theme.accent,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
              accessibilityRole="button"
              accessibilityLabel="Pause queue"
            >
              Pause queue
            </Text>
          }
        />
        <FxCol gap={MOBILE_V2_SPACING.md}>
          {upcoming.map((tk) => (
            <View
              key={tk.id}
              style={{
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: 12,
                paddingVertical: MOBILE_V2_SPACING.xl,
                paddingHorizontal: MOBILE_V2_SPACING["2xl"],
              }}
            >
              <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    backgroundColor: theme.accentSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon name={resolveKindIcon(tk.kind)} size={13} color={theme.accent} />
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 12.5,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                    numberOfLines={1}
                  >
                    {tk.vendor}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                    numberOfLines={1}
                  >
                    {tk.pickup} → {tk.drop}
                  </Text>
                </FxCol>
                <FxCol gap={2} style={{ alignItems: "flex-end" }}>
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    +{tk.payout}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    ~{tk.etaMin}m
                  </Text>
                </FxCol>
              </FxRow>
            </View>
          ))}
        </FxCol>
      </ScrollView>
    </View>
  );
}
