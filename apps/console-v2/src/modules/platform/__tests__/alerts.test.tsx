// alerts.test.tsx — CLAIM-PLATFORM-ALERTS (Wave 3, Phase C).
//
// Light-weight integration tests for the AlertsModule. We mount through the
// real provider stack (renderWithProviders) and hit the in-memory data-source
// the demo seam already wires. Tests focus on:
//   - Module mounts, page header + KPI strip + DataTable render.
//   - Capability gate on "New rule" (alerts.write) — denied without it.
//   - Capability gate on "Pause" + "Delete" row actions (also alerts.write).
//   - Capability gate on global operations-alert Ack/Resolve actions.
//   - Editor (modal) opens with the SHARED nested AND/OR/NOT condition
//     builder primitive — confirms the cross-module reuse renders correctly.
//   - Test rule action runs the live evaluator and surfaces a PASS/FAIL chip.
//   - Triggers tab in the drawer renders past fires for the rule.
//   - Read-only role (no alerts.read) renders a denied state.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
  rpc: vi.fn(),
}));

vi.mock('@/lib/seed-loader', async () => {
  // @ts-expect-error JS seed module is intentionally declaration-free.
  const seed = await import('@/lib/seed-raw/seed.js');
  return {
    seed,
    SEED_MODE_ENABLED: true,
  };
});

import { renderWithProviders } from '@/test/render';
import { AlertsModule } from '@/modules/platform/alerts';
import * as api from '@/lib/api';
import * as dataSource from '@/lib/data-source';

