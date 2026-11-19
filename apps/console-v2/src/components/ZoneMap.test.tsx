import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZoneMap, type ZonePolygon } from './ZoneMap';

const OSM_ATTRIBUTION = '\u00a9 OpenStreetMap contributors';
const OSM_TILE_URL = '/map-tiles/openstreetmap/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const OPEN_TILE_POLICY = {
  allowedTileHosts: ['same-origin'],
  tileUsageTier: 'production_cached',
  tileCacheRequired: true,
  sameOriginProxyAllowed: true,
};

const ZONES: ZonePolygon[] = [
  {
    id: 'z-north',
    name: 'North',
    paths: [
      [46.62, 24.72],
      [46.69, 24.72],
      [46.69, 24.79],
      [46.62, 24.79],
    ],
    tone: 'good',
  },
  {
    id: 'z-south',
    name: 'South',
    paths: [
      [46.62, 24.63],
      [46.69, 24.63],
      [46.69, 24.7],
      [46.62, 24.7],
    ],
    tone: 'danger',
  },
];

describe('ZoneMap', () => {
  it('renders one focusable region per zone', () => {
    render(<ZoneMap zones={ZONES} />);
    expect(screen.getByRole('button', { name: 'North' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'South' })).toBeInTheDocument();
    expect(screen.getByRole('application', { name: /Zone map/i })).toBeInTheDocument();
  });

  it('applies the tone class on each polygon', () => {
    const { container } = render(<ZoneMap zones={ZONES} />);
    const north = container.querySelector('[data-zone-id="z-north"] polygon');
    const south = container.querySelector('[data-zone-id="z-south"] polygon');
    expect(north?.getAttribute('class')).toMatch(/--good/);
    expect(south?.getAttribute('class')).toMatch(/--danger/);
  });

  it('fires onSelect with the right zone id when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ZoneMap zones={ZONES} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'North' }));
    expect(onSelect).toHaveBeenCalledWith('z-north');
  });

  it('marks the selected zone with aria-pressed=true', () => {
    render(<ZoneMap zones={ZONES} selectedId="z-south" />);
    const south = screen.getByRole('button', { name: 'South' });
    expect(south).toHaveAttribute('aria-pressed', 'true');
    const north = screen.getByRole('button', { name: 'North' });
    expect(north).toHaveAttribute('aria-pressed', 'false');
  });

  it('zooms the map with the wheel gesture', () => {
    render(<ZoneMap zones={ZONES} />);
    const map = screen.getByRole('application', { name: /Zone map/i });
    const initialViewBox = map.getAttribute('viewBox');
    fireEvent.wheel(map, { deltaY: -120 });
    expect(map.getAttribute('viewBox')).not.toBe(initialViewBox);
  });

  it('renders configured free map attribution and OSM tile images', () => {
    const { container } = render(
      <ZoneMap
        zones={ZONES}
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl={OSM_ATTRIBUTION_URL}
      />,
    );

    expect(screen.getByRole('link', { name: OSM_ATTRIBUTION })).toHaveAttribute(
      'href',
      OSM_ATTRIBUTION_URL,
    );
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(container.querySelector('image[href^="/map-tiles/openstreetmap/"]')).toBeTruthy();
  });

  it('fails loud instead of drawing synthetic polygons when no zone geometry exists', () => {
    const { container } = render(
      <ZoneMap
        zones={[]}
        tileUrlTemplate={OSM_TILE_URL}
        {...OPEN_TILE_POLICY}
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl={OSM_ATTRIBUTION_URL}
      />,
    );

    expect(screen.getByText('Zone geometry required')).toBeInTheDocument();
    expect(screen.getByText('Add zone geometry and a default map viewport before rendering zone maps.')).toBeInTheDocument();
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'blocked');
    expect(container.querySelector('polygon')).toBeNull();
  });

  it('fails closed when the tile provider is not approved', () => {
    const { container } = render(
      <ZoneMap
        zones={ZONES}
        tileUrlTemplate="https://maps.googleapis.com/maps/vt/{z}/{x}/{y}.png"
        allowedTileHosts={['maps.googleapis.com']}
        tileUsageTier="vendor"
        tileAttributionLabel={OSM_ATTRIBUTION}
        tileAttributionUrl={OSM_ATTRIBUTION_URL}
      />,
    );

    expect(screen.getByText('Map setup needed')).toBeInTheDocument();
    expect(screen.getByText('Use an approved free/open map provider before opening this map.')).toBeInTheDocument();
    expect(container.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'blocked');
    expect(container.querySelector('svg image')).toBeNull();
  });
});
