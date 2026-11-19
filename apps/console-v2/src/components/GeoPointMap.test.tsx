import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GeoPointMap } from './GeoPointMap';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const OSM_ATTRIBUTION = '\u00a9 OpenStreetMap contributors';
const OSM_TILE_URL = '/map-tiles/openstreetmap/{z}/{x}/{y}.png';
const OPEN_TILE_POLICY = {
  allowedTileHosts: ['same-origin'],
  tileUsageTier: 'production_cached',
  tileCacheRequired: true,
  sameOriginProxyAllowed: true,
};
const POLICY_BOUNDS = { minLat: 24.62, maxLat: 24.81, minLng: 46.55, maxLng: 46.8 };

describe('GeoPointMap', () => {
  it('renders MapLibre/OpenStreetMap fallback tiles, attribution, and point markers', () => {
    render(
      <GeoPointMap
        points={[
          {
            id: 'geo_1',
            lat: 24.7136,
            lng: 46.6753,
            label: 'Olaya address',
            detail: 'OSM geocode - 94.0%',
            tone: 'good',
          },
        ]}
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl="https://www.openstreetmap.org/copyright"
      />,
    );

    expect(screen.getByTestId('geo-point-map')).toBeInTheDocument();
    expect(screen.getByRole('application', { name: 'Geographic coverage map' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Olaya address, OSM geocode - 94.0%' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: OSM_ATTRIBUTION })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    expect(document.querySelector('.maplibre-backdrop')).toHaveAttribute('data-engine', 'maplibre');
    expect(document.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(document.querySelector('svg image')).toHaveAttribute(
      'href',
      expect.stringContaining('/map-tiles/openstreetmap/'),
    );
    expect(document.querySelector('.geo-point-map__fallback-grid line')).not.toBeNull();
  });

  it('keeps map controls and OSM attribution in separate anchored regions', () => {
    const css = readFileSync(resolve(TEST_DIR, '../styles/primitives.css'), 'utf8');
    expect(css).toMatch(/\.geo-point-map__controls\s*\{[\s\S]*position:\s*absolute;[\s\S]*left:\s*8px;[\s\S]*bottom:\s*8px;/);
    expect(css).toMatch(/\.geo-point-map__attribution\s*\{[\s\S]*right:\s*8px;[\s\S]*top:\s*8px;/);
    expect(css).not.toMatch(/\.geo-point-map__attribution\s*\{[\s\S]*bottom:\s*8px;/);
  }, 20000);

  it('lets operators zoom, drag-pan, reset, and still select backend points', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <GeoPointMap
        title="Operator geocoding map"
        points={[
          {
            id: 'geo_1',
            lat: 24.7036,
            lng: 46.6253,
            label: 'Olaya address',
            detail: 'Location verified - 94.0%',
            tone: 'good',
          },
          {
            id: 'geo_2',
            lat: 24.8036,
            lng: 46.7753,
            label: 'Mursalat address',
            detail: 'Location verified - 88.0%',
            tone: 'warn',
          },
        ]}
        bounds={POLICY_BOUNDS}
        selectedId="geo_1"
        onSelect={onSelect}
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl="https://www.openstreetmap.org/copyright"
      />,
    );

    const marker = screen.getByRole('button', { name: 'Olaya address, Location verified - 94.0%' });
    const firstTransform = marker.getAttribute('transform');
    fireEvent.wheel(screen.getByRole('application', { name: 'Operator geocoding map' }), { deltaY: -120 });
    expect(marker.getAttribute('transform')).not.toBe(firstTransform);
    await user.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(marker.getAttribute('transform')).toBe(firstTransform);

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(marker.getAttribute('transform')).not.toBe(firstTransform);

    const viewport = container.querySelector('.geo-point-map__viewport') as HTMLDivElement;
    viewport.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 420,
        width: 1000,
        height: 420,
        toJSON: () => ({}),
      }) as DOMRect;
    const zoomedTransform = marker.getAttribute('transform');
    fireEvent.mouseDown(viewport, { clientX: 200, clientY: 120 });
    fireEvent.mouseMove(viewport, { clientX: 260, clientY: 150 });
    fireEvent.mouseUp(viewport);
    expect(marker.getAttribute('transform')).not.toBe(zoomedTransform);

    await user.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(marker.getAttribute('transform')).toBe(firstTransform);
    await user.click(marker);
    expect(onSelect).toHaveBeenCalledWith('geo_1');
  });

  it('shows a clear empty state when no geocode coordinates can be plotted', () => {
    render(
      <GeoPointMap
        points={[]}
        bounds={POLICY_BOUNDS}
        emptyLabel="No coordinates yet."
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl="https://www.openstreetmap.org/copyright"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('No coordinates yet.');
    expect(document.querySelector('.geo-point-map__fallback-grid line')).not.toBeNull();
  });

  it('does not fabricate a viewport when neither coordinates nor map policy bounds exist', () => {
    const { container } = render(
      <GeoPointMap
        points={[]}
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl="https://www.openstreetmap.org/copyright"
      />,
    );

    expect(screen.getByText('Set a default view or save coordinates before opening the map.')).toBeInTheDocument();
    expect(container.querySelector('svg image')).toBeNull();
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'blocked');
  });

  it('fails closed when map policy is missing', () => {
    const { container } = render(<GeoPointMap points={[]} />);

    expect(screen.getByText('Map setup needed')).toBeInTheDocument();
    expect(container.querySelector('svg image')).toBeNull();
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'blocked');
  });

  it('blocks proprietary tile templates before rendering tiles', () => {
    const { container } = render(
      <GeoPointMap
        points={[]}
        bounds={POLICY_BOUNDS}
        tileUrlTemplate="https://api.mapbox.com/styles/v1/vendor/{z}/{x}/{y}.png"
        allowedTileHosts={['api.mapbox.com']}
        tileUsageTier="vendor"
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl="https://www.openstreetmap.org/copyright"
      />,
    );

    expect(screen.getByText('Map setup needed')).toBeInTheDocument();
    expect(screen.getByText('Use an approved free/open map provider before opening this map.')).toBeInTheDocument();
    expect(container.querySelector('svg image')).toBeNull();
  });
});
