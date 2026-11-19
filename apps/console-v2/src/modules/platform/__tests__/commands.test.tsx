// commands.test.tsx — verifies the catalog renders, search filters cards, and
// routes every command into the owning module workflow.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { CommandsModule } from '@/modules/platform/commands';
import * as api from '@/lib/api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CommandsModule', () => {
  it('renders the command catalog cards', async () => {
    renderWithProviders(<CommandsModule />);
    expect(await screen.findByTestId('command-card-shipments.create')).toBeInTheDocument();
  });

  it('search filters the catalog', async () => {
    renderWithProviders(<CommandsModule />);
    const search = await screen.findByTestId('commands-search');
    fireEvent.change(search, { target: { value: 'warehouse' } });
    expect(await screen.findByTestId('command-card-warehouse.transfer_execute')).toBeInTheDocument();
    expect(screen.queryByTestId('command-card-shipments.create')).not.toBeInTheDocument();
  });

  it('section filter is reflected via tab class', async () => {
    renderWithProviders(<CommandsModule />);
    const tab = await screen.findByTestId('commands-section-Warehouse');
    fireEvent.click(tab);
    expect(tab.className).toContain('is-active');
  });

  it('fails closed for generic catalog commands and links operators to the owning module', async () => {
    renderWithProviders(<CommandsModule />, { capabilities: ['all'] });
    const card = await screen.findByTestId('command-card-service_offerings.create');
    expect(within(card).getByText('owner workflow')).toBeInTheDocument();
    expect(within(card).getByTestId('command-owner-service_offerings.create')).toHaveAttribute(
      'href',
      '/catalog/service-offerings',
    );
    expect(within(card).queryByRole('button', { name: /Run/i })).not.toBeInTheDocument();
  });

  it('does not expose ui_execute_command_v1 catalog rows as runnable actions', async () => {
    const runSpy = vi.spyOn(api, 'runCommand').mockResolvedValue({} as never);
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'generic.command',
        label: 'Generic command',
        section: 'Platform',
        execution: 'rpc',
        target: 'ui_execute_command_v1',
        capability: null,
        route_targets: { console: { path: '/platform/commands' } },
      },
    ]);

    renderWithProviders(<CommandsModule />, { capabilities: ['all'] });

    const card = await screen.findByTestId('command-card-generic.command');
    expect(within(card).getByText('owner workflow')).toBeInTheDocument();
    expect(within(card).getByTestId('command-owner-generic.command')).toHaveAttribute(
      'href',
      '/platform/commands',
    );
    expect(within(card).queryByRole('button', { name: /Run/i })).not.toBeInTheDocument();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('routes commands backed by canonical targets to the owning module workflow', async () => {
    const runSpy = vi.spyOn(api, 'runCommand');
    renderWithProviders(<CommandsModule />, { capabilities: ['all'] });
    const card = await screen.findByTestId('command-card-shipments.amend');
    expect(within(card).getByText('owner workflow')).toBeInTheDocument();
    expect(within(card).getByTestId('command-owner-shipments.amend')).toHaveAttribute(
      'href',
      '/operate/shipments',
    );
    expect(within(card).queryByRole('button', { name: /Run/i })).not.toBeInTheDocument();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('normalizes live object-shaped execution metadata before routing to the owner workflow', async () => {
    const runSpy = vi.spyOn(api, 'runCommand');
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'workflow_runs.replay',
        label: 'Replay workflow run',
        section: 'Workflows',
        execution: { type: 'rpc', rpc: 'progress_workflow_run' },
        capability: null,
        route_targets: { console: { path: '/workflows/runs' } },
      },
    ]);

    renderWithProviders(<CommandsModule />, { capabilities: ['all'] });

    const card = await screen.findByTestId('command-card-workflow_runs.replay');
    expect(within(card).getByText('rpc')).toBeInTheDocument();
    expect(within(card).getByText('target: progress_workflow_run')).toBeInTheDocument();
    expect(within(card).getByText('owner workflow')).toBeInTheDocument();
    expect(within(card).getByTestId('command-owner-workflow_runs.replay')).toHaveAttribute(
      'href',
      '/workflows/runs',
    );
    expect(within(card).queryByRole('button', { name: /Run/i })).not.toBeInTheDocument();
    expect(runSpy).not.toHaveBeenCalled();
  });
});
