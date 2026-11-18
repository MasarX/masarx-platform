// plugin-studio.test.tsx — covers the 4-stage authoring loop wired to the
// `integration-plugin-studio` edge function (parse|infer|preview|save).
//
// CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Wave 12 W12-2 — INTEGRATIONS P0 #3 closure).
//
// Backed by:
//   - supabase/functions/integration-plugin-studio/index.ts (edge fn SSOT)
//   - api.plugin_studio_parse_v1 / infer / preview / save (data-source seam)
//
// The tests stub `api.*` to keep them environment-agnostic (no live edge fn
// calls). Adapter-level tests in `data-source` cover the live wire-shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { PluginStudioModule } from '@/modules/integrations/plugin-studio';
import * as apiMod from '@/lib/api';

describe('PluginStudioModule (W12-2 4-stage authoring loop)', () => {
  // Vitest's strict spy typing doesn't unify with the precisely-typed adapter
  // signatures, so we erase the function shape — the assertions on `mock.calls`
  // below are still type-checked at the use site.
  let parseSpy: any;
  let inferSpy: any;
  let previewSpy: any;
  let saveSpy: any;

  beforeEach(() => {
    parseSpy = vi.spyOn(apiMod, 'plugin_studio_parse_v1');
    inferSpy = vi.spyOn(apiMod, 'plugin_studio_infer_v1');
    previewSpy = vi.spyOn(apiMod, 'plugin_studio_preview_v1');
    saveSpy = vi.spyOn(apiMod, 'plugin_studio_save_v1');
  });
  afterEach(() => {
    parseSpy.mockRestore();
    inferSpy.mockRestore();
    previewSpy.mockRestore();
    saveSpy.mockRestore();
  });

  it('mounts with stage chips, source selector, and disabled action buttons', async () => {
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText(/Source type/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Plugin kind/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Source payload/)).toBeInTheDocument();
    expect(screen.getByTestId('plugin-studio-stage-chips')).toBeInTheDocument();
    // Parse is enabled by default (no upstream dependency); Infer/Preview/Save start disabled.
    expect(screen.getByRole('button', { name: /^Parse$/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^Infer mapping$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Preview$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
  });

  it('blocks synthetic studio stages in live mode when no backend client is configured', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(false);
    try {
      renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
      expect(await screen.findByText('Hosted confirmation required')).toBeInTheDocument();
      expect(screen.getByText(/Connect the hosted integration service/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Parse$/ })).toBeDisabled();
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      seedModeSpy.mockRestore();
      backendSpy.mockRestore();
    }
  });

  it('Parse calls plugin_studio_parse_v1 with canonical args and unlocks Infer (Stage 1)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: {
        source_type: 'curl',
        plugin_kind: 'api',
        route: { method: 'POST', path_template: '/v1/orders' },
      },
      mapping_suggestion: { version: 1, fields: [{ target_field: 'external_id', source_path: '$.id' }] },
      draft: null,
      correlation_id: 'corr_parse_1',
    } as never);
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    const parseBtn = await screen.findByRole('button', { name: /^Parse$/ });
    await user.click(parseBtn);
    await waitFor(() => {
      expect(parseSpy).toHaveBeenCalled();
    });
    const args = parseSpy.mock.calls[0]?.[0] as { source_type?: string; plugin_kind?: string };
    expect(args?.source_type).toBe('curl');
    expect(args?.plugin_kind).toBe('api');
    // After Parse, Infer becomes enabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Infer mapping$/ })).not.toBeDisabled();
    });
    expect(screen.getByTestId('plugin-studio-contract')).toBeInTheDocument();
  });

  it('Infer calls plugin_studio_infer_v1 with the parsed contract (Stage 2)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_p',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [{ target_field: 'external_id', source_path: '$.id' }] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://x/' },
      ],
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      draft: null,
      correlation_id: 'corr_i',
    } as never);
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => {
      expect(parseSpy).toHaveBeenCalled();
    });
    await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => {
      expect(inferSpy).toHaveBeenCalled();
    });
    const args = inferSpy.mock.calls[0]?.[0] as { normalized_contract?: { plugin_kind?: string } };
    expect(args?.normalized_contract?.plugin_kind).toBe('api');
    // Preview becomes enabled once mapping is in hand.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Preview$/ })).not.toBeDisabled();
    });
  });

  it('Preview surfaces diagnostics + recommended save mode and unlocks Save when clean (Stage 3)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_p',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      draft: null,
      correlation_id: 'corr_i',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_pv',
    } as never);
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    const args = previewSpy.mock.calls[0]?.[0] as {
      artifact?: string;
      outbound_operations?: Array<Record<string, unknown>>;
    };
    expect(args?.artifact).toBe('integration_plugin');
    expect(args?.outbound_operations?.[0]?.url_template).toBe('https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders');
    // Recommended save mode badge shows; Save button becomes enabled with mode label.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save \(draft\)$/ })).not.toBeDisabled();
    });
    expect(screen.getByText(/Save mode: draft/)).toBeInTheDocument();
  });

  it('Save fail-closes when Preview returns blocking diagnostics (Stage 3 → blocks Stage 4)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_p',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      draft: null,
      correlation_id: 'corr_i',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [
          {
            level: 'error',
            blocking: true,
            code: 'required_field_unmapped',
            fieldPath: 'tracking_number',
            message: 'Required field tracking_number is not mapped.',
            why: 'Schema requires it.',
            recommended_fix: 'Add a mapping rule.',
          },
        ],
        review_summary: {
          blocking_count: 1,
          warning_count: 0,
          coercion_count: 0,
          next_steps: ['Add a mapping rule.'],
          egress_policy_resolution_id: null,
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_pv',
    } as never);
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    // Save remains disabled because of blocking diagnostics.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save \(draft\)$/ })).toBeDisabled();
    });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/1 blocking/)).toBeInTheDocument();
  });

  it('blocks reserved placeholder provider hosts before save (Plugin Studio API route quality gate)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: {
        source_type: 'curl',
        plugin_kind: 'api',
        metadata: { source_url: 'https://api.example.com' },
      },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_placeholder_parse',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://api.example.com/v1/orders' },
      ],
      normalized_contract: {
        source_type: 'curl',
        plugin_kind: 'api',
        metadata: { source_url: 'https://api.example.com' },
      },
      draft: null,
      correlation_id: 'corr_placeholder_infer',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: {
        source_type: 'curl',
        plugin_kind: 'api',
        metadata: { source_url: 'https://api.example.com' },
      },
      mapping_suggestion: { version: 1, fields: [] },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [
          {
            level: 'error',
            blocking: true,
            code: 'egress_placeholder_host_blocked',
            fieldPath: 'outbound_operations[0].url_template',
            message: 'Placeholder or reserved provider host is blocked (api.example.com).',
            why: 'Plugin Studio samples must be replaced before an API plugin can be saved or activated.',
            recommended_fix: "Replace the sample URL with the provider's real HTTPS endpoint.",
            source_policy: 'integration_plugin_egress_policy',
            settings_resolution_id: 'settings_placeholder_guard',
          },
        ],
        review_summary: {
          blocking_count: 1,
          warning_count: 0,
          coercion_count: 0,
          next_steps: ["Replace the sample URL with the provider's real HTTPS endpoint."],
          egress_policy_resolution_id: 'settings_placeholder_guard',
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_placeholder_preview',
    } as never);

    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());

    const previewArgs = previewSpy.mock.calls[0]?.[0] as {
      outbound_operations?: Array<Record<string, unknown>>;
    };
    expect(previewArgs?.outbound_operations?.[0]?.url_template).toBe('https://api.example.com/v1/orders');
    expect(screen.getByText(/1 blocking/)).toBeInTheDocument();
    expect(screen.getByText('Review items found')).toBeInTheDocument();
    expect(screen.queryByText(/egress_placeholder_host_blocked/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('plugin-studio-review')).queryByText(/api\.example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save \(draft\)$/ })).toBeDisabled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('Save calls plugin_studio_save_v1 with canonical args after a clean Preview (Stage 4)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_p',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      draft: null,
      correlation_id: 'corr_i',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_pv',
    } as never);
    saveSpy.mockResolvedValue({
      ok: true,
      endpoint: 'save',
      artifact: 'integration_plugin',
      save_mode: 'draft',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      result: {
        primary_resource_type: 'integration_plugin',
        plugin_id: 'plg_test_1',
        plugin_version_id: 'pv_test_1',
      },
      report: { report_id: 'rep_test_1', status: 'succeeded' },
      correlation_id: 'corr_save',
    } as never);
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'integration_plugins' && id === 'plg_test_1') {
        return { id: 'plg_test_1', name: 'Plugin Studio draft', status: 'draft' } as never;
      }
      if (resource === 'integration_plugin_directory' && id === 'plg_test_1') {
        return { id: 'plg_test_1', latest_version_status: 'draft' } as never;
      }
      return null as never;
    });
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'integration_plugin_versions') {
        return {
          rows: [{ id: 'pv_test_1', plugin_id: 'plg_test_1', status: 'draft' }],
          total: 1,
        } as never;
      }
      return { rows: [], total: 0 } as never;
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
      await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
      await waitFor(() => expect(parseSpy).toHaveBeenCalled());
      await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
      await waitFor(() => expect(inferSpy).toHaveBeenCalled());
      await user.click(await screen.findByRole('button', { name: /^Preview$/ }));
      await waitFor(() => expect(previewSpy).toHaveBeenCalled());
      await user.click(await screen.findByRole('button', { name: /^Save \(draft\)$/ }));
      await waitFor(() => expect(saveSpy).toHaveBeenCalled());
      const args = saveSpy.mock.calls[0]?.[0] as {
        artifact?: string;
        save_mode?: string;
        outbound_operations?: Array<Record<string, unknown>>;
      };
      expect(args?.artifact).toBe('integration_plugin');
      expect(args?.save_mode).toBe('draft');
      expect(args?.outbound_operations?.[0]?.url_template).toBe('https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders');
      expect(await screen.findByTestId('plugin-studio-save-readback')).toHaveTextContent('Plugin saved');
      const catalogReadback = await screen.findByTestId('plugin-studio-catalog-readback');
      expect(catalogReadback).toHaveTextContent('Catalog confirmed');
      expect(catalogReadback).toHaveTextContent('Plugin: available');
      expect(catalogReadback).toHaveTextContent('Version: available');
      expect(screen.getByRole('button', { name: /^Open saved plugin$/ })).toBeInTheDocument();
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('passes the active tenant organization_id through every Plugin Studio stage', async () => {
    const activeTenantId = 'org_first_tenant_active';
    const normalizedContract = { source_type: 'curl', plugin_kind: 'api' };
    const mappingSuggestion = { version: 1, fields: [] };
    const cleanReview = {
      mapping_config: {},
      coerced_preview: {},
      coercions: [],
      diagnostics: [],
      review_summary: {
        blocking_count: 0,
        warning_count: 0,
        coercion_count: 0,
        next_steps: [],
        egress_policy_resolution_id: null,
      },
    };

    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: normalizedContract,
      mapping_suggestion: mappingSuggestion,
      draft: null,
      correlation_id: 'corr_active_tenant_parse',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: mappingSuggestion,
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
      normalized_contract: normalizedContract,
      draft: null,
      correlation_id: 'corr_active_tenant_infer',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: normalizedContract,
      mapping_suggestion: mappingSuggestion,
      review: cleanReview,
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_active_tenant_preview',
    } as never);
    saveSpy.mockResolvedValue({
      ok: true,
      endpoint: 'save',
      artifact: 'integration_plugin',
      save_mode: 'draft',
      normalized_contract: normalizedContract,
      review: cleanReview,
      result: {
        primary_resource_type: 'integration_plugin',
        plugin_id: 'plg_active_tenant_scope',
        plugin_version_id: 'pv_active_tenant_scope',
      },
      report: { report_id: 'rep_active_tenant_scope', status: 'succeeded' },
      correlation_id: 'corr_active_tenant_save',
    } as never);

    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, {
      identity: {
        user: {
          access_scope_type: 'platform',
          organization_id: 'org_platform_home',
        },
        scope: {
          tenant: { id: activeTenantId, label: 'First Tenant Active', rank: 2 },
        },
        capabilities: ['all'],
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    await user.click(await screen.findByRole('button', { name: /^Save \(draft\)$/ }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    expect(parseSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ organization_id: activeTenantId }));
    expect(inferSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ organization_id: activeTenantId }));
    expect(previewSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ organization_id: activeTenantId }));
    expect(saveSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ organization_id: activeTenantId }));
    expect(await screen.findByTestId('plugin-studio-save-readback')).toHaveTextContent('Plugin saved');
  });

  it('redacts secret-bearing source, generated panes, and same-page save readback', async () => {
    const rawSecrets = [
      'raw-bearer-secret',
      'raw-query-secret',
      'raw-password',
      'raw-client-secret',
      'raw-contract-secret',
      'raw-mapping-secret',
      'raw-outbound-token',
      'raw-outbound-api-key',
      'raw-diagnostic-secret',
      'raw-save-token',
    ];
    const expectRedacted = (value: string | null | undefined) => {
      expect(value).toContain('REDACTED');
      rawSecrets.forEach((secret) => {
        expect(value ?? '').not.toContain(secret);
      });
    };
    const normalizedContract = {
      source_type: 'curl',
      plugin_kind: 'api',
      route: {
        method: 'POST',
        path_template: '/v1/orders',
        headers: { Authorization: 'Bearer raw-contract-secret' },
        body_sample: {
          order_id: 'ORD-1',
          password: 'raw-password',
          nested: { clientSecret: 'raw-client-secret' },
        },
      },
      metadata: { query_string: 'api_key=raw-query-secret&safe=1' },
    };
    const mappingSuggestion = {
      version: 1,
      metadata: { clientSecret: 'raw-mapping-secret' },
      fields: [],
    };
    const review = {
      mapping_config: mappingSuggestion,
      coerced_preview: {},
      coercions: [],
      diagnostics: [
        {
          level: 'warning',
          blocking: false,
          code: 'token_rotation_required',
          message: 'Rotate token=raw-diagnostic-secret before activation.',
        },
      ],
      review_summary: {
        blocking_count: 0,
        warning_count: 1,
        coercion_count: 0,
        next_steps: ['Rotate token=raw-diagnostic-secret before activation.'],
        egress_policy_resolution_id: null,
      },
    };

    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: normalizedContract,
      mapping_suggestion: mappingSuggestion,
      draft: null,
      correlation_id: 'corr_secret_parse',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: mappingSuggestion,
      outbound_suggestions: [
        {
          operation_name: 'forward_event',
          method: 'POST',
          url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?token=raw-outbound-token',
          headers_template: { 'x-api-key': 'raw-outbound-api-key' },
        },
      ],
      normalized_contract: normalizedContract,
      draft: null,
      correlation_id: 'corr_secret_infer',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: normalizedContract,
      mapping_suggestion: mappingSuggestion,
      review,
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_secret_preview',
    } as never);
    saveSpy.mockResolvedValue({
      ok: true,
      endpoint: 'save',
      artifact: 'integration_plugin',
      save_mode: 'draft',
      normalized_contract: normalizedContract,
      review,
      result: {
        primary_resource_type: 'integration_plugin',
        plugin_id: 'plg_secret_1',
        plugin_version_id: 'pv_secret_1',
      },
      report: {
        report_id: 'rep_secret_1',
        status: 'succeeded',
        result_payload: { provider_response: { refresh_token: 'raw-save-token' } },
      },
      correlation_id: 'corr_secret_save',
    } as never);

    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    fireEvent.change(await screen.findByLabelText(/Plugin name/), {
      target: { value: 'Secret redaction plugin proof' },
    });
    fireEvent.change(screen.getByLabelText(/Source payload/), {
      target: {
        value:
          'curl -X POST "https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?api_key=raw-query-secret&safe=1" -H "Authorization: Bearer raw-bearer-secret" -d \'{"order_id":"ORD-1","password":"raw-password","nested":{"clientSecret":"raw-client-secret"}}\'',
      },
    });

    await user.click(screen.getByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    const sourceAfterParse = screen.getByLabelText(/Source payload/) as HTMLTextAreaElement;
    expectRedacted(sourceAfterParse.value);
    expect(screen.getByText('Contract prepared')).toBeInTheDocument();
    expect(screen.getByText('Mapping suggestion prepared')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    expect(screen.getByText('Outbound suggestions prepared')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    expect(screen.getByText('Review items found')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Save \(draft\)$/ }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    const saveArgs = saveSpy.mock.calls[0]?.[0] as { source_payload?: unknown };
    expect(JSON.stringify(saveArgs?.source_payload)).not.toContain('raw-bearer-secret');
    expect(JSON.stringify(saveArgs?.source_payload)).not.toContain('raw-password');
    expect(screen.getByText('Save confirmation recorded')).toBeInTheDocument();
    expect(await screen.findByTestId('plugin-studio-save-readback')).toHaveTextContent('Plugin saved');
  });

  it('authors the OpenAPI document variant with same-page save readback', async () => {
    const openApiDocument = {
      openapi: '3.0.0',
      info: { title: 'MasarX OpenAPI proof', version: '1.0.0' },
      servers: [{ url: 'https://vomhkplympywspxymnstltsw.example.invalid' }],
      paths: {
        '/v1/openapi-proof-orders': {
          post: {
            summary: 'Create shipment order',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string' },
                      customer_phone: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '202': { description: 'Accepted' } },
          },
        },
      },
    };
    const normalizedContract = {
      source_type: 'openapi',
      plugin_kind: 'api',
      route: {
        method: 'POST',
        path_template: '/v1/openapi-proof-orders',
        upstream_method: 'POST',
        upstream_path_template: '/v1/openapi-proof-orders',
      },
      metadata: { server_url: 'https://vomhkplympywspxymnstltsw.example.invalid', document_kind: '3.0.0' },
    };
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: normalizedContract,
      mapping_suggestion: { version: 1, fields: [{ target_field: 'customer_phone', source_path: '$.customer_phone' }] },
      draft: null,
      correlation_id: 'corr_openapi_parse',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: { version: 1, fields: [{ target_field: 'customer_phone', source_path: '$.customer_phone' }] },
      outbound_suggestions: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://vomhkplympywspxymnstltsw.example.invalid/v1/openapi-proof-orders' },
      ],
      normalized_contract: normalizedContract,
      draft: null,
      correlation_id: 'corr_openapi_infer',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: normalizedContract,
      mapping_suggestion: { version: 1, fields: [{ target_field: 'customer_phone', source_path: '$.customer_phone' }] },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_openapi_preview',
    } as never);
    saveSpy.mockResolvedValue({
      ok: true,
      endpoint: 'save',
      artifact: 'integration_plugin',
      save_mode: 'draft',
      normalized_contract: normalizedContract,
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      result: {
        primary_resource_type: 'integration_plugin',
        plugin_id: 'plg_openapi_1',
        plugin_version_id: 'pv_openapi_1',
      },
      report: { report_id: 'rep_openapi_1', status: 'succeeded' },
      correlation_id: 'corr_openapi_save',
    } as never);

    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });

    await user.selectOptions(await screen.findByLabelText(/Source type/), 'openapi');
    fireEvent.change(screen.getByLabelText(/Plugin name/), {
      target: { value: 'OpenAPI document plugin proof' },
    });
    fireEvent.change(screen.getByLabelText(/Source payload/), {
      target: { value: JSON.stringify(openApiDocument, null, 2) },
    });

    await user.click(screen.getByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    const parseArgs = parseSpy.mock.calls[0]?.[0] as {
      source_type?: string;
      source_payload?: { openapi?: string; servers?: Array<{ url?: string }>; paths?: Record<string, unknown> };
      plugin_kind?: string;
    };
    expect(parseArgs?.source_type).toBe('openapi');
    expect(parseArgs?.plugin_kind).toBe('api');
    expect(parseArgs?.source_payload?.openapi).toBe('3.0.0');
    expect(parseArgs?.source_payload?.servers?.[0]?.url).toBe('https://vomhkplympywspxymnstltsw.example.invalid');
    expect(parseArgs?.source_payload?.paths?.['/v1/openapi-proof-orders']).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    expect(screen.getByText('Outbound suggestions prepared')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /^Save \(draft\)$/ }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    const saveArgs = saveSpy.mock.calls[0]?.[0] as {
      source_type?: string;
      source_payload?: { openapi?: string };
      normalized_contract?: { source_type?: string; metadata?: { server_url?: string } };
      outbound_operations?: Array<Record<string, unknown>>;
    };
    expect(saveArgs?.source_type).toBe('openapi');
    expect(saveArgs?.source_payload?.openapi).toBe('3.0.0');
    expect(saveArgs?.normalized_contract?.source_type).toBe('openapi');
    expect(saveArgs?.normalized_contract?.metadata?.server_url).toBe('https://vomhkplympywspxymnstltsw.example.invalid');
    expect(saveArgs?.outbound_operations?.[0]?.url_template).toBe('https://vomhkplympywspxymnstltsw.example.invalid/v1/openapi-proof-orders');

    const readback = await screen.findByTestId('plugin-studio-save-readback');
    expect(readback).toHaveTextContent('saved: draft');
    expect(readback).toHaveTextContent('Plugin saved');
    expect(readback).toHaveTextContent('Version saved');
    expect(readback).toHaveTextContent('Review saved');
  });

  it('authors the webhook sample variant with same-page workflow binding readback', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: {
        source_type: 'webhook_sample',
        plugin_kind: 'webhook',
        webhook: { sample_payload: { event: 'shipment.created', tracking_number: 'TRK-WEBHOOK-1' } },
      },
      mapping_suggestion: {
        version: 1,
        target: 'shipments.create',
        enabled: true,
        fields: [{ target_field: 'tracking_number', source_path: '$.tracking_number' }],
        transforms: { shipment: { tracking_number: 'tracking_number' } },
      },
      draft: null,
      correlation_id: 'corr_webhook_parse',
    } as never);
    inferSpy.mockResolvedValue({
      ok: true,
      endpoint: 'infer',
      mapping_suggestion: {
        version: 1,
        target: 'shipments.create',
        enabled: true,
        fields: [{ target_field: 'tracking_number', source_path: '$.tracking_number' }],
        transforms: { shipment: { tracking_number: 'tracking_number' } },
      },
      outbound_suggestions: [],
      normalized_contract: {
        source_type: 'webhook_sample',
        plugin_kind: 'webhook',
        webhook: { sample_payload: { event: 'shipment.created', tracking_number: 'TRK-WEBHOOK-1' } },
      },
      draft: null,
      correlation_id: 'corr_webhook_infer',
    } as never);
    previewSpy.mockResolvedValue({
      ok: true,
      endpoint: 'preview',
      artifact: 'integration_plugin',
      normalized_contract: {
        source_type: 'webhook_sample',
        plugin_kind: 'webhook',
        webhook: { sample_payload: { event: 'shipment.created', tracking_number: 'TRK-WEBHOOK-1' } },
      },
      mapping_suggestion: {
        version: 1,
        target: 'shipments.create',
        enabled: true,
        fields: [{ target_field: 'tracking_number', source_path: '$.tracking_number' }],
        transforms: { shipment: { tracking_number: 'tracking_number' } },
      },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
      correlation_id: 'corr_webhook_preview',
    } as never);
    saveSpy.mockResolvedValue({
      ok: true,
      endpoint: 'save',
      artifact: 'integration_plugin',
      save_mode: 'draft',
      normalized_contract: {
        source_type: 'webhook_sample',
        plugin_kind: 'webhook',
        webhook: { sample_payload: { event: 'shipment.created', tracking_number: 'TRK-WEBHOOK-1' } },
      },
      review: {
        mapping_config: {},
        coerced_preview: {},
        coercions: [],
        diagnostics: [],
        review_summary: {
          blocking_count: 0,
          warning_count: 0,
          coercion_count: 0,
          next_steps: [],
          egress_policy_resolution_id: null,
        },
      },
      result: {
        primary_resource_type: 'integration_plugin',
        plugin_id: 'plg_webhook_1',
        plugin_version_id: 'pv_webhook_1',
        workflow_binding: {
          mode: 'attach_existing',
          intent: 'shipment.create',
          template_name: 'webhook_shipment_create_v1',
        },
      },
      report: { report_id: 'rep_webhook_1', status: 'succeeded' },
      correlation_id: 'corr_webhook_save',
    } as never);

    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });

    await user.selectOptions(await screen.findByLabelText(/Source type/), 'webhook_sample');
    await user.selectOptions(screen.getByLabelText(/Plugin kind/), 'webhook');
    fireEvent.change(screen.getByLabelText(/Plugin name/), {
      target: { value: 'Webhook sample plugin proof' },
    });
    fireEvent.change(screen.getByLabelText(/Source payload/), {
      target: { value: '{"event":"shipment.created","tracking_number":"TRK-WEBHOOK-1"}' },
    });

    await user.click(screen.getByRole('button', { name: /^Parse$/ }));
    await waitFor(() => expect(parseSpy).toHaveBeenCalled());
    const parseArgs = parseSpy.mock.calls[0]?.[0] as {
      source_type?: string;
      source_payload?: { tracking_number?: string };
      plugin_kind?: string;
    };
    expect(parseArgs?.source_type).toBe('webhook_sample');
    expect(parseArgs?.plugin_kind).toBe('webhook');
    expect(parseArgs?.source_payload?.tracking_number).toBe('TRK-WEBHOOK-1');

    await user.click(screen.getByRole('button', { name: /^Infer mapping$/ }));
    await waitFor(() => expect(inferSpy).toHaveBeenCalled());
    expect(screen.queryByText(/Outbound operations/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /^Save \(draft\)$/ }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());

    const saveArgs = saveSpy.mock.calls[0]?.[0] as {
      normalized_contract?: { plugin_kind?: string };
      source_type?: string;
      source_payload?: { event?: string };
      plugin_kind?: string;
      mapping_config?: { target?: string; transforms?: Record<string, unknown> };
    };
    expect(saveArgs?.source_type).toBe('webhook_sample');
    expect(saveArgs?.plugin_kind).toBe('webhook');
    expect(saveArgs?.normalized_contract?.plugin_kind).toBe('webhook');
    expect(saveArgs?.source_payload?.event).toBe('shipment.created');
    expect(saveArgs?.mapping_config?.target).toBe('shipments.create');
    expect(saveArgs?.mapping_config?.transforms).toEqual(expect.objectContaining({ shipment: expect.any(Object) }));
    const readback = await screen.findByTestId('plugin-studio-save-readback');
    expect(readback).toHaveTextContent('Plugin saved');
    expect(readback).toHaveTextContent('Version saved');
    expect(readback).toHaveTextContent('Workflow prepared');
    expect(readback).toHaveTextContent('Template ready');
    expect(readback).toHaveTextContent('Binding ready');
  });

  it('disables Parse button without integration_plugins.write capability (capability gate)', async () => {
    renderWithProviders(<PluginStudioModule />, { capabilities: ['integrations.write', 'integration_plugins.read'] });
    const btn = await screen.findByRole('button', { name: /^Parse/ });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/Integration plugin update permission required/i).length).toBeGreaterThan(0);
  });

  it('keeps tenant integrations approvers out of Plugin Studio draft authoring without write', async () => {
    renderWithProviders(<PluginStudioModule />, {
      capabilities: [
        'integration_plugins.read',
        'integration_plugins.test',
        'integration_plugins.approve',
        'integration_plugins.activate',
      ],
    });

    const parseButton = await screen.findByRole('button', { name: /^Parse/ });
    expect(parseButton).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Infer mapping/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Preview/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
    expect(screen.getAllByText(/Integration plugin update permission required/i).length).toBeGreaterThan(0);
  });

  it('Save button additionally requires integration_plugins.write (granular capability gate)', async () => {
    parseSpy.mockResolvedValue({
      ok: true,
      endpoint: 'parse',
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      mapping_suggestion: { version: 1, fields: [] },
      draft: null,
      correlation_id: 'corr_p',
    } as never);
    renderWithProviders(<PluginStudioModule />, { capabilities: ['integrations.write', 'integration_plugins.read'] });
    // Save button shows the capability lock for `integration_plugins.write`
    // because that's the granular cap required by the edge fn `save` endpoint.
    const saveBtn = await screen.findByRole('button', { name: /^Save/ });
    expect(saveBtn).toBeDisabled();
    expect(screen.getAllByText(/Integration plugin update permission required/i).length).toBeGreaterThan(0);
  });

  it('surfaces edge fn error message when stage fails (error envelope path)', async () => {
    parseSpy.mockRejectedValue(new Error('edge.integration_plugin_studio.failed: Capability denied'));
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /^Parse$/ }));
    await waitFor(() => {
      expect(screen.getByTestId('plugin-studio-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('plugin-studio-error').textContent).toMatch(/Capability denied/);
  });
});
