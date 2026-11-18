import { useEffect, useMemo, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  OpenStreetMapTileLayer,
  normalizeOpenStreetMapAttributionLabel,
  type MapBounds,
} from './OpenStreetMapTileLayer';

interface MapLibreBackdropProps {
  bounds: MapBounds;
  width: number;
  height: number;
  tileUrlTemplate?: string | null;
  allowedTileHosts?: string[] | null;
  usageTier?: string | null;
  cacheRequired?: boolean | null;
  sameOriginProxyAllowed?: boolean | null;
  attributionLabel?: string | null;
  attributionUrl?: string | null;
  fallbackWashClassName?: string;
  fallbackGridClassName?: string;
  className?: string;
}

interface OpenMapPolicyValidation {
  ok: boolean;
  reason?: string;
  tileUrlTemplate?: string;
}

const REQUIRED_OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const PROPRIETARY_TILE_HOST_PATTERN =
  /mapbox|maps\.google|googleapis|google\.com\/maps|virtualearth|bing\.com|hereapi|here\.com|tomtom|maptiler|arcgis/i;
const SAME_ORIGIN_TILE_HOST = 'same-origin';

function isValidBounds(bounds: MapBounds): boolean {
  return (
    Number.isFinite(bounds.minLng) &&
    Number.isFinite(bounds.maxLng) &&
    Number.isFinite(bounds.minLat) &&
    Number.isFinite(bounds.maxLat) &&
    bounds.minLng >= -180 &&
    bounds.maxLng <= 180 &&
    bounds.minLat >= -85.0511 &&
    bounds.maxLat <= 85.0511 &&
    bounds.maxLng > bounds.minLng &&
    bounds.maxLat > bounds.minLat
  );
}

function browserCanRunMapLibre(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('jsdom')) {
    return false;
  }
  return true;
}

function normalizeAttribution(label?: string | null): string {
  return normalizeOpenStreetMapAttributionLabel(label)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function operatorPolicyMessage(reason?: string): string {
  if (!reason) return 'Set a valid default map area before opening the map.';
  if (reason.includes('approved free/open map provider') || reason.includes('approved free and open provider')) {
    return 'Use an approved free/open map provider before opening this map.';
  }
  if (reason.includes('OpenStreetMap')) {
    return 'Show the required OpenStreetMap attribution before opening this map.';
  }
  if (reason.includes('HTTPS') || reason.includes('same-origin') || reason.includes('allow-list')) {
    return 'Use an approved secure map tile source before opening this map.';
  }
  if (reason.includes('URL template') || reason.includes('url_template')) {
    return 'Set a valid map tile source before opening this map.';
  }
  return 'Check the map setup before opening this map.';
}

export function validateOpenMapTilePolicy({
  tileUrlTemplate,
  allowedTileHosts,
  usageTier,
  cacheRequired,
  sameOriginProxyAllowed,
  attributionLabel,
  attributionUrl,
}: {
  tileUrlTemplate?: string | null;
  allowedTileHosts?: string[] | null;
  usageTier?: string | null;
  cacheRequired?: boolean | null;
  sameOriginProxyAllowed?: boolean | null;
  attributionLabel?: string | null;
  attributionUrl?: string | null;
}): OpenMapPolicyValidation {
  const template = String(tileUrlTemplate ?? '').trim();
  if (!template) {
    return { ok: false, reason: 'Set a valid map tile source before opening this map.' };
  }
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!template.includes(token)) {
      return { ok: false, reason: 'Set a valid map tile source before opening this map.' };
    }
  }
  if (PROPRIETARY_TILE_HOST_PATTERN.test(template)) {
    return { ok: false, reason: 'Maps must use an approved free and open provider.' };
  }
  const allowedHosts = Array.isArray(allowedTileHosts)
    ? allowedTileHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowedHosts.length === 0) {
    return { ok: false, reason: 'Approved map tile hosts must be configured before this map can render.' };
  }
  const sample = template.replace('{z}', '8').replace('{x}', '128').replace('{y}', '127');
  try {
    const parsed = new URL(sample, 'https://console.local');
    const isSameOrigin = sample.startsWith('/');
    if (!isSameOrigin && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'Use an approved secure map tile source before opening this map.' };
    }
    if (isSameOrigin) {
      if (sameOriginProxyAllowed === false || !allowedHosts.includes(SAME_ORIGIN_TILE_HOST)) {
        return { ok: false, reason: 'Same-origin map tile proxy must be approved before this map can render.' };
      }
    } else {
      const host = parsed.hostname.toLowerCase();
      if (!allowedHosts.includes(host)) {
        return { ok: false, reason: 'Approved map tile hosts must be configured before this map can render.' };
      }
      if (host === 'tile.openstreetmap.org' && String(usageTier ?? '') !== 'local_dev_light') {
        return { ok: false, reason: 'Direct public OpenStreetMap tiles are not approved for this tenant environment.' };
      }
      if (cacheRequired === true && String(usageTier ?? '') !== 'local_dev_light') {
        return { ok: false, reason: 'Production maps must use the approved cached tile source.' };
      }
    }
  } catch {
    return { ok: false, reason: 'Set a valid map tile source before opening this map.' };
  }

  const label = normalizeAttribution(attributionLabel);
  if (!label.includes('openstreetmap')) {
    return { ok: false, reason: 'Show the required OpenStreetMap attribution before opening this map.' };
  }
  if (String(attributionUrl ?? '').trim() !== REQUIRED_OSM_ATTRIBUTION_URL) {
    return { ok: false, reason: 'Show the required OpenStreetMap attribution before opening this map.' };
  }
  return { ok: true, tileUrlTemplate: template };
}

