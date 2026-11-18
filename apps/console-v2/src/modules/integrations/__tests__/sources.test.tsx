// sources.test.tsx — covers the Webhook sources operator surface
// (CLAIM-INGRESS-COMPLETE; rewired in CLAIM-INTEGRATIONS-WORKFLOWS-WIRING / Phase C5).
//
// Backed by:
//   - public.webhook_sources from
//     supabase/migrations/202510110004_webhook_integration.sql:185-208
//   - ui_read_registry.webhook_sources (seed-raw/registry.js)
//   - useResourceList<WebhookSourceRow>('webhook_sources')
//   - useUpsertWebhookSource (Phase C5 hook → ui_upsert_webhook_source_v1)
//   - useRotateWebhookSourceToken (Phase C5 hook → ui_rotate_webhook_source_token_v1)
//
// Targets:
//   1. Module mounts and the canonical registry-driven DataTable renders rows
//      from the seed (4 webhook sources).
//   2. Header `New intake source` button is capability-gated by
//      `webhooks.write` (lock chip when missing).
//   3. Toggle Enabled action fires `ui_upsert_webhook_source_v1({source_id, enabled: !current})`.
//   4. Rotate token action fires `ui_rotate_webhook_source_token_v1({source_id})`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { SourcesModule } from '@/modules/integrations/sources';
import * as apiMod from '@/lib/api';
import { consumeExternalIntakeSourceToken } from '@/lib/external-intake-token-handoff';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

const SOURCE_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'whs_exampleparcel_ksa',
    organization_id: 'org_rashed',
    source_identifier: 'exampleparcel-ksa-prod',
    name: 'Exampleparcel KSA production',
    provider_type: 'shopify',
    mapping_config_id: 'mc_exampleparcel_ksa',
    sender_id: 'snd_exampleparcel_ksa',
    rate_limit_per_hour: 1000,
    enabled: true,
    auth_token_masked: 'stored',
    created_at: '2026-05-10T12:00:00Z',
  },
  {
    id: 'whs_woo_ksa',
    organization_id: 'org_rashed',
    source_identifier: 'woocommerce-ksa',
    name: 'WooCommerce KSA',
    provider_type: 'woocommerce',
    mapping_config_id: 'mc_woo_ksa',
    sender_id: 'snd_woo_ksa',
    rate_limit_per_hour: 500,
    enabled: false,
    auth_token_masked: 'stored',
    created_at: '2026-05-10T12:05:00Z',
  },
];

const SOURCE_DIRECTORY_ROWS: Array<Record<string, unknown>> = [
  {
    ...SOURCE_ROWS[0],
    source_label: 'Exampleparcel KSA production',
    provider_type_label: 'Shopify',
    mapping_label: 'exampleparcel_ksa_v3.shipment_inbound',
    mapping_target: 'shipments.create',
    sender_label: 'Exampleparcel Riyadh sender',
    client_label: 'Exampleparcel KSA',
    event_count_24h: 7,
    error_count_24h: 0,
    rule_count: 3,
    active_rule_count: 3,
    is_healthy: true,
    hmac_enabled: false,
    hmac_auth_config_id: null,
    hmac_header: null,
    last_event_at: '2026-05-10T12:30:00Z',
  },
  {
    ...SOURCE_ROWS[1],
    source_label: 'WooCommerce KSA',
    provider_type_label: 'WooCommerce',
    mapping_label: 'woo_ksa_v1.shipment_inbound',
    mapping_target: 'shipments.create',
    sender_label: 'Woo Riyadh sender',
    client_label: 'Woo KSA',
    event_count_24h: 2,
    error_count_24h: 1,
    rule_count: 2,
    active_rule_count: 1,
    is_healthy: false,
    hmac_enabled: false,
    hmac_auth_config_id: null,
    hmac_header: null,
    last_event_at: '2026-05-10T12:15:00Z',
  },
];

const MAPPING_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'mc_exampleparcel_ksa',
    organization_id: 'org_rashed',
    mapping_type: 'webhook_inbound',
    mapping_key: 'exampleparcel_ksa_v3.shipment_inbound',
    target: 'shipments.create',
    mapping_config: { target: 'shipments.create', enabled: true },
    managed_metadata: { plugin_version_id: 'pv_exampleparcel_ksa' },
  },
  {
    id: 'mc_woo_ksa',
    organization_id: 'org_rashed',
    mapping_type: 'webhook_inbound',
    mapping_key: 'woo_ksa_v1.shipment_inbound',
    target: 'shipments.create',
    mapping_config: { target: 'shipments.create', enabled: true },
    managed_metadata: { plugin_version_id: 'pv_woo_ksa' },
  },
];

const SENDER_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'snd_exampleparcel_ksa',
    sender_id: 'snd_exampleparcel_ksa',
    organization_id_resolved: 'org_rashed',
    name: 'Exampleparcel Riyadh sender',
    client_label: 'Exampleparcel KSA',
  },
  {
    id: 'snd_woo_ksa',
    sender_id: 'snd_woo_ksa',
    organization_id_resolved: 'org_rashed',
    name: 'Woo Riyadh sender',
    client_label: 'Woo KSA',
  },
];

const CREDENTIAL_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'pac_hmac_ksa',
    organization_id: 'org_rashed',
    provider_label: 'Exampleparcel KSA webhook',
    auth_type: 'hmac',
    status: 'active',
    is_active: true,
  },
  {
    id: 'pac_api_key',
    organization_id: 'org_rashed',
    provider_label: 'Exampleparcel KSA API',
    auth_type: 'api_key',
    status: 'active',
    is_active: true,
  },
];

const LOOKUP_ROWS: Record<string, Array<Record<string, unknown>>> = {
  webhook_provider_type: [
    { value: 'shopify', label: 'Shopify', tone: 'info', is_default: true },
    { value: 'woocommerce', label: 'WooCommerce', tone: 'info' },
    { value: 'generic_json', label: 'Generic JSON', tone: 'neutral' },
  ],
  enabled_state: [
    { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true },
    { value: 'disabled', label: 'Disabled', tone: 'neutral' },
  ],
  webhook_source_health: [
    { value: 'healthy', label: 'Healthy', tone: 'good', is_default: true, rank: 10 },
    { value: 'degraded', label: 'Degraded', tone: 'warn', rank: 20 },
    { value: 'idle', label: 'Idle', tone: 'neutral', rank: 30 },
  ],
};

const originalListResource = apiMod.ui_list_resource_v1;
const originalGetLookups = apiMod.getLookups;
const originalLookupRow = apiMod.lookupRow;

function listResult(rows: Array<Record<string, unknown>>): Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>> {
  return {
    rows: rows.map((row) => ({ ...row })),
    total: rows.length,
  } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
}

