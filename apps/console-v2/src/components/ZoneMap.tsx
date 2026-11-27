// ZoneMap.tsx — free/open-source map-backed polygon canvas.
//
// Each zone is a polygon; tone defines fill (with 25% alpha) + solid stroke.
// Selected zone gets a thicker stroke and a soft drop-shadow filter.
//
// Pan/zoom is implemented inline (no Mapbox / no Leaflet) — wheel zooms about
// the cursor; drag pans the viewBox. Arrow keys move focus across the zone
// list (sorted by id) so keyboard users can step through every region.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { getLookups } from '@/lib/api';
import { MapLibreBackdrop } from './MapLibreBackdrop';
import { useT } from '@/lib/i18n';
import { OpenStreetMapAttribution, type MapBounds } from './OpenStreetMapTileLayer';

export type ZoneTone = 'good' | 'warn' | 'danger' | 'neutral';

export interface ZonePolygon {
  id: string;
  name: string;
  /** Lng/lat (or normalized 0..1) coordinate pairs. */
  paths: Array<[number, number]>;
  tone?: ZoneTone;
}

export type ZoneMapBounds = MapBounds;

export interface ZoneMapProps {
  zones: ZonePolygon[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  bounds?: ZoneMapBounds;
  className?: string;
  /** Optional fixed viewport height in px. */
  height?: number;
  /** When true, renders the zone names inside polygons (default true). */
  labels?: boolean;
  tileUrlTemplate?: string | null;
  allowedTileHosts?: string[] | null;
  tileUsageTier?: string | null;
  tileCacheRequired?: boolean | null;
  sameOriginProxyAllowed?: boolean | null;
  tileAttributionLabel?: string | null;
  tileAttributionUrl?: string | null;
}

const VIEW_W = 1000;
const VIEW_H = 600;

function autoBounds(zones: ZonePolygon[]): ZoneMapBounds | null {
  if (zones.length === 0) {
    return null;
  }
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const z of zones) {
    for (const [lng, lat] of z.paths) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  // Pad 5% on each side so polygons don't kiss the viewport edge.
  const dx = (maxLng - minLng) * 0.05 || 0.05;
  const dy = (maxLat - minLat) * 0.05 || 0.05;
  return {
    minLng: minLng - dx,
    maxLng: maxLng + dx,
    minLat: minLat - dy,
    maxLat: maxLat + dy,
  };
}

function projectPoint(
  [lng, lat]: [number, number],
  b: ZoneMapBounds,
): [number, number] {
  const w = b.maxLng - b.minLng || 1;
  const h = b.maxLat - b.minLat || 1;
  // Latitude grows up; SVG y grows down — invert.
  const x = ((lng - b.minLng) / w) * VIEW_W;
  const y = VIEW_H - ((lat - b.minLat) / h) * VIEW_H;
  return [x, y];
}

function centroid(points: Array<[number, number]>): [number, number] {
  if (points.length === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  return [sx / points.length, sy / points.length];
}

export function ZoneMap({
  zones,
  selectedId,
  onSelect,
  bounds,
  className,
  height = 360,
  labels = true,
  tileUrlTemplate,
  allowedTileHosts,
  tileUsageTier,
  tileCacheRequired,
  sameOriginProxyAllowed,
  tileAttributionLabel,
  tileAttributionUrl,
}: ZoneMapProps) {
  const t = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number }>({
    x: 0,
    y: 0,
    w: VIEW_W,
    h: VIEW_H,
  });
  const [grabbing, setGrabbing] = useState(false);

  const effectiveBounds = useMemo(() => bounds ?? autoBounds(zones), [bounds, zones]);
  const hasMapBounds = effectiveBounds != null;

  const projected = useMemo(
    () => {
      if (!effectiveBounds) return [];
      return zones.map((z) => ({
        ...z,
        points: z.paths.map((p) => projectPoint(p, effectiveBounds)),
      }));
    },
    [zones, effectiveBounds],
  );

  const handleWheelDelta = useCallback(
    (deltaY: number) => {
      const factor = deltaY > 0 ? 1.1 : 0.9;
      setViewBox((prev) => {
        const newW = Math.max(50, Math.min(prev.w * factor, VIEW_W * 4));
        const newH = Math.max(30, Math.min(prev.h * factor, VIEW_H * 4));
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
      });
    },
    [],
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

  const dragRef = useRef<{ x: number; y: number; vbx: number; vby: number } | null>(null);
  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      vbx: viewBox.x,
      vby: viewBox.y,
    };
    setGrabbing(true);
  };
  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    const scaleX = viewBox.w / (svgRef.current?.clientWidth || VIEW_W);
    const scaleY = viewBox.h / (svgRef.current?.clientHeight || VIEW_H);
    setViewBox((prev) => ({
      ...prev,
      x: dragRef.current!.vbx - dx * scaleX,
      y: dragRef.current!.vby - dy * scaleY,
    }));
  };
  const handleMouseUp = () => {
    dragRef.current = null;
    setGrabbing(false);
  };

  const sortedZones = useMemo(() => projected.slice().sort((a, b) => a.id.localeCompare(b.id)), [projected]);

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, zoneId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(zoneId);
      return;
    }
    let delta = 0;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') delta = 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') delta = -1;
    if (delta === 0) return;
    event.preventDefault();
    const idx = sortedZones.findIndex((z) => z.id === zoneId);
    const nextIdx = (idx + delta + sortedZones.length) % sortedZones.length;
    const nextId = sortedZones[nextIdx]?.id;
    if (!nextId) return;
    const target = svgRef.current?.querySelector<SVGGElement>(`[data-zone-id="${nextId}"]`);
    target?.focus();
  };

  const handleZoom = (factor: number) => {
    setViewBox((prev) => {
      const newW = Math.max(50, Math.min(prev.w * factor, VIEW_W * 4));
      const newH = Math.max(30, Math.min(prev.h * factor, VIEW_H * 4));
      const cx = prev.x + prev.w / 2;
      const cy = prev.y + prev.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  };
  const handleReset = () =>
    setViewBox({ x: 0, y: 0, w: VIEW_W, h: VIEW_H });

  const wrapClasses = ['primitive-zonemap', className].filter(Boolean).join(' ');

  return (
    <div className={wrapClasses}>
      <div
        className={'primitive-zonemap__viewport' + (grabbing ? ' is-grabbing' : '')}
        style={{ height }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {hasMapBounds ? (
          <MapLibreBackdrop
            bounds={effectiveBounds}
            width={VIEW_W}
            height={VIEW_H}
            tileUrlTemplate={tileUrlTemplate}
            allowedTileHosts={allowedTileHosts}
            usageTier={tileUsageTier}
            cacheRequired={tileCacheRequired}
            sameOriginProxyAllowed={sameOriginProxyAllowed}
            attributionLabel={tileAttributionLabel}
            attributionUrl={tileAttributionUrl}
            fallbackWashClassName="primitive-zonemap__tile-wash"
            fallbackGridClassName="primitive-zonemap__fallback-grid"
          />
        ) : (
          <div className="maplibre-backdrop" data-engine="maplibre" data-policy-status="blocked">
            <div className="maplibre-backdrop__policy-error" role="status">
              <span className="mono">{t('shell.map.zoneRequired')}</span>
              <small>{t('shell.map.zoneHint')}</small>
            </div>
          </div>
        )}
        <svg
          ref={svgRef}
          className="primitive-zonemap__svg"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="application"
          aria-label={t('shell.map.zoneLabel')}
        >
          {sortedZones.map((z) => {
            const tone = z.tone ?? 'neutral';
            const points = z.points.map(([x, y]) => `${x},${y}`).join(' ');
            const [cx, cy] = centroid(z.points);
            const isSelected = z.id === selectedId;
            return (
              <g
                key={z.id}
                data-zone-id={z.id}
                tabIndex={0}
                role="button"
                aria-label={z.name}
                aria-pressed={isSelected}
                onClick={() => onSelect?.(z.id)}
                onKeyDown={(e) => handleKeyDown(e, z.id)}
                style={{ outline: 'none' }}
              >
                <polygon
                  points={points}
                  className={
                    `primitive-zonemap__zone primitive-zonemap__zone--${tone}` +
                    (isSelected ? ' is-selected' : '')
                  }
                  strokeWidth={isSelected ? 3 : 1.5}
                />
                {labels && (
                  <text x={cx} y={cy} className="primitive-zonemap__zone-label">
                    {z.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <OpenStreetMapAttribution
          className="primitive-zonemap__attribution"
          label={tileAttributionLabel}
          url={tileAttributionUrl}
        />

        <div className="primitive-zonemap__controls">
          <button
            type="button"
            className="primitive-zonemap__btn"
            aria-label={t('shell.map.zoomIn')}
            onClick={() => handleZoom(0.85)}
          >
            +
          </button>
          <button
            type="button"
            className="primitive-zonemap__btn"
            aria-label={t('shell.map.zoomOut')}
            onClick={() => handleZoom(1.15)}
          >
            −
          </button>
          <button
            type="button"
            className="primitive-zonemap__btn"
            aria-label={t('shell.map.resetView')}
            onClick={handleReset}
            style={{ fontSize: 10 }}
          >
            ⌂
          </button>
        </div>
      </div>
      {/*
        W78 (Cross-cutting Cycle F-R-18 P2) — legend tones + swatch CSS
        tokens resolve through the canonical `chip_tone` lookup. Each row
        flagged with `metadata.is_zone_tone: true` surfaces in the legend;
        `metadata.swatch_token` is the CSS variable name used for the
        swatch fill/border (e.g. `neutral` → `--ink-3`). Replaces the
        inline `['good', 'warn', 'danger', 'neutral']` literal array and
        the ternary swatch mapping (AGENTS.md §2 ZERO HARDCODING + §4 SSOT
        + §6 row-driven config). Missing canonical category → empty
        legend so the gap surfaces; per-row missing `swatch_token` falls
        through to the row value as the CSS variable name (loud render
        when neither is seeded).
      */}
      <div className="primitive-zonemap__legend">
        {(getLookups('chip_tone') as Array<{
          value: string;
          label?: string;
          metadata?: { swatch_token?: string; is_zone_tone?: boolean };
        }>)
          .filter((row) => row.metadata?.is_zone_tone === true)
          .map((row) => {
            const token = row.metadata?.swatch_token ?? row.value;
            return (
              <span key={row.value} className="primitive-zonemap__legend-item">
                <span
                  className="primitive-zonemap__legend-swatch"
                  style={{
                    background: `oklch(from var(--${token}) l c h / 0.25)`,
                    borderColor: `var(--${token})`,
                  }}
                />
                {row.label ?? row.value}
              </span>
            );
          })}
      </div>
    </div>
  );
}
