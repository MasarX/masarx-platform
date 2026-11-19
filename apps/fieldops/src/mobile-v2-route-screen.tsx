// Mobile V2 Route screen — pixel-faithful port of design source
// flow-route.jsx ScrRoute. Driver's stop list with saved views (built-in
// + custom), filter/group/sort chip strip, density toggle, and stacked
// stop rows with status pill, COD chip, fragile chip, attempts chip.
//
// Views, filters, sorts and groups are pre-resolved by the caller and
// supplied as props so the screen stays render-pure. The "save view"
// affordance is presented only when `dirty` is true.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxChip, FxChipButton, FxRow, FxStatusDot } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2RouteStopStatus =
  | "pending"
  | "current"
  | "done"
  | "failed"
  | "partial"
  | "sla";

export type MobileV2RouteDensity = "compact" | "comfy";

export interface MobileV2RouteStop {
  readonly id: string;
  readonly seq: number;
  readonly customer: string;
  readonly address: string;
  readonly sla: string;
  readonly status: MobileV2RouteStopStatus;
  readonly cod: number;
  readonly fragile: boolean;
  readonly attempts: number;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly accuracyM?: number | null;
  readonly shortAddress?: string | null;
  readonly geocodingStatus?: string | null;
  readonly geocodingAccuracy?: string | null;
  readonly geocodingProvider?: string | null;
  readonly geocodingMatch?: string | null;
}

export interface MobileV2RouteManifestSummary {
  readonly routeLabel: string;
  readonly assignmentLabel: string;
  readonly scanOutLabel: string;
  readonly departureLabel: string;
  readonly readyForDeparture: boolean;
  readonly departed: boolean;
}

export interface MobileV2RouteSavedView {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly builtin: boolean;
}

/** A route stop group section — uppercase label + count, mirrors design flow-route.jsx group headers. */
export interface MobileV2RouteScreenGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: ReadonlyArray<MobileV2RouteStop>;
}

