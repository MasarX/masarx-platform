// geocoding.test.tsx — covers the enriched GeocodingModule behavior (claim H):
//   • renders the five-KPI strip (addresses, verified%, geocodes, avg conf, attempts).
//   • exposes the four-tab control including the new Policy & attempts tab.
//   • policy snapshot card shows the resolved settings ladder.
//   • address row click opens a drawer with linked geocodes inset.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import * as apiMod from '@/lib/api';
import { GeocodingModule } from '../geocoding';
import type { SettingsResolution } from '@/types/domain';

const RASHED_TENANT_IDENTITY = {
  capabilities: ['all'],
  user: {
    access_scope_type: 'tenant' as const,
    organization_id: 'org_rashed',
  },
  scope: {
    tenant: { id: 'org_rashed', label: 'Rashed Express', rank: 2 as const },
  },
};

const RASHED_TENANT_RENDER = { identity: RASHED_TENANT_IDENTITY };

function settingsResolution(
  category: string,
  value: unknown,
  resolvedFrom: SettingsResolution['resolved_from'] = 'global',
  scopeId: string | null = null,
): SettingsResolution {
  return {
    category,
    value,
    resolved_from: resolvedFrom,
    ladder_path: [
      {
        rank: 0,
        scope_type: resolvedFrom,
        scope_id: scopeId,
        has_value: true,
        value,
      },
    ],
    settings_resolution_id: `sres_${category}`,
    override_of: null,
  };
}

