export interface MapBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

type TileCoord = {
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
};

interface OpenStreetMapTileLayerProps {
  bounds: MapBounds;
  width: number;
  height: number;
  tileUrlTemplate?: string | null;
  washClassName?: string;
  fallbackGridClassName?: string;
}

const TILE_SIZE = 256;

function lonLatToTilePixel([lng, lat]: [number, number], z: number) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n * TILE_SIZE;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n *
    TILE_SIZE;
  return { x, y };
}

function isGeographicBounds(bounds: MapBounds): boolean {
  return (
    bounds.minLng >= -180 &&
    bounds.maxLng <= 180 &&
    bounds.minLat >= -85.0511 &&
    bounds.maxLat <= 85.0511 &&
    bounds.maxLng > bounds.minLng &&
    bounds.maxLat > bounds.minLat
  );
}

function chooseTileZoom(bounds: MapBounds, width: number, height: number): number {
  if (!isGeographicBounds(bounds)) return 0;
  const viewportAspect = width / height;
  const lngSpan = Math.max(bounds.maxLng - bounds.minLng, 0.001);
  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.001);
  const span = Math.max(lngSpan, latSpan * viewportAspect);
  return Math.max(1, Math.min(14, Math.floor(Math.log2(360 / span)) + 1));
}

function tileProjection(bounds: MapBounds, width: number, height: number) {
  const zoom = chooseTileZoom(bounds, width, height);
  if (!isGeographicBounds(bounds) || zoom <= 0) return null;
  const nw = lonLatToTilePixel([bounds.minLng, bounds.maxLat], zoom);
  const se = lonLatToTilePixel([bounds.maxLng, bounds.minLat], zoom);
  const projectedWidth = Math.max(se.x - nw.x, 1);
  const projectedHeight = Math.max(se.y - nw.y, 1);
  const minTileX = Math.floor(nw.x / TILE_SIZE);
  const maxTileX = Math.floor(se.x / TILE_SIZE);
  const minTileY = Math.floor(nw.y / TILE_SIZE);
  const maxTileY = Math.floor(se.y / TILE_SIZE);
  const maxIndex = 2 ** zoom - 1;
  const tiles: TileCoord[] = [];
  for (let x = minTileX; x <= maxTileX; x += 1) {
    for (let y = minTileY; y <= maxTileY; y += 1) {
      if (x < 0 || x > maxIndex || y < 0 || y > maxIndex) continue;
      tiles.push({
        x,
        y,
        z: zoom,
        px: ((x * TILE_SIZE - nw.x) / projectedWidth) * width,
        py: ((y * TILE_SIZE - nw.y) / projectedHeight) * height,
      });
    }
  }
  return {
    tiles,
    tileW: (TILE_SIZE / projectedWidth) * width,
    tileH: (TILE_SIZE / projectedHeight) * height,
  };
}

function FallbackGrid({
  width,
  height,
  className,
}: {
  width: number;
  height: number;
  className?: string;
}) {
  const step = Math.max(32, Math.round(Math.min(width, height) / 18));
  return (
    <g className={className} aria-hidden="true">
      {Array.from({ length: Math.ceil(width / step) + 1 }, (_, i) => i * step).map((x) => (
        <line key={`gx-${x}`} x1={x} x2={x} y1={0} y2={height} />
      ))}
      {Array.from({ length: Math.ceil(height / step) + 1 }, (_, i) => i * step).map((y) => (
        <line key={`gy-${y}`} x1={0} x2={width} y1={y} y2={y} />
      ))}
    </g>
  );
}

export function OpenStreetMapTileLayer({
  bounds,
  width,
  height,
  tileUrlTemplate,
  washClassName,
  fallbackGridClassName,
}: OpenStreetMapTileLayerProps) {
  const projected = tileProjection(bounds, width, height);
  if (!projected || !tileUrlTemplate) {
    return <FallbackGrid width={width} height={height} className={fallbackGridClassName} />;
  }
  return (
    <g aria-hidden="true">
      <FallbackGrid width={width} height={height} className={fallbackGridClassName} />
      {projected.tiles.map((tile) => (
        <image
          key={`${tile.z}-${tile.x}-${tile.y}`}
          href={tileUrlTemplate
            .replace('{z}', String(tile.z))
            .replace('{x}', String(tile.x))
            .replace('{y}', String(tile.y))}
          x={tile.px}
          y={tile.py}
          width={projected.tileW + 1}
          height={projected.tileH + 1}
          preserveAspectRatio="none"
        />
      ))}
      {washClassName ? (
        <rect x={0} y={0} width={width} height={height} className={washClassName} />
      ) : null}
    </g>
  );
}

export function normalizeOpenStreetMapAttributionLabel(label?: string | null): string {
  return String(label ?? '')
    .replace(/Ã‚Â©/g, '\u00a9')
    .replace(/Â©/g, '\u00a9')
    .replace(/\s+/g, ' ')
    .trim();
}

export function OpenStreetMapAttribution({
  className,
  label,
  url,
}: {
  className?: string;
  label?: string | null;
  url?: string | null;
}) {
  const safeLabel = normalizeOpenStreetMapAttributionLabel(label);
  if (!safeLabel || !url) return null;
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {safeLabel}
    </a>
  );
}
