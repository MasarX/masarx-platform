// mapping.test.tsx — covers the Mapping Studio operator surface
// (CLAIM-INTEGRATIONS-WORKFLOWS-WIRING / Phase C5).
//
// Backed by:
//   - public.mapping_configs from
//     supabase/migrations/202510110003_mapping_lookup.sql:101+
//   - ui_read_registry.mapping_configs (seed-raw/registry.js, capability gates
//     mappings.read / mappings.write per 202601071220:104).
//   - useResourceList<MappingConfig>('mapping_configs')
//   - useUpsertMappingArtifact (Phase C5 hook → ui_upsert_mapping_artifact_v1)
//   - usePromoteMappingVersion (Phase C5 hook → mapping_config_promote_v1)
//
// Targets:
//   1. Module mounts and the registry-driven DataTable renders rows from the
//      seeded mapping_configs.
//   2. Header `New mapping` button opens the modal with required form fields.
//   3. Save/Promote/Disable row actions fire the canonical Phase B6 RPCs.
//   4. New-mapping Create button persists via ui_upsert_mapping_artifact_v1.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { MappingModule } from '@/modules/integrations/mapping';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

const TENANT_IDENTITY = {
  capabilities: ['all'],
  user: {
    access_scope_type: 'tenant' as const,
    access_scope_id: null,
    organization_id: 'org_rashed',
  },
  scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 as const } },
};

