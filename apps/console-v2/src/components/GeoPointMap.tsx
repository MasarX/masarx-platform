import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { MapLibreBackdrop } from './MapLibreBackdrop';
import { useT } from '@/lib/i18n';
import { OpenStreetMapAttribution, type MapBounds } from './OpenStreetMapTileLayer';

export type GeoPointTone = 'good' | 'warn' | 'danger' | 'info' | 'neutral';

export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  detail?: string;
  tone?: GeoPointTone;
}

interface GeoPointMapProps {
  points: GeoPoint[];
  bounds?: MapBounds | null;
  selectedId?: string | null;
  onSelect?: (pointId: string) => void;
  height?: number;
  title?: string;
  emptyLabel?: string;
  tileUrlTemplate?: string | null;
  allowedTileHosts?: string[] | null;
  tileUsageTier?: string | null;
  tileCacheRequired?: boolean | null;
  sameOriginProxyAllowed?: boolean | null;
  tileAttributionLabel?: string | null;
  tileAttributionUrl?: string | null;
}

const VIEW_W = 1000;
const VIEW_H = 420;
const MIN_LAT_SPAN = 0.002;
const MIN_LNG_SPAN = 0.002;
const MAX_LAT_SPAN = 170.1022;
const MAX_LNG_SPAN = 360;

function validPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -85.0511 &&
    point.lat <= 85.0511 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

function normalizeBounds(bounds?: MapBounds | null): MapBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.minLat) ||
    !Number.isFinite(bounds.maxLat) ||
    !Number.isFinite(bounds.minLng) ||
    !Number.isFinite(bounds.maxLng) ||
    bounds.maxLat <= bounds.minLat ||
    bounds.maxLng <= bounds.minLng
  ) {
    return null;
  }
  return bounds;
}

