import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  buildOpenMapRasterStyle,
  MapLibreBackdrop,
  validateOpenMapTilePolicy,
} from './MapLibreBackdrop';

const OSM_ATTRIBUTION = '\u00a9 OpenStreetMap contributors';
const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const PRODUCTION_TILE_URL = '/map-tiles/openstreetmap/{z}/{x}/{y}.png';
const PUBLIC_OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const BOUNDS = { minLat: 24.62, maxLat: 24.81, minLng: 46.55, maxLng: 46.8 };

describe('MapLibreBackdrop open map policy', () => {
  it('approves production same-origin cached OSM-derived tiles', () => {
    expect(
      validateOpenMapTilePolicy({
        tileUrlTemplate: PRODUCTION_TILE_URL,
        allowedTileHosts: ['same-origin'],
        usageTier: 'production_cached',
        cacheRequired: true,
        sameOriginProxyAllowed: true,
        attributionLabel: OSM_ATTRIBUTION,
        attributionUrl: OSM_ATTRIBUTION_URL,
      }),
    ).toMatchObject({ ok: true, tileUrlTemplate: PRODUCTION_TILE_URL });
  });

  it('blocks map policies that omit the tile host allow-list', () => {
    expect(
      validateOpenMapTilePolicy({
        tileUrlTemplate: PRODUCTION_TILE_URL,
        attributionLabel: OSM_ATTRIBUTION,
        attributionUrl: OSM_ATTRIBUTION_URL,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'Approved map tile hosts must be configured before this map can render.',
    });
  });

  it('blocks direct public OSM tiles outside local light-development policy', () => {
    expect(
      validateOpenMapTilePolicy({
        tileUrlTemplate: PUBLIC_OSM_TILE_URL,
        allowedTileHosts: ['tile.openstreetmap.org'],
        usageTier: 'production_cached',
        attributionLabel: OSM_ATTRIBUTION,
        attributionUrl: OSM_ATTRIBUTION_URL,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'Direct public OpenStreetMap tiles are not approved for this tenant environment.',
    });
  });

  it('keeps direct public OSM tiles available only for local light development', () => {
    expect(
      validateOpenMapTilePolicy({
        tileUrlTemplate: PUBLIC_OSM_TILE_URL,
        allowedTileHosts: ['tile.openstreetmap.org'],
        usageTier: 'local_dev_light',
        cacheRequired: false,
        attributionLabel: OSM_ATTRIBUTION,
        attributionUrl: OSM_ATTRIBUTION_URL,
      }),
    ).toMatchObject({ ok: true, tileUrlTemplate: PUBLIC_OSM_TILE_URL });
  });

  it('blocks proprietary tile providers even when a host is allow-listed', () => {
    expect(
      validateOpenMapTilePolicy({
        tileUrlTemplate: 'https://api.mapbox.com/styles/v1/vendor/{z}/{x}/{y}.png',
        allowedTileHosts: ['api.mapbox.com'],
        usageTier: 'vendor',
        attributionLabel: OSM_ATTRIBUTION,
        attributionUrl: OSM_ATTRIBUTION_URL,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'Maps must use an approved free and open provider.',
    });
  });

  it('passes viewport bounds into the MapLibre raster source', () => {
    const style = buildOpenMapRasterStyle(PRODUCTION_TILE_URL, OSM_ATTRIBUTION, BOUNDS);
    expect(style.sources.osm).toMatchObject({
      type: 'raster',
      tiles: [PRODUCTION_TILE_URL],
      bounds: [46.55, 24.62, 46.8, 24.81],
    });
  });

  it('renders fallback raster tiles with the production policy approved', () => {
    const { container } = render(
      <MapLibreBackdrop
        bounds={BOUNDS}
        width={1000}
        height={600}
        tileUrlTemplate={PRODUCTION_TILE_URL}
        allowedTileHosts={['same-origin']}
        usageTier="production_cached"
        cacheRequired
        sameOriginProxyAllowed
        attributionLabel={OSM_ATTRIBUTION}
        attributionUrl={OSM_ATTRIBUTION_URL}
      />,
    );

    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(container.querySelector('image[href^="/map-tiles/openstreetmap/"]')).toBeTruthy();
    expect(screen.queryByText('Open map policy required')).not.toBeInTheDocument();
  });
});