describe('MappingModule', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let upsertSpy: TypedSpy<typeof apiMod, 'ui_upsert_mapping_artifact_v1'>;
  let deleteSpy: TypedSpy<typeof apiMod, 'ui_delete_mapping_config_v1'>;
  let promoteSpy: TypedSpy<typeof apiMod, 'mapping_config_promote_v1'>;
  let testMappingSpy: TypedSpy<typeof apiMod, 'ui_test_mapping_config_v1'>;
  beforeEach(() => {
    upsertSpy = typedSpy(apiMod, 'ui_upsert_mapping_artifact_v1');
    deleteSpy = typedSpy(apiMod, 'ui_delete_mapping_config_v1');
    promoteSpy = typedSpy(apiMod, 'mapping_config_promote_v1');
    testMappingSpy = typedSpy(apiMod, 'ui_test_mapping_config_v1');
  });
  afterEach(() => {
    upsertSpy.mockRestore();
    deleteSpy.mockRestore();
    promoteSpy.mockRestore();
    testMappingSpy.mockRestore();
  });

  it('mounts the page header + table rows', async () => {
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('toolbar', { name: /External Intake workspace/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Provider credentials/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Routing rules/i })).toBeEnabled();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('opens the focused mapping drawer from a focus query', async () => {
    window.history.pushState({}, '', '/integrations/mapping?focus=mc_examplemarket_ksa_v3_in');
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });

    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer).toBeTruthy();
      expect(drawer).toHaveTextContent('exampleparcel_ksa_v3.shipment_inbound');
      expect(drawer).toHaveTextContent('Mapping body');
    });

    window.history.pushState({}, '', '/integrations/mapping');
  });

  it('fetches and opens a focused mapping that is outside the first visible page', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const focusedRow = {
      id: 'mc_focus_not_page',
      organization_id: 'org_rashed',
      mapping_type: 'webhook_inbound',
      mapping_key: 'focused.mapping.outside.page',
      mapping_config: { target: 'shipments.create', sample_input: { shipment: { external_id: 'FT-FOCUS' } } },
      mapping_version: 3,
      updated_at: '2026-05-15T09:00:00.000Z',
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          if (filter.id === 'mc_focus_not_page') {
            return { rows: [focusedRow], total: 1, page: 1, page_size: 1 };
          }
          return {
            rows: [{
              ...focusedRow,
              id: 'mc_visible_other',
              mapping_key: 'visible.first.page.mapping',
            }],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          if (filter.id === 'mc_focus_not_page') {
            return {
              rows: [{
                id: 'mc_focus_not_page',
                target: 'shipments.create',
                rules_count: 0,
                source_count: 2,
                rule_usage_count: 1,
                is_in_use: true,
                has_rules: false,
              }],
              total: 1,
              page: 1,
              page_size: 1,
            };
          }
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );

    window.history.pushState({}, '', '/integrations/mapping?focus=mc_focus_not_page');
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });

    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer).toBeTruthy();
      expect(drawer).toHaveTextContent('focused.mapping.outside.page');
      expect(drawer).toHaveTextContent('2 sources');
    });
    expect(listSpy).toHaveBeenCalledWith(
      'mapping_configs',
      expect.objectContaining({ filter: { id: 'mc_focus_not_page' }, page_size: 1 }),
    );

    window.history.pushState({}, '', '/integrations/mapping');
    listSpy.mockRestore();
  });

  it('redacts secret-bearing mapping readback panes while keeping proof identifiers visible', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const focusedRow = {
      id: 'mc_redacted_mapping_readback',
      organization_id: 'org_rashed',
      mapping_type: 'webhook_inbound',
      mapping_key: 'redacted.mapping.readback',
      mapping_config: {
        target: 'shipments.create',
        sample_input: {
          shipment: { external_id: 'FT-REDACT-PROOF-1' },
          idempotency_key: 'idem-redacted-proof-1',
          headers: {
            authorization: 'Bearer raw-mapping-bearer-must-not-render',
            'x-correlation-id': 'corr-redacted-proof-1',
          },
          auth_token: 'raw-mapping-token-must-not-render',
          callback: '/functions/v1/webhook-receiver?api_key=raw-mapping-api-key-must-not-render&keep=value',
        },
        sample_output: {
          shipment: { external_id: 'FT-REDACT-PROOF-1' },
          credentials: { api_secret: 'raw-output-secret-must-not-render' },
        },
        credentials: { access_key: 'raw-body-access-must-not-render' },
      },
      mapping_version: 3,
      updated_at: '2026-05-15T09:00:00.000Z',
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          if (filter.id === 'mc_redacted_mapping_readback') {
            return { rows: [focusedRow], total: 1, page: 1, page_size: 1 };
          }
          return { rows: [], total: 0, page: 1, page_size: opts?.page_size ?? 25 };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_redacted_mapping_readback',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );

    try {
      window.history.pushState({}, '', '/integrations/mapping?focus=mc_redacted_mapping_readback');
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el).toHaveTextContent('redacted.mapping.readback');
        expect(el).toHaveTextContent('FT-REDACT-PROOF-1');
        expect(el).toHaveTextContent('idem-redacted-proof-1');
        expect(el).toHaveTextContent('corr-redacted-proof-1');
        expect(el).toHaveTextContent('[redacted]');
        expect(el).not.toHaveTextContent('raw-mapping-token-must-not-render');
        expect(el).not.toHaveTextContent('raw-mapping-bearer-must-not-render');
        expect(el).not.toHaveTextContent('raw-mapping-api-key-must-not-render');
        expect(el).not.toHaveTextContent('raw-output-secret-must-not-render');
        expect(el).not.toHaveTextContent('raw-body-access-must-not-render');
        return el as HTMLElement;
      });
      expect(within(drawer).getByText('Mapping body')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      listSpy.mockRestore();
    }
  });

  it('opens focused mapping with failed inbox remediation payload and tests the redacted payload', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const failedPayload = {
      shipment: { external_id: 'FAILED-INBOX-REF-1' },
      recipient: { name: 'Failed Receiver' },
      auth_token: 'secret-token-must-not-render',
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          return {
            rows: [{
              id: 'mc_failed_mapping',
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: 'failed.mapping.shipments.create',
              mapping_config: { target: 'shipments.create', sample_input: { shipment: { external_id: 'SAMPLE-ONLY' } } },
              mapping_version: 2,
              updated_at: '2026-05-15T09:00:00.000Z',
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_failed_mapping',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_inbox_directory' && filter.id === 'wbk_failed_mapping') {
          return {
            rows: [{
              id: 'wbk_failed_mapping',
              webhook_source_id: 'whs_failed_mapping',
              source_label: 'Failed mapping source',
              source_identifier: 'failed-mapping-source',
              mapping_config_id: 'mc_failed_mapping',
              mapping_label: 'failed.mapping.shipments.create',
              processing_status: 'failed',
              idempotency_key: 'failed-remediation-001',
              error_message: 'missing required webhook shipment recipient/address?auth_token=secret-token-must-not-render Authorization: Bearer bearer-secret-must-not-render api_key=inline-secret-must-not-render',
              raw_payload: failedPayload,
            }],
            total: 1,
            page: 1,
            page_size: 1,
          };
        }
        return originalList(resource, opts);
      },
    );
    testMappingSpy.mockResolvedValue({
      ok: true,
      status: 'succeeded',
      report_id: 'report_failed_payload',
      transformed_payload: { shipment: { external_id: 'FAILED-INBOX-REF-1' } },
      report: {
        result_payload: {
          input: { shipment: { external_id: 'FAILED-INBOX-REF-1' } },
          output: { shipment: { external_id: 'FAILED-INBOX-REF-1' } },
        },
      },
    });
    const user = userEvent.setup();

    try {
      window.history.pushState({}, '', '/integrations/mapping?focus=mc_failed_mapping&inbox_id=wbk_failed_mapping');
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el).toHaveTextContent('Failed inbound request');
        expect(el).toHaveTextContent('FAILED-INBOX-REF-1');
        expect(el).toHaveTextContent('[redacted]');
        expect(el).not.toHaveTextContent('secret-token-must-not-render');
        expect(el).not.toHaveTextContent('bearer-secret-must-not-render');
        expect(el).not.toHaveTextContent('inline-secret-must-not-render');
        expect(el).toHaveTextContent('auth_token=[redacted]');
        expect(el).toHaveTextContent('Authorization: Bearer [redacted]');
        expect(el).toHaveTextContent('api_key=[redacted]');
        return el as HTMLElement;
      });

      await user.click(within(drawer).getByRole('button', { name: /Test failed payload/i }));
      const payloadEditor = await screen.findByLabelText(/Input/i);
      const editorValue = (payloadEditor as HTMLTextAreaElement).value;
      expect(editorValue).toContain('FAILED-INBOX-REF-1');
      expect(editorValue).toContain('[redacted]');
      expect(editorValue).not.toContain('secret-token-must-not-render');
      await user.click(screen.getByRole('button', { name: /^Run$/i }));

      await waitFor(() => {
        expect(testMappingSpy).toHaveBeenCalledWith(
          'mc_failed_mapping',
          expect.objectContaining({
            shipment: expect.objectContaining({ external_id: 'FAILED-INBOX-REF-1' }),
            auth_token: '[redacted]',
          }),
        );
      });
      const result = await screen.findByTestId('mapping-test-result');
      expect(result).toHaveTextContent('Confirmation');
      expect(result).toHaveTextContent('Confirmed');
      expect(result).toHaveTextContent('needs attention');
      expect(result).toHaveTextContent('Output missing required fields');
      expect(result).toHaveTextContent('Recipient name');
      expect(result).toHaveTextContent('Address line 1');
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      listSpy.mockRestore();
    }
  });

  it('links failed mapping remediation directly back to Test webhook intake with the same inbox row', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          return {
            rows: [{
              id: 'mc_failed_mapping_bridge',
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: 'failed.mapping.bridge',
              mapping_config: { target: 'shipments.create' },
              mapping_version: 2,
              updated_at: '2026-05-15T09:00:00.000Z',
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_failed_mapping_bridge',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_inbox_directory' && filter.id === 'wbk_failed_mapping_bridge') {
          return {
            rows: [{
              id: 'wbk_failed_mapping_bridge',
              webhook_source_id: 'whs_failed_mapping_bridge',
              source_label: 'Failed mapping bridge source',
              source_identifier: 'failed-mapping-bridge-source',
              mapping_config_id: 'mc_failed_mapping_bridge',
              mapping_label: 'failed.mapping.bridge',
              processing_status: 'failed',
              idempotency_key: 'failed-remediation-bridge-001',
              error_message: 'missing required webhook shipment recipient/address',
              raw_payload: {
                shipment: { external_id: 'FAILED-BRIDGE-REF-1' },
              },
            }],
            total: 1,
            page: 1,
            page_size: 1,
          };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();

    try {
      window.history.pushState(
        {},
        '',
        '/integrations/mapping?focus=mc_failed_mapping_bridge&inbox_id=wbk_failed_mapping_bridge',
      );
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el).toHaveTextContent('Failed inbound request');
        expect(el).toHaveTextContent('FAILED-BRIDGE-REF-1');
        return el as HTMLElement;
      });

      await user.click(within(drawer).getByRole('button', { name: /Open in Test webhook intake/i }));

      await waitFor(() => {
        expect(window.location.pathname).toBe('/integrations/webhook-tester');
        expect(new URLSearchParams(window.location.search).get('inbox_id')).toBe('wbk_failed_mapping_bridge');
      });
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      listSpy.mockRestore();
    }
  });

  it('keeps failed-payload mapping test successful when shipment-create output is complete', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const failedPayload = {
      shipment: {
        reference: 'FIXED-INBOX-REF-1',
        cod_amount: 151.75,
        cod_currency: 'SAR',
        service_type: 'delivery',
        recipient: {
          name: 'Noura Fixed Receiver',
          phone: '+12025550186',
          external_id: 'FIXED-REC-1',
        },
        destination: {
          line1: 'King Fahd Road',
          city: 'Riyadh',
          country: 'SA',
        },
      },
    };
    const mappedOutput = {
      shipment: {
        external_id: 'FIXED-INBOX-REF-1',
        reference_number: 'FIXED-INBOX-REF-1',
        service_type: 'delivery',
        cod_amount: 151.75,
        currency: 'SAR',
      },
      recipient: {
        name: 'Noura Fixed Receiver',
        phone: '+12025550186',
        external_id: 'FIXED-REC-1',
      },
      address: {
        line1: 'King Fahd Road',
        city: 'Riyadh',
        country_code: 'SA',
      },
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          return {
            rows: [{
              id: 'mc_fixed_mapping',
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: 'fixed.mapping.shipments.create',
              mapping_config: { target: 'shipments.create', sample_input: failedPayload },
              mapping_version: 2,
              updated_at: '2026-05-15T15:00:00.000Z',
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_fixed_mapping',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_inbox_directory' && filter.id === 'wbk_fixed_mapping') {
          return {
            rows: [{
              id: 'wbk_fixed_mapping',
              webhook_source_id: 'whs_fixed_mapping',
              source_label: 'Fixed mapping source',
              source_identifier: 'fixed-mapping-source',
              mapping_config_id: 'mc_fixed_mapping',
              mapping_label: 'fixed.mapping.shipments.create',
              processing_status: 'failed',
              idempotency_key: 'fixed-remediation-001',
              error_message: 'missing required webhook shipment recipient/address',
              raw_payload: failedPayload,
            }],
            total: 1,
            page: 1,
            page_size: 1,
          };
        }
        return originalList(resource, opts);
      },
    );
    testMappingSpy.mockResolvedValue({
      ok: true,
      status: 'succeeded',
      report_id: 'report_fixed_payload',
      transformed_payload: mappedOutput,
      report: {
        result_payload: {
          input: failedPayload,
          output: mappedOutput,
        },
      },
    });
    const user = userEvent.setup();

    try {
      window.history.pushState({}, '', '/integrations/mapping?focus=mc_fixed_mapping&inbox_id=wbk_fixed_mapping');
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el).toHaveTextContent('Failed inbound request');
        return el as HTMLElement;
      });

      await user.click(within(drawer).getByRole('button', { name: /Test failed payload/i }));
      await user.click(await screen.findByRole('button', { name: /^Run$/i }));

      const result = await screen.findByTestId('mapping-test-result');
      expect(result).toHaveTextContent('Confirmation');
      expect(result).toHaveTextContent('Confirmed');
      expect(result).toHaveTextContent('succeeded');
      expect(result).not.toHaveTextContent('needs attention');
      expect(result).not.toHaveTextContent('Output missing required fields');
      expect(result).toHaveTextContent('Mapping output protected');
      expect(result).toHaveTextContent('Sensitive submitted details are hidden');
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      listSpy.mockRestore();
    }
  });

  it('refreshes the focused remediation panel when failed inbox readback arrives after the drawer opens', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    let resolveInbox!: (value: any) => void;
    const inboxReadback = new Promise<any>((resolve) => {
      resolveInbox = resolve;
    });
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const filter = (opts?.filter ?? {}) as Record<string, unknown>;
        if (resource === 'mapping_configs') {
          return {
            rows: [{
              id: 'mc_async_failed_mapping',
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: 'async.failed.mapping',
              mapping_config: { target: 'shipments.create', sample_input: { shipment: { external_id: 'SAMPLE-ONLY' } } },
              mapping_version: 1,
              updated_at: '2026-05-15T09:00:00.000Z',
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_async_failed_mapping',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_inbox_directory' && filter.id === 'wbk_async_failed_mapping') {
          return inboxReadback;
        }
        return originalList(resource, opts);
      },
    );

    try {
      window.history.pushState({}, '', '/integrations/mapping?focus=mc_async_failed_mapping&inbox_id=wbk_async_failed_mapping');
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      expect(document.querySelector('.drawer')).toBeNull();

      resolveInbox({
        rows: [{
          id: 'wbk_async_failed_mapping',
          webhook_source_id: 'whs_async_failed_mapping',
          source_label: 'Async failed source',
          source_identifier: 'async-failed-source',
          mapping_config_id: 'mc_async_failed_mapping',
          mapping_label: 'async.failed.mapping',
          processing_status: 'failed',
          idempotency_key: 'async-remediation-001',
          error_message: 'recipient/address missing',
          raw_payload: {
            shipment: { external_id: 'ASYNC-FAILED-REF-1' },
            recipient: { name: 'Async Failed Receiver' },
            api_key: 'async-secret-must-not-render',
          },
        }],
        total: 1,
        page: 1,
        page_size: 1,
      });

      await waitFor(() => {
        const drawer = document.querySelector('.drawer');
        expect(drawer).toHaveTextContent('Failed inbound request');
        expect(drawer).toHaveTextContent('ASYNC-FAILED-REF-1');
        expect(drawer).toHaveTextContent('[redacted]');
        expect(drawer).not.toHaveTextContent('async-secret-must-not-render');
      });
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      listSpy.mockRestore();
    }
  });

  it('edits the focused mapping body and refreshes the drawer from backend readback without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalList = apiMod.ui_list_resource_v1;
    let saved = false;
    const initialBody = {
      target: 'shipments.create',
      sample_input: { shipment: { external_id: 'FT-BODY-OLD' } },
    };
    const updatedBody = {
      target: 'shipments.create',
      sample_input: { shipment: { external_id: 'FT-BODY-NEW' } },
      remediation_note: 'recipient and address fields mapped',
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [{
              id: 'mc_body_edit',
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: 'body.edit.mapping',
              mapping_config: saved ? updatedBody : initialBody,
              mapping_version: saved ? 2 : 1,
              updated_at: saved ? '2026-05-15T10:00:00.000Z' : '2026-05-15T09:00:00.000Z',
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [{
              id: 'mc_body_edit',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 1,
              rule_usage_count: 1,
              is_in_use: true,
              has_rules: true,
            }],
            total: 1,
            page: 1,
            page_size: opts?.page_size ?? 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async () => {
      saved = true;
      return { ok: true, mapping_config_id: 'mc_body_edit' };
    });
    const user = userEvent.setup();

    try {
      window.history.pushState({}, '', '/integrations/mapping?focus=mc_body_edit');
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el).toHaveTextContent('FT-BODY-OLD');
        return el as HTMLElement;
      });

      await user.click(within(drawer).getByRole('button', { name: /Edit body/i }));
      const editor = await screen.findByLabelText(/^Mapping body$/i);
      fireEvent.change(editor, { target: { value: JSON.stringify(updatedBody, null, 2) } });
      await user.click(screen.getByRole('button', { name: /Save body/i }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
          mapping_config_id: 'mc_body_edit',
          mapping_config: updatedBody,
        }));
      });
      await waitFor(() => {
        const refreshedDrawer = document.querySelector('.drawer') as HTMLElement | null;
        expect(refreshedDrawer).toBeTruthy();
        expect(refreshedDrawer).toHaveTextContent('FT-BODY-NEW');
        expect(refreshedDrawer).toHaveTextContent('recipient and address fields mapped');
      });
      expect(listSpy).toHaveBeenCalledWith(
        'mapping_configs',
        expect.objectContaining({ filter: { id: 'mc_body_edit' }, page_size: 1 }),
      );
    } finally {
      window.history.pushState({}, '', '/integrations/mapping');
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('scopes mapping reads to the active tenant lens', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<MappingModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'mapping_configs',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'mapping_config_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
    listSpy.mockRestore();
  });

  it('keeps backend table and view names out of the operator header', async () => {
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Mapping profiles')).toBeInTheDocument();
    expect(screen.getByText('Usage directory')).toBeInTheDocument();
    expect(screen.queryByText('mapping_configs')).not.toBeInTheDocument();
    expect(screen.queryByText('v_mapping_config_directory')).not.toBeInTheDocument();
  });

  it('shows a mapping_config target when the live row does not project a flat target column', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_live_default',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'integration_plugin:live:source:tenant:org_rashed',
                mapping_config: {
                  label: 'Default shipment webhook intake',
                  target: 'shipments.create',
                },
                updated_at: '2026-05-07T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );

    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    expect(await screen.findByText('Default shipment webhook intake')).toBeInTheDocument();
    expect(screen.getByText('shipments.create')).toBeInTheDocument();
    expect(screen.queryByText('integration_plugin:live:source:tenant:org_rashed')).not.toBeInTheDocument();

    listSpy.mockRestore();
  });

  it('shows backend-read source binding context inside the mapping drawer', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_bound_source',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'bound.source.mapping',
                mapping_config: {
                  label: 'Bound source mapping',
                  target: 'shipments.create',
                },
                updated_at: '2026-05-07T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_bound_source',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 1,
                source_count: 2,
                rule_usage_count: 2,
                is_in_use: true,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'whs_bound_source',
                organization_id: 'org_rashed',
                name: 'Tenant intake source',
                source_identifier: 'tenant-intake-source',
                mapping_config_id: 'mc_bound_source',
                enabled: true,
                client_label: 'Tenant client',
                sender_label: 'Tenant sender',
                rule_count: 3,
                active_rule_count: 2,
              },
              {
                id: 'whs_archived_source',
                organization_id: 'org_rashed',
                name: 'Archived intake source',
                source_identifier: 'archived-intake-source',
                mapping_config_id: 'mc_bound_source',
                enabled: false,
                lifecycle_state: 'archived',
                archived_at: '2026-05-07T00:00:00.000Z',
                client_label: 'Archived client',
                sender_label: 'Archived sender',
                rule_count: 1,
                active_rule_count: 0,
              },
            ],
            total: 2,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['mappings.read', 'webhooks.read'] });
      const row = await waitFor(() => {
        const el = screen.getByText('Bound source mapping').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      await user.click(row);

      expect(await screen.findByText('Bound sources')).toBeInTheDocument();
      expect(screen.getByText('Tenant intake source')).toBeInTheDocument();
      expect(screen.getByText('tenant-intake-source')).toBeInTheDocument();
      expect(screen.getByText('Client: Tenant client')).toBeInTheDocument();
      expect(screen.getByText('Sender: Tenant sender')).toBeInTheDocument();
      expect(screen.getByText('2/3 rules active')).toBeInTheDocument();
      expect(screen.getByText('Archived intake source')).toBeInTheDocument();
      expect(screen.getByText('Archived')).toBeInTheDocument();
      expect(screen.getByText('0/1 rules active')).toBeInTheDocument();

      await user.click(screen.getAllByRole('button', { name: /Open source/i })[0]!);
      await waitFor(() => {
        expect(window.location.pathname).toBe('/integrations/sources');
        expect(window.location.search).toContain('focus=whs_bound_source');
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('does not read source binding details without webhooks.read', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_denied_source',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'denied.source.mapping',
                mapping_config: { label: 'Denied source mapping', target: 'shipments.create' },
                updated_at: '2026-05-07T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_denied_source',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 0,
                source_count: 1,
                rule_usage_count: 0,
                is_in_use: true,
                has_rules: false,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          throw new Error('webhook source directory must not be queried without webhooks.read');
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['mappings.read'] });
      const row = await waitFor(() => {
        const el = screen.getByText('Denied source mapping').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      await user.click(row);

      expect(await screen.findByText('Bound sources')).toBeInTheDocument();
      expect(
        screen.getByText('Intake source binding details require source read permission.'),
      ).toBeInTheDocument();
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('webhook_source_directory');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('disables `New mapping` without mappings.write', async () => {
    renderWithProviders(<MappingModule />, { capabilities: ['mappings.read'] });
    const headerBtn = await screen.findByRole('button', { name: /New mapping/ });
    expect(headerBtn).toBeDisabled();
  });

  it('does not read mapping resources when mappings.read is missing', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<MappingModule />, { capabilities: ['mappings.write'] });

    expect(await screen.findByText(/You do not have permission to view the mapping studio/i)).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('mapping_configs');
      expect(resources).not.toContain('mapping_config_directory');
    });
    listSpy.mockRestore();
  });

  it('does not expose inline cell edits without mappings.write', async () => {
    renderWithProviders(<MappingModule />, { capabilities: ['mappings.read'] });
    const table = await waitFor(() => {
      const el = document.querySelector('.dt__table') as HTMLElement | null;
      expect(el).toBeTruthy();
      expect(el?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
      return el as HTMLElement;
    });
    expect(table.querySelectorAll('td.is-editable')).toHaveLength(0);
    expect(table.querySelectorAll('.dt-th-mark')).toHaveLength(0);
  });

  it('keeps mapping report and write row actions inert without mappings.write', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MappingModule />, { capabilities: ['mappings.read'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const testAction = await screen.findByRole('option', { name: /Test with sample payload/ });
    const duplicateAction = await screen.findByRole('option', { name: /^Duplicate/ });
    const promoteAction = await screen.findByRole('option', { name: /Promote version/ });
    const disableAction = await screen.findByRole('option', { name: /^Disable/ });
    const deleteAction = await screen.findByRole('option', { name: /^Delete mapping/ });
    for (const action of [testAction, duplicateAction, promoteAction, disableAction, deleteAction]) {
      expect(action).toHaveClass('is-disabled');
      expect(action).toHaveAttribute('aria-disabled', 'true');
      expect(action).toHaveTextContent('Requires mappings write permission');
      await user.click(action);
    }

    expect(document.querySelector('label[for="mapping-test-payload"]')).toBeNull();
    expect(testMappingSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(promoteSpy).not.toHaveBeenCalled();
  });

  it('does not expose mapping targets as free-text inline edits', async () => {
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    const targetCell = await screen.findByText('shipments.create');
    expect(targetCell.closest('td')).not.toHaveClass('is-editable');
  });

  it('opens the New mapping modal with row-driven type/key/target fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    const newBtn = await screen.findByRole('button', { name: /New mapping/ });
    await user.click(newBtn);
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    expect(document.querySelector('label[for="mapping-config-type"]')).toHaveTextContent('Type');
    expect(document.querySelector('label[for="mapping-config-key"]')).toHaveTextContent('Key');
    expect(document.querySelector('label[for="mapping-config-target"]')).toHaveTextContent('Target');
    expect(screen.getByLabelText(/Mapping type/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/exampleparcel_ksa_v3\.shipment_inbound/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mapping target/i)).toHaveValue('shipments.create');
    expect(screen.getByRole('option', { name: /^Shipment create$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Shipment update$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Shipment delete$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Shipment cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Shipment reschedule$/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/shipments\.create/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Create/ })).toBeInTheDocument();
  });

  it('requires backend-governed mapping_target lookup rows before creating a mapping', async () => {
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const category = String((opts?.filter as Record<string, unknown> | undefined)?.category ?? '');
        if (resource === 'lookup_values' && category === 'mapping_target') {
          return { rows: [], total: 0, page: 1, page_size: 500 };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();

    try {
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      const newBtn = await screen.findByRole('button', { name: /New mapping/ });
      await user.click(newBtn);

      expect(
        await screen.findByRole('heading', { name: /Mapping target options are not configured/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Existing targets stay read-only/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Mapping target/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Create/ })).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('New mapping persists with active tenant organization_id', async () => {
    let createdVisible = false;
    const originalGetLookups = apiMod.getLookups;
    const lookupsSpy = vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category === 'mapping_type') {
        return [{ value: 'webhook_inbound', label: 'Webhook inbound', rank: 1, tone: 'info' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      if (category === 'mapping_target') {
        return [{ value: 'shipments.create', label: 'Create shipment', rank: 1, tone: 'good' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      return originalGetLookups(category);
    });
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          const rows = createdVisible
            ? [
                {
                  id: 'mc_unit_mapping',
                  organization_id: 'org_rashed',
                  mapping_type: 'webhook_inbound',
                  mapping_key: 'unit.mapping',
                  mapping_config: { target: 'shipments.create' },
                  updated_at: '2026-05-13T00:00:00.000Z',
                },
              ]
            : [];
          return { rows, total: rows.length, page: 1, page_size: 25 };
        }
        if (resource === 'mapping_config_directory') {
          const rows = createdVisible
            ? [
                {
                  id: 'mc_unit_mapping',
                  organization_id: 'org_rashed',
                  target: 'shipments.create',
                  rules_count: 0,
                  source_count: 0,
                  rule_usage_count: 0,
                  is_in_use: false,
                  has_rules: false,
                },
              ]
            : [];
          return { rows, total: rows.length, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async () => {
      createdVisible = true;
      return { ok: true, mapping_config_id: 'mc_unit_mapping' };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const newBtn = await screen.findByRole('button', { name: /New mapping/ });
      await waitFor(() => expect(newBtn).toBeEnabled());
      await user.click(newBtn);
      await user.type(await screen.findByPlaceholderText(/exampleparcel_ksa_v3\.shipment_inbound/), 'unit.mapping');
      await user.selectOptions(screen.getByLabelText(/Mapping target/i), 'shipments.create');
      await user.click(screen.getByRole('button', { name: /^Create/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const args = upsertSpy.mock.calls[0]?.[0] as
        | { artifact?: string; organization_id?: string; mapping_config_id?: string | null; mapping_key?: string }
        | undefined;
      expect(args?.artifact).toBe('mapping_config');
      expect(args?.organization_id).toBe('org_rashed');
      expect(args?.mapping_config_id).toBeNull();
      expect(args?.mapping_key).toBe('unit.mapping');
      expect(await screen.findByText('unit.mapping')).toBeInTheDocument();

      const createdRow = screen.getByText('unit.mapping').closest('tr');
      expect(createdRow).toBeTruthy();
      await user.click(createdRow as HTMLElement);
      expect(await screen.findByText(/"target": "shipments\.create"/)).toBeInTheDocument();
    } finally {
      lookupsSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('keeps create modal open in live mode when create omits mapping_config_id', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalGetLookups = apiMod.getLookups;
    const lookupsSpy = vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category === 'mapping_type') {
        return [{ value: 'webhook_inbound', label: 'Webhook inbound', rank: 1, tone: 'info' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      if (category === 'mapping_target') {
        return [{ value: 'shipments.create', label: 'Create shipment', rank: 1, tone: 'good' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      return originalGetLookups(category);
    });
    upsertSpy.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      const newBtn = await screen.findByRole('button', { name: /New mapping/ });
      await waitFor(() => expect(newBtn).toBeEnabled());
      await user.click(newBtn);
      await user.type(await screen.findByPlaceholderText(/exampleparcel_ksa_v3\.shipment_inbound/), 'unit.live.noid');
      await user.selectOptions(screen.getByLabelText(/Mapping target/i), 'shipments.create');
      await user.click(screen.getByRole('button', { name: /^Create/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(document.querySelector('.modal')).not.toBeNull();
      });
      const table = document.querySelector('.dt__table') as HTMLElement;
      expect(within(table).queryByText('unit.live.noid')).not.toBeInTheDocument();
    } finally {
      lookupsSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps create modal open when backend readback omits created mapping row', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalGetLookups = apiMod.getLookups;
    const lookupsSpy = vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category === 'mapping_type') {
        return [{ value: 'webhook_inbound', label: 'Webhook inbound', rank: 1, tone: 'info' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      if (category === 'mapping_target') {
        return [{ value: 'shipments.create', label: 'Create shipment', rank: 1, tone: 'good' }] as ReturnType<
          typeof apiMod.getLookups
        >;
      }
      return originalGetLookups(category);
    });
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs' || resource === 'mapping_config_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockResolvedValue({ ok: true, mapping_config_id: 'mc_missing_readback' });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      const newBtn = await screen.findByRole('button', { name: /New mapping/ });
      await waitFor(() => expect(newBtn).toBeEnabled());
      await user.click(newBtn);
      await user.type(await screen.findByPlaceholderText(/exampleparcel_ksa_v3\.shipment_inbound/), 'unit.live.missing');
      await user.selectOptions(screen.getByLabelText(/Mapping target/i), 'shipments.create');
      await user.click(screen.getByRole('button', { name: /^Create/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      expect(document.querySelector('.modal')).not.toBeNull();
      const table = document.querySelector('.dt__table') as HTMLElement;
      expect(within(table).queryByText('unit.live.missing')).not.toBeInTheDocument();
    } finally {
      lookupsSpy.mockRestore();
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('does not apply live inline edits when upsert lacks mapping row readback', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    upsertSpy.mockResolvedValue({ ok: true, correlation_id: 'corr_mapping_inline' });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      const table = await waitFor(() => {
        const el = document.querySelector('.dt__table') as HTMLElement | null;
        expect(el).toBeTruthy();
        expect(el?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        return el as HTMLElement;
      });
      const editableCell = await waitFor(() => {
        const cell = Array.from(table.querySelectorAll('td.is-editable')).find(
          (el) => (el.textContent ?? '').trim() === 'exampleparcel_ksa_v3.shipment_inbound',
        ) as HTMLElement | undefined;
        expect(cell).toBeTruthy();
        return cell as HTMLElement;
      });

      await user.dblClick(editableCell);
      const input = await waitFor(() => {
        const el = document.querySelector('.dt-inline-input') as HTMLInputElement | null;
        expect(el).toBeTruthy();
        return el as HTMLInputElement;
      });
      fireEvent.change(input, { target: { value: 'unit.inline_unconfirmed' } });
      await waitFor(() => {
        expect(input.value).toBe('unit.inline_unconfirmed');
      });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(document.querySelector('.dt-inline-input')).toBeNull();
      });
      expect(within(table).queryByText('unit.inline_unconfirmed')).not.toBeInTheDocument();
      expect(within(table).getByText('exampleparcel_ksa_v3.shipment_inbound')).toBeInTheDocument();
    } finally {
      seedModeSpy.mockRestore();
    }
  });

  it('Promote version row action refreshes the visible backend-readback version without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let version = 1;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_promote_visible',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'promote.visible',
                mapping_version: version,
                mapping_config: { target: 'shipments.create' },
                updated_at: '2026-05-13T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_promote_visible',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 1,
                source_count: 0,
                rule_usage_count: 0,
                is_in_use: false,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    promoteSpy.mockImplementation(async () => {
      version = 2;
      return { ok: true, mapping_config_id: 'mc_promote_visible', promoted_to_version: 2 };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('promote.visible').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(row).getByText('v1')).toBeInTheDocument();
      const kebab = within(row).getByRole('button', { name: /Row actions/ });
      await user.click(kebab);
      const promote = await screen.findByRole('option', { name: /Promote version/ });
      await user.click(promote);
      await waitFor(() => {
        expect(promoteSpy).toHaveBeenCalledTimes(1);
      });
      const args = promoteSpy.mock.calls[0]?.[0] as { mapping_config_id?: string } | undefined;
      expect(args?.mapping_config_id).toBe('mc_promote_visible');
      await waitFor(() => {
        const updatedRow = screen.getByText('promote.visible').closest('tr') as HTMLElement;
        expect(within(updatedRow).getByText('v2')).toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Test with sample payload row action fires ui_test_mapping_config_v1 and shows backend report output', async () => {
    testMappingSpy.mockResolvedValue({
      ok: true,
      status: 'succeeded',
      report_id: 'mor_test',
      transformed_payload: {
        shipment: { external_id: 'FT-ORDER-1001' },
        credentials: { api_secret: 'REDACTED' },
      },
      report: {
        result_payload: {
          input: { shipment: { external_id: 'FT-ORDER-1001' }, api_secret: 'REDACTED' },
          output: {
            shipment: { external_id: 'FT-ORDER-1001' },
            credentials: { api_secret: 'REDACTED' },
          },
        },
        diagnostics_summary: { status: 'succeeded', redaction: 'sensitive_fields_redacted' },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const testAction = await screen.findByRole('option', { name: /Test with sample payload/ });
    await user.click(testAction);
    expect(document.querySelector('label[for="mapping-test-payload"]')).toHaveTextContent('Input');
    await user.click(await screen.findByRole('button', { name: /^Run/ }));

    await waitFor(() => {
      expect(testMappingSpy).toHaveBeenCalled();
    });
    const call = testMappingSpy.mock.calls[0];
    expect(call?.[0]).toBeTruthy();
    expect(call?.[1]).toEqual({});
    expect(await screen.findByTestId('mapping-test-result')).toBeInTheDocument();
    expect(screen.getByText('Confirmation')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Mapping output protected')).toBeInTheDocument();
    expect(screen.getByText('Mapping input protected')).toBeInTheDocument();
    expect(screen.getAllByText(/Sensitive submitted details are hidden/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/raw-mapping-secret/)).not.toBeInTheDocument();
  });

  it('Test with sample payload row action shows normalized failed-run errors only', async () => {
    testMappingSpy.mockResolvedValue({
      ok: false,
      status: 'failed',
      error: 'mapping_test_execution_failed',
      error_state: '22023',
      report_id: 'mor_failed',
      report: {
        diagnostics_summary: {
          status: 'failed',
          error: 'mapping_test_execution_failed',
          error_state: '22023',
          redaction: 'sensitive_fields_redacted',
        },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<MappingModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const testAction = await screen.findByRole('option', { name: /Test with sample payload/ });
    await user.click(testAction);
    await user.click(await screen.findByRole('button', { name: /^Run/ }));

    await waitFor(() => {
      expect(testMappingSpy).toHaveBeenCalled();
    });
    expect(await screen.findByTestId('mapping-test-result')).toBeInTheDocument();
    expect(screen.getByText('Mapping test failed')).toBeInTheDocument();
    expect(screen.getByText('Confirmation')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText(/returned review details/i)).toBeInTheDocument();
    expect(screen.queryByText(/mapping_test_execution_failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw-sql-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SQLERRM/)).not.toBeInTheDocument();
  });

  it('keeps live mapping test open when backend report evidence is missing', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    testMappingSpy.mockResolvedValue({ ok: true, correlation_id: 'corr_without_report' });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });
      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      const testAction = await screen.findByRole('option', { name: /Test with sample payload/ });
      await user.click(testAction);
      await user.click(await screen.findByRole('button', { name: /^Run/ }));

      await waitFor(() => {
        expect(testMappingSpy).toHaveBeenCalled();
      });
      expect(document.querySelector('.modal')).not.toBeNull();
      expect(screen.queryByText(/Mapping test completed/i)).not.toBeInTheDocument();
    } finally {
      seedModeSpy.mockRestore();
    }
  });

  it('Disable row action refreshes the visible backend-readback disabled status without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let disabled = false;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_live_disable',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'live.readback.disable',
                mapping_config: {
                  label: 'Live readback disable',
                  target: 'shipments.create',
                  enabled: !disabled,
                },
                updated_at: '2026-05-13T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_live_disable',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 1,
                source_count: 0,
                rule_usage_count: 0,
                is_in_use: false,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      disabled = true;
      return { ok: true, mapping_config_id: args.mapping_config_id ?? 'mc_live_disable' };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Live readback disable').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(row).getByText('Enabled')).toBeInTheDocument();

      const kebab = within(row).getByRole('button', { name: /Row actions/ });
      await user.click(kebab);
      const disable = await screen.findByRole('option', { name: /^Disable/ });
      await user.click(disable);

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const args = upsertSpy.mock.calls[0]?.[0] as
        | {
            artifact?: string;
            organization_id?: string;
            mapping_config_id?: string;
            mapping_config?: { enabled?: boolean };
          }
        | undefined;
      expect(args?.artifact).toBe('mapping_config');
      expect(args?.organization_id).toBe('org_rashed');
      expect(args?.mapping_config_id).toBe('mc_live_disable');
      expect(args?.mapping_config?.enabled).toBe(false);
      await waitFor(() => {
        const updatedRow = screen.getByText('Live readback disable').closest('tr') as HTMLElement;
        expect(within(updatedRow).getByText('Disabled')).toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('requires explicit impact confirmation before disabling a source/API-route-bound mapping', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let disabled = false;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_bound_disable_guard',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'bound.disable.guard',
                mapping_config: {
                  label: 'Bound disable guard',
                  target: 'shipments.create',
                  enabled: !disabled,
                },
                updated_at: '2026-05-24T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_bound_disable_guard',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 3,
                source_count: 1,
                rule_usage_count: 2,
                api_route_count: 1,
                is_in_use: true,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'src_bound_disable_guard',
                organization_id: 'org_rashed',
                source_label: 'Bound Source Guard',
                source_identifier: 'bound-source-guard',
                mapping_config_id: 'mc_bound_disable_guard',
                enabled: true,
                active_rule_count: 2,
                rule_count: 2,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      disabled = true;
      return { ok: true, mapping_config_id: args.mapping_config_id ?? 'mc_bound_disable_guard' };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Bound disable guard').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(row).getByText('Enabled')).toBeInTheDocument();

      await user.click(within(row).getByRole('button', { name: /Row actions/ }));
      await user.click(await screen.findByRole('option', { name: /^Disable/ }));

      const confirm = await screen.findByTestId('mapping-disable-impact-confirm');
      expect(confirm).toHaveTextContent('This mapping is used by live intake configuration');
      expect(confirm).toHaveTextContent('1 sources');
      expect(confirm).toHaveTextContent('2 rules');
      expect(confirm).toHaveTextContent('1 API routes');
      expect(confirm).toHaveTextContent('Bound Source Guard');
      expect(upsertSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^Confirm disable$/ }));
      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        const updatedRow = screen.getByText('Bound disable guard').closest('tr') as HTMLElement;
        expect(within(updatedRow).getByText('Disabled')).toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('fails closed when mapping usage readback is unavailable before disable', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_disable_unknown_usage',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'disable.unknown.usage',
                mapping_config: {
                  label: 'Disable unknown usage',
                  target: 'shipments.create',
                  enabled: true,
                },
                updated_at: '2026-05-24T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return { rows: [], total: 0, page: 1, page_size: opts?.page_size ?? 25 };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Disable unknown usage').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(row).getByText('Enabled')).toBeInTheDocument();

      await user.click(within(row).getByRole('button', { name: /Row actions/ }));
      await user.click(await screen.findByRole('option', { name: /^Disable/ }));

      const confirm = await screen.findByTestId('mapping-disable-impact-confirm');
      expect(confirm).toHaveTextContent('Mapping usage confirmation is required');
      expect(confirm).toHaveTextContent('Pending confirmation');
      expect(screen.queryByRole('button', { name: /^Confirm disable$/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Refresh usage$/ })).toBeInTheDocument();
      expect(upsertSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
      await user.click(within(row).getByLabelText('Select row'));
      await user.click(await screen.findByRole('button', { name: /^Bulk disable$/ }));

      expect(upsertSpy).not.toHaveBeenCalled();
      expect(within(row).getByText('Enabled')).toBeInTheDocument();
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Enable row action refreshes the visible backend-readback enabled status without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let enabled = false;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_live_enable',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'live.readback.enable',
                mapping_config: {
                  label: 'Live readback enable',
                  target: 'shipments.create',
                  enabled,
                },
                updated_at: '2026-05-13T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_live_enable',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 1,
                source_count: 0,
                rule_usage_count: 0,
                is_in_use: false,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      enabled = true;
      return { ok: true, mapping_config_id: args.mapping_config_id ?? 'mc_live_enable' };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Live readback enable').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      expect(within(row).getByText('Disabled')).toBeInTheDocument();

      const kebab = within(row).getByRole('button', { name: /Row actions/ });
      await user.click(kebab);
      expect(screen.queryByRole('option', { name: /^Disable/ })).not.toBeInTheDocument();
      const enable = await screen.findByRole('option', { name: /^Enable/ });
      await user.click(enable);

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const args = upsertSpy.mock.calls[0]?.[0] as
        | {
            artifact?: string;
            organization_id?: string;
            mapping_config_id?: string;
            mapping_config?: { enabled?: boolean };
          }
        | undefined;
      expect(args?.artifact).toBe('mapping_config');
      expect(args?.organization_id).toBe('org_rashed');
      expect(args?.mapping_config_id).toBe('mc_live_enable');
      expect(args?.mapping_config?.enabled).toBe(true);
      await waitFor(() => {
        const updatedRow = screen.getByText('Live readback enable').closest('tr') as HTMLElement;
        expect(within(updatedRow).getByText('Enabled')).toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Delete mapping stays disabled while live intake dependencies still exist', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_delete_bound_guard',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'delete.bound.guard',
                mapping_config: {
                  label: 'Delete bound guard',
                  target: 'shipments.create',
                  enabled: true,
                },
                updated_at: '2026-05-24T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: [
              {
                id: 'mc_delete_bound_guard',
                organization_id: 'org_rashed',
                target: 'shipments.create',
                rules_count: 2,
                source_count: 1,
                rule_usage_count: 2,
                api_route_count: 1,
                is_in_use: true,
                has_rules: true,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'src_delete_bound_guard',
                organization_id: 'org_rashed',
                source_label: 'Delete bound source',
                mapping_config_id: 'mc_delete_bound_guard',
                enabled: true,
                active_rule_count: 2,
                rule_count: 2,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Delete bound guard').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      await user.click(within(row).getByRole('button', { name: /Row actions/ }));

      const deleteAction = await screen.findByRole('option', { name: /^Delete mapping/ });
      expect(deleteAction).toHaveClass('is-disabled');
      expect(deleteAction).toHaveTextContent('Remove 1 sources, 2 rules, and 1 API routes before deleting this mapping.');
      await user.click(deleteAction);
      expect(document.querySelector('[data-testid="mapping-delete-confirm"]')).toBeNull();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Delete mapping stays disabled until usage confirmation is available', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: [
              {
                id: 'mc_delete_unknown_usage',
                organization_id: 'org_rashed',
                mapping_type: 'webhook_inbound',
                mapping_key: 'delete.unknown.usage',
                mapping_config: {
                  label: 'Delete unknown usage',
                  target: 'shipments.create',
                  enabled: true,
                },
                updated_at: '2026-05-24T00:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Delete unknown usage').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      await user.click(within(row).getByRole('button', { name: /Row actions/ }));

      const deleteAction = await screen.findByRole('option', { name: /^Delete mapping/ });
      expect(deleteAction).toHaveClass('is-disabled');
      expect(deleteAction).toHaveTextContent('Usage confirmation is required before this mapping can be removed.');
      await user.click(deleteAction);
      expect(document.querySelector('[data-testid="mapping-delete-confirm"]')).toBeNull();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Delete mapping removes the visible row after confirmation without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let deleted = false;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: deleted
              ? []
              : [
                  {
                    id: 'mc_live_delete',
                    organization_id: 'org_rashed',
                    mapping_type: 'webhook_inbound',
                    mapping_key: 'live.readback.delete',
                    mapping_config: {
                      label: 'Live readback delete',
                      target: 'shipments.create',
                      enabled: true,
                    },
                    mapping_version: 4,
                    updated_at: '2026-05-13T00:00:00.000Z',
                  },
                ],
            total: deleted ? 0 : 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: deleted
              ? []
              : [
                  {
                    id: 'mc_live_delete',
                    organization_id: 'org_rashed',
                    target: 'shipments.create',
                    rules_count: 1,
                    source_count: 0,
                    rule_usage_count: 0,
                    api_route_count: 0,
                    is_in_use: false,
                    has_rules: true,
                  },
                ],
            total: deleted ? 0 : 1,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return { rows: [], total: 0, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    deleteSpy.mockImplementation(async (args) => {
      deleted = true;
      return { ok: true, mapping_config_id: args.mapping_config_id };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      const row = await waitFor(() => {
        const el = screen.getByText('Live readback delete').closest('tr');
        expect(el).toBeTruthy();
        return el as HTMLElement;
      });
      await user.click(within(row).getByRole('button', { name: /Row actions/ }));
      await user.click(await screen.findByRole('option', { name: /^Delete mapping/ }));

      const confirm = await screen.findByTestId('mapping-delete-confirm');
      expect(confirm).toHaveTextContent('Delete this mapping?');
      expect(confirm).toHaveTextContent('live.readback.delete');
      await user.click(screen.getByRole('button', { name: /^Delete mapping$/ }));

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledTimes(1);
      });
      expect(deleteSpy).toHaveBeenCalledWith({ mapping_config_id: 'mc_live_delete' });
      await waitFor(() => {
        expect(screen.queryByText('Live readback delete')).not.toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Bulk disable refreshes selected rows from backend readback without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const disabledIds = new Set<string>();
    const originalList = apiMod.ui_list_resource_v1;
    const rows = [
      { id: 'mc_bulk_disable_a', label: 'Bulk disable A' },
      { id: 'mc_bulk_disable_b', label: 'Bulk disable B' },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: row.id,
              mapping_config: {
                label: row.label,
                target: 'shipments.create',
                enabled: !disabledIds.has(row.id),
              },
              updated_at: '2026-05-13T00:00:00.000Z',
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 0,
              rule_usage_count: 0,
              is_in_use: false,
              has_rules: true,
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      const id = String(args.mapping_config_id ?? '');
      disabledIds.add(id);
      return { ok: true, mapping_config_id: id };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      await screen.findByText('Bulk disable A');
      await screen.findByText('Bulk disable B');
      for (const checkbox of screen.getAllByLabelText('Select row')) {
        await user.click(checkbox);
      }
      await user.click(await screen.findByRole('button', { name: /^Bulk disable$/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        for (const label of ['Bulk disable A', 'Bulk disable B']) {
          const row = screen.getByText(label).closest('tr') as HTMLElement;
          expect(within(row).getByText('Disabled')).toBeInTheDocument();
        }
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Bulk disable skips source-bound mappings and disables only reviewed-safe rows', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const disabledIds = new Set<string>();
    const originalList = apiMod.ui_list_resource_v1;
    const rows = [
      { id: 'mc_bulk_safe_disable', label: 'Bulk safe disable', sourceCount: 0, ruleUsageCount: 0, isInUse: false },
      { id: 'mc_bulk_bound_skip', label: 'Bulk bound skip', sourceCount: 1, ruleUsageCount: 1, isInUse: true },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: row.id,
              mapping_config: {
                label: row.label,
                target: 'shipments.create',
                enabled: !disabledIds.has(row.id),
              },
              updated_at: '2026-05-24T00:00:00.000Z',
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              target: 'shipments.create',
              rules_count: 1,
              source_count: row.sourceCount,
              rule_usage_count: row.ruleUsageCount,
              is_in_use: row.isInUse,
              has_rules: true,
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'src_bulk_bound_skip',
                organization_id: 'org_rashed',
                source_label: 'Bulk bound source',
                mapping_config_id: 'mc_bulk_bound_skip',
                enabled: true,
                active_rule_count: 1,
                rule_count: 1,
              },
            ],
            total: 1,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      const id = String(args.mapping_config_id ?? '');
      disabledIds.add(id);
      return { ok: true, mapping_config_id: id };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      await screen.findByText('Bulk safe disable');
      await screen.findByText('Bulk bound skip');
      for (const checkbox of screen.getAllByLabelText('Select row')) {
        await user.click(checkbox);
      }

      await user.click(await screen.findByRole('button', { name: /^Bulk disable$/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledTimes(1);
      });
      expect(upsertSpy.mock.calls[0]?.[0]?.mapping_config_id).toBe('mc_bulk_safe_disable');
      await waitFor(() => {
        const safeRow = screen.getByText('Bulk safe disable').closest('tr') as HTMLElement;
        const boundRow = screen.getByText('Bulk bound skip').closest('tr') as HTMLElement;
        expect(within(safeRow).getByText('Disabled')).toBeInTheDocument();
        expect(within(boundRow).getByText('Enabled')).toBeInTheDocument();
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Bulk enable refreshes selected rows from backend readback without reload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const enabledIds = new Set<string>();
    const originalList = apiMod.ui_list_resource_v1;
    const rows = [
      { id: 'mc_bulk_enable_a', label: 'Bulk enable A' },
      { id: 'mc_bulk_enable_b', label: 'Bulk enable B' },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'mapping_configs') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              mapping_type: 'webhook_inbound',
              mapping_key: row.id,
              mapping_config: {
                label: row.label,
                target: 'shipments.create',
                enabled: enabledIds.has(row.id),
              },
              updated_at: '2026-05-13T00:00:00.000Z',
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        if (resource === 'mapping_config_directory') {
          return {
            rows: rows.map((row) => ({
              id: row.id,
              organization_id: 'org_rashed',
              target: 'shipments.create',
              rules_count: 1,
              source_count: 0,
              rule_usage_count: 0,
              is_in_use: false,
              has_rules: true,
            })),
            total: rows.length,
            page: 1,
            page_size: 25,
          };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async (args) => {
      const id = String(args.mapping_config_id ?? '');
      enabledIds.add(id);
      return { ok: true, mapping_config_id: id };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      await screen.findByText('Bulk enable A');
      await screen.findByText('Bulk enable B');
      for (const checkbox of screen.getAllByLabelText('Select row')) {
        await user.click(checkbox);
      }
      await user.click(await screen.findByRole('button', { name: /^Bulk enable$/ }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        for (const label of ['Bulk enable A', 'Bulk enable B']) {
          const row = screen.getByText(label).closest('tr') as HTMLElement;
          expect(within(row).getByText('Enabled')).toBeInTheDocument();
        }
      });
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('Duplicate row action persists through ui_upsert_mapping_artifact_v1', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let copyVisible = false;
    const originalList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        const baseRow = {
          id: 'mc_duplicate_source',
          organization_id: 'org_rashed',
          mapping_type: 'webhook_inbound',
          mapping_key: 'duplicate.source',
          mapping_config: { target: 'shipments.create' },
          updated_at: '2026-05-13T00:00:00.000Z',
        };
        const copyRow = {
          ...baseRow,
          id: 'mc_duplicate_created',
          mapping_key: 'duplicate.source_copy',
        };
        if (resource === 'mapping_configs') {
          const rows = copyVisible ? [baseRow, copyRow] : [baseRow];
          return { rows, total: rows.length, page: 1, page_size: 25 };
        }
        if (resource === 'mapping_config_directory') {
          const rows = (copyVisible ? [baseRow, copyRow] : [baseRow]).map((row) => ({
            id: row.id,
            organization_id: row.organization_id,
            target: 'shipments.create',
            rules_count: 0,
            source_count: 0,
            rule_usage_count: 0,
            is_in_use: false,
            has_rules: false,
          }));
          return { rows, total: rows.length, page: 1, page_size: 25 };
        }
        return originalList(resource, opts);
      },
    );
    upsertSpy.mockImplementation(async () => {
      copyVisible = true;
      return { ok: true, mapping_config_id: 'mc_duplicate_created' };
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<MappingModule />, { identity: TENANT_IDENTITY });
      await screen.findByText('duplicate.source');
      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      const duplicate = await screen.findByRole('option', { name: /^Duplicate/ });
      await user.click(duplicate);
      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalledTimes(1);
      });
      const args = upsertSpy.mock.calls[0]?.[0] as
        | { artifact?: string; organization_id?: string; mapping_config_id?: string | null; mapping_key?: string }
        | undefined;
      expect(args?.artifact).toBe('mapping_config');
      expect(args?.organization_id).toBe('org_rashed');
      expect(args?.mapping_config_id).toBeNull();
      expect(args?.mapping_key).toBe('duplicate.source_copy');
      expect(await screen.findByText('duplicate.source_copy')).toBeInTheDocument();
    } finally {
      seedModeSpy.mockRestore();
      listSpy.mockRestore();
    }
  });
});
