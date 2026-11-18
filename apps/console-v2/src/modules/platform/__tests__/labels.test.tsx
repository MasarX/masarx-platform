// labels.test.tsx — verifies the print queue renders with status filters and
// reprint composer can be opened.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { LabelsModule, labelReprintDisabledReason, resolveLabelReprintTarget } from '@/modules/platform/labels';
import * as api from '@/lib/api';
import type { IdentityProviderMockValue } from '@/lib/identity';

const REAL_GET_LOOKUPS = api.getLookups;
const REAL_UI_LIST_RESOURCE = api.ui_list_resource_v1;

function mockLabelRenderStatusLookups() {
  vi.spyOn(api, 'getLookups').mockImplementation((category) => (
    category === 'label_render_job_status'
      ? [
        { value: 'queued', label: 'Queued', is_default: true, rank: 10, metadata: { backend_values: ['pending'] } },
        { value: 'completed', label: 'Completed', is_default: false, rank: 20, metadata: { backend_values: ['succeeded'] } },
        { value: 'failed', label: 'Failed', is_default: false, rank: 30, metadata: { backend_values: ['failed'] } },
      ]
      : REAL_GET_LOOKUPS(category)
  ));
}

function labelTypeRows() {
  return [
    { value: 'shipping', label: 'Shipping', is_default: true, rank: 10, metadata: { compatible_target_types: ['shipment'] } },
    { value: 'route', label: 'Route', is_default: false, rank: 40, metadata: { compatible_target_types: ['route_run'] } },
    { value: 'container', label: 'Container', is_default: false, rank: 50, metadata: { compatible_target_types: ['handling_unit'] } },
    { value: 'transfer', label: 'Transfer', is_default: false, rank: 60, metadata: { compatible_target_types: ['warehouse_transfer'] } },
  ];
}

function mockLabelDesignerFieldCatalog() {
  vi.spyOn(api, 'label_designer_get_field_catalog').mockResolvedValue({
    ok: true,
    value: {
      version: 1,
      fields: [
        {
          key: 'recipient_name',
          value_path: 'recipient_name',
          label_en: 'Recipient Name',
          label_ar: 'Recipient Name',
          group: 'Recipient',
          data_type: 'string',
          example: 'Ahmed',
        },
        {
          key: 'tracking_number',
          value_path: 'tracking_number',
          label_en: 'Tracking Number',
          label_ar: 'Tracking Number',
          group: 'Shipment',
          data_type: 'string',
          example: 'DXX123456789',
        },
      ],
    },
  });
}

async function openLabelDesignComposer(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByTestId('label-design-composer')) return;
  const button = await screen.findByRole('button', { name: /Open Label Designer/i });
  await waitFor(() => expect(button).not.toBeDisabled());
  await user.click(button);
}

async function openSharedDesignerCodeTab(user: ReturnType<typeof userEvent.setup>) {
  const codeTab = screen.queryByTestId('label-design-shared-tab-code');
  if (codeTab) await user.click(codeTab);
  return screen.getByLabelText(/Design JSON/i) as HTMLTextAreaElement;
}

async function readSharedDesignerJson(user: ReturnType<typeof userEvent.setup>) {
  return JSON.parse((await openSharedDesignerCodeTab(user)).value);
}

async function returnToSharedDesignerVisualTab(user: ReturnType<typeof userEvent.setup>) {
  const visualTab = screen.queryByTestId('label-design-shared-tab-visual');
  if (visualTab) await user.click(visualTab);
}

beforeEach(() => {
  mockLabelDesignerFieldCatalog();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  document.body.style.pointerEvents = '';
  document.body.removeAttribute('data-scroll-locked');
});