describe('GeocodingModule (claim H)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders five-KPI strip including avg confidence and attempts', async () => {
    renderWithProviders(<GeocodingModule />);
    // W27 Cycle D closure (P1 #1): KPI label renamed `Verified %` →
    // `Valid %` to match the canonical `address_validation_status`
    // value set (valid/invalid/requires_review/pending).
    await waitFor(() =>
      expect(screen.getByText('Valid %')).toBeInTheDocument()
    );
    // Each KPI label is unique by spelling.
    expect(screen.getByText('Geocodes cached')).toBeInTheDocument();
    expect(screen.getByText('Avg confidence')).toBeInTheDocument();
    expect(screen.getByText('Attempts (24h)')).toBeInTheDocument();
  });

  it('renders the geocoding coverage map with the free MapLibre/OpenStreetMap stack', async () => {
    renderWithProviders(<GeocodingModule />);

    await waitFor(() =>
      expect(screen.getByText('Geocoding coverage map')).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText('MapLibre · OpenStreetMap')).toBeInTheDocument()
    );
    expect(screen.getByRole('application', { name: 'Geocoding coverage map' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /OpenStreetMap contributors/i })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
    expect(document.querySelector('.maplibre-backdrop')).toHaveAttribute('data-engine', 'maplibre');
  });

  it('tenant-scopes address and geocode reads plus map policy resolution', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const settingsSpy = vi.spyOn(apiMod, 'resolveSettings');

    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);

    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
    await waitFor(() => {
      for (const resource of ['addresses', 'geocodes']) {
        expect(
          listSpy.mock.calls.some(([key, opts]) => {
            const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
            return key === resource && filter?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
      for (const category of ['map_policy', 'address_resolution_policy', 'geocoding_policy']) {
        expect(
          settingsSpy.mock.calls.some(([calledCategory, scope]) => {
            const scoped = scope as { organization_id?: string } | undefined;
            return calledCategory === category && scoped?.organization_id === 'org_rashed';
          }),
        ).toBe(true);
      }
    });
  });

  it('exposes a four-tab control with the new Policy & attempts tab', async () => {
    renderWithProviders(<GeocodingModule />);
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /Addresses/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Geocodes/i })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /Canonical refs/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /Policy & attempts/i })
    ).toBeInTheDocument();
  });

  it('switches to the Policy tab and shows policy breadth plus all policy snapshot cards', async () => {
    const user = userEvent.setup();
    const originalResolveSettings = apiMod.resolveSettings;
    vi.spyOn(apiMod, 'resolveSettings').mockImplementation((category, scope) => {
      const scoped = scope as { organization_id?: string } | undefined;
      if (category === 'map_policy') {
        return Promise.resolve(
          settingsResolution(
            category,
            {
              tile_provider: {
                engine: 'maplibre',
                provider: 'openstreetmap',
                data_provider: 'openstreetmap',
                usage_tier: 'production_cached',
                cache_required: true,
              },
              logistics_stack: {
                spatial_source_of_truth: 'postgis',
                routing_engine: 'valhalla',
                optimization_engine: 'vroom',
              },
            },
            'tenant',
            scoped?.organization_id ?? 'org_rashed',
          ),
        );
      }
      if (category === 'address_resolution_policy') {
        return Promise.resolve(
          settingsResolution(category, {
            fields: [
              {
                name: 'sa_short_code',
                sources: ['provided_payload', 'short_code_registry', 'national_address_lookup'],
              },
              {
                name: 'coordinates',
                sources: ['provided_payload', 'geocode_cache', 'manual_review'],
              },
            ],
          }),
        );
      }
      if (category === 'geocoding_policy') {
        return Promise.resolve(
          settingsResolution(category, {
            provider_priority: [],
            coordinate_handling: {
              country_boundary: 'SA',
              use_provided_coordinates: true,
              validate_bounds: true,
            },
            matching_plugins: [
              { name: 'short_code', enabled: true, params: { code_type: 'sa_short_code' } },
              { name: 'fuzzy', enabled: true, params: { min_score: 0.74 } },
            ],
            provider_agreement_rules: { if_disagree: 'manual_review' },
            verified_pct_good_min: 80,
            verified_pct_warn_min: 50,
            confidence_good_min: 0.8,
            confidence_warn_min: 0.5,
          }),
        );
      }
      return originalResolveSettings(category, scope);
    });

    renderWithProviders(<GeocodingModule />);
    const policyTab = await screen.findByRole('tab', {
      name: /Policy & attempts/i,
    });
    await user.click(policyTab);
    await waitFor(() =>
      expect(screen.getByText('Policy breadth')).toBeInTheDocument()
    );
    expect(screen.getByText('Map provider')).toBeInTheDocument();
    expect(screen.getByText('MapLibre / OpenStreetMap')).toBeInTheDocument();
    expect(screen.getByText('Tile delivery')).toBeInTheDocument();
    expect(screen.getByText('Production cache enabled')).toBeInTheDocument();
    expect(screen.getByText('Geo stack')).toBeInTheDocument();
    expect(screen.getAllByText('PostGIS / Valhalla / VROOM').length).toBeGreaterThan(0);
    expect(screen.getByText('Saudi short address')).toBeInTheDocument();
    expect(screen.getByText('Short Code on Saudi short code')).toBeInTheDocument();
    expect(screen.getByText('Short-code sources')).toBeInTheDocument();
    expect(screen.getByText('Submitted address > Short-code registry > National address lookup')).toBeInTheDocument();
    expect(screen.getAllByText('Coordinates').length).toBeGreaterThan(0);
    expect(screen.getByText('Saudi Arabia bounds checked')).toBeInTheDocument();
    expect(screen.getByText('Fuzzy matching')).toBeInTheDocument();
    expect(screen.getByText('Fuzzy on')).toBeInTheDocument();
    expect(screen.getByText('Review fallback')).toBeInTheDocument();
    expect(screen.getAllByText('Manual review').length).toBeGreaterThan(0);
    expect(screen.getByText('External providers')).toBeInTheDocument();
    expect(screen.getByText('Explicit only')).toBeInTheDocument();
    expect(screen.getAllByText('Map settings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Address resolution settings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Address settings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Geocoding settings').length).toBeGreaterThan(0);
    expect(screen.getByText('Recent geocoding attempts')).toBeInTheDocument();
  });

  it('applies a tenant geocoding policy change and refreshes visible readback without leaving the policy tab', async () => {
    const user = userEvent.setup();
    let applied = false;
    const initialPolicyValue = {
      provider_priority: [],
      coordinate_handling: {
        country_boundary: 'SA',
        use_provided_coordinates: true,
        validate_bounds: true,
      },
      matching_plugins: [
        { name: 'short_code', enabled: true, params: { code_type: 'sa_short_code' } },
        { name: 'fuzzy', enabled: true, params: { min_score: 0.74 } },
      ],
      provider_agreement_rules: { if_disagree: 'manual_review' },
      metadata: {
        provider_strategy: 'postgis_canonical_local_then_manual_review',
      },
    };
    const appliedPolicyValue = {
      ...initialPolicyValue,
      matching_plugins: [
        { name: 'short_code', enabled: true, params: { code_type: 'sa_short_code' } },
        { name: 'fuzzy', enabled: true, params: { min_score: 0.81 } },
      ],
      metadata: {
        provider_strategy: 'postgis_canonical_local_then_manual_review',
        operator_marker: 'MapGeocodingPolicyApplyReadback20260530',
      },
    };
    const originalResolveSettings = apiMod.resolveSettings;
    vi.spyOn(apiMod, 'resolveSettings').mockImplementation((category, scope) => {
      const scoped = scope as { organization_id?: string } | undefined;
      if (category === 'geocoding_policy') {
        return Promise.resolve(
          settingsResolution(
            category,
            applied ? appliedPolicyValue : initialPolicyValue,
            'tenant',
            scoped?.organization_id ?? 'org_rashed',
          ),
        );
      }
      if (category === 'address_resolution_policy') {
        return Promise.resolve(
          settingsResolution(category, {
            fields: [
              {
                name: 'sa_short_code',
                sources: ['provided_payload', 'short_code_registry', 'manual_review'],
              },
              {
                name: 'coordinates',
                sources: ['provided_payload', 'geocode_cache', 'manual_review'],
              },
            ],
          }),
        );
      }
      return originalResolveSettings(category, scope);
    });
    const applySpy = vi.spyOn(apiMod, 'applySettingsValue').mockImplementation(async () => {
      applied = true;
      return {
        ok: true,
        applied: true,
        category: 'geocoding_policy',
        scope_type: 'tenant',
        scope_id: 'org_rashed',
        settings_version_id: 'sv_geo_policy_apply_20260530',
        settings_version_number: 7,
        settings_resolution_id: 'srlv_geo_policy_apply_20260530',
      };
    });

    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);

    const policyTab = await screen.findByRole('tab', {
      name: /Policy & attempts/i,
    });
    await user.click(policyTab);
    await waitFor(() => expect(screen.getByText('Policy updates')).toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('MapGeocodingPolicyApplyReadback20260530');

    expect(screen.getByRole('button', { name: /Configure Geocoding/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Configure Geocoding/i }));
    expect(await screen.findByRole('dialog', { name: /Configure Geocoding/i })).toBeVisible();
    const form = await screen.findByTestId('change-request-form');
    expect(form).toHaveTextContent('Saves approved categories immediately');
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement | null;
    const justification = screen.getByPlaceholderText(/Required by Exampleparcel KSA/i);
    expect(textarea?.value).toContain('"country_boundary": "SA"');

    fireEvent.change(textarea!, {
      target: {
        value: JSON.stringify(appliedPolicyValue, null, 2),
      },
    });
    fireEvent.change(justification, {
      target: {
        value: 'MapGeocodingPolicyApplyReadback20260530',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Apply active$/i }));

    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith(
        'geocoding_policy',
        { tenant: { id: 'org_rashed' } },
        expect.objectContaining({
          coordinate_handling: expect.objectContaining({ country_boundary: 'SA' }),
          provider_agreement_rules: expect.objectContaining({ if_disagree: 'manual_review' }),
          metadata: expect.objectContaining({
            operator_marker: 'MapGeocodingPolicyApplyReadback20260530',
          }),
        }),
        expect.objectContaining({ justification: 'MapGeocodingPolicyApplyReadback20260530' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('change-request-form')).not.toBeInTheDocument();
      expect(document.body).toHaveTextContent('Policy update');
      expect(document.body).toHaveTextContent('Settings saved');
      expect(document.body).toHaveTextContent('Policy refreshed');
      expect(document.body).toHaveTextContent('MapGeocodingPolicyApplyReadback20260530');
    });
  });

  it('opens an address drawer with linked geocodes section on row click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);
    // Wait for at least one address row to render.
    await waitFor(() =>
      expect(screen.getByRole('tablist')).toBeInTheDocument()
    );
    // The seed addresses use "Olaya St" suffix on every street.
    const streetCells = await screen.findAllByText(/Olaya St/);
    expect(streetCells.length).toBeGreaterThan(0);
    await user.click(streetCells[0]!);
    // Drawer body shows the unique "Inspect policy" eyebrow + "Geocodes for
    // this address" inset header. Use getAllByText where overlap with the
    // KvGrid label or DataTable column header could occur.
    await waitFor(() =>
      expect(
        screen.getAllByText('Geocodes for this address').length
      ).toBeGreaterThan(0)
    );
    expect(screen.getByText('Location map')).toBeInTheDocument();
    expect(screen.getByText('Review settings')).toBeInTheDocument();
  });

  it('requeues geocoding for a linked shipment through the canonical workflow command', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const requeueSpy = vi
      .spyOn(apiMod, 'ui_execute_shipment_update_geocode_v1')
      .mockResolvedValue({
        ok: true,
        status: 'workflow_started',
        action_key: 'shipments.update_geocode',
        resource_key: 'shipments',
        count: 1,
        workflow_run_id: 'wfr_geocode_test',
        geocode_workflow_status: 'manual_review',
        geocode_workflow_run_id: 'wfr_nested_geocode_test',
        geocoding_attempt_id: 'gca_manual_review_test',
        manual_review_task_id: 'tsk_geocode_review_test',
        geocode_id: 'geo_geocode_row_test',
        items: [
          {
            geocode_workflow_status: 'manual_review',
            geocode_workflow_run_id: 'wfr_nested_geocode_test',
            manual_review_task_id: 'tsk_geocode_review_test',
            geocoding_attempt_id: 'gca_manual_review_test',
            geocode_id: 'geo_geocode_row_test',
          },
        ],
      });

    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);

    const streetCells = await screen.findAllByText(/Olaya St/);
    expect(streetCells.length).toBeGreaterThan(0);
    await user.click(streetCells[0]!);

    const button = await screen.findByRole('button', { name: /Requeue geocode/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    await user.click(button);

    await waitFor(() => expect(requeueSpy).toHaveBeenCalledTimes(1));
    const readback = await screen.findByTestId('geocode-execution-readback');
    expect(readback).toHaveTextContent('Location update');
    expect(readback).toHaveTextContent('Update requested');
    expect(readback).toHaveTextContent('Geocode Manual Review');
    expect(readback).toHaveTextContent('Follow-up queued');
    expect(readback).toHaveTextContent('Address check recorded');
    expect(readback).toHaveTextContent('Coordinate saved');
    expect(readback).toHaveTextContent('Review queued');
    expect(screen.getByRole('button', { name: /Open review queue/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Geocode status')).toBe(readback);
    await waitFor(() => {
      expect(
        listSpy.mock.calls.some(([key, opts]) => {
          const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
          return key === 'geocoding_attempts' && filter?.organization_id === 'org_rashed';
        }),
      ).toBe(true);
      expect(
        listSpy.mock.calls.some(([key, opts]) => {
          const filter = (opts as { filter?: Record<string, unknown> } | undefined)?.filter;
          return (
            key === 'shipments' &&
            filter?.organization_id === 'org_rashed' &&
            typeof filter.destination_address_id === 'string'
          );
        }),
      ).toBe(true);
    });
    expect(requeueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        shipment_id: expect.stringMatching(/^shp_/),
        address_id: expect.stringMatching(/^addr_/),
        destination_address_id: expect.stringMatching(/^addr_/),
      }),
    );
    const call = requeueSpy.mock.calls[0]?.[0];
    expect(call?.destination_address_id).toBe(call?.address_id);
  });

  it('keeps failed geocode execution visible in the same address drawer', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiMod, 'ui_execute_shipment_update_geocode_v1').mockRejectedValue(
      new Error('ui_execute_shipment_update_geocode_v1 nested geocode workflow failed (wfr_failed)'),
    );

    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);

    const streetCells = await screen.findAllByText(/Olaya St/);
    expect(streetCells.length).toBeGreaterThan(0);
    await user.click(streetCells[0]!);

    const button = await screen.findByRole('button', { name: /Requeue geocode/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    await user.click(button);

    const error = await screen.findByTestId('geocode-execution-error');
    expect(error).toHaveTextContent('Execution failed');
    expect(error).toHaveTextContent('nested geocode workflow failed');
    expect(screen.queryByTestId('geocode-execution-readback')).not.toBeInTheDocument();
  });

  it('surfaces manual-review and failed geocoding attempt variants from the attempt ledger', async () => {
    const user = userEvent.setup();
    const originalList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'geocoding_attempts') {
        return Promise.resolve({
          rows: [
            {
              id: 'gca_manual_review_20260530',
              organization_id: 'org_rashed',
              address_id: 'addr_4700',
              provider_name: 'postgis_short_code',
              status: 'manual_review',
              duration_ms: 42,
              created_at: '2026-05-30T09:00:00Z',
              metadata: {
                attempt_type: 'manual_review',
                manual_review_task_id: 'tsk_geo_manual_20260530',
                workflow_run_id: 'wfr_geo_manual_20260530',
              },
            },
            {
              id: 'gca_failed_20260530',
              organization_id: 'org_rashed',
              address_id: 'addr_4701',
              provider_name: 'osm_nominatim',
              status: 'failed',
              duration_ms: 88,
              created_at: '2026-05-30T08:55:00Z',
              metadata: {
                attempt_type: 'retry',
                failure_reason: 'provider_timeout',
                workflow_run_id: 'wfr_geo_failed_20260530',
              },
            },
          ],
          count: 2,
          total: 2,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      return originalList(resource, opts);
    });

    renderWithProviders(<GeocodingModule />, RASHED_TENANT_RENDER);

    await user.click(await screen.findByRole('tab', { name: /Policy & attempts/i }));
    const summary = await screen.findByTestId('geocode-attempt-variants');
    expect(summary).toHaveTextContent('Manual review');
    expect(summary).toHaveTextContent('Review task ready');
    expect(summary).toHaveTextContent('Provider timeout');
    expect(summary).toHaveTextContent('2 providers');
    expect(summary).not.toHaveTextContent('tsk_geo_manual_20260530');

    await user.click(screen.getByTestId('inspect-geocode-manual-review'));
    expect((await screen.findAllByText(/Geocoding attempt - PostGIS short-code/i)).length).toBeGreaterThan(0);
    expect(document.body).toHaveTextContent('Review task ready');
    expect(document.body).not.toHaveTextContent('tsk_geo_manual_20260530');
    expect(screen.getByRole('button', { name: /Open review queue/i })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('inspect-geocode-failure'));
    expect((await screen.findAllByText(/Geocoding attempt - OSM Nominatim/i)).length).toBeGreaterThan(0);
    expect(document.body).toHaveTextContent('Failure reason: Provider timeout');
  });
});
