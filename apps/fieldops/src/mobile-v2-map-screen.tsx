// Mobile V2 Map screen — pixel-faithful port of design source
// flow-route.jsx ScrMap. Live route surface: a base map placeholder with
// floating traffic/hazard chips, a right-rail control stack (Follow /
// Layers / Re-optimize), a horizontal bottom carousel of upcoming stops,
// and a floating active-stop card with quick comm + open-stop CTA.
//
// The native route map is policy-driven: the shell resolves map_policy and
// renders the approved open stack metadata plus coordinate-backed route pins.
// This component keeps the visual canvas native-safe without binding to a
// proprietary SDK.

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
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  DEFAULT_MOBILE_MAP_POLICY,
  type MobileMapPolicy,
} from "./mobile-shell-policy";
import { MobileV2FxMap } from "./mobile-v2-fx-map";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import {
  formatMobileV2MapLocationChipLabel,
  formatMobileV2MapLocationCoordinateLine,
  formatMobileV2MapLocationIdentityLine,
  formatMobileV2MapStopCoordinateLine,
  formatMobileV2MapStopGeocodeLine,
  formatMobileV2MapStopShortAddress,
  resolveMobileV2RouteMapGeocodeReadbackStop,
} from "./mobile-v2-route-map-location";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2MapAlert {
  readonly id: string;
  readonly text: string;
  readonly icon?: MobileV2IconName;
  readonly tone?: "warning" | "info";
}

export interface MobileV2MapStop {
  readonly id: string;
  readonly seq: number;
  readonly customer: string;
  readonly address: string;
  readonly sla: string;
  readonly etaMin: number;
  readonly distanceKm: number;
  readonly cod: number;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly accuracyM?: number | null;
  readonly shortAddress?: string | null;
  readonly geocodingStatus?: string | null;
  readonly geocodingAccuracy?: string | null;
  readonly geocodingProvider?: string | null;
  readonly geocodingMatch?: string | null;
}

export interface MobileV2MapLocationReadback {
  readonly status: "idle" | "saving" | "saved" | "error";
  readonly pingId: string | null;
  readonly capturedAt: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyM: number | null;
  readonly routeStopLabel: string | null;
  readonly message: string | null;
}

export interface MobileV2MapScreenProps {
  readonly theme: MobileV2Theme;
  readonly routeId: string;
  readonly pendingCount: number;
  readonly distanceLeftKm: number;
  readonly alerts: ReadonlyArray<MobileV2MapAlert>;
  readonly mapStops?: ReadonlyArray<MobileV2MapStop>;
  readonly upcoming: ReadonlyArray<MobileV2MapStop>;
  readonly active: MobileV2MapStop | null;
  readonly mapPolicy?: MobileMapPolicy | null;
  readonly followEnabled: boolean;
  readonly trafficEnabled: boolean;
  readonly locationReadback?: MobileV2MapLocationReadback | null;
  readonly currency?: string;
  readonly onToggleFollow?: () => void;
  readonly onToggleTraffic?: () => void;
  readonly onRecordLocation?: () => void;
  readonly onOptimize?: () => void;
  readonly onOpenList?: () => void;
  readonly onSelectStop?: (id: string) => void;
  readonly onCallActive?: () => void;
  readonly onMessageActive?: () => void;
  readonly onOpenActive?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function MapBtn(props: {
  readonly theme: MobileV2Theme;
  readonly icon: MobileV2IconName;
  readonly active?: boolean;
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
}): React.ReactElement {
  const { theme: t } = props;
  const isActive = props.active === true;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: isActive ? t.accent : t.surface,
        borderColor: isActive ? t.accent : t.border,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <FxIcon name={props.icon} size={18} color={isActive ? t.accentInk : t.ink} />
    </Pressable>
  );
}

function resolveAlertTone(tone: "warning" | "info" | undefined): FxChipTone {
  return tone === "warning" ? "warning" : "info";
}

function formatProviderToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "maplibre") return "MapLibre";
  if (normalized === "openstreetmap") return "OpenStreetMap";
  if (normalized === "postgis") return "PostGIS";
  if (normalized === "valhalla") return "Valhalla";
  if (normalized === "vroom") return "VROOM";
  return value.trim();
}

function formatMobileMapProviderLabel(policy: MobileMapPolicy): string {
  return `${formatProviderToken(policy.tileProvider.engine)} - ${formatProviderToken(policy.tileProvider.provider)}`;
}

function formatMobileMapStackLabel(policy: MobileMapPolicy): string {
  return [
    policy.logisticsStack.spatialSourceOfTruth,
    policy.logisticsStack.routingEngine,
    policy.logisticsStack.optimizationEngine,
  ]
    .map(formatProviderToken)
    .join(" - ");
}

export function MobileV2MapScreen(props: MobileV2MapScreenProps): React.ReactElement {
  const { theme, alerts, upcoming, active } = props;
  const mapStops = props.mapStops ?? upcoming;
  const mapPolicy = props.mapPolicy ?? DEFAULT_MOBILE_MAP_POLICY;
  const providerLabel = formatMobileMapProviderLabel(mapPolicy);
  const stackLabel = formatMobileMapStackLabel(mapPolicy);
  const attributionLabel = mapPolicy.tileProvider.attributionLabel;
  const currency = props.currency ?? "SAR";
  const location = props.locationReadback ?? null;
  const readbackStop = resolveMobileV2RouteMapGeocodeReadbackStop(active, mapStops);
  const readbackCoordinateLine =
    readbackStop !== null ? formatMobileV2MapStopCoordinateLine(readbackStop) : null;
  const readbackGeocodeLine =
    readbackStop !== null ? formatMobileV2MapStopGeocodeLine(readbackStop) : null;
  const readbackShortAddress =
    readbackStop !== null ? formatMobileV2MapStopShortAddress(readbackStop) : null;
  const topReadbackVisible = active === null && readbackStop !== null;
  const locationTone: FxChipTone =
    location?.status === "error"
      ? "danger"
      : location?.status === "saved"
        ? "success"
        : location?.status === "saving"
          ? "info"
          : "neutral";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* In-body header strip stripped — the gallery / host ScreenShell now
          renders the title ("Live route") and subtitle (routeId · pending ·
          km left) via FxAppBar. The "Open list" Pressable (FxIcon "list")
          used to live in this header; the host should re-surface it via the
          AppBar `right` prop (wires to props.onOpenList). */}

      {/* Native V2 route map surface.
          Resolver-backed coordinates drive pins when present; fixed anchors
          remain only when the route has no mappable coordinate readback. */}
      <View style={{ flex: 1, backgroundColor: theme.mapBg }}>
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
          <MobileV2FxMap
            theme={theme}
            mapPolicy={mapPolicy}
            stops={mapStops.map((s) => ({
              id: s.id,
              seq: s.seq,
              active: active !== null && active.id === s.id,
              status: active !== null && active.id === s.id ? "in_progress" : s.geocodingStatus,
              latitude: s.latitude ?? null,
              longitude: s.longitude ?? null,
            }))}
          />
        </View>
        {/* Top floating alerts */}
        <View
          style={{
            position: "absolute",
            top: 10,
            left: 12,
            right: 12,
            flexDirection: "row",
            columnGap: MOBILE_V2_SPACING.md,
            rowGap: MOBILE_V2_SPACING.md,
            flexWrap: "wrap",
          }}
        >
          {alerts.map((a) => (
            <FxChip
              key={a.id}
              theme={theme}
              tone={resolveAlertTone(a.tone)}
              icon={a.icon ?? "alert"}
              dense
            >
              {a.text}
            </FxChip>
          ))}
          <FxChip theme={theme} tone="info" icon="layers" dense>
            {providerLabel}
          </FxChip>
          <FxChip theme={theme} tone="neutral" icon="route" dense>
            {stackLabel}
          </FxChip>
          <FxChip theme={theme} tone="neutral" icon="pin" dense>
            {attributionLabel}
          </FxChip>
          {topReadbackVisible && readbackShortAddress !== null ? (
            <FxChip theme={theme} tone="info" icon="pin" dense mono>
              {readbackShortAddress}
            </FxChip>
          ) : null}
          {topReadbackVisible && readbackCoordinateLine !== null ? (
            <FxChip theme={theme} tone="neutral" icon="locate" dense mono>
              {readbackCoordinateLine}
            </FxChip>
          ) : null}
          {topReadbackVisible && readbackGeocodeLine !== null ? (
            <FxChip theme={theme} tone="warning" icon="alert" dense>
              {readbackGeocodeLine}
            </FxChip>
          ) : null}
          {location !== null && location.status !== "idle" ? (
            <FxChip
              theme={theme}
              tone={locationTone}
              icon={location.status === "saving" ? "locate" : location.status === "error" ? "alert" : "check"}
              dense
              mono
            >
              {formatMobileV2MapLocationChipLabel(location)}
            </FxChip>
          ) : null}
        </View>

        {/* Right rail control stack */}
        <View
          style={{
            position: "absolute",
            top: 60,
            right: 12,
            rowGap: MOBILE_V2_SPACING.lg,
          }}
        >
          <MapBtn
            theme={theme}
            icon="locate"
            active={props.followEnabled}
            onPress={props.onToggleFollow}
            accessibilityLabel="Follow my location"
          />
          <MapBtn
            theme={theme}
            icon="layers"
            active={props.trafficEnabled}
            onPress={props.onToggleTraffic}
            accessibilityLabel="Toggle traffic layer"
          />
          <MapBtn
            theme={theme}
            icon="route"
            onPress={props.onOptimize}
            accessibilityLabel="Re-optimize route"
          />
          <MapBtn
            theme={theme}
            icon="pin"
            active={location?.status === "saved"}
            onPress={props.onRecordLocation}
            accessibilityLabel="Save current location"
          />
        </View>

        {/* Bottom mini-stops carousel */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 12,
            columnGap: MOBILE_V2_SPACING.lg,
          }}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: active !== null ? 186 : 12,
          }}
        >
          {upcoming.map((s) => {
            const isActive = active !== null && s.id === active.id;
            return (
              <Pressable
                key={s.id}
                onPress={() => props.onSelectStop?.(s.id)}
                accessibilityRole="button"
                accessibilityLabel={`Stop ${s.seq}, ${s.customer}`}
                style={{
                  // Design canvas FxMap carousel card uses content-box
                  // sizing with minWidth:128 + padding 10/10 + border 1/1,
                  // so the rendered card is 128 + 20 + 2 = 150. RN is
                  // border-box, so the literal minWidth carries the full
                  // box to keep the card pitch matching the design.
                  minWidth: 150,
                  backgroundColor: theme.surface,
                  borderColor: isActive ? theme.accent : theme.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                }}
              >
                <Text
                  style={{
                    fontSize: 9,
                    color: theme.muted,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.5,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  STOP {s.seq} · {s.sla}
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    marginTop: 2,
                  }}
                  numberOfLines={1}
                >
                  {s.customer}
                </Text>
                <Text
                  style={{
                    fontSize: 10,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {s.etaMin > 0 ? `+${s.etaMin}m` : "now"} · {s.distanceKm.toFixed(1)} km
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Floating active stop card */}
        {active !== null ? (
          <View
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              bottom: 12,
            }}
          >
            <FxCard theme={theme} accent>
              <FxRow justify="space-between" align="center">
                <Text
                  style={{
                    fontSize: 10,
                    color: theme.accent,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Stop {active.seq} · {active.sla}
                </Text>
                <FxRow gap={MOBILE_V2_SPACING.md}>
                  {active.cod > 0 ? (
                    <FxChip theme={theme} tone="accent" icon="cash" dense mono>
                      {/* Design ScrMap (flow-route.jsx:267) renders the
                          active-stop COD chip as the raw value + ﷼
                          (`{active.cod} ﷼`) — no thousands separator. */}
                      {formatMobileV2CurrencyCompact(active.cod, currency, { grouped: false })}
                    </FxChip>
                  ) : null}
                  <FxChip theme={theme} dense mono>
                    {active.etaMin > 0 ? `+${active.etaMin}m` : "now"}
                  </FxChip>
                </FxRow>
              </FxRow>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  marginTop: MOBILE_V2_SPACING.md,
                }}
              >
                {active.customer}
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  marginTop: 2,
                }}
              >
                {active.address}
              </Text>
              {readbackShortAddress !== null ||
              readbackCoordinateLine !== null ||
              readbackGeocodeLine !== null ? (
                <View
                  style={{
                    marginTop: MOBILE_V2_SPACING.lg,
                    flexDirection: "row",
                    flexWrap: "wrap",
                    columnGap: MOBILE_V2_SPACING.md,
                    rowGap: MOBILE_V2_SPACING.md,
                  }}
                >
                  {readbackShortAddress !== null ? (
                    <FxChip theme={theme} tone="info" icon="pin" dense mono>
                      {readbackShortAddress}
                    </FxChip>
                  ) : null}
                  {readbackCoordinateLine !== null ? (
                    <FxChip theme={theme} tone="neutral" icon="locate" dense mono>
                      {readbackCoordinateLine}
                    </FxChip>
                  ) : null}
                  {readbackGeocodeLine !== null ? (
                    <FxChip theme={theme} tone="warning" icon="alert" dense>
                      {readbackGeocodeLine}
                    </FxChip>
                  ) : null}
                </View>
              ) : null}
              {location !== null && location.status === "saved" ? (
                <View
                  style={{
                    marginTop: MOBILE_V2_SPACING.xl,
                    padding: MOBILE_V2_SPACING.lg,
                    backgroundColor: theme.successSoft,
                    borderColor: theme.success,
                    borderWidth: 1,
                    borderRadius: 10,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 10,
                      color: theme.success,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    Latest location saved
                  </Text>
                  <Text
                    style={{
                      fontSize: 11,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      marginTop: 2,
                    }}
                  >
                    {formatMobileV2MapLocationIdentityLine(location, active.seq)}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_MONO,
                      marginTop: 2,
                    }}
                  >
                    {formatMobileV2MapLocationCoordinateLine(location)}
                  </Text>
                </View>
              ) : null}
              <FxRow gap={MOBILE_V2_SPACING.lg} style={{ marginTop: MOBILE_V2_SPACING["2xl"] }}>
                <FxButton
                  theme={theme}
                  variant="ghost"
                  size="sm"
                  icon="phone"
                  onPress={props.onCallActive}
                  accessibilityLabel={`Call ${active.customer}`}
                >
                  Call
                </FxButton>
                <FxButton
                  theme={theme}
                  variant="ghost"
                  size="sm"
                  icon="message"
                  onPress={props.onMessageActive}
                  accessibilityLabel={`Notify ${active.customer}`}
                >
                  Notify
                </FxButton>
                <FxButton
                  theme={theme}
                  variant="ghost"
                  size="sm"
                  icon="pin"
                  onPress={props.onRecordLocation}
                  disabled={location?.status === "saving"}
                  accessibilityLabel="Save current location"
                >
                  {location?.status === "saving" ? "Saving" : "Save location"}
                </FxButton>
                <FxButton
                  theme={theme}
                  variant="primary"
                  size="sm"
                  full
                  iconRight="arrow-right"
                  onPress={props.onOpenActive}
                  accessibilityLabel="Open stop detail"
                  style={{ flex: 1 }}
                >
                  Open stop
                </FxButton>
              </FxRow>
            </FxCard>
          </View>
        ) : null}
      </View>
    </View>
  );
}