async function defaultListResource(
  resource: string,
  opts?: apiMod.ListOpts,
): Promise<Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>> {
  if (resource === 'webhook_sources') return listResult(SOURCE_ROWS);
  if (resource === 'webhook_source_directory') return listResult(SOURCE_DIRECTORY_ROWS);
  if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
  if (resource === 'sender_summary') return listResult(SENDER_ROWS);
  if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
  return originalListResource(resource, opts);
}

function defaultGetLookups(category: string): ReturnType<typeof apiMod.getLookups> {
  if (category in LOOKUP_ROWS) return LOOKUP_ROWS[category] as ReturnType<typeof apiMod.getLookups>;
  return originalGetLookups(category);
}

function defaultLookupRow(category: string, value: string): ReturnType<typeof apiMod.lookupRow> {
  const row = LOOKUP_ROWS[category]?.find((candidate) => candidate.value === value);
  if (row) return row as unknown as ReturnType<typeof apiMod.lookupRow>;
  return originalLookupRow(category, value);
}

describe('SourcesModule', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let upsertSpy: TypedSpy<typeof apiMod, 'ui_upsert_webhook_source_v1'>;
  let rotateSpy: TypedSpy<typeof apiMod, 'ui_rotate_webhook_source_token_v1'>;
  let archiveSpy: TypedSpy<typeof apiMod, 'ui_archive_webhook_source_v1'>;
  beforeEach(() => {
    upsertSpy = typedSpy(apiMod, 'ui_upsert_webhook_source_v1');
    rotateSpy = typedSpy(apiMod, 'ui_rotate_webhook_source_token_v1');
    archiveSpy = typedSpy(apiMod, 'ui_archive_webhook_source_v1');
    const realList = defaultListResource;
    const realGet = apiMod.ui_get_resource_v1;
    const realGetLookups = defaultGetLookups;
    const realLookupRow = defaultLookupRow;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
      if (resource === 'webhook_sources') return listResult(SOURCE_ROWS);
      if (resource === 'webhook_source_directory') return listResult(SOURCE_DIRECTORY_ROWS);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return realList(resource, opts);
    });
    vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (SOURCE_ROWS.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (SOURCE_DIRECTORY_ROWS.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category in LOOKUP_ROWS) return LOOKUP_ROWS[category] as ReturnType<typeof apiMod.getLookups>;
      return realGetLookups(category);
    });
    vi.spyOn(apiMod, 'lookupRow').mockImplementation((category: string, value: string) => {
      const row = LOOKUP_ROWS[category]?.find((candidate) => candidate.value === value);
      if (row) return row as unknown as ReturnType<typeof apiMod.lookupRow>;
      return realLookupRow(category, value);
    });
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('mounts the page header + operator-facing source directory pill + table rows', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(
      await screen.findByText('Source list'),
    ).toBeInTheDocument();
    expect(screen.queryByText('ui_read_registry.webhook_sources')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const firstRow = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
    expect(firstRow?.textContent).toContain('Configured');
  });

  it('reads webhook sources and directory through the active tenant lens', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<SourcesModule />, {
      identity: {
        capabilities: ['all'],
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'webhook_sources',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'webhook_source_directory',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'mapping_config_directory',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'sender_summary',
        expect.objectContaining({ filter: { organization_id_resolved: 'org_rashed' } }),
      );
    });
    listSpy.mockRestore();
  });

  it('keeps generic webhook source resource reads token-redacted', async () => {
    const list = await apiMod.ui_list_resource_v1<Record<string, unknown>>('webhook_sources', {
      page_size: 5,
    });
    expect(list.rows.length).toBeGreaterThan(0);
    for (const row of list.rows) {
      expect(row).not.toHaveProperty('auth_token');
      expect(row).not.toHaveProperty('auth_token_hash');
      expect(row).toHaveProperty('auth_token_masked');
    }

    const detail = await apiMod.ui_get_resource_v1<Record<string, unknown>>(
      'webhook_sources',
      String(list.rows[0]!.id),
    );
    expect(detail).toBeTruthy();
    expect(detail).not.toHaveProperty('auth_token');
    expect(detail).not.toHaveProperty('auth_token_hash');
    expect(detail).toHaveProperty('auth_token_masked');
  });

  it('renders the canonical registry-driven columns', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table thead th').length).toBeGreaterThan(0);
    });
    const headerCells = Array.from(document.querySelectorAll('.dt__table thead th')).map((th) =>
      th.textContent?.trim() ?? '',
    );
    expect(headerCells.some((h) => /Name/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Source reference/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Provider/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Mapping/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Sender \/ client/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Rate \/ hr/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Enabled/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Receiver auth/.test(h))).toBe(true);
  });

  it('renders cross-resource links with canonical hrefs instead of hash placeholders', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const mappingLink = document.querySelector('a[href^="/integrations/mapping?focus="]') as HTMLElement;
    expect(mappingLink).not.toBeNull();
    await user.click(mappingLink);
    expect(document.querySelector('.drawer')).toBeNull();
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(document.querySelector('a[href="/integrations/rules"]')).not.toBeNull();
    expect(document.querySelector('a[href="#"]')).toBeNull();
  });

  it('keeps full source identifiers visible and copyable alongside friendly references', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    expect(document.body.textContent).toMatch(/Source ref .*exampleparcel-ksa-prod/);

    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent).toMatch(/Source ID/);
    expect(drawer.textContent).toMatch(/whs_exampleparcel_ksa/);
    expect(drawer.textContent).toMatch(/exampleparcel-ksa-prod/);
  });

  it('disables `New intake source` and shows the lock chip without webhooks.write', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['webhooks.read'] });
    const btn = await screen.findByRole('button', { name: /New intake source/ });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/Webhook update permission required/i).length).toBeGreaterThan(0);
  });

  it('renders the denied state without listing webhook-source data when webhooks.read is missing', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['webhooks.write'] });
    expect(await screen.findByText(/You do not have permission to view intake sources/i)).toBeInTheDocument();
    expect(apiMod.ui_list_resource_v1).not.toHaveBeenCalled();
    expect(document.querySelector('.dt__table')).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(rotateSpy).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('permission-gates source row write actions without firing backend mutations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesModule />, { capabilities: ['webhooks.read'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const editOption = await screen.findByRole('option', { name: /^Edit/ });
    const rotateOption = await screen.findByRole('option', { name: /^Rotate token/ });
    const toggleOption = await screen.findByRole('option', { name: /^Toggle enabled/ });
    const archiveOption = await screen.findByRole('option', { name: /^Archive source/ });
    expect(editOption).toHaveClass('is-disabled');
    expect(rotateOption).toHaveClass('is-disabled');
    expect(toggleOption).toHaveClass('is-disabled');
    expect(archiveOption).toHaveClass('is-disabled');

    await user.click(rotateOption);
    await user.click(toggleOption);
    await user.click(archiveOption);
    expect(rotateSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('opens the New intake source modal with required fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    const btn = await screen.findByRole('button', { name: /New intake source/ });
    await user.click(btn);
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    expect(screen.getByLabelText(/Intake source display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Intake source reference/i)).toBeInTheDocument();
    expect(screen.getByText('Mapping profile')).toBeInTheDocument();
    expect(screen.getByText('Shipment sender')).toBeInTheDocument();
  });

  it('keeps the disabled source option distinct when enabled-state lookups contain duplicate enabled rows', async () => {
    const user = userEvent.setup();
    vi.mocked(apiMod.getLookups).mockImplementation((category: string) => {
      if (category === 'enabled_state') {
        return [
          { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true },
          { value: 'enabled', label: 'Enabled duplicate', tone: 'good' },
          { value: 'disabled', label: 'Disabled', tone: 'neutral' },
        ] as ReturnType<typeof apiMod.getLookups>;
      }
      if (category in LOOKUP_ROWS) return LOOKUP_ROWS[category] as ReturnType<typeof apiMod.getLookups>;
      return [] as ReturnType<typeof apiMod.getLookups>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));

    const enabledState = await screen.findByRole('radiogroup', { name: 'Intake source enabled state' });
    expect(within(enabledState).getByRole('radio', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true');
    expect(within(enabledState).getByRole('radio', { name: 'Disabled' })).toHaveAttribute('aria-checked', 'false');
  });

  it('saves disabled webhook sources from the visible enabled-state button group', async () => {
    const user = userEvent.setup();
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_disabled_from_form',
      correlation_id: 'cor_disabled_from_form',
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Disabled source from form');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'disabled-source-from-form');
    await user.click(screen.getByRole('radio', { name: 'Disabled' }));
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
  });

  it('rejects numeric-only source references before the backend upsert', async () => {
    const user = userEvent.setup();
    const realList = defaultListResource;
    const realGetLookups = defaultGetLookups;
    const realLookupRow = defaultLookupRow;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_plugin_numeric_guard',
                organization_id: 'org_rashed',
                mapping_key: 'integration_plugin:numeric-guard:source:tenant:org_rashed',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: true },
                managed_metadata: { plugin_version_id: 'pv_numeric_guard' },
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    const lookupSpy = vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category === 'enabled_state') {
        return [
          { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true },
          { value: 'disabled', label: 'Disabled', tone: 'neutral' },
        ] as ReturnType<typeof apiMod.getLookups>;
      }
      return realGetLookups(category);
    });
    const lookupRowSpy = vi.spyOn(apiMod, 'lookupRow').mockImplementation((category: string, value: string) => {
      if (category === 'enabled_state') {
        if (value === 'enabled') return { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true } as ReturnType<typeof apiMod.lookupRow>;
        if (value === 'disabled') return { value: 'disabled', label: 'Disabled', tone: 'neutral' } as ReturnType<typeof apiMod.lookupRow>;
      }
      return realLookupRow(category, value);
    });

    try {
      renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /New intake source/ }));
      await user.type(screen.getByLabelText(/Intake source display name/i), 'Numeric source');
      await user.type(screen.getByLabelText(/Intake source reference/i), '1000');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Create$/i })).toBeEnabled();
      });
      await user.click(screen.getByRole('button', { name: /^Create$/i }));

      expect(await screen.findByText(/Source reference must be an operator key/i)).toBeInTheDocument();
      expect(upsertSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      lookupSpy.mockRestore();
      lookupRowSpy.mockRestore();
    }
  });

  it('creates webhook sources with the active tenant id in the canonical upsert payload', async () => {
    const user = userEvent.setup();
    const realList = defaultListResource;
    const realResolveSettings = apiMod.resolveSettings;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_plugin_active',
                organization_id: 'org_rashed',
                mapping_key: 'integration_plugin:active:source:tenant:org_rashed',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: true },
                managed_metadata: { plugin_version_id: 'pv_active' },
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    const settingsSpy = vi.spyOn(apiMod, 'resolveSettings').mockImplementation(
      async (category: string, scope?: unknown) => {
        if (category === 'webhook_source_default_policy') {
          return {
            category: 'webhook_source_default_policy',
            value: { default_rate_limit_per_hour: 1234 },
            resolved_from: 'global',
            ladder_path: [],
            settings_resolution_id: 'sv_webhook_source_default_policy_test',
            override_of: null,
          } as Awaited<ReturnType<typeof apiMod.resolveSettings>>;
        }
        return realResolveSettings(category, scope);
      },
    );
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_first_tenant',
      correlation_id: 'cor_first_tenant',
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    try {
      renderWithProviders(<SourcesModule />, {
        identity: {
          capabilities: ['all'],
          user: { access_scope_type: 'platform', organization_id: 'org_platform' },
          scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
        },
      });

      await user.click(await screen.findByRole('button', { name: /New intake source/ }));
      await waitFor(() => {
        expect(screen.getByRole('spinbutton')).toHaveValue(1234);
      });
      await user.type(screen.getByLabelText(/Intake source display name/i), 'First tenant API');
      await user.type(screen.getByLabelText(/Intake source reference/i), 'first-tenant-api');
      await user.click(screen.getByRole('button', { name: /^Create$/i }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            organization_id: 'org_rashed',
            name: 'First tenant API',
            source_identifier: 'first-tenant-api',
            mapping_config_id: expect.any(String),
            sender_id: expect.any(String),
            rate_limit_per_hour: 1234,
          }),
        );
      });
    } finally {
      listSpy.mockRestore();
      settingsSpy.mockRestore();
    }
  });

  it('creates webhook sources with backend HMAC policy fields when receiver signatures are required', async () => {
    const user = userEvent.setup();
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_hmac_required',
      correlation_id: 'cor_hmac_required',
      hmac_policy: {
        ok: true,
        hmac_enabled: true,
        hmac_auth_config_id: 'pac_hmac_ksa',
        hmac_header: 'x-msx-signature',
      },
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, {
      identity: {
        capabilities: ['all'],
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Signed receiver source');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'signed-receiver-source');
    await user.selectOptions(screen.getByLabelText(/Intake source HMAC validation/i), 'hmac');
    await user.selectOptions(screen.getByLabelText(/Intake source HMAC credential/i), 'pac_hmac_ksa');
    await user.type(screen.getByLabelText(/Intake source HMAC signature header/i), 'x-msx-signature');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org_rashed',
          name: 'Signed receiver source',
          source_identifier: 'signed-receiver-source',
          hmac_enabled: true,
          hmac_auth_config_id: 'pac_hmac_ksa',
          hmac_header: 'x-msx-signature',
        }),
      );
    });
  });

  it('offers enabled webhook-inbound mapping profiles for source remediation', async () => {
    const user = userEvent.setup();
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_ad_hoc',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'ad.hoc.shipment_inbound',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create' },
              },
              {
                id: 'mc_wrong_type',
                organization_id: 'org_rashed',
                mapping_type: 'provider_response',
                mapping_key: 'provider.response.only',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: true },
              },
              {
                id: 'mc_disabled_plugin',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'integration_plugin:disabled:source:tenant:org_rashed',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: false },
                managed_metadata: { plugin_version_id: 'pv_disabled' },
              },
              {
                id: 'mc_plugin',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'integration_plugin:active:source:tenant:org_rashed',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: true },
                managed_metadata: { plugin_version_id: 'pv_active' },
              },
            ],
            total: 3,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );

    try {
      renderWithProviders(<SourcesModule />, {
        identity: {
          capabilities: ['all'],
          user: { access_scope_type: 'platform', organization_id: 'org_platform' },
          scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
        },
      });
      await user.click(await screen.findByRole('button', { name: /New intake source/ }));
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });

      const modal = document.querySelector('.modal') as HTMLElement;
      const selects = Array.from(modal.querySelectorAll('select')) as HTMLSelectElement[];
      const mappingSelect = selects[1]!;
      const optionLabels = Array.from(mappingSelect.options).map((option) => option.textContent ?? '');

      expect(optionLabels).toEqual([
        'ad.hoc.shipment_inbound -> shipments.create',
        'integration_plugin:active:source:tenant:org_rashed -> shipments.create',
      ]);
      expect(optionLabels.join('\n')).not.toContain('integration_plugin:disabled');
      expect(optionLabels.join('\n')).not.toContain('provider.response.only');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('shows operator-facing mapping labels instead of technical integration keys', async () => {
    const user = userEvent.setup();
    const technicalKey = 'integration_plugin:active:source:tenant:org_rashed';
    const friendlyLabel = 'Default shipment webhook intake';
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_sources') {
          return listResult([
            {
              id: 'whs_labeled_mapping',
              organization_id: 'org_rashed',
              source_identifier: 'tenant-intake-webhook',
              name: 'Tenant intake webhook',
              provider_type: 'shopify',
              mapping_config_id: 'mc_labeled_plugin',
              sender_id: 'snd_exampleparcel_ksa',
              rate_limit_per_hour: 1000,
              enabled: true,
              auth_token_masked: 'stored',
            },
          ]);
        }
        if (resource === 'webhook_source_directory') {
          return listResult([
            {
              id: 'whs_labeled_mapping',
              organization_id: 'org_rashed',
              source_identifier: 'tenant-intake-webhook',
              name: 'Tenant intake webhook',
              provider_type: 'shopify',
              mapping_config_id: 'mc_labeled_plugin',
              mapping_label: technicalKey,
              sender_id: 'snd_exampleparcel_ksa',
              sender_label: 'Exampleparcel Riyadh sender',
              client_label: 'Exampleparcel KSA',
              event_count_24h: 0,
              error_count_24h: 0,
              rule_count: 0,
              active_rule_count: 0,
              is_healthy: true,
            },
          ]);
        }
        if (resource === 'mapping_config_directory') {
          return listResult([
            {
              id: 'mc_labeled_plugin',
              organization_id: 'org_rashed',
              mapping_key: technicalKey,
              target: 'shipments.create',
              mapping_config: {
                label: friendlyLabel,
                target: 'shipments.create',
                enabled: true,
              },
              managed_metadata: { plugin_version_id: 'pv_active' },
            },
          ]);
        }
        return realList(resource, opts);
      },
    );

    try {
      renderWithProviders(<SourcesModule />, {
        identity: {
          capabilities: ['all'],
          user: { access_scope_type: 'platform', organization_id: 'org_platform' },
          scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
        },
      });

      expect(await screen.findByText(friendlyLabel)).toBeInTheDocument();
      expect(screen.queryByText(technicalKey)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /New intake source/ }));
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });

      const modal = document.querySelector('.modal') as HTMLElement;
      const selects = Array.from(modal.querySelectorAll('select')) as HTMLSelectElement[];
      const mappingSelect = selects[1]!;
      const optionLabels = Array.from(mappingSelect.options).map((option) => option.textContent ?? '');

      expect(optionLabels).toEqual([`${friendlyLabel} -> shipments.create`]);
      expect(optionLabels.join('\n')).not.toContain(technicalKey);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('blocks shipment-create webhook sources until a sender/client binding is selected', async () => {
    const user = userEvent.setup();
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_shipments_create',
                organization_id: 'org_rashed',
                mapping_key: 'integration_plugin:shipment:create:source:tenant:org_rashed',
                target: 'shipments.create',
                mapping_config: { target: 'shipments.create', enabled: true },
                managed_metadata: { plugin_version_id: 'pv_shipments_create' },
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (resource === 'sender_summary') {
          return {
            rows: [],
            total: 0,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );

    try {
      renderWithProviders(<SourcesModule />, {
        identity: {
          capabilities: ['all'],
          user: { access_scope_type: 'platform', organization_id: 'org_platform' },
          scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
        },
      });

      await user.click(await screen.findByRole('button', { name: /New intake source/ }));
      await user.type(screen.getByLabelText(/Intake source display name/i), 'Unbound shipment source');
      await user.type(screen.getByLabelText(/Intake source reference/i), 'unbound-shipment-source');
      await user.click(screen.getByRole('button', { name: /^Create$/i }));

      expect(
        await screen.findByText(/Shipment-create mappings require a shipment sender/i),
      ).toBeInTheDocument();
      expect(upsertSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('preserves the current row mapping and unbound sender state when editing an existing source', async () => {
    const user = userEvent.setup();
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_sources') {
          return {
            rows: [
              {
                id: 'whs_live_row_only',
                organization_id: 'org_rashed',
                source_identifier: 'live-row-only',
                name: 'Live row-only mapping source',
                provider_type: 'generic',
                mapping_config_id: 'mc_live_row_only',
                sender_id: null,
                rate_limit_per_hour: 800,
                enabled: true,
              },
            ],
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'whs_live_row_only',
                organization_id: 'org_rashed',
                mapping_label: 'live.row-only.shipment_inbound',
                sender_id: null,
                sender_label: null,
                client_label: null,
                event_count_24h: 0,
                error_count_24h: 0,
                rule_count: 0,
                active_rule_count: 0,
                is_healthy: true,
                has_recent_errors: false,
                auth_token_masked: 'stored',
              },
            ],
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (resource === 'mapping_config_directory') {
          return { rows: [], total: 0 } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (resource === 'sender_summary') {
          return {
            rows: [
              {
                id: 'snd_live_sender',
                sender_id: 'snd_live_sender',
                name: 'Live Sender',
                client_label: 'Live Client',
              },
            ],
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_live_row_only',
      correlation_id: 'cor_live_row_only',
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    try {
      renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr')).toHaveLength(1);
      });
      await user.click(document.querySelector('.dt__table tbody tr') as Element);
      await waitFor(() => {
        expect(document.querySelector('.drawer')).not.toBeNull();
      });
      await user.click(within(document.querySelector('.drawer') as HTMLElement).getByRole('button', { name: /^Edit$/i }));
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });

      const modal = document.querySelector('.modal') as HTMLElement;
      const selects = Array.from(modal.querySelectorAll('select')) as HTMLSelectElement[];
      const mappingSelect = selects[1]!;
      const senderSelect = selects[2]!;
      expect(mappingSelect.value).toBe('mc_live_row_only');
      expect(mappingSelect.options[0]?.textContent).toContain('live.row-only.shipment_inbound');
      expect(senderSelect.value).toBe('');

      await user.click(screen.getByRole('button', { name: /^Save$/i }));
      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            source_id: 'whs_live_row_only',
            mapping_config_id: 'mc_live_row_only',
            sender_id: null,
          }),
        );
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('fires ui_rotate_webhook_source_token_v1 from the drawer footer (Phase C5)', async () => {
    const user = userEvent.setup();
    const rotatedToken = 'b'.repeat(64);
    rotateSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_rotated',
      auth_token: rotatedToken,
      correlation_id: 'cor_rotated',
    } as Awaited<ReturnType<typeof apiMod.ui_rotate_webhook_source_token_v1>>);
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const firstRow = document.querySelector('.dt__table tbody tr');
    expect(firstRow).not.toBeNull();
    await user.click(firstRow as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const rotateBtn = await screen.findByRole('button', { name: /Rotate token/ });
    await user.click(rotateBtn);
    await waitFor(() => {
      expect(rotateSpy).toHaveBeenCalled();
    });
    const args = rotateSpy.mock.calls[0]?.[0] as { source_id?: string } | undefined;
    expect(args?.source_id).toBeTruthy();
    expect(apiMod.ui_get_resource_v1).toHaveBeenCalledWith('webhook_source_directory', args?.source_id);
    expect(await screen.findByText('One-time source token')).toBeInTheDocument();
    expect(screen.getByText(/External Intake > Test webhook intake or API request intake/i)).toBeInTheDocument();
    expect(screen.getByText('Token state: Configured')).toBeInTheDocument();
    expect(screen.getByText(rotatedToken)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use in Test webhook intake/i })).toBeEnabled();
    expect(window.location.href).not.toContain(rotatedToken);
    await user.click(screen.getByRole('button', { name: /Use in API request intake/i }));
    await waitFor(() => expect(window.location.pathname).toBe('/insights/api-gateway'));
    expect(window.location.href).not.toContain(rotatedToken);
    expect(consumeExternalIntakeSourceToken('api-gateway')).toMatchObject({
      token: rotatedToken,
      source_id: args?.source_id,
    });
  });

  it('rotates a webhook source token and refreshes the open drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    const rotatedToken = 'e'.repeat(64);
    window.history.replaceState(null, '', '/integrations/sources');
    let sourceRows: Array<Record<string, unknown>> = SOURCE_ROWS.slice(0, 1).map((row) => ({ ...row }));
    let directoryRows: Array<Record<string, unknown>> = SOURCE_DIRECTORY_ROWS.slice(0, 1).map((row) => ({
      ...row,
      auth_token_masked: null,
    }));
    const realList = defaultListResource;
    const realGet = apiMod.ui_get_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return realList(resource, opts);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    rotateSpy.mockImplementation(async (args) => {
      directoryRows = directoryRows.map((row) =>
        row.id === args.source_id
          ? { ...row, auth_token_masked: 'stored', last_rotated_at: '2026-05-13T09:45:00.000Z' }
          : row,
      );
      sourceRows = sourceRows.map((row) =>
        row.id === args.source_id
          ? { ...row, updated_at: '2026-05-13T09:45:00.000Z' }
          : row,
      );
      return {
        ok: true,
        webhook_source_id: String(args.source_id),
        auth_token: rotatedToken,
        correlation_id: 'cor_rotate_no_reload',
      } as Awaited<ReturnType<typeof apiMod.ui_rotate_webhook_source_token_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBe(1);
    });
    await user.click(document.querySelector('.dt__table tbody tr') as Element);
    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement | null;
      expect(drawer?.textContent).toContain('Not configured');
    });

    await user.click(await screen.findByRole('button', { name: /Rotate token/ }));
    expect(await screen.findByText('One-time source token')).toBeInTheDocument();
    expect(screen.getByText('Token state: Configured')).toBeInTheDocument();
    expect(screen.getByText(rotatedToken)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Done$/ }));

    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement | null;
      expect(drawer?.textContent).toContain('Auth token status');
      expect(drawer?.textContent).toContain('Configured');
      expect(screen.getByTestId('source-token-readback-status')).toHaveTextContent('Token status confirmed: Configured');
      expect(drawer?.textContent).not.toContain(rotatedToken);
    });
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Configured');
      expect(row?.textContent).not.toContain(rotatedToken);
    });
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', SOURCE_ROWS[0]!.id);
    expect(listSpy.mock.calls.filter(([resource]) => resource === 'webhook_source_directory').length).toBeGreaterThan(1);
    expect(window.location.pathname).toBe('/integrations/sources');
  });

  it('fires ui_upsert_webhook_source_v1 on Toggle enabled row action (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // Row actions open via the kebab → palette pattern. Click the first row's
    // kebab, then pick `Toggle enabled` from the palette items.
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    expect(kebabs.length).toBeGreaterThan(0);
    await user.click(kebabs[0]!);
    const toggleItem = await screen.findByRole('option', { name: /Toggle enabled/ });
    await user.click(toggleItem);
    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalled();
    });
    const args = upsertSpy.mock.calls[0]?.[0] as {
      source_id?: string;
      organization_id?: string;
      enabled?: boolean;
    } | undefined;
    expect(args?.source_id).toBeTruthy();
    expect(typeof args?.enabled).toBe('boolean');
  });

  it('shows toggled enabled state from backend-refetched source rows without reload', async () => {
    const user = userEvent.setup();
    let enabled = true;
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') {
        return listResult([{ ...SOURCE_ROWS[0]!, enabled }]);
      }
      if (resource === 'webhook_source_directory') {
        return listResult([{ ...SOURCE_DIRECTORY_ROWS[0]!, enabled }]);
      }
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources' && id === SOURCE_ROWS[0]!.id) {
        return { ...SOURCE_ROWS[0]!, enabled } as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory' && id === SOURCE_ROWS[0]!.id) {
        return { ...SOURCE_DIRECTORY_ROWS[0]!, enabled } as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      enabled = Boolean(args.enabled);
      return {
        ok: true,
        webhook_source_id: String(args.source_id),
        correlation_id: 'cor_toggle_no_reload',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Enabled');
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Toggle enabled/ }));

    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Disabled');
    });
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', SOURCE_ROWS[0]!.id);
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', SOURCE_ROWS[0]!.id);
  });

  it('keeps toggled state unchanged when backend readback is stale', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult([{ ...SOURCE_ROWS[0]!, enabled: true }]);
      if (resource === 'webhook_source_directory') return listResult([{ ...SOURCE_DIRECTORY_ROWS[0]!, enabled: true }]);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return ({ ...SOURCE_ROWS[0]!, id, enabled: true }) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return ({ ...SOURCE_DIRECTORY_ROWS[0]!, id, enabled: true }) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return null as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
    });
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_exampleparcel_ksa',
      correlation_id: 'cor_toggle_stale_readback',
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Enabled');
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Toggle enabled/ }));

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Enabled');
      expect(row?.textContent).not.toContain('Disabled');
    });
  });

  it('requires a reason and fires ui_archive_webhook_source_v1 from the row action', async () => {
    const user = userEvent.setup();
    archiveSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_exampleparcel_ksa',
      enabled: false,
      action: 'archived',
      correlation_id: 'cor_archive',
    } as Awaited<ReturnType<typeof apiMod.ui_archive_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Archive source/ }));
    await user.click(await screen.findByRole('button', { name: /^Archive source$/ }));
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/i)).toHaveValue('');

    await user.type(screen.getByLabelText(/Reason/i), 'Legacy integration retired');
    await user.click(await screen.findByRole('button', { name: /^Archive source$/ }));
    await waitFor(() => {
      expect(archiveSpy).toHaveBeenCalledTimes(1);
    });
    expect(archiveSpy).toHaveBeenCalledWith({
      source_id: 'whs_exampleparcel_ksa',
      reason: 'Legacy integration retired',
    });
  });

  it('shows archived webhook source lifecycle from backend-refetched rows without reload', async () => {
    const user = userEvent.setup();
    let sourceRows: Array<Record<string, unknown>> = SOURCE_ROWS;
    let directoryRows: Array<Record<string, unknown>> = SOURCE_DIRECTORY_ROWS;
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    archiveSpy.mockImplementation(async (args) => {
      const archivedAt = '2026-05-12T05:20:00.000Z';
      sourceRows = SOURCE_ROWS.map((row) =>
        row.id === args.source_id
          ? {
              ...row,
              enabled: false,
              managed_metadata: {
                lifecycle: 'archived',
                archived_at: archivedAt,
                archive_reason: args.reason,
              },
            }
          : row,
      );
      directoryRows = SOURCE_DIRECTORY_ROWS.map((row) =>
        row.id === args.source_id
          ? {
              ...row,
              enabled: false,
              lifecycle_state: 'archived',
              archived_at: archivedAt,
              archive_reason: args.reason,
            }
          : row,
      );
      return {
        ok: true,
        webhook_source_id: String(args.source_id),
        enabled: false,
        archived_at: archivedAt,
        action: 'archived',
        correlation_id: 'cor_archive_no_reload',
      } as Awaited<ReturnType<typeof apiMod.ui_archive_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Open');
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Archive source/ }));
    await user.type(screen.getByLabelText(/Reason/i), 'Legacy integration retired');
    await user.click(await screen.findByRole('button', { name: /^Archive source$/ }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Archived');
      expect(row?.textContent).toContain('Disabled');
    });
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_exampleparcel_ksa');
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', 'whs_exampleparcel_ksa');

    const archivedKebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(archivedKebabs[0]!);
    const editOption = await screen.findByRole('option', { name: /^Edit/ });
    const rotateOption = await screen.findByRole('option', { name: /^Rotate token/ });
    const toggleOption = await screen.findByRole('option', { name: /^Toggle enabled/ });
    expect(editOption).toHaveClass('is-disabled');
    expect(editOption).toHaveTextContent('retained for audit');
    expect(rotateOption).toHaveClass('is-disabled');
    expect(rotateOption).toHaveTextContent('cannot rotate tokens');
    expect(toggleOption).toHaveClass('is-disabled');
    expect(toggleOption).toHaveTextContent('already disabled for intake');
    expect(screen.queryByRole('option', { name: /Archive source/ })).not.toBeInTheDocument();
  });

  it('keeps archive modal open when backend archive readback is missing', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(SOURCE_ROWS);
      if (resource === 'webhook_source_directory') return listResult(SOURCE_DIRECTORY_ROWS);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    vi.spyOn(apiMod, 'ui_get_resource_v1').mockResolvedValue(null as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>);
    archiveSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_exampleparcel_ksa',
      enabled: false,
      action: 'archived',
      correlation_id: 'cor_archive_missing_readback',
    } as Awaited<ReturnType<typeof apiMod.ui_archive_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Open');
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /Archive source/ }));
    await user.type(screen.getByLabelText(/Reason/i), 'Legacy integration retired');
    await user.click(await screen.findByRole('button', { name: /^Archive source$/ }));

    await waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(1));
    expect(document.querySelector('.modal')).not.toBeNull();
    expect(document.querySelector('.dt__table tbody')?.textContent ?? '').toContain('Open');
    expect(document.querySelector('.dt__table tbody')?.textContent ?? '').not.toContain('Archived');
  });

  it('shows newly created webhook source from backend-refetched rows without reload', async () => {
    const user = userEvent.setup();
    let sourceRows: Array<Record<string, unknown>> = [];
    let directoryRows: Array<Record<string, unknown>> = [];
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      const row = {
        id: 'whs_created_no_reload',
        organization_id: args.organization_id,
        source_identifier: args.source_identifier,
        name: args.name,
        provider_type: args.provider_type,
        mapping_config_id: args.mapping_config_id,
        sender_id: args.sender_id,
        rate_limit_per_hour: args.rate_limit_per_hour,
        enabled: args.enabled,
      };
      sourceRows = [row];
      directoryRows = [{
        ...row,
        mapping_label: 'exampleparcel_ksa_v3.shipment_inbound',
        sender_label: 'Exampleparcel Riyadh sender',
        client_label: 'Exampleparcel KSA',
        event_count_24h: 0,
        error_count_24h: 0,
        rule_count: 0,
        active_rule_count: 0,
        is_healthy: true,
        auth_token_masked: 'stored',
      }];
      return {
        ok: true,
        webhook_source_id: 'whs_created_no_reload',
        correlation_id: 'cor_created_no_reload',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'First tenant API');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'first-tenant-api');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('First tenant API');
      expect(row?.textContent).toContain('first-tenant-api');
    });
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_created_no_reload');
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', 'whs_created_no_reload');
  });

  it('hands a newly created one-time token to Webhook tester without putting it in the URL', async () => {
    const user = userEvent.setup();
    const createdToken = 'created-token-for-handoff'.repeat(2);
    let sourceRows: Array<Record<string, unknown>> = [];
    let directoryRows: Array<Record<string, unknown>> = [];
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      const row = {
        id: 'whs_created_handoff',
        organization_id: args.organization_id,
        source_identifier: args.source_identifier,
        name: args.name,
        provider_type: args.provider_type,
        mapping_config_id: args.mapping_config_id,
        sender_id: args.sender_id,
        rate_limit_per_hour: args.rate_limit_per_hour,
        enabled: args.enabled,
        hmac_enabled: args.hmac_enabled,
        hmac_auth_config_id: args.hmac_auth_config_id,
        hmac_header: args.hmac_header,
      };
      sourceRows = [row];
      directoryRows = [{ ...row, auth_token_masked: 'stored' }];
      return {
        ok: true,
        webhook_source_id: 'whs_created_handoff',
        auth_token: createdToken,
        correlation_id: 'cor_created_handoff',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Created handoff source');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'created-handoff-source');
    await waitFor(() => {
      expect(screen.getByLabelText(/Intake source mapping profile/i)).toHaveValue('mc_exampleparcel_ksa');
      expect(screen.getByLabelText(/Intake source shipment sender/i)).toHaveTextContent('Exampleparcel Riyadh sender');
    });
    await user.selectOptions(screen.getByLabelText(/Intake source shipment sender/i), 'snd_exampleparcel_ksa');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    expect(await screen.findByText('One-time source token')).toBeInTheDocument();
    expect(screen.getByText(createdToken)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Use in Test webhook intake/i }));

    await waitFor(() => expect(window.location.pathname).toBe('/integrations/webhook-tester'));
    expect(window.location.href).not.toContain(createdToken);
    expect(consumeExternalIntakeSourceToken('webhook-tester')).toMatchObject({
      token: createdToken,
      source_id: 'whs_created_handoff',
      source_name: 'Created handoff source',
    });
  });

  it('keeps a newly created one-time token source visible after Done without reload', async () => {
    const user = userEvent.setup();
    const createdToken = 'done-token-for-visible-row'.repeat(2);
    let sourceRows: Array<Record<string, unknown>> = [];
    let directoryRows: Array<Record<string, unknown>> = [];
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      const row = {
        id: 'whs_created_done_readback',
        organization_id: args.organization_id,
        source_identifier: args.source_identifier,
        name: args.name,
        provider_type: args.provider_type,
        mapping_config_id: args.mapping_config_id,
        sender_id: args.sender_id,
        rate_limit_per_hour: args.rate_limit_per_hour,
        enabled: args.enabled,
        hmac_enabled: args.hmac_enabled,
        hmac_auth_config_id: args.hmac_auth_config_id,
        hmac_header: args.hmac_header,
      };
      sourceRows = [row];
      directoryRows = [{ ...row, auth_token_masked: 'stored' }];
      return {
        ok: true,
        webhook_source_id: 'whs_created_done_readback',
        auth_token: createdToken,
        correlation_id: 'cor_created_done_readback',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Created done source');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'created-done-source');
    await user.selectOptions(screen.getByLabelText(/Intake source shipment sender/i), 'snd_exampleparcel_ksa');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    expect(await screen.findByText('One-time source token')).toBeInTheDocument();
    expect(screen.getByText(createdToken)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Done$/ }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Created done source');
      expect(row?.textContent).toContain('created-done-source');
      expect(row?.textContent).toContain('Configured');
      expect(row?.textContent).not.toContain(createdToken);
    });
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_created_done_readback');
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', 'whs_created_done_readback');
  });

  it('shows created HMAC source auth mode from backend-refetched rows without reload', async () => {
    const user = userEvent.setup();
    let sourceRows: Array<Record<string, unknown>> = [];
    let directoryRows: Array<Record<string, unknown>> = [];
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      const row = {
        id: 'whs_hmac_readback',
        organization_id: args.organization_id,
        source_identifier: args.source_identifier,
        name: args.name,
        provider_type: args.provider_type,
        mapping_config_id: args.mapping_config_id,
        sender_id: args.sender_id,
        rate_limit_per_hour: args.rate_limit_per_hour,
        enabled: args.enabled,
        hmac_enabled: args.hmac_enabled,
        hmac_auth_config_id: args.hmac_auth_config_id,
        hmac_header: args.hmac_header,
      };
      sourceRows = [row];
      directoryRows = [{
        ...row,
        auth_token_masked: 'stored',
        hmac_enabled: true,
        hmac_auth_config_id: 'pac_hmac_ksa',
        hmac_header: 'x-msx-signature',
      }];
      return {
        ok: true,
        webhook_source_id: 'whs_hmac_readback',
        correlation_id: 'cor_hmac_readback',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Signed readback source');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'signed-readback-source');
    await user.selectOptions(screen.getByLabelText(/Intake source shipment sender/i), 'snd_exampleparcel_ksa');
    await user.selectOptions(screen.getByLabelText(/Intake source HMAC validation/i), 'hmac');
    await user.selectOptions(screen.getByLabelText(/Intake source HMAC credential/i), 'pac_hmac_ksa');
    await user.type(screen.getByLabelText(/Intake source HMAC signature header/i), 'x-msx-signature');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const row = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
      expect(row?.textContent).toContain('Signed readback source');
      expect(row?.textContent).toContain('signed-readback-source');
      expect(row?.textContent).toContain('Token + HMAC (x-msx-signature)');
      expect(row?.textContent).toContain('Configured');
    });
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
      hmac_enabled: true,
      hmac_auth_config_id: 'pac_hmac_ksa',
      hmac_header: 'x-msx-signature',
    }));
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_hmac_readback');
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', 'whs_hmac_readback');
  });

  it('shows edited webhook source from backend-refetched rows without reload', async () => {
    const user = userEvent.setup();
    let sourceRows: Array<Record<string, unknown>> = SOURCE_ROWS.map((row) => ({ ...row }));
    let directoryRows: Array<Record<string, unknown>> = SOURCE_DIRECTORY_ROWS.map((row) => ({ ...row }));
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult(sourceRows);
      if (resource === 'webhook_source_directory') return listResult(directoryRows);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources') {
        return (sourceRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      if (resource === 'webhook_source_directory') {
        return (directoryRows.find((row) => row.id === id) ?? null) as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockImplementation(async (args) => {
      sourceRows = sourceRows.map((row) =>
        row.id === args.source_id
          ? { ...row, name: args.name, source_identifier: args.source_identifier }
          : row,
      );
      directoryRows = directoryRows.map((row) =>
        row.id === args.source_id
          ? { ...row, name: args.name, source_label: args.name, source_identifier: args.source_identifier }
          : row,
      );
      return {
        ok: true,
        webhook_source_id: String(args.source_id),
        correlation_id: 'cor_edit_no_reload',
      } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>;
    });

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelector('.dt__table tbody')?.textContent ?? '').toContain('Exampleparcel KSA production');
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    await user.click(await screen.findByRole('option', { name: /^Edit/ }));
    const nameInput = await screen.findByLabelText(/Intake source display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Exampleparcel KSA production v2');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(document.querySelector('.dt__table tbody')?.textContent ?? '').toContain('Exampleparcel KSA production v2');
    });
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_exampleparcel_ksa');
    expect(getSpy).toHaveBeenCalledWith('webhook_source_directory', 'whs_exampleparcel_ksa');
  });

  it('keeps webhook source save open when backend readback is missing', async () => {
    const user = userEvent.setup();
    const realGet = apiMod.ui_get_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'webhook_sources') return listResult([]);
      if (resource === 'webhook_source_directory') return listResult([]);
      if (resource === 'mapping_config_directory') return listResult(MAPPING_ROWS);
      if (resource === 'sender_summary') return listResult(SENDER_ROWS);
      if (resource === 'integration_credential_directory') return listResult(CREDENTIAL_ROWS);
      return listResult([]);
    });
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_sources' || resource === 'webhook_source_directory') {
        return null as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
      }
      return realGet(resource, id);
    });
    upsertSpy.mockResolvedValue({
      ok: true,
      webhook_source_id: 'whs_missing_readback',
      correlation_id: 'cor_missing_readback',
    } as Awaited<ReturnType<typeof apiMod.ui_upsert_webhook_source_v1>>);

    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New intake source/ }));
    await user.type(screen.getByLabelText(/Intake source display name/i), 'Missing readback source');
    await user.type(screen.getByLabelText(/Intake source reference/i), 'missing-readback-source');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    expect(
      await screen.findByText('Webhook source whs_missing_readback is not readable from the backend.'),
    ).toBeInTheDocument();
    expect(document.querySelector('.modal')).not.toBeNull();
    expect(document.querySelector('.dt__table tbody')?.textContent ?? '').not.toContain('Missing readback source');
    expect(getSpy).toHaveBeenCalledWith('webhook_sources', 'whs_missing_readback');
  });

  // W27 — paired projection consumption assertions. Module reads
  // `webhook_source_directory` so projection-derived columns (Healthy chip,
  // Events 24h, Errors 24h, Rules) surface in the rendered DataTable.
  it('renders the health summary projection pill without internal view names (W27)', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(
        screen.getByText('Health summary'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('v_webhook_source_directory')).not.toBeInTheDocument();
  });

  it('renders projection-derived columns Healthy + Events 24h + Rules (W27)', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table thead th').length).toBeGreaterThan(0);
    });
    const headerCells = Array.from(document.querySelectorAll('.dt__table thead th')).map((th) =>
      th.textContent?.trim() ?? '',
    );
    // W27 directory join surfaces Healthy + Events 24h + Errors 24h + Rules
    // columns alongside the canonical SSOT columns.
    expect(headerCells.some((h) => /Healthy/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Events 24h/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Errors 24h/.test(h))).toBe(true);
    expect(headerCells.some((h) => /^Rules$/.test(h))).toBe(true);
  });

  it('renders canonical lookup labels for provider, enabled, and source health states', async () => {
    renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Unknown provider');
    expect(text).not.toContain('Unknown enabled state');
    expect(text).not.toContain('Unknown source health');
    expect(text).toMatch(/Shopify|WooCommerce|Generic JSON|Custom ERP|Delivery provider/);
    expect(text).toMatch(/Enabled|Disabled/);
    expect(text).toMatch(/Healthy|Degraded|Idle/);
  });

  it('fails closed when the token projection is missing instead of rendering row auth_token', async () => {
    const user = userEvent.setup();
    const rawToken = 'raw-token-must-never-render';
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const result = await realList(resource, opts);
        if (resource === 'webhook_sources') {
          return {
            ...result,
            rows: (result.rows as Array<Record<string, unknown>>).slice(0, 1).map((row) => ({
              ...row,
              auth_token: rawToken,
            })),
          };
        }
        if (resource === 'webhook_source_directory') {
          return { ...result, rows: [] };
        }
        return result;
      },
    );
    try {
      renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBe(1);
      });

      await user.click(document.querySelector('.dt__table tbody tr') as Element);
      await waitFor(() => {
        expect(document.querySelector('.drawer')).not.toBeNull();
      });
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer.textContent).toMatch(/Auth token status/);
      expect(drawer.textContent).toMatch(/Token state unavailable/);
      expect(drawer.textContent).not.toContain(rawToken);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('renders only the projection-backed configured state for webhook auth tokens', async () => {
    const user = userEvent.setup();
    const rawToken = 'second-raw-token-must-never-render';
    const projectionMarker = 'stored';
    const realList = defaultListResource;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const result = await realList(resource, opts);
        if (resource === 'webhook_sources') {
          return {
            ...result,
            rows: (result.rows as Array<Record<string, unknown>>).slice(0, 1).map((row) => ({
              ...row,
              auth_token: rawToken,
            })),
          };
        }
        if (resource === 'webhook_source_directory') {
          return {
            ...result,
            rows: (result.rows as Array<Record<string, unknown>>).slice(0, 1).map((row) => ({
              ...row,
              auth_token_masked: projectionMarker,
            })),
          };
        }
        return result;
      },
    );
    try {
      renderWithProviders(<SourcesModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBe(1);
      });

      await user.click(document.querySelector('.dt__table tbody tr') as Element);
      await waitFor(() => {
        expect(document.querySelector('.drawer')).not.toBeNull();
      });
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer.textContent).toMatch(/Auth token status/);
      expect(drawer.textContent).toMatch(/Configured/);
      expect(drawer.textContent).not.toContain(rawToken);
      expect(drawer.textContent).not.toContain(projectionMarker);
    } finally {
      listSpy.mockRestore();
    }
  });
});
