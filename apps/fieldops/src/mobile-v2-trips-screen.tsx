// Mobile V2 Trips list + Trip detail screens — pixel-faithful port of
// design source flow-network.jsx ScrTrips + TripCard + ScrTripDetail.
// The 7-stage timeline is the centerpiece of the detail surface.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { getStrings, resolveLocaleCode, type FieldOpsStrings } from "./i18n";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { FxButton, FxCard, FxChip, FxChipButton, FxCol, FxRow } from "./mobile-v2-primitives";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
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

export type MobileV2TripStage =
  | "assigned"
  | "gate-in"
  | "loading"
  | "sealed"
  | "in-transit"
  | "arrived"
  | "gate-out"
  | "reconciled";

export interface MobileV2TripStep {
  readonly stage: Exclude<MobileV2TripStage, "assigned">;
  readonly icon: MobileV2IconName;
}

// Demo-parity alignment: TRIP_STEPS in the design source (flow-network.jsx
// line 465) treats "assigned" as a pre-step meta state — not counted in
// trip-progress — so the steps list has 7 entries starting from gate-in.
// Labels and hints live in the FieldOps catalogs (`trips.stepLabel` and
// `trips.stepHint`, keyed by stage), verbatim from the design source.
//
// When trip.stage === "assigned", `findIndex` returns -1 so the progress
// counter renders as 0/7 with sub "Assigned · next: Gate-in" — matching
// reference 01-start.png exactly.
export const MOBILE_V2_TRIP_STEPS: ReadonlyArray<MobileV2TripStep> = Object.freeze([
  Object.freeze({ stage: "gate-in" as const, icon: "shield" as MobileV2IconName }),
  Object.freeze({ stage: "loading" as const, icon: "package" as MobileV2IconName }),
  Object.freeze({ stage: "sealed" as const, icon: "shield" as MobileV2IconName }),
  Object.freeze({ stage: "in-transit" as const, icon: "truck" as MobileV2IconName }),
  Object.freeze({ stage: "arrived" as const, icon: "pin" as MobileV2IconName }),
  Object.freeze({ stage: "gate-out" as const, icon: "check" as MobileV2IconName }),
  Object.freeze({ stage: "reconciled" as const, icon: "check-double" as MobileV2IconName }),
]);

// Aligned to design SSOT `docs/design/fieldops-mobile-v2/screens/flow-network.jsx`
// TRIP_STAGE_TONE map (lines 334-343):
//   assigned   → 'default' (rendered tone-less; closest impl mapping is `neutral`)
//   gate-in    → 'info'
//   loading    → 'info'
//   sealed     → 'info'
//   in-transit → 'accent'
//   arrived    → 'success'
//   gate-out   → 'warning'
//   reconciled → 'success'
const STAGE_TONE: Readonly<Record<MobileV2TripStage, FxChipTone>> = Object.freeze({
  assigned: "neutral",
  "gate-in": "info",
  loading: "info",
  sealed: "info",
  "in-transit": "accent",
  arrived: "success",
  "gate-out": "warning",
  reconciled: "success",
});

export interface MobileV2TripLocation {
  readonly id: string;
  readonly name: string;
}

export interface MobileV2TripManifestEntry {
  readonly wb: string;
  readonly count: number;
}

export interface MobileV2Trip {
  readonly id: string;
  readonly leg: string;
  readonly driver: string;
  readonly vehicle: string;
  readonly stage: MobileV2TripStage;
  readonly origin: MobileV2TripLocation;
  readonly dest: MobileV2TripLocation;
  readonly plannedDepart: string;
  readonly plannedArrive: string;
  readonly etaMin: number | null;
  readonly distance: number;
  readonly totalParcels: number;
  readonly scanned: number;
  readonly sealNo: string | null;
  readonly manifest: ReadonlyArray<MobileV2TripManifestEntry>;
}

function formatEta(etaMin: number | null, t: FieldOpsStrings["trips"]): string {
  if (etaMin === null) return "—";
  if (etaMin === 0) return t.etaNow;
  if (etaMin > 0) {
    return t.etaDuration
      .replace("{hours}", () => String(Math.floor(etaMin / 60)))
      .replace("{minutes}", () => String(etaMin % 60));
  }
  return t.etaLate.replace("{minutes}", () => String(Math.abs(etaMin)));
}

