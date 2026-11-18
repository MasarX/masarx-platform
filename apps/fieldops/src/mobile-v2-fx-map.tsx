// Mobile V2 FxMap — pixel-faithful port of design source `_kit.jsx`
// FxMap. Renders a stylized cartographic background (grid + roads +
// route polyline + numbered stops) for the Map and TripNav screens.
//
// Production swaps this for a real map provider; this synthetic SVG is
// used by the audit gallery so the Map screen matches the FieldOps
// V2.html canvas frame-for-frame.

import * as React from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Path,
  Pattern,
  Rect,
  Text as SvgText,
} from "react-native-svg";

import {
  MOBILE_V2_FONT_MONO,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import {
  DEFAULT_MOBILE_MAP_POLICY,
  type MobileMapPolicy,
} from "./mobile-shell-policy";
import {
  buildRouteMapModel,
  type RouteMapCluster,
  type RouteMapPin,
} from "./mobile-shell-route-map";

export interface MobileV2FxMapProps {
  readonly theme: MobileV2Theme;
  /**
   * When true, renders the compact 380x200 variant used inside the
   * trip-nav preview card. Default false renders the full 380x600
   * canvas variant.
   */
  readonly mini?: boolean;
  readonly stops?: ReadonlyArray<{
    readonly id: string;
    readonly seq: number;
    readonly active?: boolean;
    readonly status?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
  }>;
  readonly mapPolicy?: MobileMapPolicy | null;
  readonly style?: StyleProp<ViewStyle>;
}

const STOPS_FULL: ReadonlyArray<{ readonly x: number; readonly y: number; readonly n: string }> =
  Object.freeze([
    Object.freeze({ x: 50, y: 540, n: "1" }),
    Object.freeze({ x: 110, y: 380, n: "2" }),
    Object.freeze({ x: 200, y: 240, n: "3" }),
    Object.freeze({ x: 260, y: 120, n: "4" }),
    Object.freeze({ x: 320, y: 60, n: "5" }),
  ]);

const ROUTE_PIN_ANCHORS: ReadonlyArray<{ readonly x: number; readonly y: number }> =
  Object.freeze([
    Object.freeze({ x: 50, y: 540 }),
    Object.freeze({ x: 110, y: 380 }),
    Object.freeze({ x: 200, y: 240 }),
    Object.freeze({ x: 260, y: 120 }),
    Object.freeze({ x: 320, y: 60 }),
    Object.freeze({ x: 336, y: 190 }),
    Object.freeze({ x: 232, y: 332 }),
    Object.freeze({ x: 94, y: 492 }),
  ]);

type CanvasPin = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly n: string;
  readonly seq: number;
  readonly active: boolean;
};

type CanvasCluster = {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly count: number;
};

function pctToCanvasX(value: number): number {
  return (value / 100) * 380;
}

function pctToCanvasY(value: number, mini: boolean): number {
  return (value / 100) * (mini ? 200 : 600);
}

function toCanvasPin(
  pin: RouteMapPin,
  stopsById: Map<string, NonNullable<MobileV2FxMapProps["stops"]>[number]>,
  mini: boolean,
): CanvasPin {
  const stop = stopsById.get(pin.id);
  const seq = stop?.seq ?? 0;
  return Object.freeze({
    id: pin.id,
    x: pctToCanvasX(pin.xPct),
    y: pctToCanvasY(pin.yPct, mini),
    n: seq > 0 ? String(seq) : "",
    seq,
    active: stop?.active === true,
  });
}

function toCanvasCluster(cluster: RouteMapCluster, mini: boolean): CanvasCluster {
  return Object.freeze({
    key: cluster.key,
    x: pctToCanvasX(cluster.xPct),
    y: pctToCanvasY(cluster.yPct, mini),
    count: cluster.count,
  });
}

function resolveCoordinatePins(
  stops: MobileV2FxMapProps["stops"],
  policy: MobileMapPolicy,
  mini: boolean,
): {
  readonly pins: readonly CanvasPin[];
  readonly clusters: readonly CanvasCluster[];
  readonly coordinateBacked: boolean;
} | null {
  if (stops === undefined || stops.length === 0) return null;
  const points = stops
    .filter(
      (stop) =>
        typeof stop.latitude === "number" &&
        Number.isFinite(stop.latitude) &&
        typeof stop.longitude === "number" &&
        Number.isFinite(stop.longitude),
    )
    .map((stop) => ({
      id: stop.id,
      latitude: stop.latitude as number,
      longitude: stop.longitude as number,
      status: stop.active === true ? "in_progress" : stop.status ?? null,
    }));
  const model = buildRouteMapModel(points, policy);
  if (model.mappableCount === 0) return null;
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  return Object.freeze({
    pins: Object.freeze(model.pins.map((pin) => toCanvasPin(pin, stopsById, mini))),
    clusters: Object.freeze(model.clusters.map((cluster) => toCanvasCluster(cluster, mini))),
    coordinateBacked: true,
  });
}

