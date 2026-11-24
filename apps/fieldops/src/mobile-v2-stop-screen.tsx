// Mobile V2 Stop detail screen — single delivery / pickup stop view.
// Source: design bundle screens/flow-route.jsx ScrStopDetail. Renders
// hero (avatar + name + tracking) + ETA/distance/window stat strip +
// address card + parcel scan list + proof checklist + event timeline
// + sticky action footer.
//
// All variant text + behavior comes from the typed Stop input (see
// MobileV2StopDetail). No hardcoded customer / address / chip text in
// the renderer; it's a pure function of theme + stop.

import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, G, Path, Pattern, Rect, Text as SvgText } from "react-native-svg";

import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  FxAvatar,
  FxButton,
  FxCard,
  FxChip,
  FxCol,
  FxRow,
  FxSectionHead,
  FxStickyAction,
} from "./mobile-v2-primitives";
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
import {
  countMobileV2ResolvedScannedParcels,
  resolveMobileV2StopParcelStatus,
} from "./mobile-v2-stop-parcel-status";
import type { MobileV2StopLocationReadback } from "./mobile-v2-route-map-location";

export type MobileV2StopChipTone =
  | "neutral"
  | "accent"
  | "warning"
  | "danger"
  | "success"
  | "info";

export interface MobileV2StopHazardChip {
  readonly label: string;
  readonly tone: MobileV2StopChipTone;
  readonly icon?: "alert" | "shield" | "info" | "flame" | "wifi-off";
}

export interface MobileV2StopParcel {
  readonly id: string;
  readonly code: string;
  readonly status: "pending" | "scanned" | "missing" | "damaged";
  /**
   * Optional human-readable description / service-class line, e.g.
   * "Standard · ~1.2 kg". Renders as a muted sub-line beneath the parcel
   * code. Aligned to design canvas ScrStopDetail parcel rows.
   */
  readonly description?: string;
}

export interface MobileV2StopProofCheckpoint {
  readonly key: string;
  readonly label: string;
  readonly status: "pending" | "done";
}

export interface MobileV2StopTimelineEntry {
  readonly id: string;
  readonly label: string;
  readonly time: string; // formatted
  readonly tone?: MobileV2StopChipTone;
  readonly icon?: "phone" | "message" | "whatsapp" | "navigate" | "alert" | "check" | "scan";
}

export interface MobileV2StopPaymentCollection {
  readonly outcome: string | null;
  readonly method: string | null;
  readonly expectedAmount: number;
  readonly collectedAmount: number | null;
  readonly tenderedAmount: number | null;
  readonly changeDueAmount: number | null;
  readonly currency: string;
  readonly source: string;
  readonly shipmentActionId?: string | null;
}

export interface MobileV2StopDetail {
  readonly id: string;
  /** 1-based stop number in the route. Surfaces in the mini-map disk. */
  readonly seq?: number;
  readonly customerInitials: string;
  readonly customerName: string;
  readonly customerPhone?: string;
  readonly trackingCode: string;
  readonly stopType: "delivery" | "pickup" | "rto";
  readonly hazards: ReadonlyArray<MobileV2StopHazardChip>;
  readonly etaMinutes: number;
  readonly distanceKm: number;
  readonly window: string;
  readonly addressLines: ReadonlyArray<string>;
  readonly addressNote?: string;
  readonly parcels: ReadonlyArray<MobileV2StopParcel>;
  /**
   * Optional total-weight summary rendered in the Parcels section
   * header right side, e.g. "2× · 2.1 kg". Aligned to design canvas
   * ScrStopDetail. When omitted, the header renders count-only.
   */
  readonly parcelsTotalLabel?: string;
  readonly proofChecklist: ReadonlyArray<MobileV2StopProofCheckpoint>;
  readonly timeline: ReadonlyArray<MobileV2StopTimelineEntry>;
  readonly cod?: { readonly amount: number; readonly currency: string };
  readonly paymentCollection?: MobileV2StopPaymentCollection | null;
}