describe('LabelsModule', () => {
  const labelDesignIdentity: IdentityProviderMockValue = {
    user: {
      id: 'usr_label_designer',
      organization_id: 'org_label_designer',
      access_scope_type: 'tenant' as const,
      access_scope_id: null,
    },
    scope: { tenant: { id: 'org_label_designer', label: 'Label Designer Tenant', rank: 2 as const } },
    capabilities: ['labels.read', 'label_design.read', 'label_design.write'],
  };

  it('renders the print queue section with status filter chips', async () => {
    mockLabelRenderStatusLookups();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });
    expect(await screen.findByTestId('labels-status-all')).toBeInTheDocument();
    expect(screen.getByTestId('labels-status-queued')).toBeInTheDocument();
    expect(screen.getByTestId('labels-status-completed')).toBeInTheDocument();
    expect(screen.getByTestId('labels-status-failed')).toBeInTheDocument();
  });

  it('surfaces Label Designer as a visible webapp workbench with the inline studio open by default', async () => {
    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const workbench = await screen.findByTestId('label-designer-workbench');
    expect(within(workbench).getByText('Visual label designer')).toBeInTheDocument();
    expect(within(workbench).getByText('tenant scoped')).toBeInTheDocument();
    expect(await screen.findByTestId('label-designer-inline-studio')).toBeInTheDocument();
    expect(await screen.findByTestId('label-design-composer')).toBeInTheDocument();
    expect(within(workbench).getByText('designer open')).toBeInTheDocument();
    expect(within(workbench).queryByRole('button', { name: /Open Label Designer/i })).not.toBeInTheDocument();
  });

  it('shows redacted renderer provider and printer readiness readback for the active label scope', async () => {
    vi.spyOn(api, 'ui_label_renderer_readiness_v1').mockResolvedValue({
      ok: true,
      scope: { scope_type: 'tenant', scope_id: 'org_label_designer' },
      renderer_provider: {
        status: 'ready',
        provider_name: 'local_label_renderer',
        invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer?redacted=query',
        invoke_secret: 'redacted',
        timeout_ms: '30000',
      },
      render_policy: {
        status: 'ready',
        missing: [],
        value: {
          header_brand_mode: 'logo',
          arabic: { enabled: true },
          barcode: { gate_mode: 'warn_only' },
        },
      },
      print_profile: {
        status: 'ready',
        missing: [],
        value: {
          profile_key: 'default_203dpi',
          dpi: 203,
          media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
          barcode: { target_module_width_dots: 2 },
        },
      },
      printer_certification: {
        status: 'missing',
        missing: ['printer_certification'],
        evidence: {},
      },
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const card = await screen.findByTestId('label-renderer-readiness-card');
    await waitFor(() => {
      expect(card).toHaveAttribute('data-renderer-provider-status', 'ready');
      expect(card).toHaveAttribute('data-printer-certification-status', 'missing');
    });
    expect(within(card).getByText('Renderer and printer readiness')).toBeInTheDocument();
    expect(within(card).getByText(/Provider Local Label Renderer/)).toBeInTheDocument();
    expect(within(card).getByText(/Secret redacted/)).toBeInTheDocument();
    expect(card).not.toHaveTextContent('EXAMPLE_PASSWORD');
    expect(card).not.toHaveTextContent('super-secret');
    expect(within(card).getByText(/Profile Default 203dpi/)).toBeInTheDocument();
    expect(within(card).getByText(/DPI 203/)).toBeInTheDocument();
    expect(within(card).getByText(/Brand Logo/)).toBeInTheDocument();
    expect(within(card).getByText(/Barcode Warn Only/)).toBeInTheDocument();
    expect(within(card).getByText(/Missing Printer Certification/)).toBeInTheDocument();
  });

  it('uses the selected active tenant for platform label designer readiness and drafts', async () => {
    const platformActiveTenantIdentity: IdentityProviderMockValue = {
      user: {
        id: 'usr_platform_label_designer',
        organization_id: 'org_platform_home',
        access_scope_type: 'platform' as const,
        access_scope_id: null,
      },
      scope: { tenant: { id: 'org_active_tenant_labels', label: 'Active Tenant Labels', rank: 2 as const } },
      capabilities: ['labels.read', 'label_design.read', 'label_design.write'],
    };
    const readinessSpy = vi.spyOn(api, 'ui_label_renderer_readiness_v1').mockResolvedValue({
      ok: true,
      scope: { scope_type: 'tenant', scope_id: 'org_active_tenant_labels' },
      renderer_provider: {
        status: 'ready',
        provider_name: 'local_label_renderer',
        invoke_secret: 'redacted',
      },
      render_policy: {
        status: 'ready',
        missing: [],
        value: { header_brand_mode: 'logo' },
      },
      print_profile: {
        status: 'ready',
        missing: [],
        value: { profile_key: 'default_203dpi', dpi: 203 },
      },
      printer_certification: {
        status: 'ready',
        missing: [],
        evidence: { certification_id: 'cert_active_tenant', result: 'passed' },
      },
    });
    const catalogSpy = vi.spyOn(api, 'label_designer_get_field_catalog').mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        fields: [
          {
            key: 'tracking_number',
            value_path: 'tracking_number',
            label_en: 'Tracking Number',
            group: 'Shipment',
            data_type: 'string',
            example: 'DXX123456789',
          },
        ],
      },
    });
    const listSpy = vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });

    renderWithProviders(<LabelsModule />, { identity: platformActiveTenantIdentity });

    const studio = await screen.findByTestId('label-designer-inline-studio');
    await waitFor(() => {
      expect(readinessSpy).toHaveBeenCalledWith('tenant', 'org_active_tenant_labels');
      expect(catalogSpy).toHaveBeenCalledWith('tenant', 'org_active_tenant_labels');
      expect(listSpy).toHaveBeenCalledWith('tenant', 'org_active_tenant_labels');
    });
    expect(within(studio).getByText('tenant: Active Tenant Labels')).toBeInTheDocument();
    expect(screen.queryByText('tenant scope_id must equal organization_id')).not.toBeInTheDocument();
  });

  it('fails visibly when renderer provider and print certification readiness are missing', async () => {
    vi.spyOn(api, 'ui_label_renderer_readiness_v1').mockResolvedValue({
      ok: true,
      scope: { scope_type: 'tenant', scope_id: 'org_label_designer' },
      renderer_provider: {
        status: 'missing',
        error: 'resolve_label_renderer_invoke_config_v1: provider invoke configuration not activated',
      },
      render_policy: {
        status: 'missing',
        missing: ['header_brand_mode'],
        value: {},
      },
      print_profile: {
        status: 'missing',
        missing: ['profile_key', 'dpi'],
        value: {},
      },
      printer_certification: {
        status: 'missing',
        missing: ['printer_certification'],
        evidence: {},
      },
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const card = await screen.findByTestId('label-renderer-readiness-card');
    await waitFor(() => {
      expect(card).toHaveAttribute('data-renderer-provider-status', 'missing');
      expect(card).toHaveAttribute('data-render-policy-status', 'missing');
      expect(card).toHaveAttribute('data-print-profile-status', 'missing');
    });
    expect(card).toHaveTextContent('Label renderer provider needs attention');
    expect(card).toHaveTextContent('Missing Profile Key, DPI');
    expect(card).toHaveTextContent('Missing Printer Certification');
  });

  it('records printer certification evidence and reconciles readiness without a reload', async () => {
    const user = userEvent.setup();
    const missingReadiness = {
      ok: true,
      scope: { scope_type: 'tenant', scope_id: 'org_label_designer' },
      renderer_provider: {
        status: 'ready',
        provider_name: 'local_label_renderer',
        invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer',
        invoke_secret: 'redacted',
        timeout_ms: '30000',
      },
      render_policy: {
        status: 'ready',
        missing: [],
        value: { header_brand_mode: 'logo', arabic: { enabled: true }, barcode: { gate_mode: 'warn_only' } },
      },
      print_profile: {
        status: 'ready',
        missing: [],
        value: {
          profile_key: 'default_203dpi',
          dpi: 203,
          media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
        },
      },
      printer_certification: {
        status: 'missing',
        missing: ['printer_certification'],
        evidence: {},
      },
    } satisfies api.LabelRendererReadinessResult;
    const readyReadiness = {
      ...missingReadiness,
      print_profile: {
        ...missingReadiness.print_profile,
        value: {
          ...(missingReadiness.print_profile?.value as Record<string, unknown>),
          printer_certification: {
            certification_id: 'cert_browser_1',
            evidence_reference: 'BrowserPrinterCertProofTest',
            printer_model: 'Zebra ZD421',
            printer_dpi: 203,
            media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
            result: 'passed',
            source: 'console_v2_platform_labels',
          },
        },
      },
      printer_certification: {
        status: 'ready',
        missing: [],
        evidence: {
          certification_id: 'cert_browser_1',
          evidence_reference: 'BrowserPrinterCertProofTest',
          printer_model: 'Zebra ZD421',
          printer_dpi: 203,
          media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
          result: 'passed',
          source: 'console_v2_platform_labels',
        },
      },
    } satisfies api.LabelRendererReadinessResult;
    let certified = false;
    vi.spyOn(api, 'ui_label_renderer_readiness_v1').mockImplementation(async () => (
      certified ? readyReadiness : missingReadiness
    ));
    const certifySpy = vi.spyOn(api, 'ui_record_label_printer_certification_v1').mockImplementation(async (args) => {
      certified = true;
      return {
        ok: true,
        scope_type: args.scope_type,
        scope_id: args.scope_id,
        settings_version_id: 'sv_label_print_profile_certified',
        settings_version_number: 2,
        certification: readyReadiness.printer_certification?.evidence as Record<string, unknown>,
        readiness: readyReadiness,
      };
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const card = await screen.findByTestId('label-renderer-readiness-card');
    await waitFor(() => expect(card).toHaveAttribute('data-printer-certification-status', 'missing'));

    await user.type(within(card).getByLabelText('Printer model'), 'Zebra ZD421');
    await user.type(within(card).getByLabelText('Printer certification evidence reference'), 'BrowserPrinterCertProofTest');
    await user.type(within(card).getByLabelText('Printer certification test label reference'), 'certification/BrowserPrinterCertProofTest.pdf');
    await user.click(within(card).getByRole('button', { name: /Record certification/i }));

    await waitFor(() => expect(card).toHaveAttribute('data-printer-certification-status', 'ready'));
    expect(within(card).getByText(/Printer certification Ready/)).toBeInTheDocument();
    expect((within(card).getByLabelText('Printer certification evidence') as HTMLTextAreaElement).value)
      .toContain('BrowserPrinterCertProofTest');
    expect(certifySpy).toHaveBeenCalledWith(expect.objectContaining({
      scope_type: 'tenant',
      scope_id: 'org_label_designer',
      evidence_reference: 'BrowserPrinterCertProofTest',
      printer_model: 'Zebra ZD421',
      test_artifact_ref: 'certification/BrowserPrinterCertProofTest.pdf',
      result: 'passed',
    }));
  }, 15000);

  it('keeps the Label Designer as an inline webapp studio that can be closed and reopened', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const studio = await screen.findByTestId('label-designer-inline-studio');
    expect(within(studio).getByText(/Designer studio - active design/i)).toBeInTheDocument();
    expect(within(studio).getByText('tenant: Label Designer Tenant')).toBeInTheDocument();
    expect(within(studio).getByTestId('label-design-composer')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(studio).getByTestId('label-design-shared-canvas-container')).toBeInTheDocument();
    });
    expect(within(await screen.findByTestId('label-designer-workbench')).getByText('designer open')).toBeInTheDocument();
    await user.click(within(studio).getByRole('button', { name: /Close designer/i }));
    expect(screen.queryByTestId('label-designer-inline-studio')).toBeNull();
    await openLabelDesignComposer(user);
    expect(await screen.findByTestId('label-designer-inline-studio')).toBeInTheDocument();
  });

  it('keeps the visual designer canvas visible before and after operators add blocks', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    mockLabelDesignerFieldCatalog();
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    expect(composer.getByTestId('label-design-shared-canvas-container')).toBeInTheDocument();
    expect(composer.getByTestId('label-design-shared-catalog-sidebar')).toBeInTheDocument();
    expect(composer.getByTestId('layers-panel')).toBeInTheDocument();

    const trackingButton = composer.getByRole('button', { name: /tracking_number/i });
    await waitFor(() => expect(trackingButton).toBeEnabled());
    await user.click(trackingButton);

    expect(composer.getByTestId('label-design-shared-canvas-svg')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('label-design-shared-canvas-undo')).toBeEnabled();
    });
    let designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0].value_path).toBe('tracking_number');

    await returnToSharedDesignerVisualTab(user);
    await user.click(screen.getByTestId('label-design-shared-canvas-undo'));
    designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks).toEqual([]);

    await returnToSharedDesignerVisualTab(user);
    await waitFor(() => {
      expect(screen.getByTestId('label-design-shared-canvas-redo')).toBeEnabled();
    });
    await user.click(screen.getByTestId('label-design-shared-canvas-redo'));
    designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0].value_path).toBe('tracking_number');
  });

  it('lets operators select, move, duplicate, and delete visual label blocks before publish', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    mockLabelDesignerFieldCatalog();
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    await user.click(composer.getByRole('button', { name: /recipient_name/i }));
    await waitFor(() => expect(screen.getByTestId('label-design-shared-canvas-svg')).toHaveTextContent('recipient_name'));
    expect(screen.getByTestId('label-design-shared-block-props-panel')).toBeInTheDocument();

    const xInput = screen.getByLabelText('X');
    const yInput = screen.getByLabelText('Y');
    fireEvent.change(xInput, { target: { value: '28' } });
    fireEvent.change(yInput, { target: { value: '56' } });
    let designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0].x).toBe(28);
    expect(designJson.templates.shipping.blocks[0].y).toBe(56);

    await returnToSharedDesignerVisualTab(user);
    await user.click(screen.getByTestId('label-design-shared-canvas-undo'));
    designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0].y).toBe(10);
    await returnToSharedDesignerVisualTab(user);
    await user.click(screen.getByTestId('label-design-shared-canvas-redo'));
    designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0].y).toBe(56);

    await returnToSharedDesignerVisualTab(user);
    fireEvent.change(screen.getByLabelText('W'), { target: { value: '188' } });
    fireEvent.change(screen.getByLabelText('H'), { target: { value: '32' } });
    fireEvent.change(screen.getByLabelText('Fallback'), { target: { value: 'Edited recipient label' } });
    designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks[0]).toMatchObject({
      width: 188,
      height: 32,
      fallback: 'Edited recipient label',
    });
  }, 20000);

  it('keeps shared canvas drag and resize wired to the backend-bound draft JSON', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    mockLabelDesignerFieldCatalog();
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    await user.click(composer.getByRole('button', { name: /recipient_name/i }));
    const canvas = await screen.findByTestId('label-design-shared-canvas-svg');
    await waitFor(() => expect(canvas).toHaveTextContent('recipient_name'));
    const block = Array.from(canvas.querySelectorAll('text'))
      .find((node) => node.textContent?.includes('recipient_name'));
    expect(block).toBeTruthy();

    fireEvent.mouseDown(block as Element, { clientX: 120, clientY: 140 });
    fireEvent.mouseMove(window, { clientX: 152, clientY: 186 });
    fireEvent.mouseUp(window);

    await waitFor(async () => {
      const designJson = await readSharedDesignerJson(user);
      expect(designJson.templates.shipping.blocks[0]).toMatchObject({
        x: 42,
        y: 56,
      });
    });

    await returnToSharedDesignerVisualTab(user);
    const resizeHandle = await screen.findByTestId('label-design-shared-canvas-resize-se');
    fireEvent.mouseDown(resizeHandle, { clientX: 152, clientY: 186 });
    fireEvent.mouseMove(window, { clientX: 197, clientY: 208 });
    fireEvent.mouseUp(window);

    await waitFor(async () => {
      const designJson = await readSharedDesignerJson(user);
      expect(designJson.templates.shipping.blocks[0]).toMatchObject({
        width: 195,
        height: 42,
      });
    });
  });

  it('adds renderer-native barcode, line, and rectangle blocks from visible designer controls', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    mockLabelDesignerFieldCatalog();
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const clickBlockButton = async (name: string) => {
      const composer = within(await screen.findByTestId('label-design-composer'));
      await user.click(await composer.findByRole('button', { name }, { timeout: 15000 }));
    };
    await clickBlockButton('Text');
    await clickBlockButton('Barcode');
    await user.selectOptions(screen.getByLabelText(/Barcode Type/i), 'qr');
    await clickBlockButton('Line');
    await clickBlockButton('Rectangle');

    const designJson = await readSharedDesignerJson(user);
    const blocks = designJson.templates.shipping.blocks;
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      fallback: 'Text',
      font_size: 12,
    });
    expect(blocks[1]).toMatchObject({
      type: 'barcode',
      barcode_type: 'QR',
      value_path: 'barcode_value',
      fallback: 'TRACKING',
      human_readable: false,
    });
    expect(blocks[1].y).toBeGreaterThanOrEqual(blocks[0].y + blocks[0].height);
    expect(blocks[2]).toMatchObject({ type: 'line' });
    expect(blocks[3]).toMatchObject({ type: 'rect' });
    await returnToSharedDesignerVisualTab(user);
    expect(screen.getByTestId('layers-panel')).toHaveTextContent('rect #3');
  }, 20000);

  it('edits the selected label-type template through the shared canvas instead of the first template', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    mockLabelDesignerFieldCatalog();
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    await user.selectOptions(composer.getByLabelText('Label type'), 'route');
    const codeEditor = await openSharedDesignerCodeTab(user);
    fireEvent.change(codeEditor, {
      target: {
        value: JSON.stringify({
          templates: {
            shipping: { page: {}, blocks: [] },
            route: { page: {}, blocks: [] },
          },
        }, null, 2),
      },
    });
    await returnToSharedDesignerVisualTab(user);
    await user.click(composer.getByRole('button', { name: /recipient_name/i }));

    const designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks).toEqual([]);
    expect(designJson.templates.route.blocks).toHaveLength(1);
    expect(designJson.templates.route.blocks[0].value_path).toBe('recipient_name');
  });

  it('requests a route-run label and shows label_jobs plus label_artifacts readback without reloading', async () => {
    mockLabelRenderStatusLookups();
    let queued = false;
    let reprintQueued = false;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const clipboardWriteSpy = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteSpy },
    });
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1').mockResolvedValue({
      ok: true,
      url: '/signed/labels/route-target-visible.pdf',
      expires_at: '2026-05-23T03:17:00Z',
    });
    const requestSpy = vi.spyOn(api, 'ui_request_label_generation_target_v1').mockImplementation(async () => {
      queued = true;
      return {
        ok: true,
        label_job_id: 'lj_route_target_visible',
        target_type: 'route_run',
        target_id: 'run_target_visible',
        label_type: 'route',
        status: 'pending',
        job: null,
      };
    });
    const reprintSpy = vi.spyOn(api, 'request_label_reprint').mockImplementation(async () => {
      reprintQueued = true;
      return {
        ok: true,
        label_id: 'lart_route_target_visible',
        reason: 'operator_request',
        label_job_id: 'lj_route_target_reprint_visible',
        new_version_id: null,
      };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [{ value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 }];
      }
      if (category === 'label_render_job_status') {
        return [
          { value: 'queued', label: 'Queued', is_default: true, rank: 10, metadata: { backend_values: ['pending', 'queued'] } },
          { value: 'completed', label: 'Completed', is_default: false, rank: 20, metadata: { backend_values: ['succeeded'] } },
          { value: 'failed', label: 'Failed', is_default: false, rank: 30, metadata: { backend_values: ['failed'] } },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'route_run_directory') {
        return Promise.resolve({
          rows: [{
            id: 'run_target_visible',
            organization_id: 'org_route_label',
            run_display_id: 'RUN-TARGET',
            branch_label: 'Main branch',
            status: 'planned',
            stop_count: 3,
            created_at: '2026-05-23T03:00:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') {
        const rows = [
          ...(queued ? [{
            id: 'lj_route_target_visible',
            organization_id: 'org_route_label',
            target_type: 'route_run',
            target_id: 'run_target_visible',
            label_type: 'route',
            status: 'pending',
            queued_at: '2026-05-23T03:01:00Z',
          }] : []),
          ...(reprintQueued ? [{
            id: 'lj_route_target_reprint_visible',
            organization_id: 'org_route_label',
            target_type: 'route_run',
            target_id: 'run_target_visible',
            label_type: 'route',
            status: 'queued',
            job_purpose: 'reprint',
            reprint_reason: 'operator_request',
            queued_at: '2026-05-23T03:03:00Z',
            target_metadata: {
              source_label_artifact_id: 'lart_route_target_visible',
              source_label_job_id: 'lj_route_target_visible',
              reprint_reason: 'operator_request',
            },
          }] : []),
        ];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_artifacts') {
        const rows = queued
          ? [{
            id: 'lart_route_target_visible',
            organization_id: 'org_route_label',
            target_type: 'route_run',
            target_id: 'run_target_visible',
            label_type: 'shipping',
            file_url: 'org_route_label/labels/lj_route_target_visible.pdf',
            source_label_job_id: 'lj_route_target_visible',
            generated_at: '2026-05-23T03:02:00Z',
          }]
          : [];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_template_directory') {
        return Promise.resolve({ rows: [{ id: 'tpl_route_target', template_key: 'route' }], total: 1 });
      }
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, {
      identity: {
        user: {
          id: 'usr_route_label',
          organization_id: 'org_route_label',
          access_scope_type: 'tenant' as const,
          access_scope_id: null,
        },
        scope: { tenant: { id: 'org_route_label', label: 'Route Label Tenant', rank: 2 as const } },
        capabilities: ['labels.read', 'labels.reprint', 'labels.download'],
      },
    });

    const workbench = await screen.findByTestId('route-run-label-workbench');
    expect(await within(workbench).findByText('RUN-TARGET - Main branch - planned')).toBeInTheDocument();
    expect(within(workbench).getByLabelText(/Target label type/i)).toHaveValue('route');
    expect(within(workbench).queryByRole('option', { name: 'Shipping' })).not.toBeInTheDocument();
    const generateButton = within(workbench).getByRole('button', { name: /Generate target label/i });
    await waitFor(() => expect(generateButton).toBeEnabled());
    await user.click(generateButton);

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'org_route_label',
        target_type: 'route_run',
        target_id: 'run_target_visible',
        label_type: 'route',
      }));
    });

    await waitFor(() => {
      expect(screen.getAllByText('Print request lj_route_target_visible').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Saved label lart_route_target_visible').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('lart_route_target_visible')).toBeInTheDocument();
    expect(screen.getAllByText('Route run').length).toBeGreaterThan(0);

    const artifactCard = screen.getByText('lart_route_target_visible').closest('.card');
    expect(artifactCard).toBeTruthy();
    await user.click(within(artifactCard as HTMLElement).getByRole('button', { name: /Open label/i }));
    await waitFor(() => {
      expect(resolverSpy).toHaveBeenCalledWith({
        resource: 'label_artifacts',
        id: 'lart_route_target_visible',
        expires_seconds: 900,
      });
    });
    expect(openSpy).toHaveBeenCalledWith('/signed/labels/route-target-visible.pdf', '_blank', 'noopener,noreferrer');
    const handoff = await screen.findByTestId('label-download-handoff-readback');
    expect(handoff).toHaveTextContent('Status ready');
    expect(handoff).toHaveTextContent('Saved label');
    expect(handoff).toHaveTextContent('Reference lart_route_target_visible');
    expect(handoff).toHaveTextContent('Secure link ready');
    expect(handoff).toHaveTextContent('Pop-up blocked');
    expect(clipboardWriteSpy).not.toHaveBeenCalled();

    await user.click(within(artifactCard as HTMLElement).getByRole('button', { name: /Reprint label/i }));
    const composer = within(await screen.findByTestId('reprint-composer'));
    expect(composer.getByText('lart_route_target_visible')).toBeInTheDocument();
    await user.click(composer.getByRole('button', { name: /^Reprint$/ }));

    await waitFor(() => {
      expect(reprintSpy).toHaveBeenCalledWith('lart_route_target_visible', { reason: 'operator_request' });
    });
    expect(await screen.findByText('lj_route_target_reprint_visible')).toBeInTheDocument();
    expect(screen.getAllByText('Print request lj_route_target_reprint_visible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Saved label pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Previous saved label lart_route_target_visible').length).toBeGreaterThan(0);
  });

  it('requests a warehouse-transfer label through the same target-label workbench', async () => {
    mockLabelRenderStatusLookups();
    let queued = false;
    const requestSpy = vi.spyOn(api, 'ui_request_label_generation_target_v1').mockImplementation(async () => {
      queued = true;
      return {
        ok: true,
        label_job_id: 'lj_transfer_target_visible',
        target_type: 'warehouse_transfer',
        target_id: 'wtr_target_visible',
        label_type: 'transfer',
        status: 'pending',
        job: null,
      };
    });
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'route_run_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'handling_units') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'warehouse_transfer_summary') {
        return Promise.resolve({
          rows: [{
            id: 'wtr_target_visible',
            organization_id: 'org_transfer_label',
            transfer_code: 'WTR-TARGET',
            status: 'in_transit',
            item_count: 4,
            updated_at: '2026-05-23T03:10:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') {
        const rows = queued
          ? [{
            id: 'lj_transfer_target_visible',
            organization_id: 'org_transfer_label',
            target_type: 'warehouse_transfer',
            target_id: 'wtr_target_visible',
            label_type: 'transfer',
            status: 'pending',
            queued_at: '2026-05-23T03:11:00Z',
          }]
          : [];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_artifacts') {
        const rows = queued
          ? [{
            id: 'lart_transfer_target_visible',
            organization_id: 'org_transfer_label',
            target_type: 'warehouse_transfer',
            target_id: 'wtr_target_visible',
            label_type: 'transfer',
            file_url: 'org_transfer_label/labels/lj_transfer_target_visible.pdf',
            source_label_job_id: 'lj_transfer_target_visible',
            generated_at: '2026-05-23T03:12:00Z',
          }]
          : [];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_template_directory') {
        return Promise.resolve({ rows: [{ id: 'tpl_transfer_target', template_key: 'transfer' }], total: 1 });
      }
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, {
      identity: {
        user: {
          id: 'usr_transfer_label',
          organization_id: 'org_transfer_label',
          access_scope_type: 'tenant' as const,
          access_scope_id: null,
        },
        scope: { tenant: { id: 'org_transfer_label', label: 'Transfer Label Tenant', rank: 2 as const } },
        capabilities: ['labels.read', 'labels.reprint'],
      },
    });

    const workbench = await screen.findByTestId('route-run-label-workbench');
    await user.selectOptions(within(workbench).getByLabelText(/Label target type/i), 'warehouse_transfer');
    expect(await within(workbench).findByText('WTR-TARGET - in_transit - 4 items')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(workbench).getByRole('button', { name: /Generate target label/i })).toBeEnabled();
    });
    await user.click(within(workbench).getByRole('button', { name: /Generate target label/i }));

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'org_transfer_label',
        target_type: 'warehouse_transfer',
        target_id: 'wtr_target_visible',
        label_type: 'transfer',
      }));
    });

    await waitFor(() => {
      expect(screen.getAllByText('Print request lj_transfer_target_visible').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Saved label lart_transfer_target_visible').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('lart_transfer_target_visible')).toBeInTheDocument();
  });

  it('requests a handling-unit label through the same target-label workbench', async () => {
    mockLabelRenderStatusLookups();
    let queued = false;
    const requestSpy = vi.spyOn(api, 'ui_request_label_generation_target_v1').mockImplementation(async () => {
      queued = true;
      return {
        ok: true,
        label_job_id: 'lj_unit_target_visible',
        target_type: 'handling_unit',
        target_id: 'hu_target_visible',
        label_type: 'container',
        status: 'pending',
        job: null,
      };
    });
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'route_run_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'warehouse_transfer_summary') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'handling_units') {
        return Promise.resolve({
          rows: [{
            id: 'hu_target_visible',
            organization_id: 'org_unit_label',
            code: 'HU-TARGET',
            unit_type: 'bag',
            status: 'open',
            branch_id: 'branch_unit_label',
            created_at: '2026-05-23T03:20:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') {
        const rows = queued
          ? [{
            id: 'lj_unit_target_visible',
            organization_id: 'org_unit_label',
            target_type: 'handling_unit',
            target_id: 'hu_target_visible',
            label_type: 'container',
            status: 'pending',
            queued_at: '2026-05-23T03:21:00Z',
          }]
          : [];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_artifacts') {
        const rows = queued
          ? [{
            id: 'lart_unit_target_visible',
            organization_id: 'org_unit_label',
            target_type: 'handling_unit',
            target_id: 'hu_target_visible',
            label_type: 'container',
            file_url: 'org_unit_label/labels/lj_unit_target_visible.pdf',
            source_label_job_id: 'lj_unit_target_visible',
            generated_at: '2026-05-23T03:22:00Z',
          }]
          : [];
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_template_directory') {
        return Promise.resolve({ rows: [{ id: 'tpl_unit_target', template_key: 'container' }], total: 1 });
      }
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, {
      identity: {
        user: {
          id: 'usr_unit_label',
          organization_id: 'org_unit_label',
          access_scope_type: 'tenant' as const,
          access_scope_id: null,
        },
        scope: { tenant: { id: 'org_unit_label', label: 'Unit Label Tenant', rank: 2 as const } },
        capabilities: ['labels.read', 'labels.reprint'],
      },
    });

    const workbench = await screen.findByTestId('route-run-label-workbench');
    await user.selectOptions(within(workbench).getByLabelText(/Label target type/i), 'handling_unit');
    expect(await within(workbench).findByText('HU-TARGET - bag - open')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(workbench).getByRole('button', { name: /Generate target label/i })).toBeEnabled();
    });
    await user.click(within(workbench).getByRole('button', { name: /Generate target label/i }));

    await waitFor(() => {
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'org_unit_label',
        target_type: 'handling_unit',
        target_id: 'hu_target_visible',
        label_type: 'container',
      }));
    });

    await waitFor(() => {
      expect(screen.getAllByText('Print request lj_unit_target_visible').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Saved label lart_unit_target_visible').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('lart_unit_target_visible')).toBeInTheDocument();
  });

  it('clicking a status filter highlights it', async () => {
    mockLabelRenderStatusLookups();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });
    const completed = await screen.findByTestId('labels-status-completed');
    fireEvent.click(completed);
    expect(completed.className).toContain('is-active');
  });

  it('does not surface a synthetic-id "Reprint (synthetic)" header CTA (W38 closure)', async () => {
    // W38-PLATFORM closure: the previous "Reprint (synthetic)" header
    // Button — which fired openReprint(['lbl_synth']) with a hardcoded
    // synthetic label_id — was removed because it could not bind to a
    // real label_job at click time. Per-row Reprint flows already exist
    // in the rowActions wired to the canonical r.id (single-row +
    // bulk-selection). This regression guard keeps the synthetic-id CTA
    // from coming back.
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.write', 'all'] });
    expect(
      screen.queryByRole('button', { name: /Reprint \(synthetic\)/i }),
    ).toBeNull();
  });

  // W28 — paired projection view consumption tests. Verifies the page-level
  // operator-facing template directory pill renders and that the SPEC_COLUMNS
  // surface the directory-derived "Renders" + "Last used" columns.
  it('W28: renders the template directory page-header pill', async () => {
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });
    expect((await screen.findAllByText(/^Template directory$/)).length).toBeGreaterThan(0);
  });

  it('W28: SPEC_COLUMNS exposes "Renders" + "Last used" columns from the directory projection', async () => {
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });
    expect(await screen.findByText(/^Renders$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Last used$/i)).toBeInTheDocument();
  });

  it('uses the operator-facing label_template_directory read instead of the raw specs resource', async () => {
    mockLabelRenderStatusLookups();
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_template_specs') {
        return Promise.reject(new Error('raw specs resource should not be read by Platform Labels'));
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    expect(await screen.findByText(/^Renders$/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('label_template_directory', undefined);
    });
    expect(listSpy).not.toHaveBeenCalledWith('label_template_specs', expect.anything());
    expect(screen.queryByText(/Label template specs did not load/i)).toBeNull();
  });

  it('renders template keys from directory rows that do not carry the legacy name alias', async () => {
    mockLabelRenderStatusLookups();
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_template_directory') {
        return Promise.resolve({
          rows: [{
            id: 'tpl_directory_only',
            template_key: 'waybill_v1',
            version: 2,
            dimensions: '4x6',
            dpi: 203,
            barcode_format: 'CODE128',
            active_version_id: 'lv_waybill_v2',
            renderer_config: { active_version_id: 'lv_waybill_v2' },
            render_count: 7,
            completed_count: 6,
            failed_count: 1,
            last_used_at: '2026-05-15T22:00:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [{
            id: 'job_directory_ref',
            template_id: 'tpl_directory_only',
            target_type: 'shipment',
            target_id: 'shp_directory_ref',
            status: 'succeeded',
            completed_at: '2026-05-15T22:00:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    expect(await screen.findByText('waybill_v1')).toBeInTheDocument();
    expect(screen.getByText('lv_waybill_v2')).toBeInTheDocument();
  });

  it('bridges template rows into the shared canvas and full designer without the legacy SVG preview', async () => {
    mockLabelRenderStatusLookups();
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'label_template_directory') {
        return Promise.resolve({
          rows: [{
            id: 'tpl_blocks_only',
            template_key: 'waybill_blocks',
            version: 1,
            dimensions: '4 x 6',
            dpi: 203,
            barcode_format: 'CODE128',
            renderer_config: {
              blocks: [
                { section_key: 'header', x: 12, y: 20, width: 180, height: 40, type: 'text' },
                { section_key: 'barcode_band', x: 20, y: 90, width: 240, height: 60, type: 'barcode' },
              ],
            },
            render_count: 0,
            completed_count: 0,
            failed_count: 0,
            last_used_at: null,
          }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await user.click(await screen.findByText('waybill_blocks'));
    const drawerPreview = await screen.findByTestId('label-template-spec-shared-preview');
    expect(within(drawerPreview).getByTestId('label-design-readonly-canvas-container')).toBeInTheDocument();
    expect(within(drawerPreview).getByTestId('label-design-readonly-canvas-svg')).toHaveTextContent('header');
    expect(within(drawerPreview).getByText('Blocks 2')).toBeInTheDocument();
    expect(screen.queryByText(/SVG canvas/i)).toBeNull();

    await user.click(within(drawerPreview).getByRole('button', { name: /Edit in full designer/i }));
    const studio = await screen.findByTestId('label-designer-inline-studio');
    expect(studio).toBeInTheDocument();
    expect(screen.getByText(/Designer studio - waybill_blocks/i)).toBeInTheDocument();
    const designJson = await readSharedDesignerJson(user);
    expect(designJson.templates.shipping.blocks).toEqual([
      expect.objectContaining({ section_key: 'header' }),
      expect.objectContaining({ section_key: 'barcode_band' }),
    ]);
  });

  it('filters completed label render jobs using the canonical succeeded backend status', async () => {
    mockLabelRenderStatusLookups();
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [
            { id: 'job_pending', status: 'pending', target_type: 'shipment', target_id: 'shp_pending' },
            { id: 'job_succeeded', status: 'succeeded', target_type: 'shipment', target_id: 'shp_succeeded' },
          ],
          total: 2,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    expect(await screen.findByText('job_succeeded')).toBeInTheDocument();
    await user.click(screen.getByTestId('labels-status-completed'));

    expect(screen.getByText('job_succeeded')).toBeInTheDocument();
    expect(screen.queryByText('job_pending')).toBeNull();
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('refreshes active print queue jobs from backend completion without a reload', async () => {
    mockLabelRenderStatusLookups();
    let labelJobReads = 0;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        labelJobReads += 1;
        return Promise.resolve({
          rows: [{
            id: 'ljob_plugin_render_live_refresh',
            status: labelJobReads > 1 ? 'succeeded' : 'pending',
            target_type: 'shipment',
            target_id: 'shp_plugin_render_live_refresh',
            output_file_url: labelJobReads > 1 ? '08d59e17/labels/ljob_plugin_render_live_refresh.pdf' : null,
            completed_at: labelJobReads > 1 ? '2026-05-22T20:05:00Z' : null,
          }],
          total: 1,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const liveJobCell = await screen.findByText('ljob_plugin_render_live_refresh');
    expect(liveJobCell).toBeInTheDocument();
    const liveJobRow = liveJobCell.closest('tr');
    expect(liveJobRow).toBeTruthy();
    await waitFor(() => {
      expect(within(liveJobRow as HTMLElement).getByText('Completed')).toBeInTheDocument();
    }, { timeout: 3500 });
    expect(labelJobReads).toBeGreaterThan(1);
  });

  it('resolves print-queue reprints to canonical labels.id, not label_jobs.id', () => {
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_direct', label_id: 'lbl_direct', shipment_id: 'shp_1' },
        [{ id: 'lbl_direct', shipment_id: 'shp_1', active_version_id: 'lv_direct' }],
      )?.labelId,
    ).toBe('lbl_direct');
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_lookup', target_id: 'shp_2' },
        [{ id: 'lbl_lookup', shipment_id: 'shp_2', active_version_id: 'lv_active' }],
      )?.labelId,
    ).toBe('lbl_lookup');
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_manifest', target_id: 'run_2845', target_metadata: { manifest_kind: 'partner_handover' } },
        [{ id: 'lbl_wrong', shipment_id: 'run_2845', active_version_id: 'lv_wrong' }],
      ),
    ).toBeNull();
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_canonical_transfer', target_type: 'warehouse_transfer', target_id: 'wtr_1' },
        [{ id: 'lbl_wrong_transfer', shipment_id: 'wtr_1', active_version_id: 'lv_wrong_transfer' }],
      ),
    ).toBeNull();
  });

  it('does not resolve reprint targets without an active label version', () => {
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_direct_inactive', label_id: 'lbl_inactive', shipment_id: 'shp_1' },
        [{ id: 'lbl_inactive', shipment_id: 'shp_1', active_version_id: null }],
      ),
    ).toBeNull();
    expect(
      resolveLabelReprintTarget(
        { id: 'lj_lookup_inactive', target_id: 'shp_2' },
        [{ id: 'lbl_lookup_inactive', shipment_id: 'shp_2', active_version_id: null }],
      ),
    ).toBeNull();
    expect(
      labelReprintDisabledReason(
        { id: 'lj_direct_inactive', label_id: 'lbl_inactive', shipment_id: 'shp_1' },
        [{ id: 'lbl_inactive', shipment_id: 'shp_1', active_version_id: null }],
      ),
    ).toBe('Label lbl_inactive has no active version');
    expect(
      labelReprintDisabledReason(
        { id: 'lj_lookup_inactive', target_id: 'shp_2' },
        [{ id: 'lbl_lookup_inactive', shipment_id: 'shp_2', active_version_id: null }],
      ),
    ).toBe('Shipment shp_2 labels have no active version');
  });

  it('print-queue Reprint calls request_label_reprint with the resolved shipment label id', async () => {
    const spy = vi.spyOn(api, 'request_label_reprint').mockResolvedValue({
      ok: true,
      label_id: 'lbl_shp_9381247_1',
      reason: 'operator_request',
      label_job_id: 'ljob_reprint_test',
      new_version_id: null,
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_reprint_reason'
        ? [{ value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 }]
        : REAL_GET_LOOKUPS(category)
    ));
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.reprint', 'all'] });

    const jobCell = await screen.findByText('lj_8821');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /Reprint/i }));

    expect(await screen.findByTestId('reprint-composer')).toBeInTheDocument();
    expect(screen.getByText('lbl_shp_9381247_1')).toBeInTheDocument();
    const composer = within(screen.getByTestId('reprint-composer'));
    expect((composer.getByRole('combobox') as HTMLSelectElement).value).toBe('operator_request');
    const submit = composer.getByRole('button', { name: /^Reprint$/ });
    expect(submit).not.toBeDisabled();
    submit.click();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('lbl_shp_9381247_1', { reason: 'operator_request' });
    });
  });

  it('shows the backend-refreshed reprint job in the same screen after submit', async () => {
    let reprintQueued = false;
    vi.spyOn(api, 'getLookups').mockImplementation((category) => {
      if (category === 'label_reprint_reason') {
        return [{ value: 'operator_request', label: 'Operator request', is_default: true, rank: 10 }];
      }
      if (category === 'label_render_job_status') {
        return [
          { value: 'queued', label: 'Queued', is_default: true, rank: 10, metadata: { backend_values: ['pending'] } },
          { value: 'completed', label: 'Completed', is_default: false, rank: 20, metadata: { backend_values: ['succeeded'] } },
          { value: 'failed', label: 'Failed', is_default: false, rank: 30, metadata: { backend_values: ['failed'] } },
        ];
      }
      return REAL_GET_LOOKUPS(category);
    });
    vi.spyOn(api, 'request_label_reprint').mockImplementation(async () => {
      reprintQueued = true;
      return {
        ok: true,
        label_id: 'lbl_shp_9381247_1',
        reason: 'operator_request',
        label_job_id: 'lj_reprint_visible',
        new_version_id: null,
      };
    });
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'labels') {
        return Promise.resolve({
          rows: [{ id: 'lbl_shp_9381247_1', shipment_id: 'shp_9381247', active_version_id: 'lv_active' }],
          total: 1,
        });
      }
      if (resource === 'label_jobs') {
        const rows = [
          {
            id: 'lj_8821',
            label_id: 'lbl_shp_9381247_1',
            target_type: 'shipment',
            target_id: 'shp_9381247',
            source_label_version_id: 'lv_original_reprint_source',
            status: 'completed',
            queued_at: '2026-05-12T00:00:00Z',
            completed_at: '2026-05-12T00:01:00Z',
          },
          ...(reprintQueued
            ? [{
              id: 'lj_reprint_visible',
              label_id: 'lbl_shp_9381247_1',
              target_type: 'shipment',
              target_id: 'shp_9381247',
              source_label_version_id: 'lv_reprint_source_visible',
              status: 'queued',
              queued_at: '2026-05-12T00:02:00Z',
              target_metadata: { reprint_reason: 'operator_request' },
            }]
            : []),
        ];
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.reprint'] });

    expect(await screen.findByText('lj_8821')).toBeInTheDocument();
    expect(screen.queryByText('lj_reprint_visible')).not.toBeInTheDocument();
    const jobRow = screen.getByText('lj_8821').closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /Reprint/i }));
    await user.click(within(await screen.findByTestId('reprint-composer')).getByRole('button', { name: /^Reprint$/ }));

    const reprintJobCell = await screen.findByText('lj_reprint_visible');
    expect(reprintJobCell).toBeInTheDocument();
    const reprintJobRow = reprintJobCell.closest('tr');
    expect(reprintJobRow).toBeTruthy();
    expect(within(reprintJobRow as HTMLElement).getByText('queued')).toBeInTheDocument();
    expect(within(reprintJobRow as HTMLElement).getByText('Source version lv_reprint_source_visible')).toBeInTheDocument();
  });

  it('label open action opens the completed label URL', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const clipboardWriteSpy = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteSpy },
    });
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1').mockResolvedValue({
      ok: true,
      url: '/signed/labels/shp_9381247-1.pdf',
      expires_at: '2026-05-12T00:15:00Z',
    });
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const latestCard = await screen.findByTestId('label-print-handoff-latest-job');
    await waitFor(() => expect(latestCard).toHaveTextContent(/Latest completed label/));

    const jobCell = await screen.findByText('lj_8821');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /Open label/i }));

    await waitFor(() => {
      expect(resolverSpy).toHaveBeenCalledWith({
        resource: 'label_jobs',
        id: 'lj_8821',
        expires_seconds: 900,
      });
    });
    expect(openSpy).toHaveBeenCalledWith('/signed/labels/shp_9381247-1.pdf', '_blank', 'noopener,noreferrer');
    const handoff = await screen.findByTestId('label-download-handoff-readback');
    expect(handoff).toHaveAttribute('data-handoff-resource', 'label_jobs');
    expect(handoff).toHaveTextContent('Status ready');
    expect(handoff).toHaveTextContent('Print request');
    expect(handoff).toHaveTextContent('Reference lj_8821');
    expect(handoff).toHaveTextContent('Secure link ready');
    expect(handoff).toHaveTextContent('Pop-up blocked');
    expect(clipboardWriteSpy).not.toHaveBeenCalled();
  });

  it('opens the latest completed label from the visible print-queue handoff card', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1').mockResolvedValue({
      ok: true,
      url: '/signed/labels/shp_9381247-1.pdf',
      expires_at: '2026-05-12T00:15:00Z',
    });
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const latestCard = await screen.findByTestId('label-print-handoff-latest-job');
    await user.click(within(latestCard).getByRole('button', { name: /Open label/i }));

    await waitFor(() => {
      expect(resolverSpy).toHaveBeenCalledWith({
        resource: 'label_jobs',
        id: 'lj_8818',
        expires_seconds: 900,
      });
    });
    expect(openSpy).toHaveBeenCalledWith('/signed/labels/shp_9381247-1.pdf', '_blank', 'noopener,noreferrer');
    const handoff = await screen.findByTestId('label-download-handoff-readback');
    expect(handoff).toHaveAttribute('data-handoff-resource', 'label_jobs');
    expect(handoff).toHaveTextContent('Print request');
    expect(handoff).toHaveTextContent('Reference lj_8818');
    expect(handoff).toHaveTextContent('Print request lj_8818');
  });

  it('shows failed print-queue handoff readback when the signed URL resolver fails', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1').mockRejectedValue(
      new Error('signed URL denied'),
    );
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const latestCard = await screen.findByTestId('label-print-handoff-latest-job');
    await user.click(within(latestCard).getByRole('button', { name: /Open label/i }));

    const handoff = await screen.findByTestId('label-download-handoff-readback');
    await waitFor(() => {
      expect(handoff).toHaveTextContent('Status failed');
    });
    expect(handoff).toHaveAttribute('data-handoff-resource', 'label_jobs');
    expect(handoff).toHaveTextContent('Print request');
    expect(handoff).toHaveTextContent('Secure download could not be prepared. Check access or try again.');
    expect(resolverSpy).toHaveBeenCalledWith({
      resource: 'label_jobs',
      id: 'lj_8818',
      expires_seconds: 900,
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('gates label download when the operator lacks labels.download', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1');
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    const jobCell = await screen.findByText('lj_8821');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    const option = await screen.findByRole('option', { name: /Open label/i });

    expect(option).toHaveClass('is-disabled');
    fireEvent.click(option);
    expect(resolverSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('label-download-handoff-readback')).not.toBeInTheDocument();
  });

  it('renders readable print-queue target lineage instead of raw metadata blobs', async () => {
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    await screen.findByText('lj_8821');
    expect(screen.getAllByText('Shipment shp_9381247').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Box 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Route run run_2845').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Partner Handover/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/manifest_kind=partner_handover/i)).toBeNull();
    expect(screen.getAllByText('Warehouse transfer wtr_2026_0481').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Transfer Summary/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/manifest_kind=transfer_summary/i)).toBeNull();
  });

  it('surfaces retrying label failures with readable reason and attempts in the print queue', async () => {
    mockLabelRenderStatusLookups();
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [{
            id: 'lj_retry_failed',
            target_type: 'shipment',
            target_id: 'shp_retry_failed',
            status: 'pending',
            error_reason: 'render_failure',
            attempts: 1,
            max_attempts: 5,
            scheduled_at: '2026-05-24T09:30:00Z',
            updated_at: '2026-05-24T09:25:00Z',
            renderer_metadata: {
              error: {
                reason: 'render_failure',
                message: 'Unable to resolve shipment-box barcode for label job lj_retry_failed',
              },
            },
          }],
          total: 1,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    const failureCard = await screen.findByTestId('label-print-failure-readback');
    expect(failureCard).toHaveAttribute('data-label-job-id', 'lj_retry_failed');
    expect(failureCard).toHaveAttribute('data-label-job-status', 'pending');
    await waitFor(() => {
      expect(failureCard).toHaveTextContent(/Latest label failure/);
      expect(failureCard).toHaveTextContent(/Print request\s+lj_retry_failed/);
      expect(failureCard).toHaveTextContent(/Status\s+pending/);
      expect(failureCard).toHaveTextContent(/Attempts\s+1\/5/);
      expect(failureCard).toHaveTextContent(/Unable to resolve shipment-box barcode for print request lj_retry_failed/);
    });

    const jobRow = screen.getByText('lj_retry_failed').closest('tr');
    expect(jobRow).toBeTruthy();
    expect(within(jobRow as HTMLElement).getByText(
      'Unable to resolve shipment-box barcode for print request lj_retry_failed',
    )).toBeInTheDocument();

    await user.click(screen.getByTestId('labels-status-failed'));
    expect(screen.getByText('lj_retry_failed')).toBeInTheDocument();
    expect(screen.getByTestId('label-print-failure-readback')).toHaveTextContent(/Print request\s+lj_retry_failed/);
  });

  it('disables queued labels until backend completion and a download URL exist', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const jobCell = await screen.findByText('lj_8819');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    const option = await screen.findByRole('option', { name: /Open label/i });

    expect(option).toHaveClass('is-disabled');
    expect(option).toHaveTextContent('Saved label is not completed or missing its download link');
    fireEvent.click(option);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not expose completed print-job handoff actions until backend label URLs are present', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [{
            id: 'lj_completed_without_url',
            label_id: 'lbl_without_url',
            target_type: 'shipment',
            target_id: 'shp_without_url',
            status: 'completed',
            completed_at: '2026-05-12T00:01:00Z',
            output_file_url: null,
            file_url: null,
          }],
          total: 1,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const resolverSpy = vi.spyOn(api, 'resolve_resource_download_url_v1');
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const jobCell = await screen.findByText('lj_completed_without_url');
    expect(screen.queryByTestId('label-print-handoff-latest-job')).not.toBeInTheDocument();
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    const option = await screen.findByRole('option', { name: /Open label/i });

    expect(option).toHaveClass('is-disabled');
    expect(option).toHaveTextContent('Saved label is not completed or missing its download link');
    fireEvent.click(option);
    expect(resolverSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('uses the newest completed label by backend completion time', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [
            {
              id: 'lj_older_completed_url',
              label_id: 'lbl_older_url',
              target_type: 'shipment',
              target_id: 'shp_older_url',
              status: 'completed',
              completed_at: '2026-05-12T00:01:00Z',
              output_file_url: 'labels/older.pdf',
            },
            {
              id: 'lj_newest_completed_url',
              label_id: 'lbl_newest_url',
              target_type: 'shipment',
              target_id: 'shp_newest_url',
              status: 'completed',
              completed_at: '2026-05-13T00:01:00Z',
              output_file_url: 'labels/newest.pdf',
            },
          ],
          total: 2,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      if (resource === 'labels') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.download'] });

    const latestCard = await screen.findByTestId('label-print-handoff-latest-job');
    await waitFor(() => expect(latestCard).toHaveTextContent(/Print request\s+lj_newest_completed_url/));
    expect(latestCard).not.toHaveTextContent('Print request lj_older_completed_url');
  });

  it('disables print-queue reprint for jobs without an active shipment label', async () => {
    const spy = vi.spyOn(api, 'request_label_reprint');
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.reprint'] });

    const jobCell = await screen.findByText('lj_8819');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    const option = await screen.findByRole('option', { name: /Reprint/i });

    expect(option).toHaveClass('is-disabled');
    expect(option).toHaveTextContent('Reprint requires a shipment label target');
    fireEvent.click(option);
    expect(screen.queryByTestId('reprint-composer')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows same-context reprint blocked readback for shipment jobs without an active label', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') {
        return Promise.resolve({
          rows: [{
            id: 'lj_no_active_label',
            shipment_id: 'shp_no_active_label',
            target_type: 'shipment',
            target_id: 'shp_no_active_label',
            status: 'pending',
            updated_at: '2026-05-24T09:30:00Z',
          }],
          total: 1,
        });
      }
      if (resource === 'labels') {
        return Promise.resolve({
          rows: [{ id: 'lbl_no_active_label', shipment_id: 'shp_no_active_label', active_version_id: null }],
          total: 1,
        });
      }
      if (resource === 'label_template_directory') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.reprint'] });

    const blocked = await screen.findByTestId('label-reprint-blocked-readback');
    expect(blocked).toHaveAttribute('data-label-job-id', 'lj_no_active_label');
    expect(blocked).toHaveTextContent('Latest blocked reprint');
    await waitFor(() => expect(blocked).toHaveTextContent(/Print request\s+lj_no_active_label/));
    expect(blocked).toHaveTextContent('Shipment shp_no_active_label labels have no active version');

    const jobRow = screen.getByText('lj_no_active_label').closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('button', { name: /Row actions/ }));
    const option = await screen.findByRole('option', { name: /Reprint/i });
    expect(option).toHaveClass('is-disabled');
    expect(option).toHaveTextContent('Shipment shp_no_active_label labels have no active version');
  });

  it('disables bulk reprint when selected jobs have no active shipment label readback', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'labels.reprint'] });

    const jobCell = await screen.findByText('lj_8819');
    const jobRow = jobCell.closest('tr');
    expect(jobRow).toBeTruthy();
    await user.click(within(jobRow as HTMLElement).getByRole('checkbox'));

    const bulkReprint = screen.getByRole('button', { name: /^Reprint$/i });
    expect(bulkReprint).toBeDisabled();
    expect(bulkReprint).toHaveAttribute('title', 'Reprint requires a shipment label target');
  });

  it('shows a denied state when the operator lacks labels.read', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');

    renderWithProviders(<LabelsModule />, { capabilities: [] });

    expect(await screen.findByText('You cannot view this here')).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to view labels & templates.')).toBeInTheDocument();
    expect(screen.getByText('Labels Read permission required')).toBeInTheDocument();

    const requestedResources = listSpy.mock.calls.map(([resource]) => resource);
    expect(requestedResources).not.toContain('label_jobs');
    expect(requestedResources).not.toContain('labels');
    expect(requestedResources).not.toContain('label_template_directory');
    expect(requestedResources).not.toContain('lookup_values');
  });

  it('permission-gates label design write actions without firing draft RPC mutations', async () => {
    const createSpy = vi.spyOn(api, 'label_designer_create_draft');
    const updateSpy = vi.spyOn(api, 'label_designer_update_draft');
    const validateSpy = vi.spyOn(api, 'label_designer_validate_label_design_draft');
    const publishSpy = vi.spyOn(api, 'label_designer_publish_label_design_draft');
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read', 'label_design.read'] });

    const newDesignButton = await screen.findByRole('button', { name: /New active label design/i });
    const openDesignerButton = await screen.findByRole('button', { name: /Open Label Designer/i });
    expect(newDesignButton).toBeDisabled();
    await waitFor(() => expect(openDesignerButton).not.toBeDisabled());
    await user.click(newDesignButton);
    await user.click(openDesignerButton);
    expect(await screen.findByTestId('label-design-composer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Text$/i })).toBeDisabled();
    expect(screen.getByTestId('label-design-shared-save-draft')).toBeDisabled();
    expect(screen.getByTestId('label-design-shared-publish-draft')).toBeDisabled();
    expect(screen.getByTestId('label-design-shared-preview-preview')).toBeDisabled();

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('shows an actionable print queue error when label_jobs readback fails', async () => {
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'label_jobs') return Promise.reject(new Error('RLS denied label_jobs'));
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });

    renderWithProviders(<LabelsModule />, { capabilities: ['labels.read'] });

    expect(await screen.findByText('Print queue did not load')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.body).toHaveTextContent('The print queue could not be loaded');
    });
    expect(screen.queryByText('RLS denied label_jobs')).toBeNull();
  });

  it('publishes a tenant label design through the canonical label designer draft RPCs', async () => {
    let published = false;
    const publishedDraft = {
      id: 'draft_label_design_1',
      organization_id: 'org_label_designer',
      scope_type: 'tenant' as const,
      scope_id: 'org_label_designer',
      label_type: 'shipping',
      draft_name: 'shipping active design',
      draft_value: {
        templates: {
          shipping: {
            page: {},
            blocks: [{ section_key: 'operator_block_1', value_path: 'tracking_number' }],
          },
        },
      },
      status: 'published' as const,
      created_at: '2026-05-06T00:00:00Z',
      updated_at: '2026-05-06T00:01:00Z',
      published_settings_version_id: 'sv_label_design_1',
      published_at: '2026-05-06T00:01:00Z',
    };
    vi.spyOn(api, 'label_designer_list_drafts').mockImplementation(async () => ({
      ok: true,
      drafts: published ? [publishedDraft] : [],
    }));
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const createSpy = vi.spyOn(api, 'label_designer_create_draft').mockResolvedValue({
      ok: true,
      draft: {
        id: 'draft_label_design_1',
        organization_id: 'org_label_designer',
        scope_type: 'tenant',
        scope_id: 'org_label_designer',
        label_type: 'shipping',
        draft_name: 'shipping active design',
        draft_value: publishedDraft.draft_value,
        status: 'draft',
        created_at: '2026-05-06T00:00:00Z',
        updated_at: '2026-05-06T00:00:00Z',
      },
    });
    const validateSpy = vi.spyOn(api, 'label_designer_validate_label_design_draft').mockResolvedValue({
      ok: true,
      errors: [],
    });
    const publishSpy = vi.spyOn(api, 'label_designer_publish_label_design_draft').mockImplementation(async () => {
      published = true;
      return {
      ok: true,
      settings_version_id: 'sv_label_design_1',
      scope_type: 'tenant',
      scope_id: 'org_label_designer',
      schema_version: 1,
      version: 1,
      };
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composerNode = await screen.findByTestId('label-design-composer');
    const composer = within(composerNode);
    expect(composer.getByLabelText('Label type')).toHaveValue('shipping');
    expect(composer.getByRole('option', { name: 'Shipping' })).toBeInTheDocument();
    expect(composer.getByRole('option', { name: 'Route' })).toBeInTheDocument();
    const draftValue = await readSharedDesignerJson(user);
    expect(draftValue.templates.shipping.label_type).toBe('shipping');
    expect(draftValue.templates.shipping.blocks).toEqual([]);
    expect(composer.getByTestId('label-design-visual-editor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Publish active design/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        scope_type: 'tenant',
        scope_id: 'org_label_designer',
        label_type: 'shipping',
      }));
    });
    await waitFor(() => {
      expect(validateSpy).toHaveBeenCalledWith('draft_label_design_1');
    });
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith(
        'draft_label_design_1',
        'Activate tenant label design from Console V2',
        { scopeType: 'tenant', scopeId: 'org_label_designer' },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('label-design-composer')).toBeInTheDocument();
      expect(screen.getByTestId('label-design-save-readback')).toHaveTextContent('Status published');
      expect(screen.getByTestId('label-design-save-readback')).toHaveTextContent('Settings sv_label_design_1');
    });
    expect(await screen.findByText('shipping active design')).toBeInTheDocument();
    expect(screen.getAllByText('Settings sv_label_design_1').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Blocks 1 - Assets 0 - Sample field tracking_number')).toBeInTheDocument();
  });

  it('publishes label designs to a selected sender scope so scoped shipment overrides are operator-visible', async () => {
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'clients') {
        return Promise.resolve({
          rows: [{
            id: 'client_label_scope_1',
            organization_id: 'org_label_designer',
            name: 'Label Scope Client',
            status: 'active',
          }],
          total: 1,
        });
      }
      if (resource === 'sender_summary') {
        return Promise.resolve({
          rows: [{
            sender_id: 'sender_label_scope_1',
            sender_name: 'Label Scope Sender',
            client_id: 'client_label_scope_1',
            client_label: 'Label Scope Client',
            organization_id_resolved: 'org_label_designer',
            sender_status: 'active',
          }],
          total: 1,
        });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const createSpy = vi.spyOn(api, 'label_designer_create_draft').mockResolvedValue({
      ok: true,
      draft: {
        id: 'draft_sender_label_design_1',
        organization_id: 'org_label_designer',
        scope_type: 'sender',
        scope_id: 'sender_label_scope_1',
        label_type: 'shipping',
        draft_name: 'shipping active design',
        draft_value: { templates: { shipping: { page: {}, blocks: [] } } },
        status: 'draft',
        created_at: '2026-05-23T00:00:00Z',
        updated_at: '2026-05-23T00:00:00Z',
      },
    });
    vi.spyOn(api, 'label_designer_validate_label_design_draft').mockResolvedValue({
      ok: true,
      errors: [],
    });
    const publishSpy = vi.spyOn(api, 'label_designer_publish_label_design_draft').mockResolvedValue({
      ok: true,
      settings_version_id: 'sv_sender_label_design_1',
      scope_type: 'sender',
      scope_id: 'sender_label_scope_1',
      schema_version: 1,
      version: 1,
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    const workbench = await screen.findByTestId('label-designer-workbench');
    const publishScope = within(workbench).getByLabelText(/Design publish scope/i);
    await waitFor(() => expect(publishScope).not.toBeDisabled());
    await user.selectOptions(publishScope, 'sender');
    await waitFor(() => {
      expect(within(workbench).getAllByText(/sender: Label Scope Sender/i).length).toBeGreaterThanOrEqual(1);
    });
    await openLabelDesignComposer(user);
    expect(await screen.findByText(/for sender: Label Scope Sender/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Publish active design/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        scope_type: 'sender',
        scope_id: 'sender_label_scope_1',
        label_type: 'shipping',
      }));
    });
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith(
        'draft_sender_label_design_1',
        'Activate sender label design from Console V2',
        { scopeType: 'sender', scopeId: 'sender_label_scope_1' },
      );
    });
  });

  it('shows the backend-published label design in place after publish without a reload', async () => {
    const drafts: api.LabelDesignDraft[] = [];
    const assets: api.LabelDesignerAsset[] = [];
    let effectiveConfigPublished = false;
    vi.spyOn(api, 'label_designer_list_drafts').mockImplementation(async () => ({
      ok: true,
      drafts: [...drafts],
    }));
    vi.spyOn(api, 'label_designer_list_assets').mockImplementation(async () => ({
      ok: true,
      assets: [...assets],
    }));
    vi.spyOn(api, 'label_designer_get_effective_label_design').mockImplementation(async () => ({
      ok: true,
      value: effectiveConfigPublished
        ? {
          source: 'published-label-design',
          settings_version_id: 'sv_label_design_live_visible',
          templates: {
            shipping: {
              blocks: (drafts[0]?.draft_value.templates as Record<string, { blocks?: unknown[] }> | undefined)?.shipping?.blocks ?? [],
              assets: (drafts[0]?.draft_value.templates as Record<string, { assets?: unknown[] }> | undefined)?.shipping?.assets ?? [],
            },
          },
        }
        : { source: 'initial-label-design', templates: { shipping: { blocks: [] } } },
    }));
    vi.spyOn(api, 'label_designer_get_effective_label_render_policy').mockResolvedValue({
      ok: true,
      value: { renderer: 'policy-readback' },
    });
    vi.spyOn(api, 'label_designer_get_effective_label_print_profile').mockResolvedValue({
      ok: true,
      value: { media: '4x6' },
    });
    vi.spyOn(api, 'label_designer_get_label_media_catalog').mockResolvedValue({
      ok: true,
      value: { media: ['thermal'] },
    });
    vi.spyOn(api, 'label_designer_upload_asset').mockImplementation(async (args) => {
      const path = `org_label_designer/designer/${args.file_name}`;
      assets.unshift({ name: args.file_name.replace(/\.[^.]+$/, ''), path, content_type: args.content_type });
      return { ok: true, path };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    vi.spyOn(api, 'label_designer_create_draft').mockImplementation(async (args) => {
      const draft: api.LabelDesignDraft = {
        id: 'draft_label_design_live_visible',
        organization_id: 'org_label_designer',
        scope_type: args.scope_type,
        scope_id: args.scope_id ?? 'org_label_designer',
        label_type: args.label_type ?? 'shipping',
        draft_name: args.draft_name ?? 'shipping active design',
        draft_value: args.draft_value,
        status: 'draft',
        created_at: '2026-05-16T00:00:00Z',
        updated_at: '2026-05-16T00:00:00Z',
      };
      drafts.push(draft);
      return { ok: true, draft };
    });
    vi.spyOn(api, 'label_designer_validate_label_design_draft').mockResolvedValue({
      ok: true,
      errors: [],
    });
    vi.spyOn(api, 'label_designer_publish_label_design_draft').mockImplementation(async () => {
      const draft = drafts.find((row) => row.id === 'draft_label_design_live_visible');
      if (draft) {
        draft.status = 'published';
        draft.published_settings_version_id = 'sv_label_design_live_visible';
        draft.published_at = '2026-05-16T00:00:01Z';
        draft.updated_at = '2026-05-16T00:00:01Z';
      }
      effectiveConfigPublished = true;
      return {
        ok: true,
        settings_version_id: 'sv_label_design_live_visible',
        scope_type: 'tenant',
        scope_id: 'org_label_designer',
        schema_version: 1,
        version: 1,
      };
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    const draftNameInput = composer.getByTestId('label-design-shared-draft-name');
    fireEvent.change(draftNameInput, {
      target: { value: 'Visible label design' },
    });
    await user.click(composer.getByRole('button', { name: /recipient_name/i }));
    const logo = new File(['tiny-png'], 'browser-logo.png', { type: 'image/png' });
    await user.upload(composer.getByLabelText(/Upload label asset/i), logo);
    await waitFor(() => {
      expect(composer.getByText(/1 designer asset available/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-status', 'confirmed');
    });
    expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute(
      'data-asset-path',
      'org_label_designer/designer/browser-logo.png',
    );
    const designJsonTextarea = await openSharedDesignerCodeTab(user);
    await waitFor(() => {
      const designJson = JSON.parse(designJsonTextarea.value);
      expect(designJson.templates.shipping.blocks[0].value_path).toBe('recipient_name');
      expect(designJson.templates.shipping.assets[0].path).toBe('org_label_designer/designer/browser-logo.png');
      expect(designJson.templates.shipping.blocks.some((block: Record<string, unknown>) =>
        block.type === 'image' && block.asset_ref === 'browser-logo' && block.value_path === 'browser-logo',
      )).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: /Publish active design/i }));

    await waitFor(() => {
      const readbackCard = screen.getByTestId('label-design-draft-draft_label_design_live_visible');
      expect(within(readbackCard).getByText('Visible label design')).toBeInTheDocument();
      expect(within(readbackCard).getByText('published')).toBeInTheDocument();
      expect(within(readbackCard).getByText('Settings sv_label_design_live_visible')).toBeInTheDocument();
      expect(within(readbackCard).getByText(/Blocks 2 - Assets 1 - Sample field recipient_name/)).toBeInTheDocument();
      expect(within(readbackCard).getByLabelText('Label design draft preview Visible label design')).toBeInTheDocument();
      expect(screen.getByTestId('label-design-composer')).toBeInTheDocument();
      expect(screen.getByTestId('label-design-save-readback')).toHaveTextContent('Status published');
      expect(screen.getByTestId('label-design-save-readback')).toHaveTextContent('Settings sv_label_design_live_visible');
    });
    await waitFor(() => {
      const effectiveReadback = (screen.getByLabelText('Effective label design') as HTMLTextAreaElement).value;
      expect(effectiveReadback).toContain('published-label-design');
      expect(effectiveReadback).toContain('sv_label_design_live_visible');
      expect(effectiveReadback).toContain('recipient_name');
      expect(effectiveReadback).toContain('browser-logo');
    });
  });

  it('imports a pasted image asset through the backend asset path without a reload', async () => {
    const assets: api.LabelDesignerAsset[] = [];
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'label_designer_list_assets').mockImplementation(async () => ({
      ok: true,
      assets: [...assets],
    }));
    const uploadSpy = vi.spyOn(api, 'label_designer_upload_asset').mockImplementation(async (args) => {
      const path = `org_label_designer/designer/${args.file_name}`;
      assets.unshift({ name: args.file_name.replace(/\.[^.]+$/, ''), path, content_type: args.content_type });
      return { ok: true, path };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    await user.clear(composer.getByLabelText(/Pasted image file name/i));
    await user.type(composer.getByLabelText(/Pasted image file name/i), 'pasted-logo.png');
    fireEvent.change(composer.getByLabelText(/Pasted image data URL/i), {
      target: {
        value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PkS9GQAAAABJRU5ErkJggg==',
      },
    });
    await user.click(composer.getByRole('button', { name: /Import pasted asset/i }));

    await waitFor(() => {
      expect(composer.getByText(/1 designer asset available/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-action', 'uploaded');
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-status', 'confirmed');
    });
    expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({
      file_name: 'pasted-logo.png',
      content_type: 'image/png',
      file_base64: expect.stringContaining('data:image/png;base64,'),
    }));
    const pastedDesignJsonTextarea = await openSharedDesignerCodeTab(user);
    await waitFor(() => {
      const designJson = JSON.parse(pastedDesignJsonTextarea.value);
      expect(designJson.templates.shipping.assets[0].path).toBe('org_label_designer/designer/pasted-logo.png');
      expect(designJson.templates.shipping.blocks.some((block: Record<string, unknown>) =>
        block.type === 'image' && block.asset_ref === 'pasted-logo' && block.value_path === 'pasted-logo',
      )).toBe(true);
    });
  });

  it('deletes a designer image asset and clears same-composer design references without a reload', async () => {
    const assets: api.LabelDesignerAsset[] = [];
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'label_designer_list_assets').mockImplementation(async () => ({
      ok: true,
      assets: [...assets],
    }));
    vi.spyOn(api, 'label_designer_upload_asset').mockImplementation(async (args) => {
      const path = `org_label_designer/designer/${args.file_name}`;
      assets.unshift({ name: args.file_name.replace(/\.[^.]+$/, ''), path, content_type: args.content_type });
      return { ok: true, path };
    });
    const deleteSpy = vi.spyOn(api, 'label_designer_delete_asset').mockImplementation(async (path) => {
      const index = assets.findIndex((asset) => asset.path === path);
      if (index >= 0) assets.splice(index, 1);
      return { ok: true, path };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    await user.clear(composer.getByLabelText(/Pasted image file name/i));
    await user.type(composer.getByLabelText(/Pasted image file name/i), 'removable-logo.png');
    fireEvent.change(composer.getByLabelText(/Pasted image data URL/i), {
      target: {
        value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PkS9GQAAAABJRU5ErkJggg==',
      },
    });
    await user.click(composer.getByRole('button', { name: /Import pasted asset/i }));

    await waitFor(() => {
      expect(composer.getByText(/1 designer asset available/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(composer.getByLabelText(/Pasted image file name/i)).toHaveValue('');
    });
    const removableDesignJsonTextarea = await openSharedDesignerCodeTab(user);
    await waitFor(() => {
      const designJson = JSON.parse(removableDesignJsonTextarea.value);
      expect(designJson.templates.shipping.assets[0].path).toBe('org_label_designer/designer/removable-logo.png');
      expect(designJson.templates.shipping.blocks.some((block: Record<string, unknown>) =>
        block.type === 'image' && block.asset_ref === 'removable-logo',
      )).toBe(true);
    });

    await user.click(composer.getByRole('button', { name: /Delete removable-logo/i }));

    await waitFor(() => {
      expect(composer.getByText(/0 designer assets available/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-action', 'deleted');
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-status', 'confirmed');
    });
    expect(deleteSpy).toHaveBeenCalledWith('org_label_designer/designer/removable-logo.png');
    expect(composer.queryByRole('button', { name: 'removable-logo' })).toBeNull();
    await waitFor(() => {
      const designJson = JSON.parse(removableDesignJsonTextarea.value);
      expect(designJson.templates.shipping.assets).toHaveLength(0);
      expect(designJson.templates.shipping.blocks).toHaveLength(0);
    });
  });

  it('uploads a dropped image asset through the backend asset path without a reload', async () => {
    const assets: api.LabelDesignerAsset[] = [];
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'label_designer_list_assets').mockImplementation(async () => ({
      ok: true,
      assets: [...assets],
    }));
    const uploadSpy = vi.spyOn(api, 'label_designer_upload_asset').mockImplementation(async (args) => {
      const path = `org_label_designer/designer/${args.file_name}`;
      assets.unshift({ name: args.file_name.replace(/\.[^.]+$/, ''), path, content_type: args.content_type });
      return { ok: true, path };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    const dropzone = composer.getByTestId('label-designer-asset-dropzone');
    expect(dropzone).toHaveTextContent('Drop image asset');

    const logo = new File(['tiny-png'], 'dropped-logo.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [logo] } });

    await waitFor(() => {
      expect(composer.getByText(/1 designer asset available/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-action', 'uploaded');
      expect(composer.getByTestId('label-designer-asset-readback')).toHaveAttribute('data-readback-status', 'confirmed');
    });
    expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({
      file_name: 'dropped-logo.png',
      content_type: 'image/png',
      file_base64: expect.stringContaining('data:image/png;base64,'),
    }));
    const droppedDesignJsonTextarea = await openSharedDesignerCodeTab(user);
    await waitFor(() => {
      const designJson = JSON.parse(droppedDesignJsonTextarea.value);
      expect(designJson.templates.shipping.assets[0].path).toBe('org_label_designer/designer/dropped-logo.png');
      expect(designJson.templates.shipping.blocks.some((block: Record<string, unknown>) =>
        block.type === 'image' && block.asset_ref === 'dropped-logo' && block.value_path === 'dropped-logo',
      )).toBe(true);
    });
  });

  it('saves and edits a label design draft with same-page confirmation', async () => {
    const drafts: api.LabelDesignDraft[] = [];
    vi.spyOn(api, 'label_designer_list_drafts').mockImplementation(async () => ({
      ok: true,
      drafts: [...drafts],
    }));
    const createSpy = vi.spyOn(api, 'label_designer_create_draft').mockImplementation(async (args) => {
      const draft: api.LabelDesignDraft = {
        id: 'draft_label_design_saved_1',
        organization_id: 'org_label_designer',
        scope_type: args.scope_type,
        scope_id: args.scope_id,
        label_type: args.label_type ?? 'shipping',
        draft_name: args.draft_name ?? null,
        draft_value: args.draft_value,
        status: 'draft',
        created_at: '2026-05-23T20:00:00Z',
        updated_at: '2026-05-23T20:00:00Z',
        published_settings_version_id: null,
        published_at: null,
      };
      drafts.unshift(draft);
      return { ok: true, draft };
    });
    const updateSpy = vi.spyOn(api, 'label_designer_update_draft').mockImplementation(async (args) => {
      const index = drafts.findIndex((row) => row.id === args.draft_id);
      const draft = drafts[index];
      if (!draft) return { ok: false, error: { code: 'draft_not_found', message: 'Draft not found' } };
      const updated: api.LabelDesignDraft = {
        ...draft,
        label_type: args.label_type ?? draft.label_type,
        draft_name: args.draft_name ?? draft.draft_name,
        draft_value: args.draft_value ?? draft.draft_value,
        updated_at: '2026-05-23T20:01:00Z',
      };
      drafts[index] = updated;
      return { ok: true, draft: updated };
    });
    const archiveSpy = vi.spyOn(api, 'label_designer_archive_draft').mockImplementation(async (args) => {
      const index = drafts.findIndex((row) => row.id === args.draft_id);
      const draft = drafts[index];
      if (!draft) return { ok: false, error: { code: 'draft_not_found', message: 'Draft not found' } };
      const archived: api.LabelDesignDraft = {
        ...draft,
        status: 'archived',
        archived_at: '2026-05-27T19:15:00Z',
        archived_by: 'usr_label_designer',
        archive_reason: args.archive_reason ?? null,
        updated_at: '2026-05-27T19:15:00Z',
      };
      drafts[index] = archived;
      return { ok: true, draft: archived };
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    let composer = within(await screen.findByTestId('label-design-composer'));
    await user.clear(composer.getByLabelText(/Draft name/i));
    await user.type(composer.getByLabelText(/Draft name/i), 'Saved label draft');
    await user.click(composer.getByRole('button', { name: /recipient_name/i }));
    await user.click(composer.getByRole('button', { name: /Save draft/i }));

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      scope_type: 'tenant',
      scope_id: 'org_label_designer',
      draft_name: 'Saved label draft',
    }));
    const readbackCard = await screen.findByTestId('label-design-draft-draft_label_design_saved_1');
    expect(within(readbackCard).getByText('Saved label draft')).toBeInTheDocument();
    expect(within(readbackCard).getByText('draft')).toBeInTheDocument();
    expect(within(readbackCard).getByText(/Blocks 1 - Assets 0 - Sample field recipient_name/)).toBeInTheDocument();
    await waitFor(() => {
      expect(composer.getByTestId('label-design-save-readback')).toHaveTextContent('Draft draft_label_design_saved_1');
    });

    await user.click(screen.getByRole('button', { name: /Close designer/i }));
    await user.click(within(readbackCard).getByRole('button', { name: /Edit draft/i }));
    composer = within(await screen.findByTestId('label-design-composer'));
    expect(composer.getByLabelText(/Draft name/i)).toHaveValue('Saved label draft');
    await user.clear(composer.getByLabelText(/Draft name/i));
    await user.type(composer.getByLabelText(/Draft name/i), 'Saved label draft updated');
    await user.click(composer.getByRole('button', { name: /Save draft/i }));

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      draft_id: 'draft_label_design_saved_1',
      draft_name: 'Saved label draft updated',
      scopeType: 'tenant',
      scopeId: 'org_label_designer',
    }));
    await waitFor(() => {
      expect(within(readbackCard).getByText('Saved label draft updated')).toBeInTheDocument();
    });

    await user.click(within(readbackCard).getByRole('button', { name: /Archive draft/i }));
    expect(archiveSpy).toHaveBeenCalledWith(expect.objectContaining({
      draft_id: 'draft_label_design_saved_1',
      scopeType: 'tenant',
      scopeId: 'org_label_designer',
    }));
    await waitFor(() => {
      expect(within(readbackCard).getByText('archived')).toBeInTheDocument();
    });
    expect(within(readbackCard).getByText(/Archived/)).toHaveTextContent('Saved label draft updated');
    expect(within(readbackCard).queryByRole('button', { name: /Edit draft/i })).not.toBeInTheDocument();
    expect(within(readbackCard).queryByRole('button', { name: /Archive draft/i })).not.toBeInTheDocument();
  }, 30000);

  it('loads shipment sample payload and renderer preview from the visible designer without leaving context', async () => {
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'label_designer_get_effective_label_design').mockResolvedValue({
      ok: true,
      value: { templates: { shipping: { source: 'effective-design' } } },
    });
    vi.spyOn(api, 'label_designer_get_effective_label_render_policy').mockResolvedValue({
      ok: true,
      value: { renderer: 'policy-readback' },
    });
    vi.spyOn(api, 'label_designer_get_effective_label_print_profile').mockResolvedValue({
      ok: true,
      value: { media: '4x6' },
    });
    vi.spyOn(api, 'label_designer_get_label_media_catalog').mockResolvedValue({
      ok: true,
      value: { paper: ['thermal'] },
    });
    const sampleSpy = vi.spyOn(api, 'label_designer_get_sample_payload').mockResolvedValue({
      ok: true,
      payload: { shipment_id: 'shp_preview_1', tracking_number: 'TRK-PREVIEW-1' },
    });
    const previewSpy = vi.spyOn(api, 'label_designer_preview_label_design_draft').mockResolvedValue({
      ok: true,
      pdf_base64: 'JVBERi0xLjQ=',
      renderer_metadata: { preview: true, pages: 1 },
      validation: { ok: true, errors: [] },
    });
    vi.spyOn(api, 'label_designer_create_draft').mockImplementation(async (args) => ({
      ok: true,
      draft: {
        id: 'draft_preview_1',
        organization_id: 'org_label_designer',
        scope_type: args.scope_type,
        scope_id: args.scope_id,
        label_type: args.label_type ?? 'shipping',
        draft_name: args.draft_name ?? null,
        draft_value: args.draft_value,
        status: 'draft',
        created_at: '2026-05-23T21:00:00Z',
        updated_at: '2026-05-23T21:00:00Z',
        published_settings_version_id: null,
        published_at: null,
      },
    }));
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') {
        const rows = labelTypeRows().map((row) => ({
          ...row,
          category: 'label_type',
          sort_order: row.rank,
          status: 'active',
        }));
        return Promise.resolve({ rows, total: rows.length });
      }
      if (resource === 'shipment_directory') {
        return Promise.resolve({
          rows: [{
            id: 'shp_preview_1',
            tracking_number: 'TRK-PREVIEW-1',
            recipient_label: 'Preview Recipient',
            destination_city: 'Riyadh',
            status: 'ready',
          }],
          total: 1,
        });
      }
      if (resource === 'shipment_boxes') {
        expect(opts?.filter).toEqual({ shipment_id: 'shp_preview_1' });
        return Promise.resolve({
          rows: [{ id: 'box_preview_1', shipment_id: 'shp_preview_1', box_number: 1, barcode_value: 'BOX-PREVIEW-1' }],
          total: 1,
        });
      }
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    const previewWorkbench = await screen.findByTestId('label-design-preview-workbench');
    expect(within(previewWorkbench).getByLabelText('Shipment')).toHaveValue('shp_preview_1');
    expect(within(previewWorkbench).getByTestId('label-design-shared-preview-pdf-unavailable')).toHaveTextContent('Run preview to render PDF');
    await waitFor(() => {
      expect((within(previewWorkbench).getByLabelText('Effective label design') as HTMLTextAreaElement).value).toContain('effective-design');
      expect((within(previewWorkbench).getByLabelText('Effective render policy') as HTMLTextAreaElement).value).toContain('policy-readback');
    });

    await user.click(composer.getByRole('button', { name: /Load sample payload/i }));
    await waitFor(() => {
      expect((within(previewWorkbench).getByTestId('label-design-shared-preview-sample-payload') as HTMLTextAreaElement).value).toContain('TRK-PREVIEW-1');
    });
    expect(sampleSpy).toHaveBeenCalledWith({
      shipment_id: 'shp_preview_1',
      shipment_box_id: 'box_preview_1',
    });

    await user.click(composer.getByRole('button', { name: /^Preview$/i }));
    await waitFor(() => {
      expect(within(previewWorkbench).getByTestId('label-design-shared-preview-pdf-unavailable')).toHaveTextContent('PDF preview is available in the browser');
    });
    await user.click(within(previewWorkbench).getByTestId('label-design-shared-preview-toggle-preview-details'));
    expect((within(previewWorkbench).getByTestId('label-design-shared-preview-preview-response') as HTMLTextAreaElement).value).toContain('pdf_base64');
    expect(previewSpy).toHaveBeenCalledWith(expect.objectContaining({
      draft_id: 'draft_preview_1',
      shipment_id: 'shp_preview_1',
      shipment_box_id: 'box_preview_1',
    }));
    expect(screen.getByTestId('label-design-save-readback')).toHaveTextContent('Draft draft_preview_1');
  });

  it('fails closed when the canonical label_type lookup is missing', async () => {
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    vi.spyOn(api, 'getLookups').mockImplementation((category) => (
      category === 'label_type' ? [] : REAL_GET_LOOKUPS(category)
    ));
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((resource, opts) => {
      if (resource === 'lookup_values') return Promise.resolve({ rows: [], total: 0 });
      return REAL_UI_LIST_RESOURCE(resource, opts);
    });
    const createSpy = vi.spyOn(api, 'label_designer_create_draft');
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    const composer = within(await screen.findByTestId('label-design-composer'));
    expect(await screen.findByText('Label types are not configured')).toBeInTheDocument();
    expect(composer.getByLabelText('Label type')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Publish active design/i })).toBeDisabled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('blocks invalid label design JSON before calling the backend draft RPC', async () => {
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({ ok: true, drafts: [] });
    const createSpy = vi.spyOn(api, 'label_designer_create_draft');
    const user = userEvent.setup();

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    await openLabelDesignComposer(user);
    fireEvent.change(await openSharedDesignerCodeTab(user), { target: { value: '{bad json' } });
    await user.click(screen.getByRole('button', { name: /Publish active design/i }));

    expect(await screen.findByText(/Label design action failed/i)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('shows published label design drafts for the active tenant scope', async () => {
    vi.spyOn(api, 'label_designer_list_drafts').mockResolvedValue({
      ok: true,
      drafts: [{
        id: 'draft_published_1',
        organization_id: 'org_label_designer',
        scope_type: 'tenant',
        scope_id: 'org_label_designer',
        label_type: 'shipping',
        draft_name: 'Tenant waybill',
        draft_value: {
          templates: {
            shipping: {
              page: {},
              blocks: [{ type: 'text', value_path: 'Example Entity ntvplorhukthpmnmvgrstqzp' }],
              assets: [{ asset_key: 'logo' }],
            },
          },
        },
        status: 'published',
        created_at: '2026-05-06T00:00:00Z',
        updated_at: '2026-05-06T00:00:00Z',
        published_settings_version_id: 'sv_label_design_1',
        published_at: '2026-05-06T00:01:00Z',
      }],
    });

    renderWithProviders(<LabelsModule />, { identity: labelDesignIdentity });

    expect(await screen.findByTestId('label-design-drafts-panel')).toBeInTheDocument();
    const readbackCard = await screen.findByTestId('label-design-draft-draft_published_1');
    expect(within(readbackCard).getByText('Tenant waybill')).toBeInTheDocument();
    expect(within(readbackCard).getByText('published')).toBeInTheDocument();
    expect(within(readbackCard).getByText('Settings sv_label_design_1')).toBeInTheDocument();
    expect(within(readbackCard).getByText(/Blocks 1 - Assets 1 - Sample field shipment\.recipient\.name/)).toBeInTheDocument();
  });
});
