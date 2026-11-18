// rules.test.tsx — covers the Webhook routing rules operator surface
// (CLAIM-INGRESS-COMPLETE; rewired in CLAIM-INTEGRATIONS-WORKFLOWS-WIRING / Phase C5).
//
// Backed by:
//   - public.webhook_rules from
//     supabase/migrations/202510110004_webhook_integration.sql:248+
//   - ui_read_registry.webhook_rules (seed-raw/registry.js)
//   - useResourceList<WebhookRuleRow>('webhook_rules')
//   - useUpsertWebhookRule  (Phase C5 hook → ui_upsert_webhook_rule_v1)
//   - useDeleteWebhookRule  (Phase C5 hook → ui_delete_webhook_rule_v1)
//   - useReorderWebhookRule (Phase C5 hook → ui_reorder_webhook_rule_v1)
//
// Targets (legacy 6 + Phase C5 mutation specs):
//   1. Module mounts and the registry-driven DataTable renders rows from the
//      seeded rules.
//   2. Filter chips by source and event_type are rendered (with `all` resets).
//   3. Header `New rule` button is capability-gated by `webhooks.write`.
//   4. New-rule modal opens with the required form fields (incl. workflow
//      template picker UI).
//   5. Source filter chip narrows the rendered rows to that source's rules.
//   6. Enable/disable row actions fire ui_upsert_webhook_rule_v1.
//   7. Increase priority row action fires ui_reorder_webhook_rule_v1.
//   8. Delete row action fires ui_delete_webhook_rule_v1.
//   9. Create submit refreshes the visible table from backend readback.
//  10. Edit submit refreshes the visible table from backend readback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RulesModule, type WebhookRuleRow } from '@/modules/integrations/rules';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';
import type { ListResult } from '@/types/domain';