export interface MobileV2RouteScreenProps {
  readonly theme: MobileV2Theme;
  readonly activeView: MobileV2RouteSavedView;
  readonly views: ReadonlyArray<MobileV2RouteSavedView>;
  /**
   * Flat stop list — rendered when `groups` is omitted (no grouping
   * active). When the host supplies `groups` the screen renders per-group
   * sections instead (design flow-route.jsx:54-65).
   */
  readonly rows: ReadonlyArray<MobileV2RouteStop>;
  /**
   * Optional pre-computed group sections. When present (the active
   * saved-view's group key is not "none"), the screen renders an
   * uppercase section header + count chip + chevron per group, then the
   * group's stop rows — mirroring the working Tasks `precomputedGroups`
   * pattern. `rows` is still used for the empty-state check.
   */
  readonly groups?: ReadonlyArray<MobileV2RouteScreenGroup>;
  readonly totalStops: number;
  readonly searchValue: string;
  readonly density: MobileV2RouteDensity;
  readonly sortLabel: string;
  readonly groupLabel: string;
  readonly filterCount: number;
  readonly dirty: boolean;
  readonly manifestSummary?: MobileV2RouteManifestSummary | null;
  /** ISO currency code, defaults to "SAR". */
  readonly currency?: string;
  readonly onSearchChange?: (next: string) => void;
  readonly onOpenViews?: () => void;
  readonly onOpenFilters?: () => void;
  readonly onOpenGroup?: () => void;
  readonly onOpenSort?: () => void;
  readonly onToggleDensity?: () => void;
  readonly onSaveView?: () => void;
  readonly onOpenMap?: () => void;
  readonly onOpenScan?: () => void;
  readonly onConfirmDeparture?: () => void;
  readonly isConfirmingDeparture?: boolean;
  readonly onSelectStop?: (id: string) => void;
  readonly onClearFilters?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const STATUS_META: Readonly<
  Record<MobileV2RouteStopStatus, { readonly label: string; readonly tone: FxChipTone }>
> = Object.freeze({
  pending: Object.freeze({ label: "Pending", tone: "neutral" }),
  // Aligned to design canvas ScrRoute artboard: the active stop chip
  // reads "In progress" (not "Current"). Production cutover resolves
  // this via i18n once cloud is wired.
  current: Object.freeze({ label: "In progress", tone: "accent" }),
  done: Object.freeze({ label: "Delivered", tone: "success" }),
  failed: Object.freeze({ label: "Failed", tone: "danger" }),
  partial: Object.freeze({ label: "Partial", tone: "warning" }),
  sla: Object.freeze({ label: "SLA risk", tone: "warning" }),
});

function StopRow(props: {
  readonly theme: MobileV2Theme;
  readonly stop: MobileV2RouteStop;
  readonly compact: boolean;
  readonly currency: string;
  readonly onPress?: () => void;
}): React.ReactElement {
  const { theme: t, stop, compact, currency } = props;
  const isCurrent = stop.status === "current";
  const isDone = stop.status === "done";
  const statusMeta = STATUS_META[stop.status];
  const statusDotKind = stop.status === "partial" ? "sla" : stop.status;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`Stop ${stop.seq}, ${stop.customer}`}
      style={{
        backgroundColor: isCurrent ? t.accentSoft : t.surface,
        paddingHorizontal: 16,
        paddingVertical: compact ? 8 : 14,
        borderLeftWidth: 3,
        borderLeftColor: isCurrent ? t.accent : "transparent",
      }}
    >
      <FxRow gap={MOBILE_V2_SPACING["2xl"]} align="center">
        <View style={{ width: 32, alignItems: "center" }}>
          <Text
            style={{
              fontSize: compact ? 14 : 18,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              fontFamily: MOBILE_V2_FONT_MONO,
              color: isDone ? t.muted : t.ink,
              textDecorationLine: isDone ? "line-through" : "none",
              lineHeight: compact ? 14 : 18,
            }}
          >
            {String(stop.seq).padStart(2, "0")}
          </Text>
          {!compact ? (
            <View style={{ marginTop: MOBILE_V2_SPACING["4xl"] }}>
              <FxStatusDot theme={t} kind={statusDotKind} />
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <FxRow justify="space-between" align="center">
            <Text
              style={{
                fontSize: compact ? 13 : 14,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                color: t.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                flex: 1,
                minWidth: 0,
              }}
              numberOfLines={1}
            >
              {stop.customer}
            </Text>
            <Text
              style={{
                fontSize: 11,
                color: t.muted,
                fontFamily: MOBILE_V2_FONT_MONO,
                marginLeft: MOBILE_V2_SPACING.lg,
              }}
            >
              {stop.sla}
            </Text>
          </FxRow>
          {!compact ? (
            <Text
              style={{
                fontSize: 12,
                color: t.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginTop: MOBILE_V2_SPACING.xs,
              }}
              numberOfLines={1}
            >
              {stop.address}
            </Text>
          ) : null}
          {!compact ? (
            <FxRow gap={MOBILE_V2_SPACING.sm} wrap style={{ marginTop: MOBILE_V2_SPACING.md }}>
              <FxChip theme={t} tone={statusMeta.tone} dense>
                {statusMeta.label}
              </FxChip>
              {stop.cod > 0 ? (
                <FxChip theme={t} tone="accent" icon="cash" dense mono>
                  {/* Design ScrRoute StopRow (flow-route.jsx:107) renders
                      the COD chip as the raw value + ﷼ (`{s.cod} ﷼`) —
                      no thousands separator. */}
                  {formatMobileV2CurrencyCompact(stop.cod, currency, { grouped: false })}
                </FxChip>
              ) : null}
              {stop.fragile ? (
                <FxChip theme={t} tone="info" icon="package" dense>
                  Fragile
                </FxChip>
              ) : null}
              {stop.attempts > 1 ? (
                <FxChip theme={t} tone="warning" icon="refresh" dense mono>
                  Try {stop.attempts}
                </FxChip>
              ) : null}
            </FxRow>
          ) : null}
        </View>
        <FxIcon name="chevron-right" size={18} color={t.muted} />
      </FxRow>
    </Pressable>
  );
}

/** Edge-to-edge stacked stop rows over a 1px border divider — design `StopRows`. */
function StopRows(props: {
  readonly theme: MobileV2Theme;
  readonly stops: ReadonlyArray<MobileV2RouteStop>;
  readonly compact: boolean;
  readonly currency: string;
  readonly onSelectStop?: (id: string) => void;
}): React.ReactElement {
  return (
    <View style={{ backgroundColor: props.theme.border, rowGap: 1 }}>
      {props.stops.map((s) => (
        <StopRow
          key={s.id}
          theme={props.theme}
          stop={s}
          compact={props.compact}
          currency={props.currency}
          onPress={() => props.onSelectStop?.(s.id)}
        />
      ))}
    </View>
  );
}

function RouteManifestStrip(props: {
  readonly theme: MobileV2Theme;
  readonly summary: MobileV2RouteManifestSummary;
  readonly onConfirmDeparture?: () => void;
  readonly isConfirmingDeparture?: boolean;
}): React.ReactElement {
  const { theme, summary } = props;
  const scanTone: FxChipTone = summary.readyForDeparture ? "success" : "warning";
  const departureTone: FxChipTone = summary.departed
    ? "success"
    : summary.readyForDeparture
      ? "accent"
      : "neutral";
  return (
    <View
      accessibilityLabel={`Route manifest ${summary.routeLabel}, ${summary.assignmentLabel}, ${summary.scanOutLabel}, ${summary.departureLabel}`}
      style={{
        marginTop: MOBILE_V2_SPACING.md,
        padding: MOBILE_V2_SPACING.lg,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 12,
        backgroundColor: theme.surface,
        rowGap: MOBILE_V2_SPACING.md,
      }}
    >
      <FxRow align="center" gap={MOBILE_V2_SPACING.md}>
        <FxIcon name="route" size={16} color={theme.accent} />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: theme.ink,
            fontSize: 12,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {summary.routeLabel}
        </Text>
      </FxRow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: MOBILE_V2_SPACING.sm }}>
        <FxChip theme={theme} tone="neutral" icon="shield" dense>
          {summary.assignmentLabel}
        </FxChip>
        <FxChip theme={theme} tone={scanTone} icon="scan" dense>
          {summary.scanOutLabel}
        </FxChip>
        <FxChip
          theme={theme}
          tone={departureTone}
          icon={summary.departed ? "check" : "navigate"}
          dense
        >
          {summary.departureLabel}
        </FxChip>
      </View>
      {props.onConfirmDeparture ? (
        <FxButton
          theme={theme}
          variant={summary.departed ? "soft" : "primary"}
          size="sm"
          icon={summary.departed ? "check" : "navigate"}
          full
          disabled={
            props.isConfirmingDeparture === true ||
            summary.departed ||
            !summary.readyForDeparture
          }
          onPress={props.onConfirmDeparture}
          accessibilityLabel="Confirm route departure"
          testID="mobile-v2-route-confirm-departure"
        >
          {summary.departed
            ? "Departure confirmed"
            : props.isConfirmingDeparture === true
              ? "Confirming departure..."
              : summary.readyForDeparture
                ? "Confirm departure"
                : "Scan-out required"}
        </FxButton>
      ) : null}
    </View>
  );
}