function resolveFallbackMapPins(
  stops: MobileV2FxMapProps["stops"],
): ReadonlyArray<CanvasPin> {
  if (stops === undefined || stops.length === 0) {
    return STOPS_FULL.map((s, index) => Object.freeze({
      id: `fallback-${index + 1}`,
      ...s,
      seq: index + 1,
      active: index === 0,
    }));
  }
  return stops.slice(0, ROUTE_PIN_ANCHORS.length).map((stop, index) => {
    const anchor = ROUTE_PIN_ANCHORS[index] ?? ROUTE_PIN_ANCHORS[ROUTE_PIN_ANCHORS.length - 1]!;
    return Object.freeze({
      id: stop.id,
      x: anchor.x,
      y: anchor.y,
      n: String(stop.seq),
      seq: stop.seq,
      active: stop.active === true,
    });
  });
}

function buildCoordinateRoutePath(pins: readonly CanvasPin[]): string | null {
  const ordered = pins
    .filter((pin) => Number.isFinite(pin.x) && Number.isFinite(pin.y))
    .slice()
    .sort((a, b) => a.seq - b.seq);
  if (ordered.length < 2) return null;
  return ordered
    .map((pin, index) => `${index === 0 ? "M" : "L"}${Math.round(pin.x)} ${Math.round(pin.y)}`)
    .join(" ");
}

/**
 * Route map canvas. Coordinates from the task resolver drive the visible
 * pins/clusters; fixed anchors are only used when no mappable coordinates
 * exist in the current route envelope.
 */