function autoBounds(points: GeoPoint[], configured?: MapBounds | null): MapBounds | null {
  const valid = points.filter(validPoint);
  if (!valid.length) return normalizeBounds(configured);
  const minLat = Math.min(...valid.map((point) => point.lat));
  const maxLat = Math.max(...valid.map((point) => point.lat));
  const minLng = Math.min(...valid.map((point) => point.lng));
  const maxLng = Math.max(...valid.map((point) => point.lng));
  const latPad = Math.max((maxLat - minLat) * 0.18, 0.006);
  const lngPad = Math.max((maxLng - minLng) * 0.18, 0.008);
  return {
    minLat: Math.max(-85.0511, minLat - latPad),
    maxLat: Math.min(85.0511, maxLat + latPad),
    minLng: Math.max(-180, minLng - lngPad),
    maxLng: Math.min(180, maxLng + lngPad),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampBounds(bounds: MapBounds): MapBounds {
  const latSpan = clamp(bounds.maxLat - bounds.minLat, MIN_LAT_SPAN, MAX_LAT_SPAN);
  const lngSpan = clamp(bounds.maxLng - bounds.minLng, MIN_LNG_SPAN, MAX_LNG_SPAN);
  const latCenter = clamp((bounds.minLat + bounds.maxLat) / 2, -85.0511 + latSpan / 2, 85.0511 - latSpan / 2);
  const lngCenter = clamp((bounds.minLng + bounds.maxLng) / 2, -180 + lngSpan / 2, 180 - lngSpan / 2);
  return {
    minLat: latCenter - latSpan / 2,
    maxLat: latCenter + latSpan / 2,
    minLng: lngCenter - lngSpan / 2,
    maxLng: lngCenter + lngSpan / 2,
  };
}

function zoomBounds(bounds: MapBounds, factor: number): MapBounds {
  const latCenter = (bounds.minLat + bounds.maxLat) / 2;
  const lngCenter = (bounds.minLng + bounds.maxLng) / 2;
  const latSpan = (bounds.maxLat - bounds.minLat) * factor;
  const lngSpan = (bounds.maxLng - bounds.minLng) * factor;
  return clampBounds({
    minLat: latCenter - latSpan / 2,
    maxLat: latCenter + latSpan / 2,
    minLng: lngCenter - lngSpan / 2,
    maxLng: lngCenter + lngSpan / 2,
  });
}

function panBounds(bounds: MapBounds, deltaX: number, deltaY: number, width: number, height: number): MapBounds {
  const lngDelta = (deltaX / Math.max(width, 1)) * (bounds.maxLng - bounds.minLng);
  const latDelta = (deltaY / Math.max(height, 1)) * (bounds.maxLat - bounds.minLat);
  return clampBounds({
    minLat: bounds.minLat + latDelta,
    maxLat: bounds.maxLat + latDelta,
    minLng: bounds.minLng - lngDelta,
    maxLng: bounds.maxLng - lngDelta,
  });
}

function project(point: GeoPoint, bounds: MapBounds): { x: number; y: number } {
  const lngSpan = bounds.maxLng - bounds.minLng || 1;
  const latSpan = bounds.maxLat - bounds.minLat || 1;
  return {
    x: ((point.lng - bounds.minLng) / lngSpan) * VIEW_W,
    y: VIEW_H - ((point.lat - bounds.minLat) / latSpan) * VIEW_H,
  };
}

function markerClass(tone: GeoPointTone | undefined, selected: boolean): string {
  return [
    'geo-point-map__marker',
    `geo-point-map__marker--${tone ?? 'neutral'}`,
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function GeoPointMap({
  points,
  bounds,
  selectedId,
  onSelect,
  height = 300,
  title = 'Geographic coverage map',
  emptyLabel = 'No geocoded points to plot yet.',
  tileUrlTemplate,
  allowedTileHosts,
  tileUsageTier,
  tileCacheRequired,
  sameOriginProxyAllowed,
  tileAttributionLabel,
  tileAttributionUrl,
}: GeoPointMapProps) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; bounds: MapBounds } | null>(null);
  const [viewBounds, setViewBounds] = useState<MapBounds | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const plottedPoints = useMemo(() => points.filter(validPoint), [points]);
  const effectiveBounds = useMemo(() => autoBounds(plottedPoints, bounds), [bounds, plottedPoints]);

  useEffect(() => {
    setViewBounds(effectiveBounds ? clampBounds(effectiveBounds) : null);
  }, [effectiveBounds]);

  const activeBounds = viewBounds ?? effectiveBounds;

  const handleZoom = useCallback((factor: number) => {
    setViewBounds((current) => {
      const next = current ?? effectiveBounds;
      return next ? zoomBounds(next, factor) : next;
    });
  }, [effectiveBounds]);

  const handleReset = () => {
    setViewBounds(effectiveBounds ? clampBounds(effectiveBounds) : null);
  };

  const handleWheelDelta = useCallback(
    (deltaY: number) => {
      if (!activeBounds) return;
      handleZoom(deltaY > 0 ? 1.15 : 0.85);
    },
    [activeBounds, handleZoom],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      handleWheelDelta(event.deltaY);
    };
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheelDelta]);

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!activeBounds) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      bounds: activeBounds,
    };
    setGrabbing(true);
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    setViewBounds(
      panBounds(
        dragRef.current.bounds,
        event.clientX - dragRef.current.x,
        event.clientY - dragRef.current.y,
        rect.width,
        rect.height,
      ),
    );
  };

  const handleMouseUp = () => {
    dragRef.current = null;
    setGrabbing(false);
  };

  return (
    <div className="geo-point-map" data-testid="geo-point-map" style={{ minHeight: height }}>
      <div
        ref={viewportRef}
        className={'geo-point-map__viewport' + (grabbing ? ' is-grabbing' : '')}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {activeBounds ? (
        <>
          <MapLibreBackdrop
            bounds={activeBounds}
            width={VIEW_W}
            height={VIEW_H}
            tileUrlTemplate={tileUrlTemplate}
            allowedTileHosts={allowedTileHosts}
            usageTier={tileUsageTier}
            cacheRequired={tileCacheRequired}
            sameOriginProxyAllowed={sameOriginProxyAllowed}
            attributionLabel={tileAttributionLabel}
            attributionUrl={tileAttributionUrl}
            fallbackWashClassName="geo-point-map__tile-wash"
            fallbackGridClassName="geo-point-map__fallback-grid"
          />
          <svg
            ref={svgRef}
            className="geo-point-map__svg"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="application"
            aria-label={title}
          >
            {plottedPoints.map((point) => {
              const { x, y } = project(point, activeBounds);
              const selected = selectedId === point.id;
              return (
                <g
                  key={point.id}
                  className={markerClass(point.tone, selected)}
                  transform={`translate(${x} ${y})`}
                  role={onSelect ? 'button' : 'img'}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-label={`${point.label}${point.detail ? `, ${point.detail}` : ''}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => onSelect?.(point.id)}
                  onKeyDown={(event) => {
                    if (!onSelect) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onSelect(point.id);
                  }}
                >
                  <circle r={selected ? 13 : 10} />
                  <circle r={selected ? 4.5 : 3.5} className="geo-point-map__marker-core" />
                  <text x={15} y={4}>{point.label}</text>
                </g>
              );
            })}
          </svg>
          <div className="geo-point-map__controls" aria-label={t('shell.map.controls')}>
            <button
              type="button"
              className="geo-point-map__btn"
              aria-label={t('shell.map.zoomIn')}
              onClick={() => handleZoom(0.85)}
            >
              +
            </button>
            <button
              type="button"
              className="geo-point-map__btn"
              aria-label={t('shell.map.zoomOut')}
              onClick={() => handleZoom(1.15)}
            >
              -
            </button>
            <button
              type="button"
              className="geo-point-map__btn geo-point-map__btn--reset"
              aria-label={t('shell.map.resetView')}
              onClick={handleReset}
            >
              {t('shell.map.reset')}
            </button>
          </div>
        </>
        ) : (
        <div className="maplibre-backdrop" data-engine="maplibre" data-policy-status="blocked">
          <div className="maplibre-backdrop__policy-error" role="status">
            <span className="mono">{t('shell.map.setupNeeded')}</span>
            <small>{t('shell.map.setupHint')}</small>
          </div>
        </div>
        )}
        {plottedPoints.length === 0 ? (
          <div className="geo-point-map__empty" role="status">{emptyLabel}</div>
        ) : null}
        <OpenStreetMapAttribution
          className="geo-point-map__attribution"
          label={tileAttributionLabel}
          url={tileAttributionUrl}
        />
      </div>
    </div>
  );
}
