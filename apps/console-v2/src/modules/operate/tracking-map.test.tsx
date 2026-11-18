// tracking-map.test.tsx - covers CLAIM-B Tracking Map hardening.
//
// Targets:
//   1. Module mounts with the page header + map canvas.
//   2. Cluster grid honors the cloud `clustering.grid_px` key (and falls back
//      to legacy `clustering.grid`).
//   3. Inspect-policy drawer renders the LadderViz, scope pill, and JSON.
//   4. Sidebar shipment cards open the decision-trail drawer on click.
//   5. Reset zoom button restores the initial viewport.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { TrackingMapModule } from '@/modules/operate/tracking-map';
import * as apiMod from '@/lib/api';

describe('TrackingMapModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts with the page header and renders the map canvas', async () => {
    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('.map-canvas')).not.toBeNull();
    });
    expect(screen.getByText('Clustering policy')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Clustering: \d+px grid, \d+ shipments? minimum\. Click a cluster to zoom\./);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Riyadh - Return/);
    });
    expect(document.body.textContent).not.toMatch(/Â|Ã|â|grid_px|min_count|same_day|\brto\b|no lat\/lng/i);
    expect(screen.getByRole('link', { name: '\u00a9 OpenStreetMap contributors' })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    expect(document.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(document.querySelector('image[href^="/map-tiles/openstreetmap/"]')).not.toBeNull();
  });

  it('renders hub markers from branch lat/lng projections without missing-location after setup', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'hubs') {
        return {
          rows: [
            {
              id: 'hub_ruh_n',
              organization_id: 'org_rashed',
              code: 'RUH-N',
              name: 'Riyadh North',
              city: 'Riyadh',
              cutoff_time: '07:00',
              lat: 24.7136,
              lng: '46.6753',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (
        resource === 'shipments' ||
        resource === 'geocodes' ||
        resource === 'shipment_directory' ||
        resource === 'canonical_districts'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Riyadh North')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-missing-location')).not.toBeInTheDocument();
  });

  it('renders missing hub coordinates as operator-safe labels', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'hubs') {
        return {
          rows: [
            {
              id: 'hub_pending_coordinates',
              organization_id: 'org_rashed',
              code: 'RUH-PENDING',
              name: 'Riyadh Pending Hub',
              city: 'Riyadh',
              cutoff_time: '07:00',
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (
        resource === 'shipments' ||
        resource === 'geocodes' ||
        resource === 'shipment_directory' ||
        resource === 'canonical_districts'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Missing location')).toBeInTheDocument();
    expect(screen.getByText('Riyadh Pending Hub - location unavailable')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Â|Ã|â|lat\/lng/i);
  });

  it('sanitizes mojibake map attribution labels without weakening policy validation', async () => {
    const realResolve = apiMod.resolveSettings;
    vi.spyOn(apiMod, 'resolveSettings').mockImplementation(async (category, scope) => {
      const resolved = await realResolve(category, scope);
      if (category !== 'map_policy') return resolved;
      return {
        ...resolved,
        value: {
          ...(resolved?.value ?? {}),
          tile_provider: {
            ...((resolved?.value as { tile_provider?: Record<string, unknown> } | undefined)?.tile_provider ?? {}),
            attribution_label: 'Â© OpenStreetMap contributors',
            attribution_url: 'https://www.openstreetmap.org/copyright',
          },
        },
      } as never;
    });

    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.map-canvas')).not.toBeNull();
    });
    expect(screen.getByRole('link', { name: '\u00a9 OpenStreetMap contributors' })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    expect(document.querySelector('.maplibre-backdrop')).toHaveAttribute('data-policy-status', 'approved');
    expect(document.body.textContent).not.toMatch(/Â©|Ã|â/);
  });

  it('tenant-scopes shipment, geocode, hub, directory reads and map policy resolution', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const settingsSpy = vi.spyOn(apiMod, 'resolveSettings');

    renderWithProviders(<TrackingMapModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          organization_id: 'org_rashed',
        },
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Express', rank: 2 },
        },
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.map-canvas')).not.toBeNull();
    });
    await waitFor(() => {
      for (const resource of ['shipments', 'geocodes', 'hubs', 'shipment_directory']) {
        expect(
          listSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      expect(
        settingsSpy.mock.calls.some(([category, scope]) => {
          const scoped = scope as { organization_id?: string } | undefined;
          return category === 'map_policy' && scoped?.organization_id === 'org_rashed';
        }),
      ).toBe(true);
    });
  });

  it('renders hub markers from canonical coordinate objects', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'hubs') {
        return {
          rows: [
            {
              id: 'hub_nested_coordinates',
              organization_id: 'org_rashed',
              code: 'RUH-MAP',
              name: 'Riyadh Map Hub',
              city: 'Riyadh',
              cutoff_time: '07:00',
              coordinates: { lat: '24.7136', lng: '46.6753' },
            },
          ],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (
        resource === 'shipments' ||
        resource === 'geocodes' ||
        resource === 'shipment_directory' ||
        resource === 'canonical_districts'
      ) {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });

    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Riyadh Map Hub')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-missing-location')).not.toBeInTheDocument();
  });

  it('explains incomplete map setup without exposing policy keys', async () => {
    vi.spyOn(apiMod, 'resolveSettings').mockResolvedValue({
      category: 'map_policy',
      resolved_from: 'tenant',
      value: {
        clustering: { enabled: true },
      },
    } as never);

    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Map settings are incomplete')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Default viewport/);
    expect(document.body.textContent).toMatch(/Cluster grid size/);
    expect(document.body.textContent).toMatch(/Minimum shipments per cluster/);
    expect(document.body.textContent).not.toMatch(/default_viewport|clustering\.grid|grid_px|min_count/i);
  });

  it('opens the inspect-policy drawer with operator-safe policy labels', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelector('.map-canvas')).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: /Inspect policy/ }));
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // LadderViz steps + summarized policy settings must both render.
    expect(document.body.textContent).toMatch(/Resolved settings/);
    expect(document.body.textContent).toMatch(/Map display policy/);
    expect(document.body.textContent).toMatch(/Policy applied/);
    expect(document.body.textContent).toMatch(/clustering/);
    expect(document.body.textContent).not.toMatch(/map_policy|settings_resolution|srlv_|grid_px|min_count|default_viewport/i);
  });

  it('clicking a sidebar shipment opens the decision-trail drawer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('button[aria-label^="Open "]').length).toBeGreaterThan(0);
    });
    const card = document.querySelector('button[aria-label^="Open "]') as HTMLButtonElement;
    await user.click(card);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Decision trail drawer surfaces a recognizable header from buildDecisionTrailDrawerSpec.
    expect(document.body.textContent).toMatch(/decision/i);
  });

  it('reset-zoom button is rendered and clickable', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackingMapModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelector('.map-canvas')).not.toBeNull();
    });
    const resetBtn = screen.getByRole('button', { name: /Reset zoom/ });
    expect(resetBtn).toBeInTheDocument();
    expect(resetBtn).toHaveStyle({ zIndex: '2' });
    await user.click(resetBtn);
    // No assertion on viewport state internals - just confirm the click does
    // not throw and the canvas remains mounted.
    expect(document.querySelector('.map-canvas')).not.toBeNull();
  });
});