// ---------------------------------------------------------------------------
// TripCard
// ---------------------------------------------------------------------------

function TripCard({
  theme,
  strings,
  trip,
  hero,
  onOpen,
}: {
  readonly theme: MobileV2Theme;
  readonly strings: FieldOpsStrings;
  readonly trip: MobileV2Trip;
  readonly hero?: boolean;
  readonly onOpen: () => void;
}): React.ReactElement {
  const pct = trip.totalParcels > 0 ? Math.round((trip.scanned / trip.totalParcels) * 100) : 0;
  const heroBg = hero === true ? theme.chrome : theme.surface;
  const heroFg = hero === true ? theme.onChrome : theme.ink;
  const subFg = hero === true ? "rgba(255,255,255,0.7)" : theme.muted;
  const lineBg = hero === true ? "rgba(255,255,255,0.25)" : theme.border;
  const t = strings.trips;

  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t.openTrip.replace("{id}", () => trip.id)}>
      {/* Outer card wraps both the main info area and the footer slab so
          they share a single rounded border. `overflow: hidden` clips
          the footer's distinct background to the card's rounded
          bottom corners. Padding moved inside the inner View so the
          footer slab can have its own padding without competing. */}
      <View
        style={{
          backgroundColor: heroBg,
          // Design canvas TripCard gives the hero variant `border:none`
          // and only the non-hero card a 1px border. Matching that keeps
          // the hero card from rendering 2px taller (border box) and
          // shifting downstream cards.
          borderColor: theme.border,
          borderWidth: hero === true ? 0 : 1,
          borderRadius: MOBILE_V2_RADII.card,
          overflow: "hidden",
        }}
      >
      <View
        style={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingVertical: MOBILE_V2_SPACING["3xl"],
        }}
      >
        <FxRow justify="space-between" align="flex-start" style={{ marginBottom: MOBILE_V2_SPACING.xl }}>
          <FxCol gap={2}>
            <FxRow gap={MOBILE_V2_SPACING.md}>
              <Text
                style={{
                  fontSize: 10.5,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: heroFg,
                  opacity: 0.7,
                }}
              >
                {trip.id}
              </Text>
              <FxChip theme={theme} tone={STAGE_TONE[trip.stage]} dense>
                {t.stage[trip.stage]}
              </FxChip>
            </FxRow>
            <Text
              style={{
                fontSize: 14.5,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                color: heroFg,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginTop: 2,
              }}
            >
              {trip.leg}
            </Text>
          </FxCol>
          <FxCol gap={2} style={{ alignItems: "flex-end" }}>
            <Text
              style={{
                fontSize: 10,
                color: heroFg,
                opacity: 0.6,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {t.eta}
            </Text>
            <Text
              style={{
                fontSize: 13,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_MONO,
                color: heroFg,
              }}
            >
              {formatEta(trip.etaMin, t)}
            </Text>
          </FxCol>
        </FxRow>

        {/* Origin → progress → dest */}
        <FxRow gap={MOBILE_V2_SPACING.xl} align="center" style={{ marginBottom: MOBILE_V2_SPACING.xl }}>
          <FxCol gap={1}>
            <Text style={{ fontSize: 10, color: heroFg, opacity: 0.55, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6 }}>
              {t.from}
            </Text>
            <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: heroFg, fontFamily: MOBILE_V2_FONT_SANS }}>
              {trip.origin.name}
            </Text>
            <Text style={{ fontSize: 10.5, color: heroFg, opacity: 0.6, fontFamily: MOBILE_V2_FONT_MONO }}>
              {trip.origin.id} · {trip.plannedDepart}
            </Text>
          </FxCol>

          {/* Progress line with truck pip */}
          <View style={{ flex: 1, height: 24, position: "relative", justifyContent: "center" }}>
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "50%",
                height: 2,
                backgroundColor: lineBg,
                borderRadius: 1,
              }}
            />
            <View
              style={{
                position: "absolute",
                left: 0,
                top: "50%",
                height: 2,
                width: `${pct}%`,
                backgroundColor: theme.accent,
                borderRadius: 1,
                marginTop: -1,
              }}
            />
            <View
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: "50%",
                width: 24,
                height: 24,
                borderRadius: 999,
                backgroundColor: heroBg,
                borderColor: theme.accent,
                borderWidth: 2,
                alignItems: "center",
                justifyContent: "center",
                marginLeft: -12,
                marginTop: -12,
              }}
            >
              <FxIcon name="truck" size={12} color={hero === true ? theme.onChrome : theme.accent} stroke={2.4} />
            </View>
          </View>

          <FxCol gap={1} style={{ alignItems: "flex-end" }}>
            <Text style={{ fontSize: 10, color: heroFg, opacity: 0.55, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6 }}>
              {t.to}
            </Text>
            <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: heroFg, fontFamily: MOBILE_V2_FONT_SANS }}>
              {trip.dest.name}
            </Text>
            <Text style={{ fontSize: 10.5, color: heroFg, opacity: 0.6, fontFamily: MOBILE_V2_FONT_MONO }}>
              {trip.dest.id} · {trip.plannedArrive}
            </Text>
          </FxCol>
        </FxRow>

      </View>

      {/* Footer slab — design canvas TripCard renders this as a separate
          background region (surfaceAlt on non-hero, rgba(0,0,0,0.18) on
          hero) with VEHICLE / PARCELS / SEAL label-value columns and an
          "Open -> " text CTA on the right. The previous icon-pair row
          was a visually distinct format (icons + values + km) and read
          as a different IA from the design's labeled-metric trio. */}
      <View
        style={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingVertical: MOBILE_V2_SPACING.xl,
          backgroundColor: hero === true ? "rgba(0,0,0,0.18)" : theme.surfaceAlt,
          borderTopColor: hero === true ? "rgba(255,255,255,0.08)" : theme.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <FxRow gap={MOBILE_V2_SPACING["2xl"]}>
          <FxCol gap={1}>
            <Text
              style={{
                fontSize: 9.5,
                color: heroFg,
                opacity: 0.55,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {t.vehicle}
            </Text>
            <Text
              style={{
                fontSize: 11.5,
                color: heroFg,
                fontFamily: MOBILE_V2_FONT_MONO,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {trip.vehicle}
            </Text>
          </FxCol>
          <FxCol gap={1}>
            <Text
              style={{
                fontSize: 9.5,
                color: heroFg,
                opacity: 0.55,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {t.parcels}
            </Text>
            <Text
              style={{
                fontSize: 11.5,
                color: heroFg,
                fontFamily: MOBILE_V2_FONT_MONO,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {trip.scanned}/{trip.totalParcels}
            </Text>
          </FxCol>
          <FxCol gap={1}>
            <Text
              style={{
                fontSize: 9.5,
                color: heroFg,
                opacity: 0.55,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {t.seal}
            </Text>
            <Text
              style={{
                fontSize: 11.5,
                color: heroFg,
                fontFamily: MOBILE_V2_FONT_MONO,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {trip.sealNo ?? "—"}
            </Text>
          </FxCol>
        </FxRow>
        <Text
          style={{
            fontSize: 11,
            color: hero === true ? heroFg : theme.muted,
            opacity: hero === true ? 0.85 : 1,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {t.open}
        </Text>
      </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// MobileV2TripsScreen — list
// ---------------------------------------------------------------------------

export type MobileV2TripsTab = "all" | "mine" | "transit" | "reconciled";

export interface MobileV2TripsScreenProps {
  readonly theme: MobileV2Theme;
  readonly trips: ReadonlyArray<MobileV2Trip>;
  readonly tab: MobileV2TripsTab;
  readonly onTabChange: (tab: MobileV2TripsTab) => void;
  readonly onOpenTrip: (trip: MobileV2Trip) => void;
  /**
   * Free-text search query (trip ID, vehicle, seal, leg). Optional —
   * design canvas ScrTrips renders a search bar above the filter pills.
   */
  readonly searchQuery?: string;
  readonly onSearchChange?: (q: string) => void;
  /** Scan-seal action invoked by the design-canvas yellow CTA next to the search input. */
  readonly onScanSeal?: () => void;
  readonly locale?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2TripsScreen(props: MobileV2TripsScreenProps): React.ReactElement {
  const { theme } = props;
  const strings = getStrings(resolveLocaleCode(props.locale));
  const t = strings.trips;
  const count = (template: string, n: number): string => template.replace("{count}", () => String(n));
  const base = props.trips;
  const filtered =
    props.tab === "mine"
      ? base.filter((tr) => tr.driver === "You")
      : props.tab === "transit"
        ? base.filter((tr) => tr.stage === "in-transit")
        : props.tab === "reconciled"
          ? base.filter((tr) => tr.stage === "reconciled" || tr.stage === "gate-out")
          : base;
  const mine = props.tab === "all" || props.tab === "mine" ? base.find((tr) => tr.driver === "You") ?? null : null;
  const others = filtered.filter((tr) => tr !== mine);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* Sticky top chrome: search bar (with inline scan-seal CTA) + filter
          pills, matching design canvas ScrTrips top-chrome container
          (padding 10/16/8, chips row marginTop 8). */}
      <View
        style={{
          backgroundColor: theme.bg,
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING.xl,
          paddingBottom: MOBILE_V2_SPACING.lg,
          borderBottomColor: theme.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
          rowGap: MOBILE_V2_SPACING.lg,
        }}
      >
        {/* FxSearchBar — bordered bar with inline accent scan-seal button */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: 40,
            backgroundColor: theme.surfaceAlt,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: 11,
            paddingLeft: MOBILE_V2_SPACING["2xl"],
            paddingRight: MOBILE_V2_SPACING.sm,
            columnGap: MOBILE_V2_SPACING.lg,
            overflow: "hidden",
          }}
        >
          <FxIcon name="search" size={16} color={theme.muted} />
          <TextInput
            value={props.searchQuery ?? ""}
            onChangeText={(v) => props.onSearchChange?.(v)}
            placeholder={t.searchPlaceholder}
            placeholderTextColor={theme.muted}
            accessibilityLabel={t.searchLabel}
            style={{
              flex: 1,
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.body,
              paddingVertical: 0,
            }}
          />
          <Pressable
            onPress={() => props.onScanSeal?.()}
            accessibilityRole="button"
            accessibilityLabel={t.scanSeal}
            style={{
              backgroundColor: theme.accent,
              height: 32,
              borderRadius: 8,
              paddingHorizontal: MOBILE_V2_SPACING.xl,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              columnGap: MOBILE_V2_SPACING.md,
            }}
          >
            <FxIcon name="scan" size={14} color={theme.accentInk} stroke={2.4} />
            <Text
              style={{
                color: theme.accentInk,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: 11.5,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {t.scanSeal}
            </Text>
          </Pressable>
        </View>

        {/* Filter pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            columnGap: MOBILE_V2_SPACING.md,
            paddingBottom: MOBILE_V2_SPACING.xs,
          }}
        >
          <FxChipButton
            theme={theme}
            icon="truck"
            label={count(t.tabAll, base.length)}
            active={props.tab === "all"}
            onPress={() => props.onTabChange("all")}
            accessibilityLabel={t.showAll}
          />
          <FxChipButton
            theme={theme}
            icon="user"
            label={count(t.tabMine, base.filter((tr) => tr.driver === "You").length)}
            active={props.tab === "mine"}
            onPress={() => props.onTabChange("mine")}
            accessibilityLabel={t.showMine}
          />
          <FxChipButton
            theme={theme}
            icon="clock"
            label={count(t.tabTransit, base.filter((tr) => tr.stage === "in-transit").length)}
            active={props.tab === "transit"}
            onPress={() => props.onTabChange("transit")}
            accessibilityLabel={t.showTransit}
          />
          <FxChipButton
            theme={theme}
            icon="check"
            label={count(t.tabReconciled, base.filter((tr) => tr.stage === "reconciled" || tr.stage === "gate-out").length)}
            active={props.tab === "reconciled"}
            onPress={() => props.onTabChange("reconciled")}
            accessibilityLabel={t.showReconciled}
          />
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING["2xl"],
          paddingBottom: MOBILE_V2_SPACING["6xl"],
          rowGap: MOBILE_V2_SPACING["2xl"],
        }}
      >
        {mine !== null ? (
          <>
            <Text
              style={{
                fontSize: 10,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.sectionHead,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
                paddingHorizontal: MOBILE_V2_SPACING.sm,
                paddingVertical: MOBILE_V2_SPACING.xs,
              }}
            >
              {t.myTrip}
            </Text>
            <TripCard strings={strings} theme={theme} trip={mine} hero onOpen={() => props.onOpenTrip(mine)} />
          </>
        ) : null}
        {others.length > 0 ? (
          <>
            <Text
              style={{
                fontSize: 10,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.sectionHead,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
                paddingHorizontal: MOBILE_V2_SPACING.sm,
                paddingTop: MOBILE_V2_SPACING.xl,
              }}
            >
              {t.network}
            </Text>
            {others.map((tr) => (
              <TripCard strings={strings} key={tr.id} theme={theme} trip={tr} onOpen={() => props.onOpenTrip(tr)} />
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MobileV2TripDetailScreen — 7-stage timeline + manifest + seal
// ---------------------------------------------------------------------------

export interface MobileV2TripDetailScreenProps {
  readonly theme: MobileV2Theme;
  readonly trip: MobileV2Trip;
  readonly isAdvancingStage?: boolean;
  readonly onAdvanceStage?: (next: MobileV2TripStage) => void;
  readonly onScanSeal?: () => void;
  readonly onScanManifest?: () => void;
  readonly onLiveNav?: () => void;
  readonly onReportIncident?: () => void;
  readonly onClose?: () => void;
  readonly locale?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2TripDetailScreen(props: MobileV2TripDetailScreenProps): React.ReactElement {
  const { theme, trip } = props;
  const t = getStrings(resolveLocaleCode(props.locale)).trips;
  const stageActionBusy = props.isAdvancingStage === true;
  const idx = MOBILE_V2_TRIP_STEPS.findIndex((s) => s.stage === trip.stage);
  const nextStep = MOBILE_V2_TRIP_STEPS[idx + 1] ?? null;
  const pct = trip.totalParcels > 0 ? Math.round((trip.scanned / trip.totalParcels) * 100) : 0;
  const progressPct = ((idx + 1) / MOBILE_V2_TRIP_STEPS.length) * 100;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["4xl"], rowGap: MOBILE_V2_SPACING["3xl"], paddingBottom: 96 }}>
        {/* Progress hero */}
        <View
          style={{
            backgroundColor: theme.chrome,
            borderRadius: MOBILE_V2_RADII.card,
            padding: MOBILE_V2_SPACING["3xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={4}>
              <Text style={{ fontSize: 11, color: theme.onChrome, opacity: 0.7, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, fontFamily: MOBILE_V2_FONT_SANS }}>
                {t.progress}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={{ fontSize: 32, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome, letterSpacing: -1 }}>
                  {idx + 1}
                </Text>
                <Text style={{ fontSize: 32, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome, opacity: 0.45, letterSpacing: -1 }}>
                  /{MOBILE_V2_TRIP_STEPS.length}
                </Text>
              </View>
              <Text style={{ fontSize: 12, color: theme.onChrome, opacity: 0.7, fontFamily: MOBILE_V2_FONT_SANS }}>
                {t.stage[trip.stage]}
                {nextStep !== null ? ` · ${t.next.replace("{step}", () => t.stepLabel[nextStep.stage])}` : ""}
              </Text>
            </FxCol>
            <FxCol gap={2} style={{ alignItems: "flex-end" }}>
              <Text style={{ fontSize: 10, color: theme.onChrome, opacity: 0.6, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                {t.distance}
              </Text>
              <Text style={{ fontSize: 18, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.onChrome }}>
                {t.distanceKm.replace("{distance}", () => String(trip.distance))}
              </Text>
              <Text style={{ fontSize: 11, color: theme.onChrome, opacity: 0.6, fontFamily: MOBILE_V2_FONT_SANS, marginTop: 2 }}>
                {trip.driver}
              </Text>
            </FxCol>
          </FxRow>

          <View style={{ marginTop: MOBILE_V2_SPACING["3xl"], height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
            <View style={{ height: "100%", width: `${progressPct}%`, backgroundColor: theme.accent }} />
          </View>
        </View>

        {/* Stages timeline */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
            {t.stages}
          </Text>
          <FxCard theme={theme} padding={0}>
            {MOBILE_V2_TRIP_STEPS.map((step, i) => {
              const done = i <= idx;
              const current = i === idx;
              const upcoming = i > idx;
              const isNext = i === idx + 1;
              const isLast = i === MOBILE_V2_TRIP_STEPS.length - 1;
              const opacity = upcoming && !isNext ? 0.5 : 1;
              const dotBg = done ? theme.success : isNext ? theme.accent : theme.surfaceAlt;
              const dotFg = done || isNext ? "#FFFFFF" : theme.muted;
              return (
                <FxRow
                  key={step.stage}
                  gap={MOBILE_V2_SPACING["2xl"]}
                  align="flex-start"
                  style={{
                    paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                    paddingVertical: MOBILE_V2_SPACING["3xl"],
                    borderBottomColor: theme.border,
                    borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
                    opacity,
                  }}
                >
                  <View style={{ alignItems: "center", width: 28 }}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        backgroundColor: dotBg,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <FxIcon name={done ? "check" : step.icon} size={14} color={dotFg} stroke={2.2} />
                    </View>
                    {!isLast ? (
                      <View
                        style={{
                          width: 2,
                          flex: 1,
                          marginTop: MOBILE_V2_SPACING.sm,
                          backgroundColor: done ? theme.success : theme.border,
                          alignSelf: "center",
                        }}
                      />
                    ) : null}
                  </View>
                  <FxCol gap={2} style={{ flex: 1 }}>
                    <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                      <Text style={{ fontSize: 13, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, color: theme.ink, fontFamily: MOBILE_V2_FONT_SANS }}>
                        {t.stepLabel[step.stage]}
                      </Text>
                      {current ? (
                        <FxChip theme={theme} tone="accent" dense>
                          {t.current}
                        </FxChip>
                      ) : null}
                    </FxRow>
                    <Text style={{ fontSize: 11.5, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                      {t.stepHint[step.stage]}
                    </Text>
                  </FxCol>
                  {done ? <FxIcon name="check" size={14} color={theme.success} stroke={2.2} /> : null}
                </FxRow>
              );
            })}
          </FxCard>
        </FxCol>

        {/* Manifest */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
            {t.manifest}
          </Text>
          <FxCard theme={theme} padding={0}>
            <FxRow justify="space-between" style={{ paddingHorizontal: MOBILE_V2_SPACING["3xl"], paddingVertical: MOBILE_V2_SPACING["2xl"] }}>
              <FxCol gap={2}>
                <Text style={{ fontSize: 13, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, color: theme.ink, fontFamily: MOBILE_V2_FONT_SANS }}>
                  {t.manifestSummary.replace("{parcels}", () => String(trip.totalParcels)).replace("{manifests}", () => String(trip.manifest.length))}
                </Text>
                <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_MONO }}>
                  {t.scannedSummary.replace("{scanned}", () => String(trip.scanned)).replace("{total}", () => String(trip.totalParcels)).replace("{pct}", () => String(pct))}
                </Text>
              </FxCol>
              <FxChip theme={theme} tone={trip.scanned === trip.totalParcels ? "success" : "warning"} dense mono>
                {pct}%
              </FxChip>
            </FxRow>
            <View style={{ height: 1, backgroundColor: theme.border }} />
            {trip.manifest.map((m, i) => (
              <FxRow
                key={m.wb}
                gap={MOBILE_V2_SPACING.lg}
                align="center"
                style={{
                  paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                  paddingVertical: MOBILE_V2_SPACING.xl,
                  borderBottomColor: theme.border,
                  borderBottomWidth: i === trip.manifest.length - 1 ? 0 : StyleSheet.hairlineWidth,
                }}
              >
                <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                  <FxIcon name="doc" size={14} color={theme.muted} />
                </View>
                <FxCol gap={2} style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12.5, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, color: theme.ink, fontFamily: MOBILE_V2_FONT_MONO }}>
                    {m.wb}
                  </Text>
                  <Text style={{ fontSize: 11, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                    {t.manifestParcels.replace("{count}", () => String(m.count))}
                  </Text>
                </FxCol>
                <FxIcon name="chevron-right" size={16} color={theme.muted} />
              </FxRow>
            ))}
          </FxCard>
        </FxCol>

        {/* Trailer seal */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          <Text style={{ fontSize: 10, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, letterSpacing: 0.8, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS, paddingHorizontal: MOBILE_V2_SPACING.xs }}>
            {t.trailerSeal}
          </Text>
          <FxCard theme={theme} padding={14}>
            <FxRow justify="space-between" align="center">
              <FxCol gap={2}>
                <Text style={{ fontSize: 11, color: theme.muted, fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold, letterSpacing: 0.6, textTransform: "uppercase", fontFamily: MOBILE_V2_FONT_SANS }}>
                  {t.sealNumber}
                </Text>
                <Text style={{ fontSize: 18, fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold, fontFamily: MOBILE_V2_FONT_MONO, color: theme.ink }}>
                  {trip.sealNo ?? t.notSealed}
                </Text>
              </FxCol>
              {trip.sealNo !== null ? (
                <FxChip theme={theme} tone="success" icon="shield" dense>
                  {t.verified}
                </FxChip>
              ) : (
                <FxButton theme={theme} variant="soft" size="sm" icon="scan" onPress={props.onScanSeal} disabled={stageActionBusy}>
                  {t.scanSeal}
                </FxButton>
              )}
            </FxRow>
          </FxCard>
        </FxCol>

        {/* Context-aware primary action */}
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          {trip.stage === "assigned" ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="shield" onPress={() => props.onAdvanceStage?.("gate-in")} disabled={stageActionBusy}>
              {t.startGateIn}
            </FxButton>
          ) : null}
          {trip.stage === "gate-in" ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="package" onPress={() => props.onAdvanceStage?.("loading")} disabled={stageActionBusy}>
              {t.beginLoading}
            </FxButton>
          ) : null}
          {trip.stage === "loading" ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="shield" onPress={props.onScanSeal} disabled={stageActionBusy || trip.scanned < trip.totalParcels}>
              {t.applySeal.replace("{scanned}", () => String(trip.scanned)).replace("{total}", () => String(trip.totalParcels))}
            </FxButton>
          ) : null}
          {trip.stage === "sealed" ? (
            <FxButton theme={theme} variant="success" full size="lg" icon="truck" onPress={() => props.onAdvanceStage?.("in-transit")} disabled={stageActionBusy}>
              {t.depart}
            </FxButton>
          ) : null}
          {trip.stage === "in-transit" ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="map" onPress={props.onLiveNav}>
              {t.liveNav.replace("{destination}", () => trip.dest.name)}
            </FxButton>
          ) : null}
          {trip.stage === "arrived" ? (
            <FxButton theme={theme} variant="primary" full size="lg" icon="check" onPress={() => props.onAdvanceStage?.("gate-out")} disabled={stageActionBusy}>
              {t.sealVerify}
            </FxButton>
          ) : null}
          {trip.stage === "gate-out" ? (
            <FxButton theme={theme} variant="success" full size="lg" icon="check-double" onPress={() => props.onAdvanceStage?.("reconciled")} disabled={stageActionBusy}>
              {t.reconcile}
            </FxButton>
          ) : null}
          {trip.stage === "reconciled" ? (
            <FxButton theme={theme} variant="soft" full size="lg" icon="check" onPress={props.onClose}>
              {t.closed}
            </FxButton>
          ) : null}
          <FxButton theme={theme} variant="ghost" full icon="alert" onPress={props.onReportIncident}>
            {t.reportIncident}
          </FxButton>
        </FxCol>
      </ScrollView>
    </View>
  );
}