export function buildOpenMapRasterStyle(
  tileUrlTemplate: string,
  attributionLabel: string | null | undefined,
  bounds: MapBounds,
): maplibregl.StyleSpecification {
  const sourceBounds: [number, number, number, number] = [
    bounds.minLng,
    bounds.minLat,
    bounds.maxLng,
    bounds.maxLat,
  ];
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [tileUrlTemplate],
        tileSize: 256,
        attribution: attributionLabel ?? 'OpenStreetMap contributors',
        bounds: sourceBounds,
      },
    },
    layers: [
      {
        id: 'osm-raster',
        type: 'raster',
        source: 'osm',
      },
    ],
  };
}

export function MapLibreBackdrop({
  bounds,
  width,
  height,
  tileUrlTemplate,
  allowedTileHosts,
  usageTier,
  cacheRequired,
  sameOriginProxyAllowed,
  attributionLabel,
  attributionUrl,
  fallbackWashClassName,
  fallbackGridClassName,
  className,
}: MapLibreBackdropProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const policy = useMemo(
    () =>
      validateOpenMapTilePolicy({
        tileUrlTemplate,
        allowedTileHosts,
        usageTier,
        cacheRequired,
        sameOriginProxyAllowed,
        attributionLabel,
        attributionUrl,
      }),
    [allowedTileHosts, attributionLabel, attributionUrl, cacheRequired, sameOriginProxyAllowed, tileUrlTemplate, usageTier],
  );
  const validBounds = isValidBounds(bounds);
  const canUseMapLibre = Boolean(policy.ok && validBounds && browserCanRunMapLibre());
  const safeAttributionLabel = normalizeOpenStreetMapAttributionLabel(attributionLabel);
  const styleSpec = useMemo(
    () => (policy.tileUrlTemplate ? buildOpenMapRasterStyle(policy.tileUrlTemplate, safeAttributionLabel, bounds) : null),
    [bounds, policy.tileUrlTemplate, safeAttributionLabel],
  );

  useEffect(() => {
    if (!canUseMapLibre || !containerRef.current || !styleSpec) {
      setReady(false);
      return undefined;
    }
    let cancelled = false;
    let map: maplibregl.Map | null = null;

    void import('maplibre-gl')
      .then((mod) => {
        if (cancelled || !containerRef.current) return;
        const MapCtor = mod.Map ?? mod.default.Map;
        map = new MapCtor({
          container: containerRef.current,
          style: styleSpec,
          interactive: false,
          attributionControl: false,
          renderWorldCopies: false,
          fadeDuration: 0,
        });
        mapRef.current = map;
        map.fitBounds(
          [
            [bounds.minLng, bounds.minLat],
            [bounds.maxLng, bounds.maxLat],
          ],
          { animate: false, padding: 0 },
        );
        map.once('load', () => {
          if (!cancelled) setReady(true);
        });
        map.on('error', () => {
          if (!cancelled) setReady(false);
        });
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });

    return () => {
      cancelled = true;
      map?.remove();
      if (mapRef.current === map) mapRef.current = null;
      setReady(false);
    };
  }, [bounds, bounds.maxLat, bounds.maxLng, bounds.minLat, bounds.minLng, canUseMapLibre, styleSpec]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isValidBounds(bounds)) return;
    map.fitBounds(
      [
        [bounds.minLng, bounds.minLat],
        [bounds.maxLng, bounds.maxLat],
      ],
      { animate: false, padding: 0 },
    );
  }, [bounds, bounds.maxLat, bounds.maxLng, bounds.minLat, bounds.minLng]);

  return (
    <div
      className={['maplibre-backdrop', className].filter(Boolean).join(' ')}
      data-engine="maplibre"
      data-policy-status={policy.ok && validBounds ? 'approved' : 'blocked'}
    >
      {!policy.ok || !validBounds ? (
        <div className="maplibre-backdrop__policy-error" role="status">
          <span className="mono">Map setup needed</span>
          <small>{operatorPolicyMessage(policy.reason)}</small>
        </div>
      ) : null}
      <div ref={containerRef} className="maplibre-backdrop__canvas" aria-hidden="true" />
      {policy.ok && validBounds ? (
        <svg
          className="maplibre-backdrop__fallback"
          data-render-state={ready ? 'ready' : 'loading'}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <OpenStreetMapTileLayer
            bounds={bounds}
            width={width}
            height={height}
            tileUrlTemplate={policy.tileUrlTemplate}
            washClassName={fallbackWashClassName}
            fallbackGridClassName={fallbackGridClassName}
          />
        </svg>
      ) : null}
    </div>
  );
}