describe('RulesModule', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let upsertSpy: TypedSpy<typeof apiMod, 'ui_upsert_webhook_rule_v1'>;
  let deleteSpy: TypedSpy<typeof apiMod, 'ui_delete_webhook_rule_v1'>;
  let reorderSpy: TypedSpy<typeof apiMod, 'ui_reorder_webhook_rule_v1'>;
  let resourceListSpy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    upsertSpy = typedSpy(apiMod, 'ui_upsert_webhook_rule_v1');
    deleteSpy = typedSpy(apiMod, 'ui_delete_webhook_rule_v1');
    reorderSpy = typedSpy(apiMod, 'ui_reorder_webhook_rule_v1');
  });
  afterEach(() => {
    upsertSpy.mockRestore();
    deleteSpy.mockRestore();
    reorderSpy.mockRestore();
    resourceListSpy?.mockRestore();
    resourceListSpy = undefined;
  });

  function mockRuleListReadback(
    initialRule?: Partial<WebhookRuleRow>,
    options: { applyMutations?: boolean; extraRules?: WebhookRuleRow[] } = {},
  ) {
    const applyMutations = options.applyMutations !== false;
    let rules: WebhookRuleRow[] = [
      {
        id: 'wbr_live_readback',
        webhook_source_id: 'whs_live_readback',
        name: 'Live readback rule',
        event_type: 'shipment.created',
        priority: 10,
        mapping_config_id: 'mc_examplemarket_ksa_v3_in',
        workflow_template_id: 'tpl_intake_exampleparcel',
        domain_category: 'shipment',
        enabled: true,
        created_at: '2026-05-13T06:00:00.000Z',
        ...initialRule,
      },
      ...(options.extraRules ?? []),
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (key) => {
      if (key === 'webhook_rules') {
        return { rows: rules, total: rules.length } as ListResult<unknown>;
      }
      if (key === 'webhook_sources') {
        return {
          rows: [
            {
              id: 'whs_live_readback',
              organization_id: 'org_rashed',
              name: 'Live readback source',
              source_identifier: 'live-readback-source',
              provider_type: 'generic',
              enabled: true,
              mapping_config_id: 'mc_examplemarket_ksa_v3_in',
            },
          ],
          total: 1,
        } as ListResult<unknown>;
      }
      return { rows: [], total: 0 } as ListResult<unknown>;
    });
    const completeListSpy = vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (key) => {
      if (key === 'mapping_configs') {
        return {
          rows: [
            {
              id: 'mc_examplemarket_ksa_v3_in',
              mapping_key: 'exampleparcel.ksa.v3.in',
              mapping_type: 'webhook_inbound',
              target: 'shipments.create',
            },
          ],
          total: 1,
        } as ListResult<unknown>;
      }
      if (key === 'workflow_templates') {
        return {
          rows: [
            {
              id: 'tpl_intake_exampleparcel',
              name: 'Exampleparcel KSA inbound intake',
              template_key: 'webhook_intake_v1',
              trigger: 'shipment.created',
              scope_type: 'global',
              scope_id: null,
            },
          ],
          total: 1,
        } as ListResult<unknown>;
      }
      return { rows: [], total: 0 } as ListResult<unknown>;
    });
    resourceListSpy = {
      mockRestore: () => {
        listSpy.mockRestore();
        completeListSpy.mockRestore();
      },
    };
    upsertSpy.mockImplementation(async (args) => {
      if (args.rule_id) {
        if (applyMutations) {
          rules = rules.map((row) =>
            row.id === args.rule_id
              ? {
                  ...row,
                  ...(args.webhook_source_id !== undefined ? { webhook_source_id: String(args.webhook_source_id) } : {}),
                  ...(args.name !== undefined ? { name: String(args.name) } : {}),
                  ...(args.event_type !== undefined ? { event_type: String(args.event_type) } : {}),
                  ...(args.priority !== undefined ? { priority: Number(args.priority) } : {}),
                  ...(args.mapping_config_id !== undefined
                    ? { mapping_config_id: args.mapping_config_id ? String(args.mapping_config_id) : undefined }
                    : {}),
                  ...(args.workflow_template_id !== undefined
                    ? { workflow_template_id: args.workflow_template_id ? String(args.workflow_template_id) : undefined }
                    : {}),
                  ...(args.domain_category !== undefined
                    ? { domain_category: args.domain_category ? String(args.domain_category) : undefined }
                    : {}),
                  ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
                }
              : row,
          );
        }
        return { ok: true, webhook_rule_id: String(args.rule_id) };
      }
      const createdId = 'wbr_created_readback';
      if (applyMutations) {
        rules = [
          {
            id: createdId,
            webhook_source_id: String(args.webhook_source_id ?? 'whs_live_readback'),
            name: String(args.name ?? 'Created readback rule'),
            event_type: String(args.event_type ?? 'shipment.created'),
            priority: Number(args.priority ?? 10),
            mapping_config_id: args.mapping_config_id ? String(args.mapping_config_id) : 'mc_examplemarket_ksa_v3_in',
            workflow_template_id: args.workflow_template_id ? String(args.workflow_template_id) : 'tpl_intake_exampleparcel',
            domain_category: args.domain_category ? String(args.domain_category) : 'shipment',
            enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
            created_at: '2026-05-13T06:30:00.000Z',
          },
          ...rules,
        ];
      }
      return { ok: true, webhook_rule_id: createdId };
    });
    reorderSpy.mockImplementation(async (args) => {
      if (applyMutations) {
        rules = rules.map((row) =>
          row.id === args.rule_id && typeof args.priority === 'number'
            ? { ...row, priority: args.priority }
            : row,
        );
      }
      return { ok: true, webhook_rule_id: String(args.rule_id ?? ''), priority: args.priority };
    });
    deleteSpy.mockImplementation(async (args) => {
      if (applyMutations) {
        rules = rules.filter((row) => row.id !== args.rule_id);
      }
      return { ok: true, webhook_rule_id: String(args.rule_id ?? ''), deleted: true };
    });
    return { listSpy };
  }

  async function openLiveReadbackRuleActions(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => {
      expect(screen.getByText('Live readback rule')).toBeInTheDocument();
    });
    const row = screen.getByText('Live readback rule').closest('tr');
    expect(row).not.toBeNull();
    const actionButton = within(row as HTMLTableRowElement).getByRole('button', {
      name: /Row actions/,
    });
    await user.click(actionButton);
  }

  it('mounts the page header + operator-facing routing pill + table rows', async () => {
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect((await screen.findAllByText('Routing rules')).length).toBeGreaterThan(0);
    expect(screen.getByRole('toolbar', { name: /External Intake workspace/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open API request intake/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Test webhook intake/i })).toBeEnabled();
    expect(screen.queryByText('ui_read_registry.webhook_rules')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('renders routing rule drawer chips as operator labels instead of object text', async () => {
    const user = userEvent.setup();
    mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    const rowLabel = await screen.findByText('Live readback rule');
    await user.click(rowLabel.closest('tr') as HTMLTableRowElement);

    await waitFor(() => {
      expect(screen.getByText('Routing rule')).toBeInTheDocument();
      expect(screen.queryByText('[object Object]')).toBeNull();
      expect(screen.getAllByText(apiMod.lookupRow('domain_category', 'shipment')?.label ?? 'Shipment').length)
        .toBeGreaterThan(0);
      expect(screen.getAllByText(/Enabled/i).length).toBeGreaterThan(0);
    });
  });

  it('renders denied state without protected webhook rule reads when webhooks.read is missing', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const completeListSpy = vi.spyOn(apiMod, 'ui_list_resource_complete');
    const settingsSpy = vi.spyOn(apiMod, 'resolveSettings');
    renderWithProviders(<RulesModule />, { capabilities: [] });

    expect(await screen.findByText(/You do not have permission to view webhook routing rules/i)).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('webhook_rules');
      expect(resources).not.toContain('webhook_sources');

      const completeResources = completeListSpy.mock.calls.map(([resource]) => resource);
      expect(completeResources).not.toContain('mapping_configs');
      expect(completeResources).not.toContain('workflow_templates');

      const categories = settingsSpy.mock.calls.map(([category]) => category);
      expect(categories).not.toContain('webhook_routing_policy');
    });
    listSpy.mockRestore();
    completeListSpy.mockRestore();
    settingsSpy.mockRestore();
  });

  it('reads webhook sources through the active tenant lens before showing source-owned rules', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<RulesModule />, {
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
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    listSpy.mockRestore();
  });

  it('renders the canonical registry-driven columns', async () => {
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table thead th').length).toBeGreaterThan(0);
    });
    const headerCells = Array.from(document.querySelectorAll('.dt__table thead th')).map((th) =>
      th.textContent?.trim() ?? '',
    );
    expect(headerCells.some((h) => /Name/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Source/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Event/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Priority/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Mapping/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Workflow/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Domain/.test(h))).toBe(true);
    expect(headerCells.some((h) => /Enabled/.test(h))).toBe(true);
  });

  it('renders cross-resource links with canonical hrefs instead of hash placeholders', async () => {
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    expect(document.querySelector('a[href="#"]')).toBeNull();
    expect(document.querySelector('a[href^="/integrations/sources?focus="')).not.toBeNull();
    expect(document.querySelector('a[href^="/integrations/mapping?focus="')).not.toBeNull();
    expect(document.querySelector('a[href^="/workflows/templates?focus="')).not.toBeNull();
  });

  it('renders source + event filter chips with `all` reset chips', async () => {
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const filterRow = document.querySelector('[aria-label="Filter chips"]')!;
    expect(filterRow).not.toBeNull();
    // Each filter group has exactly one `all` reset chip.
    const allChips = Array.from(filterRow.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === 'all',
    );
    expect(allChips.length).toBe(2);
    // Event-type chips include the canonical `shipment.created` event.
    expect(filterRow.textContent).toMatch(/shipment\.created/);
  });

  it('disables `New rule` and shows the lock chip without webhooks.write', async () => {
    renderWithProviders(<RulesModule />, { capabilities: ['webhooks.read'] });
    const btn = await screen.findByRole('button', { name: /New rule/ });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/Webhook update permission required/i).length).toBeGreaterThan(0);
  });

  it('permission-gates rule row write actions without firing backend mutations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['webhooks.read'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const editOption = await screen.findByRole('option', { name: /^Edit/ });
    const toggleOption = await screen.findByRole('option', { name: /^Disable rule/ });
    expect(screen.queryByRole('option', { name: /^Enable rule/ })).not.toBeInTheDocument();
    const increaseOption = await screen.findByRole('option', { name: /^Increase priority/ });
    const decreaseOption = await screen.findByRole('option', { name: /^Decrease priority/ });
    const deleteOption = await screen.findByRole('option', { name: /^Delete rule/ });
    expect(editOption).toHaveClass('is-disabled');
    expect(toggleOption).toHaveClass('is-disabled');
    expect(increaseOption).toHaveClass('is-disabled');
    expect(decreaseOption).toHaveClass('is-disabled');
    expect(deleteOption).toHaveClass('is-disabled');

    await user.click(toggleOption);
    await user.click(increaseOption);
    await user.click(decreaseOption);
    await user.click(deleteOption);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('opens the New rule modal with the workflow_template picker control', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    const btn = await screen.findByRole('button', { name: /New rule/ });
    await user.click(btn);
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    // The workflow template picker is rendered as an accessible button so
    // operators can open the ReferencePicker palette.
    expect(
      screen.getByRole('button', { name: /Pick workflow template/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Pick workflow template/ }));
    const suggestions = await screen.findByRole('listbox', { name: /Suggestions/i });
    expect(
      await within(suggestions).findByText(/Exampleparcel KSA inbound intake|webhook_intake_v1/i),
    ).toBeInTheDocument();
    expect(
      within(suggestions).queryByText(/Bank deposit reconciliation|bank_deposit_reconciliation/i),
    ).toBeNull();
    expect(within(suggestions).queryByText(/COD driver shift settlement/i)).toBeNull();
    // Required input fields. (Both the rule-name and event-type placeholders
    // mention `shipment.created` — assert >= 1 to keep the test robust as
    // copy evolves.)
    expect(screen.getAllByPlaceholderText(/shipment\.created/).length).toBeGreaterThan(0);
  });

  it('uses row-driven mapping and canonical domain controls in the New rule modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await user.click(await screen.findByRole('button', { name: /New rule/ }));

    expect(screen.getByRole('button', { name: /Pick mapping config/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pick mapping config/ })).toHaveTextContent(
      'mc_examplemarket_ksa_v3_in',
    );
    expect(screen.queryByPlaceholderText(/shipping \/ finance \/ comms \/ warehouse/i)).toBeNull();

    const domainSelect = document.querySelector('#webhook-rule-domain') as HTMLSelectElement | null;
    expect(domainSelect).not.toBeNull();
    const canonicalDomainValues = (
      apiMod.getLookups('domain_category') as Array<{ value: string }>
    ).map((row) => row.value);
    expect(Array.from(domainSelect?.options ?? []).map((option) => option.value)).toEqual(
      canonicalDomainValues,
    );

    await user.click(screen.getByRole('button', { name: /Pick mapping config/ }));
    const mappingOption = await screen.findByText('exampleparcel_ksa_v3.shipment_inbound');
    await user.click(mappingOption);
    expect(screen.getByRole('button', { name: /Pick mapping config/ })).toHaveTextContent(
      'mc_examplemarket_ksa_v3_in',
    );
  });

  it('source filter chip narrows the rendered rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const beforeCount = document.querySelectorAll('.dt__table tbody tr').length;
    const filterRow = document.querySelector('[aria-label="Filter chips"]')!;
    // Click the first source-specific chip (skip the `all` chip).
    const sourceChips = Array.from(filterRow.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() !== 'all' && !b.classList.contains('mono'),
    );
    expect(sourceChips.length).toBeGreaterThan(0);
    await user.click(sourceChips[0] as Element);
    await waitFor(() => {
      const afterCount = document.querySelectorAll('.dt__table tbody tr').length;
      expect(afterCount).toBeGreaterThan(0);
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    });
  });

  it('Disable rule row action fires ui_upsert_webhook_rule_v1 (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const toggle = await screen.findByRole('option', { name: /Disable rule/ });
    await user.click(toggle);
    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalled();
    });
    const args = upsertSpy.mock.calls[0]?.[0] as { rule_id?: string; enabled?: boolean } | undefined;
    expect(args?.rule_id).toBeTruthy();
    expect(typeof args?.enabled).toBe('boolean');
  });

  it('disables a rule and refreshes the visible rule row from backend readback without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(await screen.findByRole('option', { name: /Disable rule/ }));

    await waitFor(() => {
      const row = screen.getByText('Live readback rule').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText('Disabled')).toBeInTheDocument();
    });
    expect(upsertSpy).toHaveBeenCalledWith({
      rule_id: 'wbr_live_readback',
      enabled: false,
    });
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('enables a disabled rule and refreshes the visible rule row from backend readback without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback({ enabled: false });
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    expect(screen.queryByRole('option', { name: /Disable rule/ })).not.toBeInTheDocument();
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(await screen.findByRole('option', { name: /Enable rule/ }));

    await waitFor(() => {
      const row = screen.getByText('Live readback rule').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText('Enabled')).toBeInTheDocument();
    });
    expect(upsertSpy).toHaveBeenCalledWith({
      rule_id: 'wbr_live_readback',
      enabled: true,
    });
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('keeps rule enabled state unchanged when backend readback is stale', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    mockRuleListReadback(undefined, { applyMutations: false });
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    await user.click(await screen.findByRole('option', { name: /Disable rule/ }));

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith({
        rule_id: 'wbr_live_readback',
        enabled: false,
      });
    });
    await waitFor(() => {
      const row = screen.getByText('Live readback rule').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText('Enabled')).toBeInTheDocument();
      expect(within(row as HTMLTableRowElement).queryByText('Disabled')).toBeNull();
    });
  });

  it('Increase priority row action fires ui_reorder_webhook_rule_v1 (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const inc = await screen.findByRole('option', { name: /Increase priority/ });
    await user.click(inc);
    await waitFor(() => {
      expect(reorderSpy).toHaveBeenCalled();
    });
    const args = reorderSpy.mock.calls[0]?.[0] as { rule_id?: string; priority?: number } | undefined;
    expect(args?.rule_id).toBeTruthy();
    expect(typeof args?.priority).toBe('number');
  });

  it('reorders priority and keeps the updated backend-readback priority visible without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(await screen.findByRole('option', { name: /Increase priority/ }));

    await waitFor(() => {
      const row = screen.getByText('Live readback rule').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText('11')).toBeInTheDocument();
    });
    expect(reorderSpy).toHaveBeenCalledWith({
      rule_id: 'wbr_live_readback',
      priority: 11,
    });
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('Delete rule row action fires ui_delete_webhook_rule_v1 (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const del = await screen.findByRole('option', { name: /Delete rule/ });
    await user.click(del);
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalled();
    });
    const args = deleteSpy.mock.calls[0]?.[0] as { rule_id?: string } | undefined;
    expect(args?.rule_id).toBeTruthy();
  });

  it('deletes a rule and removes the row from the visible backend-readback table without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(await screen.findByRole('option', { name: /Delete rule/ }));

    await waitFor(() => {
      expect(screen.queryByText('Live readback rule')).toBeNull();
    });
    expect(deleteSpy).toHaveBeenCalledWith({ rule_id: 'wbr_live_readback' });
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('bulk deletes rules and removes them from the visible backend-readback table without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback(undefined, {
      extraRules: [
        {
          id: 'wbr_live_readback_b',
          webhook_source_id: 'whs_live_readback',
          name: 'Live readback rule B',
          event_type: 'shipment.created',
          priority: 20,
          mapping_config_id: 'mc_examplemarket_ksa_v3_in',
          workflow_template_id: 'tpl_intake_exampleparcel',
          domain_category: 'shipment',
          enabled: true,
          created_at: '2026-05-13T06:10:00.000Z',
        },
      ],
    });
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await screen.findByText('Live readback rule');
    await screen.findByText('Live readback rule B');
    for (const checkbox of screen.getAllByLabelText('Select row')) {
      await user.click(checkbox);
    }
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(await screen.findByRole('button', { name: /^Bulk delete$/ }));

    await waitFor(() => {
      expect(screen.queryByText('Live readback rule')).toBeNull();
      expect(screen.queryByText('Live readback rule B')).toBeNull();
    });
    expect(deleteSpy).toHaveBeenCalledWith({ rule_id: 'wbr_live_readback' });
    expect(deleteSpy).toHaveBeenCalledWith({ rule_id: 'wbr_live_readback_b' });
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('creates a rule and shows the backend-readback row without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await user.click(await screen.findByRole('button', { name: /New rule/ }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Created readback rule');
    await user.clear(screen.getByLabelText('Event type'));
    await user.type(screen.getByLabelText('Event type'), 'shipment.created');
    await user.click(screen.getByRole('button', { name: /Pick workflow template/ }));
    const suggestions = await screen.findByRole('listbox', { name: /Suggestions/i });
    await user.click(await within(suggestions).findByText(/Exampleparcel KSA inbound intake|webhook_intake_v1/i));
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByText('Created readback rule')).toBeInTheDocument();
    });
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_id: null,
        webhook_source_id: 'whs_live_readback',
        name: 'Created readback rule',
        event_type: 'shipment.created',
        mapping_config_id: 'mc_examplemarket_ksa_v3_in',
        workflow_template_id: 'tpl_intake_exampleparcel',
        domain_category: 'shipment',
        enabled: true,
      }),
    );
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('edits a rule and shows the backend-readback row without reload', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    const { listSpy } = mockRuleListReadback();
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    await user.click(await screen.findByRole('option', { name: /^Edit/ }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Edited readback rule');
    await user.clear(screen.getByLabelText('Event type'));
    await user.type(screen.getByLabelText('Event type'), 'shipment.updated');
    await user.clear(screen.getByLabelText('Priority'));
    await user.type(screen.getByLabelText('Priority'), '17');
    await user.selectOptions(screen.getByLabelText('Domain'), 'communication');
    const readsBeforeMutation = listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length;
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
      const row = screen.getByText('Edited readback rule').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText('shipment.updated')).toBeInTheDocument();
      expect(within(row as HTMLTableRowElement).getByText('17')).toBeInTheDocument();
      expect(within(row as HTMLTableRowElement).getByText('Communication')).toBeInTheDocument();
      expect(screen.queryByText('Live readback rule')).toBeNull();
    });
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_id: 'wbr_live_readback',
        name: 'Edited readback rule',
        webhook_source_id: 'whs_live_readback',
        event_type: 'shipment.updated',
        priority: 17,
        mapping_config_id: 'mc_examplemarket_ksa_v3_in',
        workflow_template_id: 'tpl_intake_exampleparcel',
        domain_category: 'communication',
        enabled: true,
      }),
    );
    expect(listSpy.mock.calls.filter(([key]) => key === 'webhook_rules').length).toBeGreaterThan(
      readsBeforeMutation,
    );
    expect(window.location.pathname).toBe('/integrations/rules');
  });

  it('keeps the edit modal open when backend readback does not reflect edited fields', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/integrations/rules');
    mockRuleListReadback(undefined, { applyMutations: false });
    renderWithProviders(<RulesModule />, { capabilities: ['all'] });

    await openLiveReadbackRuleActions(user);
    await user.click(await screen.findByRole('option', { name: /^Edit/ }));
    await user.clear(screen.getByLabelText('Event type'));
    await user.type(screen.getByLabelText('Event type'), 'shipment.updated');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/confirmation did not keep event_type/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Live readback rule')).toBeInTheDocument();
    expect(screen.getByLabelText('Event type')).toHaveValue('shipment.updated');
  });
});
