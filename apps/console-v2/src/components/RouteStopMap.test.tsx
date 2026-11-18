import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildRouteStopGeoPoints, RouteStopMap } from './RouteStopMap';

const TILE_PROVIDER = {
  url_template: '/map-tiles/openstreetmap/{z}/{x}/{y}.png',
  allowed_hosts: ['same-origin'],
  usage_tier: 'production_cached',
  cache_required: true,
  same_origin_proxy_allowed: true,
  attribution_label: '\u00a9 OpenStreetMap contributors',
  attribution_url: 'https://www.openstreetmap.org/copyright',
};

describe('RouteStopMap', () => {
  it('joins route stops to shipments and address geocodes', () => {
    const points = buildRouteStopGeoPoints(
      [{ id: 'rs_1', shipment_id: 'shp_1', sequence_order: 3 }],
      [{ id: 'shp_1', tracking_number: 'SHP-1', destination_address_id: 'addr_1' }],
      [{ address_id: 'addr_1', latitude: '24.7136', longitude: '46.6753', confidence_score: 0.94 }],
    );

    expect(points).toEqual([
      expect.objectContaining({
        id: 'rs_1',
        lat: 24.7136,
        lng: 46.6753,
        label: '#3 SHP-1',
        detail: 'geocoded stop - 94%',
      }),
    ]);
  });

  it('prefers primary non-expired geocodes over higher-confidence stale alternatives', () => {
    const points = buildRouteStopGeoPoints(
      [{ id: 'rs_1', shipment_id: 'shp_1', sequence_order: 1 }],
      [{ id: 'shp_1', tracking_number: 'SHP-1', destination_address_id: 'addr_1' }],
      [
        {
          address_id: 'addr_1',
          latitude: 24.9,
          longitude: 46.9,
          confidence_score: 0.99,
          provider_name: 'stale-provider',
          is_primary: false,
          expires_at: '2020-01-01T00:00:00Z',
          geocoded_at: '2020-01-01T00:00:00Z',
        },
        {
          address_id: 'addr_1',
          latitude: 24.7136,
          longitude: 46.6753,
          confidence_score: 0.9,
          provider_name: 'primary-provider',
          is_primary: true,
          expires_at: '2099-01-01T00:00:00Z',
          geocoded_at: '2026-01-01T00:00:00Z',
        },
      ],
    );

    expect(points).toEqual([
      expect.objectContaining({
        lat: 24.7136,
        lng: 46.6753,
        detail: 'primary-provider geocode - 90%',
      }),
    ]);
  });

  it('renders a MapLibre-backed stop map using the shared open map policy', () => {
    const { container } = render(
      <RouteStopMap
        stops={[{ id: 'rs_1', shipment_id: 'shp_1', sequence_order: 1 }]}
        shipments={[{ id: 'shp_1', tracking_number: 'SHP-1', destination_address_id: 'addr_1' }]}
        geocodes={[{ address_id: 'addr_1', latitude: 24.7136, longitude: 46.6753, confidence_score: 0.94 }]}
        tileProvider={TILE_PROVIDER}
        bounds={{ minLat: 24.62, maxLat: 24.81, minLng: 46.55, maxLng: 46.8 }}
      />,
    );

    expect(screen.getByTestId('route-stop-map')).toBeInTheDocument();
    expect(screen.getByRole('application', { name: 'Route stop map' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '#1 SHP-1, geocoded stop - 94%' })).toBeInTheDocument();
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(container.querySelector('image[href^="/map-tiles/openstreetmap/"]')).toBeTruthy();
  });
});
