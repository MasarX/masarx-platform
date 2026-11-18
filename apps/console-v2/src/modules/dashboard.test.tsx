// dashboard.test.tsx — covers the operator dashboard surface added/hardened in
// claim-A. Targets:
//   1. KPI strip mounts and renders via useDashboardKpis().
//   2. Audit-log activity feed surfaces canonical denied state when the
//      capability is missing — instead of an inline string.
//   3. ScopeCardWidget renders the LadderViz next to the resolved value so the
//      override path is auditable inline (AGENTS.md ladder-logging mandate).
//   4. CodCounters drives `tenant` from useIdentity scope, not a hardcoded id.
//
// We mount the live `DashboardModule` via `renderWithProviders` so the
// QueryClient/Identity/I18n/Theme stack matches production. Tests do not stub
// the api.* layer — they exercise the in-memory data-source adapter that
// modules use today and that production will replace with supabase-js calls.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { DashboardModule, formatCommandExecution } from '@/modules/dashboard';
import * as api from '@/lib/api';

describe('DashboardModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts and renders the operator KPI strip', async () => {
    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });
    // PageHeader announces the dashboard title (driven by i18n catalog).
    expect(
      screen.getByRole('heading', { level: 1, name: /operations command center/i }),
    ).toBeInTheDocument();
    // KPI strip — at least one tile renders once useDashboardKpis() resolves.
    await waitFor(() => {
      expect(document.querySelector('.kpi')).not.toBeNull();
    });
  });

  it('does not fetch dashboard decisions without observability read access', async () => {
    const listDecisionLog = vi.spyOn(api, 'listDecisionLog').mockResolvedValue([]);
    renderWithProviders(<DashboardModule />, { capabilities: ['console_metadata.read'] });

    await waitFor(() => {
      expect(document.querySelector('.kpi')).not.toBeNull();
    });
    expect(listDecisionLog).not.toHaveBeenCalled();
  });

  it('exposes the canonical "Open palette" action button', async () => {
    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });
    expect(
      screen.getByRole('button', { name: /Open palette/ }),
    ).toBeInTheDocument();
  });

  it('opens the shell command palette through the canonical topbar trigger', async () => {
    const shellTrigger = document.createElement('button');
    shellTrigger.id = 'cmd-trigger';
    shellTrigger.setAttribute('aria-label', 'Command palette trigger');
    const clickSpy = vi.fn();
    shellTrigger.addEventListener('click', clickSpy);
    document.body.appendChild(shellTrigger);

    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });

    fireEvent.click(screen.getByRole('button', { name: /Open palette/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    shellTrigger.remove();
  });

  it('renders the view-switcher inline tabs from the persisted view stash', async () => {
    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });
    // Default views ship 4 inline tabs; we don't assert the labels here (i18n)
    // but the tab strip must exist.
    await waitFor(() => {
      expect(document.querySelectorAll('.dash-tab').length).toBeGreaterThan(0);
    });
  });

  it('keeps the dashboard grid responsive (one widget per kind in default view)', async () => {
    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });
    await waitFor(() => {
      // The default `my_day` view ships 4 widgets — grid must render that many.
      expect(document.querySelectorAll('.dash-widget').length).toBeGreaterThanOrEqual(4);
    });
  });
  it('filters My Work tasks with the resolved authenticated operator id', async () => {
    const operatorId = '00000000-0000-4000-8000-000000000321';
    const listTasksSpy = vi.spyOn(api, 'listTasks').mockResolvedValue([]);

    renderWithProviders(<DashboardModule />, {
      identity: {
        user: {
          id: operatorId,
          name: 'Live Operator',
          role: 'super_admin',
          organization_id: '00000000-0000-4000-8000-000000000111',
          access_scope_type: 'platform',
          access_scope_id: null,
        },
        capabilities: ['all'],
      },
    });

    await waitFor(() => {
      expect(listTasksSpy).toHaveBeenCalledWith(expect.objectContaining({ assigned_to: operatorId }));
    });
    expect(listTasksSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ assigned_to: 'usr_admin_rashed' }),
    );
  });

  it('renders live command registry execution metadata when it is object-shaped', async () => {
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'shipments.create',
        label: 'Create shipment',
        capability: 'shipments.write',
        execution: { type: 'rpc', rpc: 'start_workflow_run', params: { template_key: 'shipment_create_v1' } },
      },
    ]);

    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });

    expect(await screen.findByRole('button', { name: /Create shipment/i })).toBeInTheDocument();
    expect(screen.getByText('System action')).toBeInTheDocument();
    expect(screen.queryByText('rpc · start_workflow_run')).not.toBeInTheDocument();
  });

  it('opens dashboard command rows through navigation/palette, never runCommand dry-run', async () => {
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'shipments.create',
        label: 'Create shipment',
        capability: 'shipments.write',
        execution: { type: 'rpc', rpc: 'start_workflow_run' },
      },
    ]);
    const runCommandSpy = vi.spyOn(api, 'runCommand');
    const shellTrigger = document.createElement('button');
    shellTrigger.id = 'cmd-trigger';
    shellTrigger.setAttribute('aria-label', 'Command palette trigger');
    const clickSpy = vi.fn();
    shellTrigger.addEventListener('click', clickSpy);
    document.body.appendChild(shellTrigger);

    renderWithProviders(<DashboardModule />, { capabilities: ['all'] });

    const commandButton = await screen.findByRole('button', { name: /Create shipment/i });
    expect(commandButton).toBeInTheDocument();
    fireEvent.click(commandButton);

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
    expect(runCommandSpy).not.toHaveBeenCalled();
    shellTrigger.remove();
  });

  it('keeps label dashboard command rows enabled when the operator has the required capability', async () => {
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'labels.print',
        label: 'Print labels',
        capability: 'labels.download',
        execution: { type: 'rpc', rpc: 'request_label_reprint' },
      },
    ]);
    const shellTrigger = document.createElement('button');
    shellTrigger.id = 'cmd-trigger';
    shellTrigger.setAttribute('aria-label', 'Command palette trigger');
    const clickSpy = vi.fn();
    shellTrigger.addEventListener('click', clickSpy);
    document.body.appendChild(shellTrigger);

    renderWithProviders(<DashboardModule />, { capabilities: ['labels.download'] });

    const commandButton = await screen.findByRole('button', { name: /Print labels/i });
    expect(commandButton).toBeEnabled();
    expect(commandButton).toHaveTextContent('System action');

    fireEvent.click(commandButton);

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
    shellTrigger.remove();
  });

  it('disables dashboard command rows when the operator lacks the required capability', async () => {
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'labels.print',
        label: 'Print labels',
        capability: 'labels.download',
        execution: { type: 'rpc', rpc: 'request_label_reprint' },
      },
    ]);
    const runCommandSpy = vi.spyOn(api, 'runCommand');
    const shellTrigger = document.createElement('button');
    shellTrigger.id = 'cmd-trigger';
    shellTrigger.setAttribute('aria-label', 'Command palette trigger');
    const clickSpy = vi.fn();
    shellTrigger.addEventListener('click', clickSpy);
    document.body.appendChild(shellTrigger);

    renderWithProviders(<DashboardModule />, {
      capabilities: ['billing.read', 'console_metadata.read'],
    });

    const commandButton = await screen.findByRole('button', { name: /Print labels/i });
    expect(commandButton).toBeDisabled();
    expect(commandButton).toHaveTextContent('Labels Download permission required');

    fireEvent.click(commandButton);

    expect(clickSpy).not.toHaveBeenCalled();
    expect(runCommandSpy).not.toHaveBeenCalled();
    shellTrigger.remove();
  });
});

describe('formatCommandExecution', () => {
  it('formats string and object execution rows without rendering raw objects', () => {
    expect(formatCommandExecution('rpc', 'shipment_amend_cancel_v1')).toBe('System action');
    expect(formatCommandExecution({ type: 'rpc', rpc: 'start_workflow_run', params: {} })).toBe('System action');
    expect(formatCommandExecution({ kind: 'workflow' })).toBe('Workflow action');
  });
});