export interface MobileV2StopScreenProps {
  readonly theme: MobileV2Theme;
  readonly stop: MobileV2StopDetail;
  readonly locationReadback?: MobileV2StopLocationReadback | null;
  readonly terminalState?: "done" | "failed" | "partial" | null;
  readonly intentReadback?: {
    readonly status: string;
    readonly eventType: string | null;
    readonly eventCount: number;
  } | null;
  readonly onCall?: () => void;
  readonly onWhatsApp?: () => void;
  readonly onNavigate?: () => void;
  readonly onCopyAddress?: () => void;
  readonly onShareAddress?: () => void;
  readonly onScanParcel?: () => void;
  /** Tap a parcel to open its detail. Parcel status renders only from the stop read-back. */
  readonly onParcelPress?: (parcelId: string) => void;
  /** Open the damaged-parcel hold sheet for this stop. */
  readonly onDamageHold?: () => void;
  /** Open the delivery reschedule sheet for this stop. */
  readonly onReschedule?: () => void;
  /** Tap a proof checklist item to open proof capture. Done state renders only from the stop read-back. */
  readonly onProofPress?: (key: string) => void;
  readonly onPodSubmit?: () => void;
  readonly onFail?: () => void;
}

function chipToneToTokens(theme: MobileV2Theme, tone: MobileV2StopChipTone): {
  readonly bg: string;
  readonly fg: string;
  readonly border: string;
} {
  switch (tone) {
    case "accent":
      return { bg: theme.accentSoft, fg: theme.accent, border: theme.accent };
    case "warning":
      return { bg: theme.warningSoft, fg: theme.warning, border: theme.warning };
    case "danger":
      return { bg: theme.dangerSoft, fg: theme.danger, border: theme.danger };
    case "success":
      return { bg: theme.successSoft, fg: theme.success, border: theme.success };
    case "info":
      return { bg: theme.infoSoft, fg: theme.info, border: theme.info };
    case "neutral":
    default:
      return { bg: theme.surfaceAlt, fg: theme.inkSoft, border: theme.border };
  }
}

/**
 * Proof-type glyph for a "Required proof" checklist row. Mirrors the
 * design ScrStopDetail proof config (`flow-route.jsx:402`):
 * `photo→camera, sig→sig, otp→shield, id→id, cod→cash`. `scan` is the
 * impl's parcel-scan checkpoint (design `proofReq` never includes it).
 * Any unknown key degrades to a neutral `shield` glyph so the row still
 * renders a sensible icon disk.
 */
function resolveProofIcon(key: string): MobileV2IconName {
  switch (key) {
    case "photo":
      return "camera";
    case "sig":
      return "sig";
    case "otp":
      return "shield";
    case "id":
      return "id";
    case "cod":
      return "cash";
    case "scan":
      return "scan";
    default:
      return "shield";
  }
}