export function MobileV2RouteScreen(
  props: MobileV2RouteScreenProps,
): React.ReactElement {
  const { theme, rows, groups, density, filterCount, dirty } = props;
  const currency = props.currency ?? "SAR";
  const compact = density === "compact";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Search + filter chip strip (sticky-style; consumer wraps in sticky if
            needed). The in-body title row (active-view picker + map icon + "X of
            Y · sort" subtitle) is stripped — the gallery / host ScreenShell now
            renders the title via FxAppBar. Note: `activeView.emoji`, the map
            chevron, and the open-map icon used to live in this title row; the
            host can re-surface them via the AppBar `right` prop or by wiring
            `onOpenViews` / `onOpenMap` from outside the screen. */}
        <View
          style={{
            backgroundColor: theme.bg,
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 8,
            borderBottomColor: theme.border,
            borderBottomWidth: 1,
          }}
        >
          {/* Search bar — a real editable TextInput bound to searchValue
              (design FxSearchBar flow-network.jsx:16-27). U2 fix: was a
              static Text placeholder that could not be typed into. The
              TextInput's own paddingVertical preserves the prior 9px
              search-bar height so the visual baseline is unchanged. */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: theme.surfaceAlt,
              borderColor: theme.border,
              borderWidth: 1,
              borderRadius: 12,
              paddingLeft: 12,
              columnGap: MOBILE_V2_SPACING.md,
              overflow: "hidden",
            }}
          >
            <FxIcon name="search" size={16} color={theme.muted} />
            <TextInput
              value={props.searchValue}
              onChangeText={props.onSearchChange}
              placeholder="Search name, address, parcel ID…"
              placeholderTextColor={theme.muted}
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              accessibilityLabel="Search route stops"
              style={{
                flex: 1,
                fontSize: 13,
                paddingVertical: 9,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            />
            {/* Design FxSearchBar (flow-network.jsx:16-25) renders the scan
                affordance as a solid accent-filled pill: theme.accent
                background, accentInk text, borderRadius 8, padded. */}
            <Pressable
              onPress={props.onOpenScan}
              accessibilityRole="button"
              accessibilityLabel="Scan parcel"
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                columnGap: MOBILE_V2_SPACING.md,
                backgroundColor: theme.accent,
                height: 32,
                borderRadius: 8,
                paddingHorizontal: MOBILE_V2_SPACING.xl,
              }}
            >
              <FxIcon name="scan" size={14} color={theme.accentInk} stroke={2.4} />
              <Text
                style={{
                  fontSize: 11.5,
                  color: theme.accentInk,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Scan parcel
              </Text>
            </Pressable>
          </View>

          {props.manifestSummary ? (
            <RouteManifestStrip
              theme={theme}
              summary={props.manifestSummary}
              onConfirmDeparture={props.onConfirmDeparture}
              isConfirmingDeparture={props.isConfirmingDeparture}
            />
          ) : null}

          {/* Filter / Group / Sort / Density chip strip */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              columnGap: MOBILE_V2_SPACING.md,
              paddingVertical: MOBILE_V2_SPACING.sm,
            }}
            style={{ marginTop: MOBILE_V2_SPACING.sm }}
          >
            <FxChipButton
              theme={theme}
              icon="filter"
              label={filterCount > 0 ? `Filters · ${filterCount}` : "Filters"}
              active={filterCount > 0}
              onPress={props.onOpenFilters}
              accessibilityLabel="Open filters"
            />
            <FxChipButton
              theme={theme}
              icon="list"
              label={`Group: ${props.groupLabel}`}
              onPress={props.onOpenGroup}
              accessibilityLabel="Group by"
            />
            <FxChipButton
              theme={theme}
              icon="chevron-down"
              label={`Sort: ${props.sortLabel}`}
              onPress={props.onOpenSort}
              accessibilityLabel="Sort by"
            />
            <FxChipButton
              theme={theme}
              icon={compact ? "plus" : "minus"}
              label={compact ? "Compact" : "Comfy"}
              onPress={props.onToggleDensity}
              accessibilityLabel={`Density, currently ${compact ? "compact" : "comfy"}`}
            />
            {dirty ? (
              <FxChipButton
                theme={theme}
                icon="star"
                label="Save view"
                tone="accent"
                onPress={props.onSaveView}
                accessibilityLabel="Save current view"
              />
            ) : null}
          </ScrollView>
        </View>

        {/* Empty state OR stacked stop rows */}
        {rows.length === 0 ? (
          <View style={{ paddingHorizontal: 24, paddingVertical: 48, alignItems: "center" }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                backgroundColor: theme.surfaceAlt,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: MOBILE_V2_SPACING.xl,
              }}
            >
              <FxIcon name="search" size={26} color={theme.muted} />
            </View>
            <Text
              style={{
                fontSize: 15,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              No stops match this view
            </Text>
            <Text
              style={{
                fontSize: 12,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                textAlign: "center",
                marginTop: MOBILE_V2_SPACING.sm,
              }}
            >
              Clear filters or pick another saved view.
            </Text>
            <FxButton
              theme={theme}
              variant="soft"
              size="sm"
              icon="x"
              onPress={props.onClearFilters}
              accessibilityLabel="Clear filters"
              style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}
            >
              Clear filters
            </FxButton>
          </View>
        ) : groups !== undefined && groups.length > 0 ? (
          // Grouped sections — design flow-route.jsx:54-65: per-group
          // uppercase label + count chip + chevron, then the group's
          // stop rows. Mirrors the working Tasks precomputedGroups path.
          <View>
            {groups.map((group) => (
              <View key={group.key}>
                <FxRow
                  justify="space-between"
                  align="center"
                  style={{
                    paddingTop: 14,
                    paddingBottom: MOBILE_V2_SPACING.md,
                    paddingHorizontal: 16,
                  }}
                >
                  <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                    <Text
                      style={{
                        fontSize: 10,
                        color: theme.muted,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {group.label}
                    </Text>
                    <FxChip theme={theme} dense mono>
                      {String(group.rows.length)}
                    </FxChip>
                  </FxRow>
                  <FxIcon name="chevron-down" size={16} color={theme.muted} />
                </FxRow>
                <StopRows
                  theme={theme}
                  stops={group.rows}
                  compact={compact}
                  currency={currency}
                  onSelectStop={props.onSelectStop}
                />
              </View>
            ))}
          </View>
        ) : (
          <StopRows
            theme={theme}
            stops={rows}
            compact={compact}
            currency={currency}
            onSelectStop={props.onSelectStop}
          />
        )}
      </ScrollView>
    </View>
  );
}