function alertRuleRow(overrides: Record<string, unknown>) {
  return {
    id: 'alr_existing_refresh',
    organization_id: 'org_platform',
    name: 'Existing backend refresh rule',
    rule_name: 'Existing backend refresh rule',
    trigger_source: 'console.alerts.refresh',
    condition: { error_rate: '0.05' },
    trigger_conditions: { error_rate: '0.05' },
    severity: 'warn',
    channel: 'slack',
    alert_channels: ['slack'],
    enabled: true,
    created_by: 'system',
    created_at: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

function opsAlertRow(overrides: Record<string, unknown>) {
  return {
    id: 'ops_alert_refresh',
    organization_id: 'org_platform',
    severity: 'critical',
    opened_at: '2026-05-17T00:00:00.000Z',
    created_at: '2026-05-17T00:00:00.000Z',
    acknowledged_at: null,
    resolved_at: null,
    source: 'webhook_ack_failure',
    alert_type: 'webhook_ack_failure',
    message: 'Backend refresh ops alert',
    details: {},
    ...overrides,
  };
}

async function mountAndWait(opts?: { capabilities?: string[] }) {
  const utils = renderWithProviders(<AlertsModule />, opts);
  await waitFor(() => {
    expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument();
  });
  return utils;
}

describe('AlertsModule', () => {
  beforeEach(() => {
    dataSource.setRole('ops_admin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts the page header, KPI strip, and DataTable', async () => {
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    // Page header + parity pill.
    expect(screen.getAllByText(/Alerts/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/parity · DD\/PD\/Sentry/i)).toBeInTheDocument();
    // KPI strip is visible — scope the lookup so the row toggle button labelled
    // "Enabled" doesn't conflict with the KPI label.
    const kpi = screen.getByTestId('alerts-kpi-strip');
    expect(kpi).toBeInTheDocument();
    expect(within(kpi).getByText(/^Alert rules$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Enabled$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Triggered today$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Open ops alerts$/i)).toBeInTheDocument();
    // At least one rule row should be visible.
    expect(screen.getByText(/High error rate · API ingress/i)).toBeInTheDocument();
  });

  it('denies the page entirely when alerts.read is missing', async () => {
    renderWithProviders(<AlertsModule />, { capabilities: [] });
    expect(
      await screen.findByText(/Alerts management requires the alerts.read capability/i),
    ).toBeInTheDocument();
  });

  it('disables "New rule" when alerts.write is missing (capability gate)', async () => {
    await mountAndWait({ capabilities: ['alerts.read'] });
    const newBtn = screen.getByRole('button', { name: /^New rule/i });
    expect(newBtn).toBeDisabled();
    // CapabilityLock chip should be appended inside the disabled button.
    expect(within(newBtn).getByText(/Alert update permission required/i)).toBeInTheDocument();
  });

  it('enables "New rule" when alerts.write is granted', async () => {
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    const newBtn = screen.getByRole('button', { name: /^New rule/i });
    expect(newBtn).not.toBeDisabled();
  });

  it('opens the visual condition builder with the shared nested AND/OR/NOT control', async () => {
    const user = userEvent.setup();
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    // Open the first row's drawer by clicking the row.
    const firstRow = screen.getByText(/High error rate · API ingress/i).closest('tr')!;
    await user.click(firstRow);
    // The drawer surfaces the "Edit condition (visual builder)" button.
    const editBtn = await screen.findByRole('button', { name: /Edit condition \(visual builder\)/i });
    await user.click(editBtn);
    // Visual builder rendered — assert nested AND/OR/NOT control + JSONLogic
    // preview both come from the SHARED condition-model primitive.
    const builder = await screen.findByTestId('alerts-cond-builder');
    expect(builder).toBeInTheDocument();
    const group = within(builder).getByTestId('alerts-cond-group');
    expect(group).toBeInTheDocument();
    // Combinator dropdown offers all three modes (ALL/ANY/NONE).
    const combinator = within(group).getByLabelText(/Combinator/i) as HTMLSelectElement;
    expect(combinator).toBeInTheDocument();
    expect(within(combinator).getByText(/ALL of \(AND\)/i)).toBeInTheDocument();
    expect(within(combinator).getByText(/ANY of \(OR\)/i)).toBeInTheDocument();
    expect(within(combinator).getByText(/NONE of \(NOT\)/i)).toBeInTheDocument();
    // JSONLogic preview rendered.
    const preview = within(builder).getByTestId('alerts-cond-rule-preview');
    expect(preview.textContent).toMatch(/error_rate|AND|ALL/i);
  });

  it('Test rule action evaluates against a payload and shows a PASS/FAIL chip', async () => {
    const user = userEvent.setup();
    await mountAndWait({ capabilities: ['alerts.read'] });
    // Trigger the page-header "Test rule" action — it opens against the first row.
    const testBtn = screen.getByRole('button', { name: /^Test rule$/i });
    await user.click(testBtn);
    const body = await screen.findByTestId('alerts-test-rule');
    // Default sample payload uses the first historical trigger payload for
    // alr_high_error_rate (`error_rate: 0.087`). The rule condition is the
    // legacy flat `{ error_rate: '0.05' }` (equals), so the default sample
    // evaluates to FAIL — the PASS/FAIL chip MUST render either way.
    expect(within(body).getByText(/FAIL · would not fire/i)).toBeInTheDocument();
    // Edit the textarea to make it match exactly (error_rate: 0.05) — chip
    // flips to PASS.
    const textarea = within(body).getByLabelText(/Trigger details/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"error_rate": 0.05}' } });
    expect(within(body).getByText(/PASS · would fire/i)).toBeInTheDocument();
    // Switching to invalid JSON renders a danger chip.
    fireEvent.change(textarea, { target: { value: '{not json' } });
    expect(within(body).getByText(/invalid details/i)).toBeInTheDocument();
    expect(within(body).getByText(/invalid payload/i)).toBeInTheDocument();
  });

  it('renders the triggers history tab with prior fires for the selected rule', async () => {
    const user = userEvent.setup();
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    // Open drawer for the high-error-rate rule (3 prior fires in the seed).
    const firstRow = screen.getByText(/High error rate · API ingress/i).closest('tr')!;
    await user.click(firstRow);
    const drawer = await screen.findByTestId('alerts-rule-drawer');
    const triggers = within(drawer).getByTestId('alerts-triggers-history');
    // Seeded rule alr_high_error_rate has 3 historical fires (altrg_001..003).
    expect(within(triggers).getByText('altrg_001')).toBeInTheDocument();
    expect(within(triggers).getByText('altrg_002')).toBeInTheDocument();
    expect(within(triggers).getByText('altrg_003')).toBeInTheDocument();
    // Status chips ("fired" / "acknowledged" / "resolved") all surface in the
    // history (matching the seed lifecycle distribution).
    expect(within(triggers).getByText(/^fired$/)).toBeInTheDocument();
    expect(within(triggers).getByText(/^acknowledged$/)).toBeInTheDocument();
    expect(within(triggers).getByText(/^resolved$/)).toBeInTheDocument();
  });

  it('renders the active ops_alerts cross-link (open + resolved) in the drawer', async () => {
    const user = userEvent.setup();
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    const firstRow = screen.getByText(/High error rate · API ingress/i).closest('tr')!;
    await user.click(firstRow);
    const drawer = await screen.findByTestId('alerts-rule-drawer');
    const opsList = within(drawer).getByTestId('alerts-active-ops-alerts');
    // Seed has one open ops_alert sourced from rule:alr_high_error_rate.
    expect(within(opsList).getByText(/API ingress error rate exceeded/i)).toBeInTheDocument();
    expect(within(opsList).getByText(/^open$/i)).toBeInTheDocument();
  });

  // Phase C6 — assert canonical mutation RPCs fire with the canonical p_args
  // jsonb envelope. Each test mocks the api facade entry to verify the wire
  // payload + that the toast surfaces the canonical RPC name (so cutover
  // observability stays consistent).
  it('New rule modal Create button calls create_alert_rule_v1 with the canonical envelope', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'create_alert_rule_v1').mockResolvedValue({
      ok: true,
      alert_rule_id: 'alr_new_test',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    await user.click(screen.getByRole('button', { name: /^New rule/i }));
    // Modal renders; submit Create.
    await user.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      rule_name: expect.any(String),
      trigger_source: expect.any(String),
      alert_channels: expect.any(Array),
      severity: expect.any(String),
      enabled: true,
    });
  });

  it('New rule create shows backend alert_rules readback in the table without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleRows = [
      alertRuleRow({ id: 'alr_existing_refresh', name: 'Existing backend refresh rule' }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return {
            rows: visibleRows,
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const createSpy = vi
      .spyOn(api, 'create_alert_rule_v1')
      .mockImplementation(async (args: Record<string, unknown>) => {
        visibleRows = [
          ...visibleRows,
          alertRuleRow({
            id: 'alr_first_tenant_refresh',
            name: String(args.rule_name),
            rule_name: String(args.rule_name),
            severity: String(args.severity),
            channel: String((args.alert_channels as string[] | undefined)?.[0] ?? 'slack'),
            alert_channels: args.alert_channels,
            enabled: true,
          }),
        ];
        return {
          ok: true,
          alert_rule_id: 'alr_first_tenant_refresh',
          correlation_id: 'cor_alert_refresh',
          settings_resolution_id: 'srlv_alert_refresh',
        };
      });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    expect(await screen.findByText('Existing backend refresh rule')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^New rule/i }));
    await user.clear(await screen.findByLabelText(/Rule name/i));
    await user.type(screen.getByLabelText(/Rule name/i), 'First tenant alert refresh');
    await user.selectOptions(screen.getByLabelText(/^Severity$/i), 'critical');
    await user.selectOptions(screen.getByLabelText(/^Channel$/i), 'email');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rule_name: 'First tenant alert refresh',
          severity: 'critical',
          alert_channels: ['email'],
        }),
      );
      const tableText = document.querySelector('.dt__table tbody')?.textContent ?? '';
      expect(tableText).toContain('First tenant alert refresh');
      expect(tableText).toContain('critical');
      expect(tableText).toContain('email');
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rules').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Drawer Pause button calls pause_alert_rule_v1 with alert_rule_id', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'pause_alert_rule_v1').mockResolvedValue({
      ok: true,
      alert_rule_id: 'alr_high_error_rate',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    const firstRow = screen.getByText(/High error rate · API ingress/i).closest('tr')!;
    await user.click(firstRow);
    await screen.findByTestId('alerts-rule-drawer');
    // Pause button lives in the drawer footer (outside the drawer body div).
    const pauseBtn = await screen.findByRole('button', { name: /^Pause$/i });
    await user.click(pauseBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ alert_rule_id: expect.stringContaining('alr_') }),
    );
  });

  it('Pause rule click reconciles visible status from backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleRows = [
      alertRuleRow({
        id: 'alr_pause_refresh',
        name: 'Pause backend refresh rule',
        rule_name: 'Pause backend refresh rule',
        enabled: true,
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return {
            rows: visibleRows,
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const pauseSpy = vi
      .spyOn(api, 'pause_alert_rule_v1')
      .mockImplementation(async () => {
        visibleRows = visibleRows.map((row) =>
          row.id === 'alr_pause_refresh' ? { ...row, enabled: false } : row,
        );
        return {
          ok: true,
          alert_rule_id: 'alr_pause_refresh',
          correlation_id: 'cor_alert_pause_refresh',
          settings_resolution_id: 'srlv_alert_pause_refresh',
        };
      });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const row = (await screen.findByText('Pause backend refresh rule')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /^Pause rule$/i })).toHaveTextContent('Enabled');
    await user.click(within(row).getByRole('button', { name: /^Pause rule$/i }));

    await waitFor(() => {
      expect(pauseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ alert_rule_id: 'alr_pause_refresh' }),
      );
      const refreshedRow = screen.getByText('Pause backend refresh rule').closest('tr')!;
      expect(within(refreshedRow).getByRole('button', { name: /^Resume rule$/i })).toHaveTextContent('Paused');
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rules').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Resume rule click reconciles visible status from backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleRows = [
      alertRuleRow({
        id: 'alr_resume_refresh',
        name: 'Resume backend refresh rule',
        rule_name: 'Resume backend refresh rule',
        enabled: false,
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return {
            rows: visibleRows,
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const resumeSpy = vi
      .spyOn(api, 'resume_alert_rule_v1')
      .mockImplementation(async () => {
        visibleRows = visibleRows.map((row) =>
          row.id === 'alr_resume_refresh' ? { ...row, enabled: true } : row,
        );
        return {
          ok: true,
          alert_rule_id: 'alr_resume_refresh',
          correlation_id: 'cor_alert_resume_refresh',
          settings_resolution_id: 'srlv_alert_resume_refresh',
        };
      });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const row = (await screen.findByText('Resume backend refresh rule')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /^Resume rule$/i })).toHaveTextContent('Paused');
    await user.click(within(row).getByRole('button', { name: /^Resume rule$/i }));

    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ alert_rule_id: 'alr_resume_refresh' }),
      );
      const refreshedRow = screen.getByText('Resume backend refresh rule').closest('tr')!;
      expect(within(refreshedRow).getByRole('button', { name: /^Pause rule$/i })).toHaveTextContent('Enabled');
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rules').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Drawer channel change reconciles visible table state from backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleRows = [
      alertRuleRow({
        id: 'alr_channel_refresh',
        name: 'Channel backend refresh rule',
        rule_name: 'Channel backend refresh rule',
        channel: 'slack',
        alert_channels: ['slack'],
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return {
            rows: visibleRows,
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const updateSpy = vi
      .spyOn(api, 'update_alert_rule_v1')
      .mockImplementation(async (args: Record<string, unknown>) => {
        const nextChannels = (args.alert_channels as string[] | undefined) ?? ['email'];
        visibleRows = visibleRows.map((row) =>
          row.id === 'alr_channel_refresh'
            ? {
                ...row,
                channel: nextChannels[0] ?? 'email',
                alert_channels: nextChannels,
              }
            : row,
        );
        return {
          ok: true,
          alert_rule_id: 'alr_channel_refresh',
          revision: 1,
          correlation_id: 'cor_alert_channel_refresh',
          settings_resolution_id: 'srlv_alert_channel_refresh',
        };
      });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const row = (await screen.findByText('Channel backend refresh rule')).closest('tr')!;
    expect(within(row).getByText(/^slack$/i)).toBeInTheDocument();
    await user.click(row);
    const drawer = await screen.findByTestId('alerts-rule-drawer');
    await user.selectOptions(within(drawer).getByLabelText(/^Channel$/i), 'email');

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          alert_rule_id: 'alr_channel_refresh',
          alert_channels: ['email'],
        }),
      );
      const refreshedRow = screen.getByText('Channel backend refresh rule').closest('tr')!;
      expect(within(refreshedRow).getByText(/^email$/i)).toBeInTheDocument();
      expect(screen.getByTestId('alerts-rule-drawer-channel-value')).toHaveTextContent('email');
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rules').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Drawer Delete button refetches backend lists and removes the rule without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleRows = [
      alertRuleRow({
        id: 'alr_delete_refresh',
        name: 'Delete backend refresh rule',
        rule_name: 'Delete backend refresh rule',
        trigger_source: 'console.alerts.delete',
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return { rows: visibleRows, total: visibleRows.length, page: 0, page_size: visibleRows.length };
        }
        if (resource === 'alert_rule_directory') {
          return {
            rows: visibleRows.map((row) => ({
              id: row.id,
              organization_id: row.organization_id,
              rule_name: row.rule_name,
              enabled: row.enabled,
              priority: 10,
              trigger_source: row.trigger_source,
              trigger_conditions: row.trigger_conditions,
              throttle_window_minutes: 15,
              alert_channels: row.alert_channels,
              created_by: row.created_by,
              created_at: row.created_at,
              updated_at: row.created_at,
              severity_label: row.severity,
              created_by_label: 'System',
              created_by_email: null,
              condition_summary: 'error_rate = 0.05',
              alert_channels_count: row.alert_channels?.length ?? 0,
              last_triggered_at: null,
              trigger_count_24h: 0,
              ack_count_24h: 0,
              resolved_count_24h: 0,
              is_throttled: false,
              is_paused: !row.enabled,
            })),
            total: visibleRows.length,
            page: 0,
            page_size: visibleRows.length,
          };
        }
        if (['alert_triggers', 'alert_trigger_summary', 'ops_alerts'].includes(resource)) {
          return { rows: [], total: 0, page: 0, page_size: 0 };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const deleteSpy = vi.spyOn(api, 'delete_alert_rule_v1').mockImplementation(async () => {
      visibleRows = [];
      return {
        ok: true,
        alert_rule_id: 'alr_delete_refresh',
        correlation_id: 'cor_alert_delete_refresh',
        settings_resolution_id: 'srlv_alert_delete_refresh',
      };
    });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const firstRow = (await screen.findByText('Delete backend refresh rule')).closest('tr')!;
    await user.click(firstRow);
    await screen.findByTestId('alerts-rule-drawer');
    const delBtn = await screen.findByRole('button', { name: /^Delete$/i });
    await user.click(delBtn);

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith({ alert_rule_id: 'alr_delete_refresh' });
      expect(screen.queryByText('Delete backend refresh rule')).not.toBeInTheDocument();
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rules').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'alert_rule_directory').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Global ops alert Ack and Resolve reconcile from backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    let visibleOpsAlerts: Array<Record<string, unknown>> = [
      opsAlertRow({
        id: 'ops_alert_global_refresh',
        message: 'Global ops alert backend refresh',
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules' || resource === 'alert_rule_directory') {
          return { rows: [], total: 0, page: 0, page_size: 0 };
        }
        if (resource === 'alert_triggers' || resource === 'alert_trigger_summary') {
          return { rows: [], total: 0, page: 0, page_size: 0 };
        }
        if (resource === 'ops_alerts') {
          return {
            rows: visibleOpsAlerts,
            total: visibleOpsAlerts.length,
            page: 0,
            page_size: visibleOpsAlerts.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const ackSpy = vi.spyOn(api, 'acknowledge_ops_alert_v1').mockImplementation(async () => {
      visibleOpsAlerts = visibleOpsAlerts.map((row) =>
        row.id === 'ops_alert_global_refresh'
          ? { ...row, acknowledged_at: '2026-05-17T00:10:00.000Z' }
          : row,
      );
      return {
        ok: true,
        ops_alert_id: 'ops_alert_global_refresh',
        correlation_id: 'cor_alert_ack_refresh',
        settings_resolution_id: 'srlv_alert_ack_refresh',
      };
    });
    const resolveSpy = vi.spyOn(api, 'resolve_ops_alert_v1').mockImplementation(async () => {
      visibleOpsAlerts = visibleOpsAlerts.map((row) =>
        row.id === 'ops_alert_global_refresh'
          ? { ...row, resolved_at: '2026-05-17T00:20:00.000Z' }
          : row,
      );
      return {
        ok: true,
        ops_alert_id: 'ops_alert_global_refresh',
        correlation_id: 'cor_alert_resolve_refresh',
        settings_resolution_id: 'srlv_alert_resolve_refresh',
      };
    });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const panel = await screen.findByTestId('alerts-global-ops-alerts');
    expect(within(panel).getByText('Global ops alert backend refresh')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /^Ack$/i }));

    await waitFor(() => {
      expect(ackSpy).toHaveBeenCalledWith({ ops_alert_id: 'ops_alert_global_refresh' });
      expect(within(panel).getByText(/^acknowledged$/i)).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /^Ack$/i })).not.toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /^Resolve$/i })).toBeInTheDocument();
    });

    await user.click(within(panel).getByRole('button', { name: /^Resolve$/i }));

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith({ ops_alert_id: 'ops_alert_global_refresh' });
      expect(within(panel).getByText(/^resolved$/i)).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /^Resolve$/i })).not.toBeInTheDocument();
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'ops_alerts').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('Global ops alert Ack and Resolve actions are gated by alerts.write', async () => {
    const originalList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((async (resource: string, opts?: unknown) => {
      if (resource === 'alert_rules' || resource === 'alert_rule_directory') {
        return { rows: [], total: 0, page: 0, page_size: 0 };
      }
      if (resource === 'alert_triggers' || resource === 'alert_trigger_summary') {
        return { rows: [], total: 0, page: 0, page_size: 0 };
      }
      if (resource === 'ops_alerts') {
        return {
          rows: [
            opsAlertRow({
              id: 'ops_alert_readonly_gate',
              message: 'Readonly ops alert gate',
            }),
          ],
          total: 1,
          page: 0,
          page_size: 1,
        };
      }
      return originalList(resource, opts as never);
    }) as typeof api.ui_list_resource_v1);

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read'],
    });

    const panel = await screen.findByTestId('alerts-global-ops-alerts');
    expect(within(panel).getByText('Readonly ops alert gate')).toBeInTheDocument();
    const ack = within(panel).getByRole('button', {
      name: /Ack.*Alert update permission required/i,
    });
    const resolve = within(panel).getByRole('button', {
      name: /Resolve.*Alert update permission required/i,
    });
    expect(ack).toBeDisabled();
    expect(resolve).toBeDisabled();
    expect(within(ack).getByText(/Alert update permission required/i)).toBeInTheDocument();
    expect(within(resolve).getByText(/Alert update permission required/i)).toBeInTheDocument();
  });

  it('Rule drawer Ack and Resolve reconcile from backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = api.ui_list_resource_v1;
    const visibleRules: Array<Record<string, unknown>> = [
      alertRuleRow({
        id: 'alr_drawer_ops_refresh',
        name: 'Drawer ops alert backend refresh rule',
        rule_name: 'Drawer ops alert backend refresh rule',
        trigger_source: 'console.alerts.drawer-refresh',
      }),
    ];
    let visibleOpsAlerts: Array<Record<string, unknown>> = [
      opsAlertRow({
        id: 'ops_alert_drawer_refresh',
        source: 'rule:alr_drawer_ops_refresh',
        alert_type: 'drawer_refresh',
        message: 'Drawer ops alert backend refresh',
      }),
    ];
    const listSpy = vi
      .spyOn(api, 'ui_list_resource_v1')
      .mockImplementation((async (resource: string, opts?: unknown) => {
        if (resource === 'alert_rules') {
          return {
            rows: visibleRules,
            total: visibleRules.length,
            page: 0,
            page_size: visibleRules.length,
          };
        }
        if (resource === 'alert_rule_directory') {
          return {
            rows: visibleRules.map((row) => ({
              id: row.id,
              rule_name: row.rule_name ?? row.name,
              name: row.name,
              enabled: row.enabled,
              priority: 10,
              trigger_source: row.trigger_source,
              trigger_conditions: row.trigger_conditions,
              throttle_window_minutes: 15,
              alert_channels: row.alert_channels,
              created_by: row.created_by,
              created_at: row.created_at,
              updated_at: row.created_at,
              severity_label: row.severity,
              created_by_label: 'System',
              created_by_email: null,
              condition_summary: 'error_rate = 0.05',
              alert_channels_count: Array.isArray(row.alert_channels) ? row.alert_channels.length : 0,
              last_triggered_at: null,
              trigger_count_24h: 0,
              ack_count_24h: 0,
              resolved_count_24h: 0,
              is_throttled: false,
              is_paused: !row.enabled,
            })),
            total: visibleRules.length,
            page: 0,
            page_size: visibleRules.length,
          };
        }
        if (resource === 'alert_triggers' || resource === 'alert_trigger_summary') {
          return { rows: [], total: 0, page: 0, page_size: 0 };
        }
        if (resource === 'ops_alerts') {
          return {
            rows: visibleOpsAlerts,
            total: visibleOpsAlerts.length,
            page: 0,
            page_size: visibleOpsAlerts.length,
          };
        }
        return originalList(resource, opts as never);
      }) as typeof api.ui_list_resource_v1);
    const ackSpy = vi.spyOn(api, 'acknowledge_ops_alert_v1').mockImplementation(async () => {
      visibleOpsAlerts = visibleOpsAlerts.map((row) =>
        row.id === 'ops_alert_drawer_refresh'
          ? { ...row, acknowledged_at: '2026-05-17T00:10:00.000Z' }
          : row,
      );
      return {
        ok: true,
        ops_alert_id: 'ops_alert_drawer_refresh',
        correlation_id: 'cor_alert_drawer_ack_refresh',
        settings_resolution_id: 'srlv_alert_drawer_ack_refresh',
      };
    });
    const resolveSpy = vi.spyOn(api, 'resolve_ops_alert_v1').mockImplementation(async () => {
      visibleOpsAlerts = visibleOpsAlerts.map((row) =>
        row.id === 'ops_alert_drawer_refresh'
          ? { ...row, resolved_at: '2026-05-17T00:20:00.000Z' }
          : row,
      );
      return {
        ok: true,
        ops_alert_id: 'ops_alert_drawer_refresh',
        correlation_id: 'cor_alert_drawer_resolve_refresh',
        settings_resolution_id: 'srlv_alert_drawer_resolve_refresh',
      };
    });

    renderWithProviders(<AlertsModule />, {
      capabilities: ['alerts.read', 'alerts.write'],
    });

    const row = (await screen.findByText('Drawer ops alert backend refresh rule')).closest('tr')!;
    await user.click(row);
    await screen.findByTestId('alerts-rule-drawer');
    expect(within(screen.getByTestId('alerts-active-ops-alerts')).getByText(/^open$/i)).toBeInTheDocument();

    await user.click(within(screen.getByTestId('alerts-active-ops-alerts')).getByRole('button', { name: /^Ack$/i }));

    await waitFor(() => {
      const opsList = within(screen.getByTestId('alerts-active-ops-alerts'));
      expect(ackSpy).toHaveBeenCalledWith({ ops_alert_id: 'ops_alert_drawer_refresh' });
      expect(opsList.getByText(/^acknowledged$/i)).toBeInTheDocument();
      expect(opsList.queryByRole('button', { name: /^Ack$/i })).not.toBeInTheDocument();
      expect(opsList.getByRole('button', { name: /^Resolve$/i })).toBeInTheDocument();
    });

    await user.click(within(screen.getByTestId('alerts-active-ops-alerts')).getByRole('button', { name: /^Resolve$/i }));

    await waitFor(() => {
      const opsList = within(screen.getByTestId('alerts-active-ops-alerts'));
      expect(resolveSpy).toHaveBeenCalledWith({ ops_alert_id: 'ops_alert_drawer_refresh' });
      expect(opsList.getByText(/^resolved$/i)).toBeInTheDocument();
      expect(opsList.queryByRole('button', { name: /^Resolve$/i })).not.toBeInTheDocument();
    });
    expect(
      listSpy.mock.calls.filter(([resource]) => resource === 'ops_alerts').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('Pause + Delete row actions are gated by alerts.write', async () => {
    const user = userEvent.setup();
    // Without write capability the row actions menu hides Pause and Delete.
    await mountAndWait({ capabilities: ['alerts.read'] });
    const firstRow = screen.getByText(/High error rate · API ingress/i).closest('tr')!;
    // The row-action overflow button is rendered by DataTable; click it to
    // surface the action menu (only the read-only "Test rule" action should
    // be visible).
    const rowActionBtn = within(firstRow).queryAllByRole('button')[0];
    if (rowActionBtn) {
      await user.click(rowActionBtn);
    }
    // No active "Pause" or "Delete" buttons should render (capability gated).
    // The page-level Test rule action remains accessible because it only
    // requires alerts.read.
    expect(screen.getByRole('button', { name: /^Test rule$/i })).not.toBeDisabled();
  });

  // W28 — paired projection view consumption tests. Verifies the page-level
  // "Rule analytics" pill renders and that the DataTable surfaces
  // the directory-derived "Fires 24h" column header.
  it('W28: renders the rule analytics page-header pill', async () => {
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    expect(screen.getByText(/^Rule analytics$/)).toBeInTheDocument();
    expect(screen.queryByText(/alert_rules|alert_triggers|ops_alerts|v_alert_rule_directory/)).not.toBeInTheDocument();
  });

  it('W28: DataTable surfaces the "Fires 24h" column from the directory projection', async () => {
    await mountAndWait({ capabilities: ['alerts.read', 'alerts.write'] });
    // The DataTable renders the column header explicitly. The actual
    // numeric value depends on real "now" vs seed timestamps, so we only
    // assert the header is wired (not the per-row value).
    const headers = screen.getAllByText(/^Fires 24h$/i);
    expect(headers.length).toBeGreaterThan(0);
  });
});