export function MobileV2FxMap(props: MobileV2FxMapProps): React.ReactElement {
  const { theme } = props;
  const stroke = theme.border;
  const mini = props.mini === true;
  const coordinateLayer = resolveCoordinatePins(
    props.stops,
    props.mapPolicy ?? DEFAULT_MOBILE_MAP_POLICY,
    mini,
  );
  const pins = coordinateLayer?.pins ?? resolveFallbackMapPins(props.stops);
  const clusters = coordinateLayer?.clusters ?? [];
  const routePath = coordinateLayer?.coordinateBacked === true
    ? buildCoordinateRoutePath(pins)
    : null;

  if (mini) {
    return (
      <View style={[{ flex: 1, backgroundColor: theme.mapBg }, props.style]}>
        <Svg
          viewBox="0 0 380 200"
          preserveAspectRatio="xMidYMid slice"
          width="100%"
          height="100%"
        >
          <Defs>
            <Pattern id="gridmini" width="32" height="32" patternUnits="userSpaceOnUse">
              <Path
                d="M32 0H0V32"
                fill="none"
                stroke={stroke}
                strokeWidth={0.5}
                opacity={0.5}
              />
            </Pattern>
          </Defs>
          <Rect width="380" height="200" fill="url(#gridmini)" />
          <Path
            d="M0 70 Q 120 60 380 130"
            stroke={stroke}
            strokeWidth={12}
            fill="none"
            opacity={0.7}
          />
          <Path
            d="M0 70 Q 120 60 380 130"
            stroke={theme.surface}
            strokeWidth={8}
            fill="none"
          />
          <Path
            d="M40 0 Q 80 100 200 160 Q 300 200 380 180"
            stroke={stroke}
            strokeWidth={9}
            fill="none"
            opacity={0.6}
          />
          <Path
            d="M40 0 Q 80 100 200 160 Q 300 200 380 180"
            stroke={theme.surface}
            strokeWidth={5}
            fill="none"
          />
          <Path
            d={routePath ?? "M260 30 Q 200 90 190 150"}
            stroke={theme.mapRoute}
            strokeWidth={3.5}
            fill="none"
            strokeDasharray={routePath ? undefined : "6 4"}
            strokeLinecap="round"
          />
          {clusters.map((cluster) => (
            <G key={cluster.key}>
              <Circle cx={cluster.x} cy={cluster.y} r={16} fill={theme.mapRoute} opacity={0.2} />
              <Circle cx={cluster.x} cy={cluster.y} r={11} fill={theme.surface} stroke={theme.mapRoute} strokeWidth={2} />
              <SvgText
                x={cluster.x}
                y={cluster.y + 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight="bold"
                fill={theme.ink}
                fontFamily={MOBILE_V2_FONT_MONO}
              >
                {cluster.count}
              </SvgText>
            </G>
          ))}
          {pins.map((pin) => (
            <G key={pin.id}>
              {pin.active ? <Circle cx={pin.x} cy={pin.y} r={18} fill={theme.accent} opacity={0.18} /> : null}
              <Circle
                cx={pin.x}
                cy={pin.y}
                r={11}
                fill={theme.surface}
                stroke={pin.active ? theme.accent : theme.mapRoute}
                strokeWidth={pin.active ? 3 : 2.25}
              />
              <SvgText
                x={pin.x}
                y={pin.y + 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight="bold"
                fill={theme.ink}
                fontFamily={MOBILE_V2_FONT_MONO}
              >
                {pin.n}
              </SvgText>
            </G>
          ))}
          <Circle cx={pins[0]?.x ?? 260} cy={pins[0]?.y ?? 30} r={20} fill={theme.accent} opacity={0.18} />
          <Circle cx={pins[0]?.x ?? 260} cy={pins[0]?.y ?? 30} r={6} fill={theme.accent} />
        </Svg>
      </View>
    );
  }

  return (
    <View style={[{ flex: 1, backgroundColor: theme.mapBg }, props.style]}>
      <Svg
        viewBox="0 0 380 600"
        preserveAspectRatio="xMidYMid slice"
        width="100%"
        height="100%"
      >
        <Defs>
          <Pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <Path
              d="M40 0H0V40"
              fill="none"
              stroke={stroke}
              strokeWidth={0.5}
              opacity={0.6}
            />
          </Pattern>
        </Defs>
        <Rect width="380" height="600" fill="url(#grid)" />
        {/* Roads — outer stroke (border) + inner highlight (surface) */}
        <Path
          d="M0 120 Q 120 110 380 200"
          stroke={stroke}
          strokeWidth={14}
          fill="none"
          opacity={0.7}
        />
        <Path
          d="M0 120 Q 120 110 380 200"
          stroke={theme.surface}
          strokeWidth={9}
          fill="none"
        />
        <Path
          d="M40 0 Q 60 200 200 320 Q 320 400 380 380"
          stroke={stroke}
          strokeWidth={10}
          fill="none"
          opacity={0.7}
        />
        <Path
          d="M40 0 Q 60 200 200 320 Q 320 400 380 380"
          stroke={theme.surface}
          strokeWidth={6}
          fill="none"
        />
        <Path
          d="M0 480 Q 200 460 380 510"
          stroke={stroke}
          strokeWidth={8}
          fill="none"
          opacity={0.6}
        />
        <Path
          d="M0 480 Q 200 460 380 510"
          stroke={theme.surface}
          strokeWidth={5}
          fill="none"
        />
        <Path
          d="M250 0 Q 270 250 230 600"
          stroke={stroke}
          strokeWidth={8}
          fill="none"
          opacity={0.6}
        />
        <Path
          d="M250 0 Q 270 250 230 600"
          stroke={theme.surface}
          strokeWidth={5}
          fill="none"
        />
        {/* Route polyline */}
        <Path
          d={routePath ?? "M50 540 Q 120 480 110 380 Q 100 280 200 240 Q 280 210 260 120 Q 250 80 320 60"}
          stroke={theme.mapRoute}
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
        />
        {clusters.map((cluster) => (
          <G key={cluster.key}>
            <Circle cx={cluster.x} cy={cluster.y} r={22} fill={theme.mapRoute} opacity={0.2} />
            <Circle cx={cluster.x} cy={cluster.y} r={16} fill={theme.surface} stroke={theme.mapRoute} strokeWidth={2.5} />
            <SvgText
              x={cluster.x}
              y={cluster.y + 5}
              textAnchor="middle"
              fontSize={12}
              fontWeight="bold"
              fill={theme.ink}
              fontFamily={MOBILE_V2_FONT_MONO}
            >
              {cluster.count}
            </SvgText>
          </G>
        ))}
        {/* Numbered stops from the resolver-backed route projection. */}
        {pins.map((s, index) => (
          <G key={`${s.id}-${index}`}>
            {s.active ? <Circle cx={s.x} cy={s.y} r={22} fill={theme.accent} opacity={0.18} /> : null}
            <Circle
              cx={s.x}
              cy={s.y}
              r={14}
              fill={theme.surface}
              stroke={s.active ? theme.accent : theme.mapRoute}
              strokeWidth={s.active ? 3 : 2.5}
            />
            <SvgText
              x={s.x}
              y={s.y + 5}
              textAnchor="middle"
              fontSize={13}
              fontWeight="bold"
              fill={theme.ink}
              fontFamily={MOBILE_V2_FONT_MONO}
            >
              {s.n}
            </SvgText>
          </G>
        ))}
        {/* Driver position halo */}
        <Circle cx={pins[0]?.x ?? 50} cy={pins[0]?.y ?? 540} r={22} fill={theme.accent} opacity={0.18} />
        <Circle cx={pins[0]?.x ?? 50} cy={pins[0]?.y ?? 540} r={6} fill={theme.accent} />
      </Svg>
    </View>
  );
}