function formatPaymentMethod(value: string | null): string {
  if (!value) return "Payment method pending";
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Stylized mini-map for the address card header. Pixel-faithful port of
 * the design canvas `FxMap mini` SVG (see _kit.jsx): grid background +
 * two thick road strokes + a dashed route line ending in a labelled
 * stop disk. Pure render — no real geocoding, no per-tenant branching.
 * The label number comes from props so the visible stop sequence stays
 * synced with whatever stop is shown above.
 */
function StopAddressMiniMap({
  theme,
  stopSeq,
}: {
  readonly theme: MobileV2Theme;
  readonly stopSeq: number;
}): React.ReactElement {
  const stroke = theme.border;
  return (
    <Svg viewBox="0 0 380 200" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
      <Defs>
        <Pattern id="gridmini" width="32" height="32" patternUnits="userSpaceOnUse">
          <Path d="M32 0H0V32" fill="none" stroke={stroke} strokeWidth={0.5} opacity={0.5} />
        </Pattern>
      </Defs>
      <Rect width={380} height={200} fill="url(#gridmini)" />
      <Path d="M0 70 Q 120 60 380 130" stroke={stroke} strokeWidth={12} fill="none" opacity={0.7} />
      <Path d="M0 70 Q 120 60 380 130" stroke={theme.surface} strokeWidth={8} fill="none" />
      <Path d="M40 0 Q 80 100 200 160 Q 300 200 380 180" stroke={stroke} strokeWidth={9} fill="none" opacity={0.6} />
      <Path d="M40 0 Q 80 100 200 160 Q 300 200 380 180" stroke={theme.surface} strokeWidth={5} fill="none" />
      <Path
        d="M260 30 Q 200 90 190 150"
        stroke={theme.mapRoute}
        strokeWidth={3.5}
        fill="none"
        strokeDasharray="6 4"
        strokeLinecap="round"
      />
      <Circle cx={260} cy={30} r={20} fill={theme.accent} opacity={0.18} />
      <Circle cx={260} cy={30} r={6} fill={theme.accent} />
      <G>
        <Circle cx={190} cy={150} r={12} fill={theme.surface} stroke={theme.mapRoute} strokeWidth={2.5} />
        <SvgText
          x={190}
          y={155}
          textAnchor="middle"
          fontSize={11}
          fontWeight="700"
          fill={theme.ink}
          fontFamily={MOBILE_V2_FONT_MONO}
        >
          {stopSeq}
        </SvgText>
      </G>
    </Svg>
  );
}

/**
 * ETA / Distance / Window stat tile — local port of the design SSOT
 * `FxStat` (flow-route.jsx lines 461-473, used by ScrStopDetail's
 * summary strip). The design renders each metric as its own bordered
 * surface (radius 12, `10px 12px` padding) with an 18px tinted icon
 * box (10px glyph) + 9px caps label on a row above a 16px bold mono
 * value. Earlier impl wrapped `FxMetric` (label + 22px value, no icon)
 * in an `FxCard`, which produced a different layout and a ~22px
 * horizontal drift on every label. Kept local to this screen file per
 * scope — not promoted to the shared kit.
 */
type StopStatTone = "accent" | "warning" | "info" | "success" | "muted";

function StopStat({
  theme,
  label,
  value,
  icon,
  tone = "muted",
}: {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly value: string;
  readonly icon: "clock" | "route" | "calendar";
  readonly tone?: StopStatTone;
}): React.ReactElement {
  const toneMap: Record<StopStatTone, { readonly fg: string; readonly bg: string }> = {
    accent: { fg: theme.accent, bg: theme.accentSoft },
    warning: { fg: theme.warning, bg: theme.warningSoft },
    info: { fg: theme.info, bg: theme.infoSoft },
    success: { fg: theme.success, bg: theme.successSoft },
    muted: { fg: theme.muted, bg: theme.surfaceAlt },
  };
  const t = toneMap[tone];
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        borderWidth: 1,
        // design FxStat uses borderRadius:12 (== RADII.button), not the
        // 14px card radius.
        borderRadius: MOBILE_V2_RADII.button,
        // design FxStat padding:'10px 12px' → xl vertical, 2xl horizontal.
        paddingVertical: MOBILE_V2_SPACING.xl,
        paddingHorizontal: MOBILE_V2_SPACING["2xl"],
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          columnGap: MOBILE_V2_SPACING.md,
          // design FxStat icon-row marginBottom:4.
          marginBottom: MOBILE_V2_SPACING.sm,
        }}
      >
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 6,
            backgroundColor: t.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name={icon} size={10} color={t.fg} />
        </View>
        <Text
          style={{
            fontSize: 9,
            color: theme.muted,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {label}
        </Text>
      </View>
      <Text
        style={{
          fontSize: MOBILE_V2_TYPE_SIZES.metricInline,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          fontFamily: MOBILE_V2_FONT_MONO,
          color: t.fg,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function MobileV2StopScreen(props: MobileV2StopScreenProps): React.ReactElement {
  const { theme, stop } = props;
  const locationReadback = props.locationReadback ?? null;
  const terminalState = props.terminalState ?? null;
  const isTerminal = terminalState !== null;
  const backendCustomerPhone =
    typeof stop.customerPhone === "string" && stop.customerPhone.trim().length > 0
      ? stop.customerPhone.trim()
      : null;
  const sansSemibold = {
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  } as const;
  const monoBold = {
    fontFamily: MOBILE_V2_FONT_MONO,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  } as const;

  const podDoneCount = stop.proofChecklist.filter((c) => c.status === "done").length;
  const parcelDoneCount = countMobileV2ResolvedScannedParcels(stop.parcels, stop.proofChecklist);
  const paymentCollection = stop.paymentCollection ?? null;
  const terminalCopy =
    terminalState === "done"
      ? { label: "Delivery completed", icon: "check" as const, tone: "success" as const }
      : terminalState === "failed"
        ? { label: "Delivery failed", icon: "alert" as const, tone: "danger" as const }
        : terminalState === "partial"
          ? { label: "Partial delivery recorded", icon: "alert" as const, tone: "warning" as const }
          : null;
  const resolveParcelStatus = (parcel: MobileV2StopParcel): MobileV2StopParcel["status"] =>
    resolveMobileV2StopParcelStatus(parcel, stop.proofChecklist, stop.parcels);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING.xl,
          paddingBottom: 120,
        }}
      >
        {/* Hero — design canvas ScrStopDetail uses:
             - Avatar (48px) + center column with `STOP X · STP-XXX`
               chip-row in 9px caps above the customer name (17px),
               plus phone in 12px mono below.
             - Right column = two stacked 38x38 soft-tinted square
               buttons (phone in successSoft / whatsapp in infoSoft).
             Earlier impl used 52px avatar + horizontal pill buttons
             which read as a different visual hierarchy. */}
        <FxCard theme={theme} accent>
          <FxCol gap={MOBILE_V2_SPACING["2xl"]}>
            <FxRow gap={MOBILE_V2_SPACING.xl} align="flex-start">
              <FxAvatar theme={theme} name={stop.customerName} tone="accent" size={48} />
              <View style={{ flex: 1 }}>
                {stop.seq !== undefined ? (
                  <FxRow gap={MOBILE_V2_SPACING.md} align="center">
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
                      Stop {stop.seq}
                    </Text>
                    <Text
                      style={{
                        fontSize: 9,
                        color: theme.muted,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      }}
                    >
                      ·
                    </Text>
                    <Text
                      style={{
                        fontSize: 9,
                        color: theme.muted,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {stop.id}
                    </Text>
                  </FxRow>
                ) : null}
                <Text
                  style={{
                    ...sansSemibold,
                    color: theme.ink,
                    fontSize: 17,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    lineHeight: 20,
                    marginTop: stop.seq !== undefined ? 2 : 0,
                  }}
                >
                  {stop.customerName}
                </Text>
                {backendCustomerPhone !== null ? (
                  <Text
                    style={{
                      fontFamily: MOBILE_V2_FONT_MONO,
                      color: theme.muted,
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  >
                    {backendCustomerPhone}
                  </Text>
                ) : null}
              </View>
              {backendCustomerPhone !== null ? (
                <View style={{ flexDirection: "column", rowGap: MOBILE_V2_SPACING.sm, alignItems: "flex-end" }}>
                  <Pressable
                    onPress={props.onCall}
                    accessibilityRole="button"
                    accessibilityLabel="Call"
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 11,
                      backgroundColor: theme.successSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name="phone" size={16} color={theme.success} />
                  </Pressable>
                  <Pressable
                    onPress={props.onWhatsApp}
                    accessibilityRole="button"
                    accessibilityLabel="WhatsApp"
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 11,
                      backgroundColor: theme.infoSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name="whatsapp" size={16} color={theme.info} />
                  </Pressable>
                </View>
              ) : null}
            </FxRow>

            {stop.hazards.length > 0 ? (
              <FxRow gap={MOBILE_V2_SPACING.md} wrap>
                {stop.hazards.map((h) => {
                  const tokens = chipToneToTokens(theme, h.tone);
                  return (
                    <View
                      key={h.label}
                      style={{
                        backgroundColor: tokens.bg,
                        borderColor: tokens.border,
                        borderWidth: 1,
                        borderRadius: 999,
                        paddingHorizontal: MOBILE_V2_SPACING.lg,
                        paddingVertical: MOBILE_V2_SPACING.xs,
                        flexDirection: "row",
                        alignItems: "center",
                        columnGap: MOBILE_V2_SPACING.sm,
                      }}
                    >
                      {h.icon !== undefined ? <FxIcon name={h.icon} size={12} color={tokens.fg} /> : null}
                      <Text
                        style={{
                          color: tokens.fg,
                          fontFamily: MOBILE_V2_FONT_SANS,
                          fontSize: MOBILE_V2_TYPE_SIZES.chip,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
                        }}
                      >
                        {h.label}
                      </Text>
                    </View>
                  );
                })}
              </FxRow>
            ) : null}
          </FxCol>
        </FxCard>

        {props.intentReadback ? (
          <FxCard theme={theme}>
            <Text
              style={{
                ...sansSemibold,
                color: props.intentReadback.status === "synced" ? theme.success : theme.warning,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
              }}
            >
              Action logged: {props.intentReadback.status.replace(/_/g, " ")} -{" "}
              {props.intentReadback.eventCount} update
              {props.intentReadback.eventCount === 1 ? "" : "s"}
            </Text>
          </FxCard>
        ) : null}

        {/* Stat strip — 3 discrete stat tiles per design SSOT
            ScrStopDetail (flow-route.jsx lines 360-364): each metric
            is its own bordered surface built by `FxStat` (icon box +
            caps label + 16px mono value), not an `FxMetric` inside an
            `FxCard`. COD intentionally not rendered here; it surfaces
            above in the hazard ribbon as "Collect X ﷼" so the driver
            sees a single canonical COD affordance. Tone mirrors the
            design: ETA = warning when running late into the morning
            window (etaMin>0 && window<'12:00') else accent; Distance
            and Window stay muted. ETA value: "0 min" reads as "now".
            Distance value is a single "<n> km" string (design renders
            the unit inline, not as a split run). */}
        <FxRow gap={MOBILE_V2_SPACING.lg}>
          <StopStat
            theme={theme}
            label="ETA"
            value={stop.etaMinutes > 0 ? `+${stop.etaMinutes}m` : "now"}
            icon="clock"
            tone={stop.etaMinutes > 0 && stop.window < "12:00" ? "warning" : "accent"}
          />
          <StopStat
            theme={theme}
            label="Distance"
            value={`${stop.distanceKm.toFixed(1)} km`}
            icon="route"
            tone="muted"
          />
          <StopStat theme={theme} label="Window" value={stop.window} icon="calendar" tone="muted" />
        </FxRow>

        {/* Address card — design canvas ScrStopDetail puts a 120px
            stylized mini-map at the top with a route line ending at the
            current stop disk, fading into the card surface via a
            bottom-aligned gradient. Address + buttons render below
            inside padding. We render the full card with padding={0} and
            handle inner padding manually so the map is full-bleed
            inside the rounded card edge. */}
        <FxCard theme={theme} padding={0} style={{ overflow: "hidden" } as never}>
          <View
            style={{
              height: 120,
              backgroundColor: theme.mapBg,
              borderTopLeftRadius: MOBILE_V2_RADII.card,
              borderTopRightRadius: MOBILE_V2_RADII.card,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <StopAddressMiniMap theme={theme} stopSeq={stop.seq ?? 1} />
            {/* Gradient overlay: in RN web this needs an explicit gradient
                layer; for now we fake the fade with a faded surface band
                at the bottom 30px so the address text reads cleanly. */}
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 40,
                backgroundColor: theme.surface,
                opacity: 0.45,
              }}
            />
          </View>
          <FxCol
            gap={MOBILE_V2_SPACING.lg}
            style={{
              paddingTop: MOBILE_V2_SPACING.xl,
              paddingHorizontal: MOBILE_V2_SPACING["3xl"],
              paddingBottom: MOBILE_V2_SPACING["3xl"],
            }}
          >
            {/* U-r: design ScrStopDetail (flow-route.jsx:373) renders the
                address as plain text in the card — no leading pin icon. */}
            <View>
              {stop.addressLines.map((line, idx) => (
                <Text
                  key={idx}
                  style={{
                    color: idx === 0 ? theme.ink : theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: idx === 0 ? MOBILE_V2_TYPE_WEIGHTS.semibold : MOBILE_V2_TYPE_WEIGHTS.medium,
                  }}
                >
                  {line}
                </Text>
              ))}
              {/* Address note — design ScrStopDetail (flow-route.jsx:374)
                  renders this inside a boxed note: surfaceAlt fill,
                  borderRadius 8, 8px/10px padding, leading `info` icon. */}
              {stop.addressNote !== undefined ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    columnGap: MOBILE_V2_SPACING.md,
                    marginTop: MOBILE_V2_SPACING.md,
                    paddingVertical: MOBILE_V2_SPACING.lg,
                    paddingHorizontal: MOBILE_V2_SPACING.xl,
                    backgroundColor: theme.surfaceAlt,
                    borderRadius: 8,
                  }}
                >
                  <FxIcon name="info" size={12} color={theme.muted} />
                  <Text
                    style={{
                      flex: 1,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      fontSize: MOBILE_V2_TYPE_SIZES.caption,
                    }}
                  >
                    {stop.addressNote}
                  </Text>
                </View>
              ) : null}
              {locationReadback !== null ? (
                <View
                  style={{
                    marginTop: MOBILE_V2_SPACING.md,
                    paddingVertical: MOBILE_V2_SPACING.lg,
                    paddingHorizontal: MOBILE_V2_SPACING.xl,
                    backgroundColor: theme.infoSoft,
                    borderColor: theme.info,
                    borderWidth: 1,
                    borderRadius: 8,
                    rowGap: MOBILE_V2_SPACING.sm,
                  }}
                  accessibilityLabel="Stop location details"
                >
                  <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                    <FxIcon name="pin" size={12} color={theme.info} />
                    <Text
                      style={{
                        color: theme.info,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        fontSize: 10,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                      }}
                    >
                      Verified location
                    </Text>
                  </FxRow>
                  {locationReadback.shortAddress !== null ? (
                    <Text
                      style={{
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_MONO,
                        fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      }}
                    >
                      {locationReadback.shortAddress}
                    </Text>
                  ) : null}
                  {locationReadback.coordinateLine !== null ? (
                    <Text
                      style={{
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_MONO,
                        fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      }}
                    >
                      {locationReadback.coordinateLine}
                    </Text>
                  ) : null}
                  {locationReadback.geocodeLine !== null ? (
                    <Text
                      style={{
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                        fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      }}
                    >
                      {locationReadback.geocodeLine}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
            {/* Address action row — design SSOT `flow-route.jsx` ScrStopDetail
                lines 376-378 renders all three as `variant="ghost"` size="sm".
                Earlier impl had Navigate filled yellow (primary) which drifted
                the visual hierarchy: the design intentionally keeps these
                three as equal-emphasis ghost affordances and reserves the
                primary CTA for the bottom "Start delivery" button. */}
            <FxRow gap={MOBILE_V2_SPACING.md}>
              <FxButton theme={theme} variant="ghost" icon="navigate" size="sm" onPress={props.onNavigate}>
                Navigate
              </FxButton>
              <FxButton theme={theme} variant="ghost" icon="copy" size="sm" onPress={props.onCopyAddress}>
                Copy
              </FxButton>
              <FxButton theme={theme} variant="ghost" icon="share" size="sm" onPress={props.onShareAddress}>
                Share
              </FxButton>
            </FxRow>
          </FxCol>
        </FxCard>

        {/* Parcels — section header right side prefers a total-weight
            label per design canvas ScrStopDetail ("2× · 2.1 kg") when
            provided by the caller; falls back to the legacy
            "done/total" counter otherwise. Pending parcels show the
            design canvas "scan to verify" affordance instead of a raw
            status word so the row reads as a call-to-action. */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxSectionHead
            theme={theme}
            label="Parcels"
            right={
              <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
                <Text
                  style={{
                    fontFamily: MOBILE_V2_FONT_MONO,
                    color: theme.muted,
                    fontSize: 11,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  }}
                >
                  {stop.parcelsTotalLabel ?? `${parcelDoneCount}/${stop.parcels.length}`}
                </Text>
                <Pressable
                  onPress={isTerminal ? undefined : props.onScanParcel}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isTerminal }}
                  disabled={isTerminal}
                >
                  <FxIcon name="scan" size={18} color={theme.accent} />
                </Pressable>
              </FxRow>
            }
          />
          <FxCol gap={MOBILE_V2_SPACING.md}>
            {stop.parcels.map((p) => (
              <Pressable
                key={p.id}
                onPress={
                  !isTerminal && props.onParcelPress !== undefined
                    ? () => props.onParcelPress!(p.id)
                    : undefined
                }
                accessibilityRole="button"
                accessibilityLabel={`Parcel ${p.code} ${resolveParcelStatus(p)}`}
                accessibilityState={{ disabled: isTerminal }}
                disabled={isTerminal}
                style={{
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: MOBILE_V2_RADII.tile,
                  paddingVertical: MOBILE_V2_SPACING.xl,
                  paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: MOBILE_V2_SPACING.xl,
                }}
              >
                {/* Parcel-row leading element — design ScrStopDetail
                    (flow-route.jsx:388) uses a 28×28 surfaceAlt rounded
                    tile holding a `package` glyph, not a status dot. */}
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    backgroundColor: resolveParcelStatus(p) === "scanned" ? theme.successSoft : theme.surfaceAlt,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FxIcon
                    name={resolveParcelStatus(p) === "scanned" ? "check" : "package"}
                    size={14}
                    color={resolveParcelStatus(p) === "scanned" ? theme.success : theme.muted}
                  />
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ ...monoBold, color: theme.ink, fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong }}>
                    {p.code}
                  </Text>
                  {p.description !== undefined ? (
                    <Text
                      style={{
                        fontFamily: MOBILE_V2_FONT_SANS,
                        color: theme.muted,
                        fontSize: 11,
                      }}
                    >
                      {p.description}
                    </Text>
                  ) : null}
                </FxCol>
                <FxChip
                  theme={theme}
                  tone={
                    resolveParcelStatus(p) === "scanned"
                      ? "success"
                      : resolveParcelStatus(p) === "missing"
                        ? "danger"
                        : resolveParcelStatus(p) === "damaged"
                          ? "warning"
                          : "info"
                  }
                  dense
                >
                  {resolveParcelStatus(p) === "pending" ? "scan to verify" : resolveParcelStatus(p)}
                </FxChip>
              </Pressable>
            ))}
          </FxCol>
          {props.onDamageHold !== undefined ? (
            <FxButton
              theme={theme}
              variant="outline-danger"
              icon="alert"
              size="md"
              full
              disabled={isTerminal || stop.parcels.length === 0}
              onPress={isTerminal ? undefined : props.onDamageHold}
              accessibilityLabel="Report damaged parcel"
            >
              Report damaged parcel
            </FxButton>
          ) : null}
          {props.onReschedule !== undefined ? (
            <FxButton
              theme={theme}
              variant="outline-accent"
              icon="calendar"
              size="md"
              full
              disabled={isTerminal}
              onPress={isTerminal ? undefined : props.onReschedule}
              accessibilityLabel="Reschedule delivery"
            >
              Reschedule delivery
            </FxButton>
          ) : null}
        </FxCol>

        {paymentCollection !== null ? (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <FxSectionHead theme={theme} label="COD collection" />
            <FxCard theme={theme} padding={14}>
              <FxCol gap={MOBILE_V2_SPACING.md}>
                <FxRow justify="space-between" align="flex-start" gap={MOBILE_V2_SPACING.lg}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        ...sansSemibold,
                        color: theme.ink,
                        fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                      }}
                    >
                      {paymentCollection.outcome === "collected"
                        ? "Collection confirmed"
                        : "Collection pending"}
                    </Text>
                    <Text
                      style={{
                        color: theme.muted,
                        fontSize: MOBILE_V2_TYPE_SIZES.caption,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {formatPaymentMethod(paymentCollection.method)} · {paymentCollection.source}
                    </Text>
                  </View>
                  <FxChip
                    theme={theme}
                    tone={paymentCollection.outcome === "collected" ? "success" : "warning"}
                    dense
                  >
                    {paymentCollection.outcome === "collected" ? "collected" : "pending"}
                  </FxChip>
                </FxRow>
                <FxRow gap={MOBILE_V2_SPACING.md} align="stretch">
                  <StopStat
                    theme={theme}
                    label="Expected"
                    value={`${paymentCollection.expectedAmount.toLocaleString()} ${paymentCollection.currency}`}
                    icon="calendar"
                    tone="muted"
                  />
                  <StopStat
                    theme={theme}
                    label="Collected"
                    value={`${(paymentCollection.collectedAmount ?? 0).toLocaleString()} ${paymentCollection.currency}`}
                    icon="clock"
                    tone={paymentCollection.outcome === "collected" ? "success" : "warning"}
                  />
                </FxRow>
                {paymentCollection.tenderedAmount !== null || paymentCollection.changeDueAmount !== null ? (
                  <Text
                    style={{
                      color: theme.muted,
                      fontSize: MOBILE_V2_TYPE_SIZES.caption,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Tendered {(paymentCollection.tenderedAmount ?? paymentCollection.collectedAmount ?? 0).toLocaleString()} {paymentCollection.currency}
                    {" · "}
                    Change {(paymentCollection.changeDueAmount ?? 0).toLocaleString()} {paymentCollection.currency}
                  </Text>
                ) : null}
              </FxCol>
            </FxCard>
          </FxCol>
        ) : null}

        {/* Proof checklist */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <FxSectionHead
            theme={theme}
            label="Required proof"
            right={
              <Text
                style={{
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.muted,
                  fontSize: 11,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {`${podDoneCount}/${stop.proofChecklist.length}`}
              </Text>
            }
          />
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            {stop.proofChecklist.map((c) => {
              const done = c.status === "done";
              // Proof-type glyph per checkpoint key — design ScrStopDetail
              // `flow-route.jsx:402` (`photo→camera, sig→sig, otp→shield,
              // id→id, cod→cash`); `scan` is the impl's parcel-scan
              // checkpoint. A done row swaps to `check`.
              const proofIcon = done ? "check" : resolveProofIcon(c.key);
              return (
                <FxCard theme={theme} padding={12} key={c.key}>
                  <Pressable
                    onPress={
                      !isTerminal && props.onProofPress !== undefined
                        ? () => props.onProofPress!(c.key)
                        : undefined
                    }
                    accessibilityRole="checkbox"
                    accessibilityLabel={c.label}
                    accessibilityState={{ checked: done, disabled: isTerminal }}
                    disabled={isTerminal}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      columnGap: MOBILE_V2_SPACING.xl,
                    }}
                  >
                    {/* 32×32 rounded toned icon disk — accentSoft/accent,
                        switching to successSoft/success when captured.
                        Design flow-route.jsx:407-409. */}
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 9,
                        backgroundColor: done ? theme.successSoft : theme.accentSoft,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <FxIcon
                        name={proofIcon}
                        size={16}
                        color={done ? theme.success : theme.accent}
                      />
                    </View>
                    <Text
                      style={{
                        ...sansSemibold,
                        color: done ? theme.muted : theme.ink,
                        fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                        flex: 1,
                        textDecorationLine: done ? "line-through" : "none",
                      }}
                    >
                      {c.label}
                    </Text>
                    {/* Trailing status chip — `required` until captured,
                        then a `success`-toned `captured`. Design
                        flow-route.jsx:411. */}
                    <FxChip theme={theme} tone={done ? "success" : "neutral"} dense>
                      {done ? "captured" : "required"}
                    </FxChip>
                  </Pressable>
                </FxCard>
              );
            })}
          </FxCol>
        </FxCol>

        {/* Timeline */}
        {stop.timeline.length > 0 ? (
          <FxCol gap={MOBILE_V2_SPACING.lg}>
            <FxSectionHead theme={theme} label="Activity" />
            <View
              style={{
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.card,
                padding: MOBILE_V2_SPACING["2xl"],
                rowGap: MOBILE_V2_SPACING["2xl"],
              }}
            >
              {stop.timeline.map((t, idx) => {
                const tokens = chipToneToTokens(theme, t.tone ?? "neutral");
                return (
                  <FxRow key={t.id} gap={MOBILE_V2_SPACING.xl} align="center">
                    <View
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 999,
                        backgroundColor: tokens.bg,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {t.icon !== undefined ? (
                        <FxIcon name={t.icon} size={14} color={tokens.fg} />
                      ) : (
                        <Text
                          style={{
                            color: tokens.fg,
                            fontFamily: MOBILE_V2_FONT_MONO,
                            fontSize: 11,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                          }}
                        >
                          {String(idx + 1).padStart(2, "0")}
                        </Text>
                      )}
                    </View>
                    <Text style={{ ...sansSemibold, color: theme.ink, fontSize: MOBILE_V2_TYPE_SIZES.body, flex: 1 }}>
                      {t.label}
                    </Text>
                    <Text
                      style={{
                        fontFamily: MOBILE_V2_FONT_MONO,
                        color: theme.muted,
                        fontSize: MOBILE_V2_TYPE_SIZES.chip,
                      }}
                    >
                      {t.time}
                    </Text>
                  </FxRow>
                );
              })}
            </View>
          </FxCol>
        ) : null}
      </ScrollView>

      <FxStickyAction theme={theme}>
        {terminalCopy !== null ? (
          <FxButton
            theme={theme}
            variant={terminalCopy.tone === "success" ? "outline-accent" : "outline-danger"}
            icon={terminalCopy.icon}
            size="md"
            disabled
            full
          >
            {terminalCopy.label}
          </FxButton>
        ) : (
          <FxRow gap={MOBILE_V2_SPACING.lg}>
          {/* Match design canvas ScrStopDetail bottom CTA contract:
              ghost "Can't deliver" (with alert icon) + primary
              "Start delivery →" (with arrow-right). Earlier impl used
              "Fail" / "Submit POD" which framed the screen as a
              mid-flow POD compose step; the design treats stop-detail
              as the *entry* into the POD flow, so the primary CTA is
              the forward-progress verb. */}
          <FxButton theme={theme} variant="ghost" icon="alert" size="md" onPress={props.onFail}>
            Can't deliver
          </FxButton>
          <FxButton
            theme={theme}
            variant="primary"
            iconRight="arrow-right"
            size="md"
            onPress={props.onPodSubmit}
            style={{ flexGrow: 1 } as never}
          >
            {podDoneCount > 0
              ? `Resume delivery · ${podDoneCount}/${stop.proofChecklist.length}`
              : "Start delivery"}
          </FxButton>
          </FxRow>
        )}
      </FxStickyAction>
    </View>
  );
}
