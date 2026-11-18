// catalog.test.tsx — covers the integration_plugins catalog operator surface
// (CLAIM-INTEGRATIONS-WORKFLOWS-WIRING / Phase C5).
//
// Backed by:
//   - public.integration_plugins from
//     supabase/migrations/202602220010_integration_plugin_control_plane_v1.sql:445
//   - useResourceList<IntegrationPlugin>('integration_plugins')
//   - useInstallIntegrationPlugin (Phase C5 hook → integration_plugin_generate_draft_v1)
//   - useUninstallIntegrationPlugin (Phase C5 hook -> integration_plugin_rollback_v1)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { CatalogModule } from '@/modules/integrations/catalog';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';
import { consumeExternalIntakeSourceToken } from '@/lib/external-intake-token-handoff';

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => routerMocks.navigate,
  };
});

describe('CatalogModule (Phase C5 wiring)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let installSpy: TypedSpy<typeof apiMod, 'integration_plugin_generate_draft_v1'>;
  let uninstallSpy: TypedSpy<typeof apiMod, 'integration_plugin_rollback_v1'>;
  let exportHandoffSpy: TypedSpy<typeof apiMod, 'integration_plugin_export_handoff_v1'>;
  let deactivateSpy: TypedSpy<typeof apiMod, 'plugin_deactivate_v1'>;
  beforeEach(() => {
    installSpy = typedSpy(apiMod, 'integration_plugin_generate_draft_v1');
    uninstallSpy = typedSpy(apiMod, 'integration_plugin_rollback_v1');
    exportHandoffSpy = typedSpy(apiMod, 'integration_plugin_export_handoff_v1');
    deactivateSpy = typedSpy(apiMod, 'plugin_deactivate_v1');
    routerMocks.navigate.mockClear();
    sessionStorage.clear();
  });
  afterEach(() => {
    installSpy.mockRestore();
    uninstallSpy.mockRestore();
    exportHandoffSpy.mockRestore();
    deactivateSpy.mockRestore();
    vi.unstubAllEnvs();
    sessionStorage.clear();
    window.history.pushState(null, '', '/');
  });

  it('mounts the page header + plugin cards', async () => {
    renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      // Cards render with the plugin name as a heading.
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
  });

  it('disables Add integration without integration_plugins.write', async () => {
    renderWithProviders(<CatalogModule />, { capabilities: ['integrations.write', 'integration_plugins.read'] });
    const btn = await screen.findByRole('button', { name: /Add integration/ });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/Integration plugin update permission required/i).length).toBeGreaterThan(0);
  });

  it('submits the current Add integration modal values and surfaces draft readback', async () => {
    const user = userEvent.setup();
    const realGetLookups = apiMod.getLookups;
    const lookupSpy = vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
      if (category === 'integration_plugin_kind') {
        return [
          { value: 'carrier', label: 'Carrier', rank: 10, is_default: true },
          { value: 'crm', label: 'CRM', rank: 20 },
        ];
      }
      if (category === 'integration_plugin_source_type') {
        return [{ value: 'manual', label: 'Manual', rank: 10, is_default: true }];
      }
      if (category === 'integration_plugin_auth_mode') {
        return [
          { value: 'api_key_header', label: 'API key header', rank: 10, is_default: true },
          { value: 'bearer_token_header', label: 'Bearer token header', rank: 20 },
        ];
      }
      return realGetLookups(category);
    });
    let draftCreated = false;
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    listSpy.mockImplementation(async (resource: string) => {
      if (resource === 'integration_plugins') {
        return {
          rows: draftCreated
            ? [{
                id: 'plg_manual_draft_readback',
                name: 'Browser Proof Carrier',
                vendor: 'Browser Proof Vendor',
                status: 'draft',
                plugin_kind: 'carrier',
                active_version_id: null,
              }]
            : [],
          total: draftCreated ? 1 : 0,
        };
      }
      if (resource === 'integration_plugin_directory') {
        return {
          rows: draftCreated
            ? [{
                id: 'plg_manual_draft_readback',
                vendor: 'Browser Proof Vendor',
                version_count: 1,
                latest_version_no: 1,
                latest_version_status: 'draft',
                binding_count: 0,
                active_binding_count: 0,
                has_active_version: false,
                is_pending_review: false,
              }]
            : [],
          total: draftCreated ? 1 : 0,
        };
      }
      return { rows: [], total: 0 };
    });
    installSpy.mockImplementationOnce(async () => {
      draftCreated = true;
      return {
        ok: true,
        integration_plugin_id: 'plg_manual_draft_readback',
        integration_plugin_version_id: 'plgv_manual_draft_readback',
        status: 'draft',
      };
    });

    try {
      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /Add integration/ }));
      await user.type(await screen.findByLabelText(/Display name/i), 'Browser Proof Carrier');
      await user.type(await screen.findByLabelText(/Vendor/i), 'Browser Proof Vendor');
      await user.selectOptions(await screen.findByLabelText(/Auth/i), 'bearer_token_header');
      await user.click(await screen.findByRole('button', { name: /^Create$/i }));

      await waitFor(() => {
        expect(installSpy).toHaveBeenCalledWith({
          plugin_name: 'Browser Proof Carrier',
          plugin_kind: 'carrier',
          source_type: 'manual',
          inbound_config: { auth_mode: 'bearer_token_header' },
          vendor: 'Browser Proof Vendor',
        });
      });
      const readback = await screen.findByTestId('integration-catalog-manual-draft-readback');
      expect(readback).toHaveTextContent('Integration details confirmed');
      expect(readback).toHaveTextContent('Browser Proof Carrier');
      expect(readback).toHaveTextContent('Vendor: Browser Proof Vendor');
      expect(readback).toHaveTextContent('Source: manual');
      expect(readback).toHaveTextContent('Security: bearer_token_header');
      expect(readback).toHaveTextContent('plg_manual_draft_readback');
      expect(readback).toHaveTextContent('Catalog listing confirmed');
      expect(readback).toHaveTextContent('Directory listing confirmed');
      expect(readback).toHaveTextContent('Directory: draft');
      expect(await screen.findByTestId('integration-plugin-card-plg_manual_draft_readback')).toHaveTextContent('Browser Proof Carrier');
      expect(screen.queryByRole('dialog', { name: /Add integration/i })).not.toBeInTheDocument();
    } finally {
      lookupSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('disables token-bearing export handoff without integration_plugins.write', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogModule />, { capabilities: ['integration_plugins.read'] });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="integration-plugin-card-"]').length).toBeGreaterThan(0);
    });
    const card = document.querySelector('[data-testid^="integration-plugin-card-"]');
    expect(card).toBeTruthy();
    await user.click(card as HTMLElement);

    const handoffButton = await screen.findByRole('button', { name: /Export handoff/i });
    expect(handoffButton).toBeDisabled();
    expect(exportHandoffSpy).not.toHaveBeenCalled();
  });

  it('shows a denied state without issuing protected plugin catalog reads', async () => {
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    try {
      renderWithProviders(<CatalogModule />, { capabilities: [] });

      expect(await screen.findByText(/You do not have permission to view the plugin catalog/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).not.toContain('integration_plugins');
        expect(resources).not.toContain('integration_plugin_directory');
      });
      expect(screen.queryByRole('button', { name: /Add integration/i })).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('Rollback action stays in the drawer and refreshes active version readback', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_rollback_readback';
    const activeVersionId = 'plgv_rollback_v2';
    const targetVersionId = 'plgv_rollback_v1';
    let currentActiveVersionId = activeVersionId;
    let approvalEvents: Array<Record<string, unknown>> = [];
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');
    const pluginRow = () => ({
      id: pluginId,
      organization_id: 'org_rashed',
      name: 'Rollback Readback Plugin',
      vendor: 'Readback Vendor',
      version: currentActiveVersionId === targetVersionId ? 'v1' : 'v2',
      status: 'active',
      health: null,
      plugin_kind: 'inbound',
      binding: '-',
      active_version_id: currentActiveVersionId,
    });
    const directoryRow = () => ({
      id: pluginId,
      vendor: 'Readback Vendor',
      version_label: currentActiveVersionId === targetVersionId ? 'v1' : 'v2',
      version_count: 2,
      latest_version_no: 2,
      latest_version_status: 'active',
      active_version_status: 'active',
      binding_count: 1,
      install_count: 1,
      active_binding_count: 1,
      has_active_version: true,
      is_pending_review: false,
    });

    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') return { rows: [pluginRow()], total: 1 };
        if (resource === 'integration_plugin_directory') return { rows: [directoryRow()], total: 1 };
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [
              {
                id: activeVersionId,
                plugin_id: pluginId,
                version: 'v2',
                version_no: 2,
                status: currentActiveVersionId === activeVersionId ? 'active' : 'approved',
                created_at: '2026-05-22T00:02:00.000Z',
              },
              {
                id: targetVersionId,
                plugin_id: pluginId,
                version: 'v1',
                version_no: 1,
                status: currentActiveVersionId === targetVersionId ? 'active' : 'approved',
                created_at: '2026-05-22T00:01:00.000Z',
              },
            ],
            total: 2,
          };
        }
        if (resource === 'integration_plugin_bindings') {
          return {
            rows: [{
              id: 'ipb_rollback_v1',
              plugin_version_id: targetVersionId,
              scope_type: 'tenant',
              scope_id: 'org_rashed',
              binding_type: 'runtime',
              runtime_resource_type: 'webhook_source',
              runtime_resource_id: 'whs_rollback_v1',
              enabled: true,
              updated_at: '2026-05-22T00:03:00.000Z',
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_approval_events') {
          return { rows: approvalEvents, total: approvalEvents.length };
        }
        if (resource === 'integration_plugin_validation_runs') return { rows: [], total: 0 };
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) return pluginRow();
        if (resource === 'integration_plugin_directory' && id === pluginId) return directoryRow();
        return null;
      });
      uninstallSpy.mockImplementation(async (args) => {
        currentActiveVersionId = targetVersionId;
        approvalEvents = [{
          id: 'ipe_rollback_readback',
          plugin_version_id: targetVersionId,
          action: 'rolled_back',
          actor_user_id: 'usr_reviewer',
          reason: args.reason,
          created_at: '2026-05-22T00:04:00.000Z',
        }];
        return {
          plugin_id: pluginId,
          to_plugin_version_id: targetVersionId,
          from_plugin_version_id: activeVersionId,
          scope_type: 'tenant',
          scope_id: 'org_rashed',
        };
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Rollback to v1/i }));

      await waitFor(() => {
        expect(uninstallSpy).toHaveBeenCalledWith(expect.objectContaining({
          plugin_id: pluginId,
          target_plugin_version_id: targetVersionId,
          reason: 'Console rollback to v1',
        }));
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(document.querySelector('.drawer')?.textContent).toContain('Versionv1');
        expect(screen.getAllByText(targetVersionId).length).toBeGreaterThan(0);
        expect(screen.getByText(/ipe_rollback_readback/i)).toBeInTheDocument();
        expect(screen.getByText(/Console rollback to v1/i)).toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('disables rollback when no reusable target version binding exists', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_rollback_unavailable';
    const versionId = 'plgv_rollback_only';
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');

    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') {
          return {
            rows: [{
              id: pluginId,
              organization_id: 'org_rashed',
              name: 'Rollback Unavailable Plugin',
              vendor: 'Readback Vendor',
              version: 'v1',
              status: 'active',
              plugin_kind: 'inbound',
              active_version_id: versionId,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_directory') {
          return {
            rows: [{
              id: pluginId,
              vendor: 'Readback Vendor',
              version_label: 'v1',
              version_count: 1,
              latest_version_no: 1,
              latest_version_status: 'active',
              active_version_status: 'active',
              binding_count: 0,
              active_binding_count: 0,
              has_active_version: true,
              is_pending_review: false,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [{
              id: versionId,
              plugin_id: pluginId,
              version: 'v1',
              version_no: 1,
              status: 'active',
              created_at: '2026-05-22T00:00:00.000Z',
            }],
            total: 1,
          };
        }
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) {
          return {
            id: pluginId,
            organization_id: 'org_rashed',
            name: 'Rollback Unavailable Plugin',
            vendor: 'Readback Vendor',
            version: 'v1',
            status: 'active',
            plugin_kind: 'inbound',
            active_version_id: versionId,
          };
        }
        return null;
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      const rollbackButton = await screen.findByRole('button', { name: /Rollback unavailable/i });
      expect(rollbackButton).toBeDisabled();
      expect(screen.getByText(/Rollback unavailable until another version has reusable runtime bindings/i)).toBeInTheDocument();
      expect(uninstallSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('deactivates an active plugin and refreshes same-drawer readback without reload', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_deactivate_readback';
    const versionId = 'plgv_deactivate_readback_1';
    let pluginStatus = 'active';
    let versionStatus = 'active';
    let activeVersionId: string | null = versionId;
    let approvalEvents: Array<Record<string, unknown>> = [];
    let bindings: Array<Record<string, unknown>> = [{
      id: 'ipb_deactivate_readback',
      plugin_version_id: versionId,
      scope_type: 'tenant',
      scope_id: 'org_rashed',
      binding_type: 'webhook_source',
      runtime_resource_type: 'webhook_sources',
      runtime_resource_id: 'whs_deactivate_readback',
      enabled: true,
      updated_at: '2026-05-29T19:00:00.000Z',
    }];
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');
    const pluginRow = () => ({
      id: pluginId,
      organization_id: 'org_rashed',
      name: 'Deactivate Readback Plugin',
      vendor: 'Readback Vendor',
      version: 'v1',
      status: pluginStatus,
      health: null,
      plugin_kind: 'inbound',
      binding: '-',
      active_version_id: activeVersionId,
    });
    const directoryRow = () => ({
      id: pluginId,
      vendor: 'Readback Vendor',
      version_label: activeVersionId ? 'v1' : null,
      version_count: 1,
      latest_version_no: 1,
      latest_version_status: versionStatus,
      active_version_status: activeVersionId ? versionStatus : null,
      binding_count: bindings.length,
      install_count: bindings.length,
      active_binding_count: bindings.filter((row) => row.enabled !== false).length,
      has_active_version: Boolean(activeVersionId),
      is_pending_review: false,
    });
    const versionRow = () => ({
      id: versionId,
      plugin_id: pluginId,
      version: 'v1',
      version_no: 1,
      status: versionStatus,
      created_at: '2026-05-29T19:00:00.000Z',
    });

    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') return { rows: [pluginRow()], total: 1 };
        if (resource === 'integration_plugin_directory') return { rows: [directoryRow()], total: 1 };
        if (resource === 'integration_plugin_versions') return { rows: [versionRow()], total: 1 };
        if (resource === 'integration_plugin_bindings') return { rows: bindings, total: bindings.length };
        if (resource === 'integration_plugin_approval_events') {
          return { rows: approvalEvents, total: approvalEvents.length };
        }
        if (resource === 'integration_plugin_validation_runs') return { rows: [], total: 0 };
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) return pluginRow();
        if (resource === 'integration_plugin_directory' && id === pluginId) return directoryRow();
        return null;
      });
      deactivateSpy.mockImplementation(async (args) => {
        pluginStatus = 'disabled';
        versionStatus = 'approved';
        activeVersionId = null;
        bindings = bindings.map((row) => ({
          ...row,
          enabled: false,
          updated_at: '2026-05-29T19:01:00.000Z',
        }));
        approvalEvents = [{
          id: 'ipe_deactivate_readback',
          plugin_version_id: versionId,
          action: 'deactivated',
          actor_user_id: 'usr_reviewer',
          reason: args.reason,
          created_at: '2026-05-29T19:01:00.000Z',
        }];
        return {
          ok: true,
          integration_plugin_id: pluginId,
          integration_plugin_version_id: versionId,
          status: 'disabled',
          version_status: 'approved',
          changed_count: 1,
        };
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      expect(await screen.findByText(/Binding: 1\/1 runtime binding/i)).toBeInTheDocument();
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Deactivate plugin/i }));

      await waitFor(() => {
        expect(deactivateSpy).toHaveBeenCalledWith(expect.objectContaining({
          plugin_id: pluginId,
          plugin_version_id: versionId,
          reason: 'Console deactivate Deactivate Readback Plugin v1',
        }));
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getAllByText(/Disabled/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Approved/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Binding: 0\/1 runtime binding/i).length).toBeGreaterThan(0);
        expect(document.querySelector('.drawer')?.textContent).not.toContain(`Active version${versionId}`);
        expect(screen.getByText(/ipe_deactivate_readback/i)).toBeInTheDocument();
        expect(screen.getByText(/Console deactivate Deactivate Readback Plugin v1/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Activate/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Deactivate plugin/i })).not.toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('rejects a submitted plugin and refreshes same-drawer denial readback without reload', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_reject_readback';
    const versionId = 'plgv_reject_readback_1';
    let pluginStatus = 'pending';
    let versionStatus = 'submitted';
    let approvalEvents: Array<Record<string, unknown>> = [];
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');
    const approveSpy = typedSpy(apiMod, 'plugin_approve_v1');
    const pluginRow = () => ({
      id: pluginId,
      organization_id: 'org_rashed',
      name: 'Reject Readback Plugin',
      vendor: 'Governance Vendor',
      version: 'v1',
      status: pluginStatus,
      health: null,
      plugin_kind: 'inbound',
      binding: '-',
      active_version_id: null,
    });
    const directoryRow = () => ({
      id: pluginId,
      vendor: 'Governance Vendor',
      version_label: 'v1',
      version_count: 1,
      latest_version_no: 1,
      latest_version_status: versionStatus,
      active_version_status: null,
      binding_count: 0,
      install_count: 0,
      active_binding_count: 0,
      has_active_version: false,
      is_pending_review: versionStatus === 'submitted',
    });
    const versionRow = () => ({
      id: versionId,
      plugin_id: pluginId,
      version: 'v1',
      version_no: 1,
      status: versionStatus,
      created_at: '2026-05-22T00:00:00.000Z',
      submitted_by: 'usr_reviewer',
    });

    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') return { rows: [pluginRow()], total: 1 };
        if (resource === 'integration_plugin_directory') return { rows: [directoryRow()], total: 1 };
        if (resource === 'integration_plugin_versions') return { rows: [versionRow()], total: 1 };
        if (resource === 'integration_plugin_approval_events') {
          return { rows: approvalEvents, total: approvalEvents.length };
        }
        if (
          resource === 'integration_plugin_validation_runs'
          || resource === 'integration_plugin_bindings'
        ) {
          return { rows: [], total: 0 };
        }
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) return pluginRow();
        if (resource === 'integration_plugin_directory' && id === pluginId) return directoryRow();
        return null;
      });
      approveSpy.mockImplementation(async () => {
        pluginStatus = 'rejected';
        versionStatus = 'rejected';
        approvalEvents = [{
          id: 'ipe_reject_readback',
          plugin_version_id: versionId,
          action: 'rejected',
          actor_user_id: 'usr_reviewer',
          reason: 'console governance denial',
          created_at: '2026-05-22T00:01:00.000Z',
        }];
        return {
          integration_plugin_id: pluginId,
          integration_plugin_version_id: versionId,
          status: 'rejected',
        };
      });

      renderWithProviders(<CatalogModule />, {
        capabilities: [
          'integration_plugins.read',
          'integration_plugins.approve',
        ],
      });
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      expect(await screen.findByRole('button', { name: /Reject/ })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Reject/ }));
      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalledWith({
          plugin_version_id: versionId,
          decision: 'rejected',
        });
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getByText(/Latest version status/i)).toBeInTheDocument();
        expect(screen.getAllByText(/Rejected/i).length).toBeGreaterThan(0);
        expect(screen.getByText(/ipe_reject_readback/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Activate/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
      approveSpy.mockRestore();
    }
  });

  // W27 — paired projection consumption assertions. Module reads
  // `integration_plugin_directory` so projection-derived stat boxes
  // (Versions, Bindings) and the operator-facing directory pill surface in
  // the DOM.
  it('renders the catalog directory projection pill (W27)', async () => {
    renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(
        screen.getByText('Catalog directory'),
      ).toBeInTheDocument();
    });
  });

  it('renders projection-derived Versions + Bindings stat boxes on plugin cards (W27)', async () => {
    renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
    });
    // W27 stat boxes include Versions and Bindings (replacing the legacy
    // 24h-events stat box). The eyebrow labels are uppercase.
    const eyebrows = Array.from(document.querySelectorAll('.eyebrow')).map(
      (n) => n.textContent?.trim() ?? '',
    );
    expect(eyebrows.some((s) => /^Versions$/i.test(s))).toBe(true);
    expect(eyebrows.some((s) => /^Bindings$/i.test(s))).toBe(true);
  });

  it('opens the focused saved plugin drawer from a catalog focus link', async () => {
    window.history.pushState(null, '', '/integrations/catalog?focus=plg_exampleparcel_ksa');
    renderWithProviders(<CatalogModule />, { capabilities: ['all'] });

    const focusedCard = await screen.findByTestId('integration-plugin-card-plg_exampleparcel_ksa');
    expect(focusedCard).toHaveAttribute('aria-current', 'true');
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(screen.getAllByText(/Exampleparcel KSA Webhook/i).length).toBeGreaterThan(1);
  });

  it('reads plugin audit ledgers from registry resources without synthetic drawer claims', async () => {
    const user = userEvent.setup();
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    try {
      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.card').length).toBeGreaterThan(0);
      });
      const firstCard = document.querySelector('.card');
      expect(firstCard).not.toBeNull();
      await user.click(firstCard as Element);
      await waitFor(() => {
        expect(listSpy).toHaveBeenCalledWith(
          'integration_plugin_validation_runs',
          expect.objectContaining({ page_size: 50 }),
        );
        expect(listSpy).toHaveBeenCalledWith(
          'integration_plugin_approval_events',
          expect.objectContaining({ page_size: 50 }),
        );
      });
      expect(screen.queryByText(/synthetic/i)).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('lets a granular approver test, approve, and activate without draft-write capability', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_lifecycle_readback';
    const versionId = 'plgv_lifecycle_readback_1';
    let pluginStatus = 'pending';
    let versionStatus = 'submitted';
    let activeVersionId: string | null = null;
    let approvalEvents: Array<Record<string, unknown>> = [];
    let validationRuns: Array<Record<string, unknown>> = [];
    let bindings: Array<Record<string, unknown>> = [];
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');
    const runTestSpy = typedSpy(apiMod, 'runPluginTest');
    const approveSpy = typedSpy(apiMod, 'plugin_approve_v1');
    const activateSpy = typedSpy(apiMod, 'plugin_activate_v1');
    const setBindingSpy = typedSpy(apiMod, 'plugin_set_binding_v1');
    const pluginRow = () => ({
      id: pluginId,
      organization_id: 'org_rashed',
      name: 'Lifecycle Readback Plugin',
      vendor: 'Readback Vendor',
      version: 'v1',
      status: pluginStatus,
      health: null,
      plugin_kind: 'inbound · webhook',
      binding: '-',
      active_version_id: activeVersionId,
    });
    const directoryRow = () => ({
      id: pluginId,
      vendor: 'Readback Vendor',
      version_label: 'v1',
      version_count: 1,
      latest_version_no: 1,
      latest_version_status: versionStatus,
      active_version_status: activeVersionId ? versionStatus : null,
      binding_count: bindings.length,
      install_count: bindings.length,
      active_binding_count: bindings.filter((row) => row.enabled !== false).length,
      has_active_version: Boolean(activeVersionId),
      is_pending_review: versionStatus === 'submitted',
    });
    const versionRow = () => ({
      id: versionId,
      plugin_id: pluginId,
      version: 'v1',
      version_no: 1,
      status: versionStatus,
      created_at: '2026-05-22T00:00:00.000Z',
      submitted_by: 'usr_reviewer',
    });

    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') return { rows: [pluginRow()], total: 1 };
        if (resource === 'integration_plugin_directory') return { rows: [directoryRow()], total: 1 };
        if (resource === 'integration_plugin_versions') return { rows: [versionRow()], total: 1 };
        if (resource === 'integration_plugin_approval_events') {
          return { rows: approvalEvents, total: approvalEvents.length };
        }
        if (resource === 'integration_plugin_validation_runs') {
          return { rows: validationRuns, total: validationRuns.length };
        }
        if (resource === 'integration_plugin_bindings') {
          return { rows: bindings, total: bindings.length };
        }
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) return pluginRow();
        if (resource === 'integration_plugin_directory' && id === pluginId) return directoryRow();
        return null;
      });
      runTestSpy.mockImplementation(async () => {
        validationRuns = [{
          id: 'ipr_lifecycle_validation',
          plugin_version_id: versionId,
          run_type: 'test',
          status: 'succeeded',
          correlation_id: 'cor_lifecycle_validation',
          created_at: '2026-05-22T00:00:30.000Z',
          completed_at: '2026-05-22T00:00:31.000Z',
        }];
        return {
          ok: true,
          plugin_id: pluginId,
          plugin_version_id: versionId,
          validation_run_id: 'ipr_lifecycle_validation',
          duration_ms: 31,
          steps: [{ name: 'validate_schema', ok: true, ms: 31 }],
          correlation_id: 'cor_lifecycle_validation',
        };
      });
      approveSpy.mockImplementation(async () => {
        versionStatus = 'approved';
        approvalEvents = [
          {
            id: 'ipe_lifecycle_approved',
            plugin_version_id: versionId,
            action: 'approved',
            actor_user_id: 'usr_reviewer',
            reason: 'frontend-readback-test',
            created_at: '2026-05-22T00:01:00.000Z',
          },
        ];
        return { integration_plugin_id: pluginId, integration_plugin_version_id: versionId, status: 'approved' };
      });
      activateSpy.mockImplementation(async () => {
        pluginStatus = 'active';
        versionStatus = 'active';
        activeVersionId = versionId;
        bindings = [
          {
            id: 'ipb_lifecycle_active',
            plugin_version_id: versionId,
            scope_type: 'tenant',
            scope_id: 'org_rashed',
            binding_type: 'runtime',
            runtime_resource_type: 'webhook_source',
            runtime_resource_id: 'whs_lifecycle_active',
            activation_payload: {
              source_identifier: 'lifecycle-active-source',
              issued_token: 'raw-lifecycle-runtime-token',
              headers: { authorization: 'Bearer raw-lifecycle-bearer' },
            },
            metadata: {
              provider_url: 'https://provider.example.test/orders?api_key=raw-lifecycle-query-key',
            },
            enabled: true,
            updated_at: '2026-05-22T00:02:00.000Z',
          },
        ];
        return { integration_plugin_id: pluginId, integration_plugin_version_id: versionId, status: 'active' };
      });
      setBindingSpy.mockImplementation(async (args) => {
        let changedCount = 0;
        bindings = bindings.map((row) => ({
          ...row,
          ...(row.scope_type === args.scope_type && row.scope_id === args.scope_id
            ? {
                enabled: args.enabled,
                updated_at: '2026-05-22T00:03:00.000Z',
              }
            : {}),
        }));
        changedCount = bindings.filter((row) =>
          row.scope_type === args.scope_type && row.scope_id === args.scope_id,
        ).length;
        return {
          integration_plugin_id: pluginId,
          integration_plugin_version_id: versionId,
          enabled: args.enabled,
          changed_count: changedCount,
        };
      });

      renderWithProviders(<CatalogModule />, {
        capabilities: [
          'integration_plugins.read',
          'integration_plugins.test',
          'integration_plugins.approve',
          'integration_plugins.activate',
        ],
      });
      expect(await screen.findByRole('button', { name: /Add integration/ })).toBeDisabled();
      const card = await screen.findByTestId(`integration-plugin-card-${pluginId}`);
      await user.click(card);
      expect(await screen.findByRole('button', { name: /Approve/ })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Run validation/i }));
      await waitFor(() => {
        expect(runTestSpy).toHaveBeenCalledWith(
          pluginId,
          expect.objectContaining({
            event: { type: 'shipment.created' },
            metadata: { source: 'console_v2_catalog_validation' },
          }),
          versionId,
        );
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getByText(/Validation history/i)).toBeInTheDocument();
        expect(screen.getByText(/ipr_lifecycle_validation/i)).toBeInTheDocument();
        expect(screen.getByText(/cor_lifecycle_validation/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /Run test event/i })).not.toBeDisabled();

      await user.click(screen.getByRole('button', { name: /Approve/ }));
      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalled();
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getByText(/Latest version status/i)).toBeInTheDocument();
        expect(screen.getAllByText(/Approved/i).length).toBeGreaterThan(0);
        expect(screen.getByText(/ipe_lifecycle_approved/i)).toBeInTheDocument();
      });

      await user.click(await screen.findByRole('button', { name: /Activate/ }));
      await waitFor(() => {
        expect(activateSpy).toHaveBeenCalled();
        expect(activateSpy).toHaveBeenCalledWith(expect.objectContaining({
          plugin_version_id: versionId,
          scope_type: 'client',
          scope_id: 'cl_exampleparcel_ksa',
        }));
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getAllByText(/Active/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Binding: 1\/1 runtime binding/i).length).toBeGreaterThan(0);
        expect(screen.getByTestId('plugin-runtime-bindings')).toBeInTheDocument();
        expect(screen.getByText(/ipb_lifecycle_active/i)).toBeInTheDocument();
        expect(screen.getByLabelText('Runtime binding config')).toHaveTextContent('lifecycle-active-source');
        expect(screen.getByLabelText('Runtime binding config')).toHaveTextContent('REDACTED');
      });
      expect(document.querySelector('.drawer')?.textContent).not.toContain('raw-lifecycle-runtime-token');
      expect(document.querySelector('.drawer')?.textContent).not.toContain('raw-lifecycle-bearer');
      expect(document.querySelector('.drawer')?.textContent).not.toContain('raw-lifecycle-query-key');

      await user.click(await screen.findByRole('button', { name: /Disable binding/ }));
      await waitFor(() => {
        expect(setBindingSpy).toHaveBeenCalledWith(expect.objectContaining({
          plugin_version_id: versionId,
          enabled: false,
          scope_type: 'tenant',
          scope_id: 'org_rashed',
        }));
        expect(document.querySelector('.drawer')).not.toBeNull();
        expect(screen.getAllByText(/Binding: 0\/1 runtime binding/i).length).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: /Enable binding/ })).toBeInTheDocument();
        expect(screen.queryByText(/Updating runtime binding/i)).not.toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
      runTestSpy.mockRestore();
      approveSpy.mockRestore();
      activateSpy.mockRestore();
      setBindingSpy.mockRestore();
    }
  });

  it('exports active plugin handoff with redacted same-drawer readback', async () => {
    const user = userEvent.setup();
    const pluginId = 'plg_export_handoff';
    const versionId = 'plgv_export_handoff_1';
    const rawToken = 'ipt_live_export_secret_token';
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const getSpy = typedSpy(apiMod, 'ui_get_resource_v1');

    try {
      vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:58429/');
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') {
          return {
            rows: [{
              id: pluginId,
              organization_id: 'org_rashed',
              name: 'Export Handoff Plugin',
              vendor: 'Handoff Vendor',
              version: 'v1',
              status: 'active',
              plugin_kind: 'webhook',
              active_version_id: versionId,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_directory') {
          return {
            rows: [{
              id: pluginId,
              vendor: 'Handoff Vendor',
              version_label: 'v1',
              version_count: 1,
              latest_version_no: 1,
              latest_version_status: 'active',
              active_version_status: 'active',
              binding_count: 1,
              active_binding_count: 1,
              has_active_version: true,
              is_pending_review: false,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [{
              id: versionId,
              plugin_id: pluginId,
              version: 'v1',
              version_no: 1,
              status: 'active',
              created_at: '2026-05-24T00:00:00.000Z',
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_bindings') {
          return {
            rows: [{
              id: 'ipb_export_handoff',
              plugin_version_id: versionId,
              scope_type: 'tenant',
              scope_id: 'org_rashed',
              binding_type: 'webhook_source',
              runtime_resource_type: 'webhook_sources',
              runtime_resource_id: 'whs_export_handoff',
              enabled: true,
              updated_at: '2026-05-24T00:01:00.000Z',
            }],
            total: 1,
          };
        }
        if (
          resource === 'integration_plugin_validation_runs'
          || resource === 'integration_plugin_approval_events'
        ) {
          return { rows: [], total: 0 };
        }
        return { rows: [], total: 0 };
      });
      getSpy.mockImplementation(async (resource: string, id: string) => {
        if (resource === 'integration_plugins' && id === pluginId) {
          return {
            id: pluginId,
            organization_id: 'org_rashed',
            name: 'Export Handoff Plugin',
            status: 'active',
            plugin_kind: 'webhook',
            active_version_id: versionId,
          };
        }
        return null;
      });
      exportHandoffSpy.mockResolvedValue({
        ok: true,
        plugin_id: pluginId,
        plugin_version_id: versionId,
        kind: 'webhook',
        endpoint: 'http://127.0.0.1:58429/functions/v1/webhook-receiver',
        token: rawToken,
        headers: { authorization: `Bearer ${rawToken}` },
        instructions: ['Point webhook destination to endpoint.', `Send Authorization: Bearer ${rawToken}.`],
        sample_curl: `curl -X POST "http://127.0.0.1:58429/functions/v1/webhook-receiver" -H "authorization: Bearer ${rawToken}" -H "content-type: application/json" -d '{}'`,
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Export handoff/i }));

      const readback = await screen.findByTestId('plugin-export-handoff-readback');
      await waitFor(() => {
        expect(exportHandoffSpy).toHaveBeenCalledWith({
          plugin_version_id: versionId,
          base_url: 'http://127.0.0.1:58429',
        });
        expect(readback).toHaveTextContent('Export setup confirmed');
        expect(readback).toHaveTextContent(pluginId);
        expect(readback).toHaveTextContent(versionId);
        expect(readback).toHaveTextContent('Issued - redacted');
        expect(readback).toHaveTextContent('Bearer redacted-token');
      });
      expect(document.querySelector('.drawer')?.textContent).not.toContain(rawToken);
    } finally {
      listSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('routes API-route plugin runtime tests to API Gateway route evidence with source-token handoff', async () => {
    const user = userEvent.setup();
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const pluginId = 'plg_api_runtime';
    const versionId = 'plgv_api_runtime_1';
    const routeId = 'api_route_runtime_1';
    const packId = 'api_pack_runtime_1';
    const sourceId = 'whs_api_runtime_1';
    try {
      listSpy.mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'integration_plugins') {
          return {
            rows: [{
              id: pluginId,
              organization_id: 'org_rashed',
              name: 'API Runtime Plugin',
              vendor: 'Runtime Vendor',
              version: 'v1',
              status: 'active',
              plugin_kind: 'inbound',
              active_version_id: versionId,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_directory') {
          return {
            rows: [{
              id: pluginId,
              vendor: 'Runtime Vendor',
              version_label: 'v1',
              version_count: 1,
              latest_version_no: 1,
              latest_version_status: 'active',
              active_version_status: 'active',
              binding_count: 2,
              install_count: 1,
              active_binding_count: 2,
              has_active_version: true,
              is_pending_review: false,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [{
              id: versionId,
              plugin_id: pluginId,
              version: 'v1',
              version_no: 1,
              status: 'active',
              created_at: '2026-05-22T00:00:00.000Z',
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_bindings') {
          const filter = (opts?.filter ?? {}) as Record<string, unknown>;
          if (filter.plugin_version_id !== versionId) {
            return {
              rows: Array.from({ length: 60 }, (_, index) => ({
                id: `ipb_unrelated_${index}`,
                plugin_version_id: `plgv_unrelated_${index}`,
                runtime_resource_type: 'webhook_sources',
                runtime_resource_id: `whs_unrelated_${index}`,
                activation_payload: { source_identifier: `unrelated-${index}` },
                enabled: true,
                updated_at: '2026-05-22T00:03:00.000Z',
              })),
              total: 60,
            };
          }
          return {
            rows: [
              {
                id: 'ipb_api_runtime_source',
                plugin_version_id: versionId,
                runtime_resource_type: 'webhook_sources',
                runtime_resource_id: sourceId,
                activation_payload: {
                  source_identifier: 'api-runtime-source',
                  issued_token: 'ipt_api_runtime_source_token',
                },
                enabled: true,
                updated_at: '2026-05-22T00:01:00.000Z',
              },
              {
                id: 'ipb_api_runtime',
                plugin_version_id: versionId,
                runtime_resource_type: 'api_route',
                runtime_resource_id: routeId,
                activation_payload: {
                  pack_id: packId,
                  method: 'POST',
                  path_template: '/v1/orders',
                },
                enabled: true,
                updated_at: '2026-05-22T00:02:00.000Z',
              },
            ],
            total: 2,
          };
        }
        if (
          resource === 'integration_plugin_validation_runs'
          || resource === 'integration_plugin_approval_events'
        ) {
          return { rows: [], total: 0 };
        }
        return { rows: [], total: 0 };
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      expect(await screen.findByText(/Binding: 2\/2 runtime bindings/i)).toBeInTheDocument();
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Run test event/i }));

      await waitFor(() => {
        expect(routerMocks.navigate).toHaveBeenCalledWith({
          to: '/insights/api-gateway',
          search: {
            view: 'routes',
            focusRoute: routeId,
            routePackId: packId,
          },
        });
      });
      expect(listSpy).toHaveBeenCalledWith(
        'integration_plugin_bindings',
        expect.objectContaining({
          filter: { plugin_version_id: versionId },
        }),
      );
      expect(consumeExternalIntakeSourceToken('api-gateway')).toMatchObject({
        token: 'ipt_api_runtime_source_token',
        source_id: sourceId,
        source_name: 'api-runtime-source',
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('routes webhook-source plugin runtime tests to the tester without stashing redacted tokens', async () => {
    const user = userEvent.setup();
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const pluginId = 'plg_webhook_runtime';
    const versionId = 'plgv_webhook_runtime_1';
    const sourceId = 'whs_runtime_1';
    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') {
          return {
            rows: [{
              id: pluginId,
              organization_id: 'org_rashed',
              name: 'Webhook Runtime Plugin',
              vendor: 'Runtime Vendor',
              version: 'v1',
              status: 'active',
              plugin_kind: 'inbound',
              active_version_id: versionId,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_directory') {
          return {
            rows: [{
              id: pluginId,
              vendor: 'Runtime Vendor',
              version_label: 'v1',
              version_count: 1,
              latest_version_no: 1,
              latest_version_status: 'active',
              active_version_status: 'active',
              binding_count: 1,
              install_count: 1,
              active_binding_count: 1,
              has_active_version: true,
              is_pending_review: false,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [{
              id: versionId,
              plugin_id: pluginId,
              version: 'v1',
              version_no: 1,
              status: 'active',
              created_at: '2026-05-22T00:00:00.000Z',
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_bindings') {
          return {
            rows: [{
              id: 'ipb_webhook_runtime',
              plugin_version_id: versionId,
              runtime_resource_type: 'webhook_source',
              runtime_resource_id: sourceId,
              activation_payload: {
                source_identifier: 'browser-runtime-source',
                issued_token: 'REDACTED',
              },
              enabled: true,
              updated_at: '2026-05-22T00:02:00.000Z',
            }],
            total: 1,
          };
        }
        if (
          resource === 'integration_plugin_validation_runs'
          || resource === 'integration_plugin_approval_events'
        ) {
          return { rows: [], total: 0 };
        }
        return { rows: [], total: 0 };
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      expect(await screen.findByText(/Binding: 1\/1 runtime binding/i)).toBeInTheDocument();
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Run test event/i }));

      await waitFor(() => {
        expect(routerMocks.navigate).toHaveBeenCalledWith({
          to: '/integrations/webhook-tester',
          search: {
            plugin_id: pluginId,
            source_id: sourceId,
          },
        });
      });
      expect(consumeExternalIntakeSourceToken('webhook-tester')).toBeNull();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('keeps API route runtime tests ahead of webhook-source handoff when both bindings exist', async () => {
    const user = userEvent.setup();
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const pluginId = 'plg_mixed_runtime';
    const versionId = 'plgv_mixed_runtime_1';
    const routeId = 'api_route_mixed_1';
    const packId = 'route_pack_mixed_1';
    try {
      listSpy.mockImplementation(async (resource: string) => {
        if (resource === 'integration_plugins') {
          return {
            rows: [{
              id: pluginId,
              organization_id: 'org_rashed',
              name: 'Mixed Runtime Plugin',
              vendor: 'Runtime Vendor',
              version: 'v1',
              status: 'active',
              plugin_kind: 'inbound',
              active_version_id: versionId,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_directory') {
          return {
            rows: [{
              id: pluginId,
              vendor: 'Runtime Vendor',
              version_label: 'v1',
              version_count: 1,
              latest_version_no: 1,
              latest_version_status: 'active',
              active_version_status: 'active',
              binding_count: 2,
              install_count: 1,
              active_binding_count: 2,
              has_active_version: true,
              is_pending_review: false,
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_versions') {
          return {
            rows: [{
              id: versionId,
              plugin_id: pluginId,
              version: 'v1',
              version_no: 1,
              status: 'active',
              created_at: '2026-05-22T00:00:00.000Z',
            }],
            total: 1,
          };
        }
        if (resource === 'integration_plugin_bindings') {
          return {
            rows: [
              {
                id: 'ipb_webhook_runtime_mixed',
                plugin_version_id: versionId,
                runtime_resource_type: 'webhook_sources',
                runtime_resource_id: 'whs_mixed_1',
                activation_payload: {
                  source_identifier: 'mixed-webhook-source',
                  issued_token: 'ipt_mixed_api_source_token',
                },
                enabled: true,
                updated_at: '2026-05-22T00:01:00.000Z',
              },
              {
                id: 'ipb_api_runtime_mixed',
                plugin_version_id: versionId,
                runtime_resource_type: 'api_routes',
                runtime_resource_id: routeId,
                activation_payload: {
                  pack_id: packId,
                  method: 'POST',
                  path_template: '/v1/mixed',
                },
                enabled: true,
                updated_at: '2026-05-22T00:02:00.000Z',
              },
            ],
            total: 2,
          };
        }
        if (
          resource === 'integration_plugin_validation_runs'
          || resource === 'integration_plugin_approval_events'
        ) {
          return { rows: [], total: 0 };
        }
        return { rows: [], total: 0 };
      });

      renderWithProviders(<CatalogModule />, { capabilities: ['all'] });
      expect(await screen.findByText(/Binding: 2\/2 runtime bindings/i)).toBeInTheDocument();
      await user.click(await screen.findByTestId(`integration-plugin-card-${pluginId}`));
      await user.click(await screen.findByRole('button', { name: /Run test event/i }));

      await waitFor(() => {
        expect(routerMocks.navigate).toHaveBeenCalledWith({
          to: '/insights/api-gateway',
          search: {
            view: 'routes',
            focusRoute: routeId,
            routePackId: packId,
          },
        });
      });
      expect(routerMocks.navigate).not.toHaveBeenCalledWith({
        to: '/integrations/webhook-tester',
        search: {
          plugin_id: pluginId,
          source_id: 'whs_mixed_1',
        },
      });
      expect(consumeExternalIntakeSourceToken('api-gateway')).toMatchObject({
        token: 'ipt_mixed_api_source_token',
        source_id: 'whs_mixed_1',
        source_name: 'mixed-webhook-source',
      });
      expect(consumeExternalIntakeSourceToken('webhook-tester')).toBeNull();
    } finally {
      listSpy.mockRestore();
    }
  });
});
