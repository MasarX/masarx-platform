// runs.test.tsx — Run history (Claim D + Phase C5) coverage.
// - Asserts the table renders with status chips and the seeded WFR rows.
// - Asserts opening a row launches the drawer with the canonical Gantt frame.
// - Asserts capability gating on bulk + drawer actions.
// - Phase C5: Cancel-row fires close_workflow_run; Replay-row opens the drawer
//   with replay=true (so the drawer auto-replays through useReplayWorkflowRun).
// - W11-6 (CLAIM-WORKFLOWS-DEFERRED): Triggers + Schedules tabs surface
//   workflow_run_triggers + workflow_schedule_triggers rows, with capability
//   gating on schedule "Run now" action.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RunsModule } from '@/modules/workflows/runs';
import { workflowRunTraceSearch } from '@/modules/workflows/_runs/trace-search';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';

describe('RunsModule (Workflow Run History)', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/workflows/runs');
  });

  it('mounts and lists workflow run history rows without raw table labels', async () => {
    renderWithProviders(<RunsModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('history')).toBeInTheDocument());
    // First seeded run is WFR-3221 (running).
    await waitFor(() => expect(screen.getByText('WFR-3221')).toBeInTheDocument());
    expect(screen.getByText('Run history · step timeline')).toBeInTheDocument();
    expect(screen.queryByText('workflow_runs · workflow_run_steps')).not.toBeInTheDocument();
    expect(screen.queryByText(/workflow_run_status\/undefined/)).not.toBeInTheDocument();
  });

  it('shows a denied state without issuing protected workflow run reads', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    try {
      renderWithProviders(<RunsModule />, { capabilities: [] });

      expect(await screen.findByText(/You do not have permission to view workflow runs/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).not.toContain('workflow_run_directory');
        expect(resources).not.toContain('workflow_templates');
        expect(resources).not.toContain('workflow_run_triggers');
        expect(resources).not.toContain('workflow_schedule_triggers');
      });
      expect(screen.queryByRole('button', { name: /Refresh runs/i })).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('renders workflow binding run templates with operator labels', async () => {
    const originalListResource = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
        if (resource === 'workflow_run_directory') {
          return {
            rows: [
              {
                id: 'wfr_binding_tenant_signup',
                run_id: 'WFR-BINDING',
                template_id: 'tpl_binding_tenant_signup',
                workflow_template_id: 'tpl_binding_tenant_signup',
                template_name: 'workflow_binding.tenant_signup.review_requested.global.v1',
                started_at: '2026-05-07T01:27:00.000Z',
                duration_ms: 1200,
                status: 'completed',
                workflow_status: 'completed',
                correlation_id: 'cor_binding_tenant_signup',
                triggered_by: 'api',
              },
            ],
            total: 1,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (resource === 'workflow_templates') {
          return {
            rows: [
              {
                id: 'tpl_binding_tenant_signup',
                template_id: 'workflow_binding.tenant_signup.review_requested.global.v1',
                name: 'workflow_binding.tenant_signup.review_requested.global.v1',
                version: '1',
                steps: [],
              },
            ],
            total: 1,
            page: 0,
            page_size: 50,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        if (
          resource === 'workflow_run_triggers' ||
          resource === 'workflow_schedule_triggers' ||
          resource === 'workflow_run_steps'
        ) {
          return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
            ReturnType<typeof apiMod.ui_list_resource_v1>
          >;
        }
        return originalListResource(resource, opts);
      },
    );

    try {
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('WFR-BINDING')).toBeInTheDocument());
      expect(screen.getByText('Tenant Signup - Review Requested')).toBeInTheDocument();
      expect(document.body.textContent ?? '').not.toContain('workflow_binding.');
    } finally {
      listSpy.mockRestore();
    }
  });

  it('opens the drawer Gantt timeline when a row is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
    await user.click(screen.getByText('WFR-3220'));
    // Drawer header surfaces "Step timeline" eyebrow on real Gantt body.
    await waitFor(() => expect(screen.getByText('Step timeline')).toBeInTheDocument());
  });

  it('View trace row action carries the workflow run correlation_id search payload', () => {
    expect(workflowRunTraceSearch({ correlation_id: 'cor_9821' })).toEqual({
      cor: 'cor_9821',
    });
    expect(workflowRunTraceSearch({ correlation_id: null })).toBeUndefined();
  });

  it('does not render header-only replay affordances without a selected run', async () => {
    // Wave 5 RE-AUDIT (WORKFLOWS.md P1): workflow lifecycle write actions
    // gate on the canonical `workflows.write` capability — matches B6 RPCs
    // and the seed-raw/navigation.js workflow nav.
    renderWithProviders(<RunsModule />, {
      capabilities: ['shipments.read', 'workflows.read'], // explicitly no workflows.write
    });
    // Wait for loading to clear and the real refresh action to render.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /Refresh runs/ })).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(screen.queryByRole('button', { name: /Replay batch/ })).not.toBeInTheDocument();
  });

  it('marks selected runs inspected only after backend event readback', async () => {
    const user = userEvent.setup();
    const logSpy = vi.spyOn(apiMod, 'ui_log_event_v1').mockResolvedValue({
      ok: true,
      app: 'console',
      logged_at: '2026-05-30T10:00:00.000Z',
      event_id: 'evt-workflow-run-inspected-1',
      readback: {
        id: 'evt-workflow-run-inspected-1',
        event_type: 'workflow_run.inspected',
      },
    } as never);
    try {
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('WFR-3221')).toBeInTheDocument());
      const rowSelectors = await screen.findAllByRole('checkbox', { name: /Select row/ });
      await user.click(rowSelectors[0]!);
      await user.click(await screen.findByRole('button', { name: /Mark inspected/ }));

      await waitFor(() => expect(logSpy).toHaveBeenCalled());
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'workflow_run.inspected',
          workflow_run_id: expect.any(String),
          payload: expect.objectContaining({
            surface: 'console_v2.workflow_runs.bulk_mark_inspected',
          }),
        }),
        'console',
        { requireReadback: true },
      );
      const readback = await screen.findByTestId('workflow-run-inspection-readback');
      expect(within(readback).getByText('Confirmed from saved data')).toBeInTheDocument();
      expect(within(readback).getByText('activity recorded')).toBeInTheDocument();
      expect(within(readback).getByText('reference recorded')).toBeInTheDocument();
    } finally {
      logSpy.mockRestore();
    }
  });

  describe('Phase C5 mutation specs', () => {
    // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
    // signature emitted by `vi.spyOn` collides with the loose
    // `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` type
    // when the module's export changes between minor versions. We assert against
    // recorded call args directly below.
    let progressSpy: ReturnType<typeof vi.spyOn> & {
      mock: { calls: unknown[][] };
      mockRestore: () => void;
    };
    let closeSpy: ReturnType<typeof vi.spyOn> & {
      mock: { calls: unknown[][] };
      mockRestore: () => void;
    };
    beforeEach(() => {
      progressSpy = vi.spyOn(apiMod, 'progress_workflow_run') as unknown as typeof progressSpy;
      closeSpy = vi.spyOn(apiMod, 'close_workflow_run') as unknown as typeof closeSpy;
    });
    afterEach(() => {
      progressSpy.mockRestore();
      closeSpy.mockRestore();
    });

    it('Cancel run row action fires close_workflow_run (Phase C5)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('WFR-3221')).toBeInTheDocument());
      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      const cancel = await screen.findByRole('option', { name: /Cancel run/ });
      await user.click(cancel);
      await waitFor(() => {
        expect(closeSpy).toHaveBeenCalled();
      });
      const args = closeSpy.mock.calls[0];
      expect(args?.[0]).toBeTruthy();
      expect(args?.[1]).toBe('cancelled');
    });

    it('Cancel run row action refreshes same-table directory readback without reload', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let runStatus = 'in_progress';
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_directory') {
            return {
              rows: [
                {
                  id: 'wfr_cancel_refresh',
                  run_id: 'WFR-CANCEL',
                  template_id: 'tpl_cancel_refresh',
                  workflow_template_id: 'tpl_cancel_refresh',
                  template_name: 'cancel_refresh_v1',
                  started_at: '2026-05-22T14:30:00.000Z',
                  completed_at: runStatus === 'cancelled' ? '2026-05-22T14:31:00.000Z' : null,
                  duration_ms: runStatus === 'cancelled' ? 60_000 : null,
                  status: runStatus,
                  workflow_status: runStatus,
                  triggered_by: 'manual',
                  correlation_id: 'cor-cancel-refresh',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_cancel_refresh',
                  template_id: 'cancel_refresh_v1',
                  name: 'cancel_refresh_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (
            resource === 'workflow_run_triggers' ||
            resource === 'workflow_schedule_triggers' ||
            resource === 'workflow_run_steps'
          ) {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      closeSpy.mockImplementation(async () => {
        runStatus = 'cancelled';
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(() => expect(screen.getByText('WFR-CANCEL')).toBeInTheDocument());
        expect(screen.getByText('In Progress')).toBeInTheDocument();
        const directoryReadsBeforeCancel = listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length;

        const rowActions = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(rowActions[0]!);
        await user.click(await screen.findByRole('option', { name: /Cancel run/ }));

        await waitFor(() => expect(closeSpy).toHaveBeenCalledWith('wfr_cancel_refresh', 'cancelled'));
        await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument());
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length).toBeGreaterThan(
          directoryReadsBeforeCancel,
        );
      } finally {
        listSpy.mockRestore();
      }
    });

    it('Cancel run row action is disabled for terminal failed runs', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_directory') {
            return {
              rows: [
                {
                  id: 'wfr_failed_terminal',
                  run_id: 'WFR-FAILED',
                  template_id: 'tpl_failed_terminal',
                  workflow_template_id: 'tpl_failed_terminal',
                  template_name: 'failed_terminal_v1',
                  started_at: '2026-05-22T14:30:00.000Z',
                  completed_at: '2026-05-22T14:31:00.000Z',
                  duration_ms: 60_000,
                  status: 'failed',
                  workflow_status: 'failed',
                  triggered_by: 'manual',
                  correlation_id: 'cor-failed-terminal',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_failed_terminal',
                  template_id: 'failed_terminal_v1',
                  name: 'failed_terminal_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (
            resource === 'workflow_run_triggers' ||
            resource === 'workflow_schedule_triggers' ||
            resource === 'workflow_run_steps'
          ) {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(() => expect(screen.getByText('WFR-FAILED')).toBeInTheDocument());

        const rowActions = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(rowActions[0]!);
        const cancel = await screen.findByRole('option', { name: /Cancel run/ });
        expect(cancel).toHaveClass('is-disabled');
        expect(cancel).toHaveTextContent('Workflow status Failed cannot be cancelled');
        await user.click(cancel).catch(() => undefined);

        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
      }
    });
  });

  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — Triggers + Schedules tabs surface
  // canonical workflow_run_triggers + workflow_schedule_triggers rows.
  describe('W11-6 Triggers + Schedules tabs', () => {
    beforeEach(() => {
      // Reset hash state so each test starts on the default Runs tab.
      window.location.hash = '#/workflows/runs';
    });

    it('renders the page-level tab strip with all three tabs', async () => {
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('history')).toBeInTheDocument());
      const tabs = await screen.findByTestId('wf-runs-tabs');
      expect(tabs).toBeInTheDocument();
      expect(within(tabs).getByTestId('wf-runs-tab-runs')).toBeInTheDocument();
      expect(within(tabs).getByTestId('wf-runs-tab-triggers')).toBeInTheDocument();
      expect(within(tabs).getByTestId('wf-runs-tab-schedules')).toBeInTheDocument();
    });

    it('switches to the Triggers tab and lists workflow_run_triggers rows', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('WFR-3221')).toBeInTheDocument());
      const triggersTab = screen.getByTestId('wf-runs-tab-triggers');
      await user.click(triggersTab);
      // Seeded source template name from workflow_run_triggers (wrt_001).
      await waitFor(() =>
        expect(screen.getAllByText('Exampleparcel KSA inbound intake').length).toBeGreaterThan(0),
      );
      // Clean URL deep-link is updated so the tab survives reload.
      expect(window.location.search).toContain('tab=triggers');
    });

    it('creates a workflow run trigger without platform scope payload and shows same-tab backend readback without reload', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let createdTrigger: Record<string, unknown> | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_triggers') {
            const rows = createdTrigger ? [createdTrigger] : [];
            return {
              rows,
              total: rows.length,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_trigger_source',
                  template_id: 'trigger_source_v1',
                  name: 'trigger_source_v1',
                  version: '1',
                  steps: [],
                },
                {
                  id: 'tpl_trigger_target',
                  template_id: 'trigger_target_v1',
                  name: 'trigger_target_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 2,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory' || resource === 'workflow_schedule_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_run_trigger_v1').mockImplementation(async (args) => {
        createdTrigger = {
          id: 'trigger_author_readback',
          source_workflow_template_id: args.source_workflow_template_id,
          source_template_name: 'trigger_source_v1',
          target_workflow_template_id: args.target_workflow_template_id,
          target_template_name: 'trigger_target_v1',
          source_statuses: args.source_statuses ?? ['succeeded'],
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: 'org_trigger_author',
          enabled: args.enabled !== false,
          last_scanned_completed_at: null,
          created_at: '2026-05-26T10:00:00.000Z',
          updated_at: '2026-05-26T10:00:00.000Z',
          notes: args.notes ?? null,
        };
        return {
          ok: true,
          status: 'created',
          workflow_run_trigger_id: 'trigger_author_readback',
          source_workflow_template_id: args.source_workflow_template_id,
          target_workflow_template_id: args.target_workflow_template_id,
          source_statuses: args.source_statuses ?? ['succeeded'],
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: 'org_trigger_author',
          enabled: args.enabled !== false,
          notes: args.notes ?? null,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-triggers')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-triggers'));
        const triggerReadsBefore = listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_triggers').length;
        await user.click(await screen.findByRole('button', { name: /^New trigger/ }));
        fireEvent.change(await screen.findByLabelText('Trigger context patch JSON'), {
          target: { value: '{"handoff":"ops"}' },
        });
        await user.type(await screen.findByLabelText('Trigger notes'), 'operator trigger proof');
        await user.click(await screen.findByRole('button', { name: /^Create trigger/ }));

        await waitFor(() => expect(createSpy).toHaveBeenCalledWith({
          source_workflow_template_id: 'tpl_trigger_source',
          target_workflow_template_id: 'tpl_trigger_target',
          source_statuses: ['succeeded'],
          context_patch: { handoff: 'ops' },
          enabled: true,
          notes: 'operator trigger proof',
          scope_id: expect.any(String),
        }));
        expect(Object.prototype.hasOwnProperty.call(createSpy.mock.calls[0]?.[0] ?? {}, 'scope_type')).toBe(false);
        const readback = await screen.findByTestId('workflow-run-trigger-create-readback');
        expect(within(readback).getByText('Created')).toBeInTheDocument();
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(within(readback).getByText('operator trigger proof')).toBeInTheDocument();
        const triggersTable = screen.getByRole('table');
        expect(within(triggersTable).getByText('trigger_source_v1')).toBeInTheDocument();
        expect(within(triggersTable).getByText('trigger_target_v1')).toBeInTheDocument();
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_triggers').length).toBeGreaterThan(
          triggerReadsBefore,
        );
      } finally {
        createSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('creates workflow run triggers in the selected active tenant for platform operators', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let createdTrigger: Record<string, unknown> | null = null;
      const activeTenantId = 'org_workflow_active_tenant';
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_triggers') {
            const rows = createdTrigger ? [createdTrigger] : [];
            return { rows, total: rows.length, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                { id: 'tpl_trigger_source', template_id: 'trigger_source_v1', name: 'trigger_source_v1', version: '1', steps: [] },
                { id: 'tpl_trigger_target', template_id: 'trigger_target_v1', name: 'trigger_target_v1', version: '1', steps: [] },
              ],
              total: 2,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory' || resource === 'workflow_schedule_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_run_trigger_v1').mockImplementation(async (args) => {
        createdTrigger = {
          id: 'trigger_active_tenant_readback',
          source_workflow_template_id: args.source_workflow_template_id,
          source_template_name: 'trigger_source_v1',
          target_workflow_template_id: args.target_workflow_template_id,
          target_template_name: 'trigger_target_v1',
          source_statuses: args.source_statuses ?? ['succeeded'],
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: args.scope_id,
          enabled: args.enabled !== false,
          last_scanned_completed_at: null,
          created_at: '2026-06-01T10:00:00.000Z',
          updated_at: '2026-06-01T10:00:00.000Z',
          notes: args.notes ?? null,
        };
        return {
          ok: true,
          status: 'created',
          workflow_run_trigger_id: 'trigger_active_tenant_readback',
          source_workflow_template_id: args.source_workflow_template_id,
          target_workflow_template_id: args.target_workflow_template_id,
          source_statuses: args.source_statuses ?? ['succeeded'],
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: args.scope_id ?? null,
          enabled: args.enabled !== false,
          notes: args.notes ?? null,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, {
          capabilities: ['all'],
          identity: {
            capabilities: ['all'],
            user: {
              access_scope_type: 'platform',
              access_scope_id: null,
              organization_id: 'org_platform_home',
            },
            scope: { tenant: { id: activeTenantId, label: 'Workflow Active Tenant', rank: 2 } },
          },
        });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-triggers')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-triggers'));
        await user.click(await screen.findByRole('button', { name: /^New trigger/ }));
        await user.type(await screen.findByLabelText('Trigger notes'), 'active tenant trigger proof');
        await user.click(await screen.findByRole('button', { name: /^Create trigger/ }));

        await waitFor(() => expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
          scope_id: activeTenantId,
          notes: 'active tenant trigger proof',
        })));
        const readback = await screen.findByTestId('workflow-run-trigger-create-readback');
        expect(within(readback).getByText('Configured')).toBeInTheDocument();
      } finally {
        createSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('edits, disables, and deletes a workflow run trigger with same-tab backend readback', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let triggerRows: Array<Record<string, unknown>> = [
        {
          id: 'trigger_lifecycle_readback',
          source_workflow_template_id: 'tpl_trigger_source',
          source_template_name: 'trigger_source_v1',
          target_workflow_template_id: 'tpl_trigger_target',
          target_template_name: 'trigger_target_v1',
          source_statuses: ['succeeded'],
          context_patch: { existing: true },
          scope_type: 'tenant',
          scope_id: 'org_trigger_lifecycle',
          enabled: true,
          deleted_at: null,
          last_scanned_completed_at: null,
          created_at: '2026-06-01T10:00:00.000Z',
          updated_at: '2026-06-01T10:00:00.000Z',
          notes: 'existing trigger',
        },
      ];
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_triggers') {
            return {
              rows: triggerRows,
              total: triggerRows.length,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                { id: 'tpl_trigger_source', template_id: 'trigger_source_v1', name: 'trigger_source_v1', version: '1', steps: [] },
                { id: 'tpl_trigger_target', template_id: 'trigger_target_v1', name: 'trigger_target_v1', version: '1', steps: [] },
                { id: 'tpl_trigger_target_two', template_id: 'trigger_target_two_v1', name: 'trigger_target_two_v1', version: '1', steps: [] },
              ],
              total: 3,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory' || resource === 'workflow_schedule_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const updateSpy = vi.spyOn(apiMod, 'ui_update_workflow_run_trigger_v1').mockImplementation(async (args) => {
        triggerRows = triggerRows.map((row) => row.id === args.workflow_run_trigger_id
          ? {
              ...row,
              source_workflow_template_id: args.source_workflow_template_id ?? row.source_workflow_template_id,
              target_workflow_template_id: args.target_workflow_template_id ?? row.target_workflow_template_id,
              target_template_name: args.target_workflow_template_id === 'tpl_trigger_target_two'
                ? 'trigger_target_two_v1'
                : row.target_template_name,
              source_statuses: args.source_statuses ?? row.source_statuses,
              context_patch: args.context_patch ?? row.context_patch,
              enabled: args.enabled ?? row.enabled,
              notes: args.notes ?? row.notes,
              updated_at: '2026-06-01T10:05:00.000Z',
            }
          : row);
        const updated = triggerRows[0]!;
        return {
          ok: true,
          status: 'updated',
          workflow_run_trigger_id: String(updated.id),
          source_workflow_template_id: String(updated.source_workflow_template_id),
          target_workflow_template_id: String(updated.target_workflow_template_id),
          source_statuses: updated.source_statuses as string[],
          context_patch: updated.context_patch as Record<string, unknown>,
          scope_type: String(updated.scope_type),
          scope_id: String(updated.scope_id),
          enabled: Boolean(updated.enabled),
          notes: updated.notes ? String(updated.notes) : null,
          updated_at: String(updated.updated_at),
        };
      });
      const deleteSpy = vi.spyOn(apiMod, 'ui_delete_workflow_run_trigger_v1').mockImplementation(async (id) => {
        triggerRows = triggerRows.map((row) => row.id === id
          ? {
              ...row,
              enabled: false,
              deleted_at: '2026-06-01T10:10:00.000Z',
              updated_at: '2026-06-01T10:10:00.000Z',
            }
          : row);
        return {
          ok: true,
          status: 'deleted',
          workflow_run_trigger_id: id,
          source_workflow_template_id: 'tpl_trigger_source',
          target_workflow_template_id: 'tpl_trigger_target_two',
          scope_type: 'tenant',
          scope_id: 'org_trigger_lifecycle',
          enabled: false,
          deleted_at: '2026-06-01T10:10:00.000Z',
          workflow_trigger_fires_count: 2,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-triggers')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-triggers'));
        await waitFor(() => expect(screen.getByText('trigger_source_v1')).toBeInTheDocument());

        await user.click(screen.getAllByRole('button', { name: 'Row actions' })[0]!);
        await user.click((await screen.findAllByText('Disable trigger'))[0]!);
        await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
          workflow_run_trigger_id: 'trigger_lifecycle_readback',
          enabled: false,
          scope_id: expect.any(String),
        })));
        let readback = await screen.findByTestId('workflow-run-trigger-lifecycle-readback');
        expect(within(readback).getByText('disabled')).toBeInTheDocument();
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();

        await user.click(screen.getAllByRole('button', { name: 'Row actions' })[0]!);
        await user.click((await screen.findAllByText('Edit trigger'))[0]!);
        fireEvent.change(await screen.findByLabelText('Target workflow template'), {
          target: { value: 'tpl_trigger_target_two' },
        });
        fireEvent.change(await screen.findByLabelText('Trigger notes'), {
          target: { value: 'updated lifecycle proof' },
        });
        await user.click(await screen.findByRole('button', { name: /^Save trigger/ }));
        await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
          workflow_run_trigger_id: 'trigger_lifecycle_readback',
          target_workflow_template_id: 'tpl_trigger_target_two',
          notes: 'updated lifecycle proof',
          scope_id: expect.any(String),
        })));
        readback = await screen.findByTestId('workflow-run-trigger-lifecycle-readback');
        expect(within(readback).getByText('updated')).toBeInTheDocument();
        expect(readback).toHaveTextContent('trigger_target_two_v1');
        expect(within(readback).getByText('updated lifecycle proof')).toBeInTheDocument();

        await user.click(screen.getAllByRole('button', { name: 'Row actions' })[0]!);
        await user.click((await screen.findAllByText('Delete trigger'))[0]!);
        await user.click(await screen.findByRole('button', { name: /^Delete trigger/ }));
        await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(
          'trigger_lifecycle_readback',
          expect.any(String),
        ));
        readback = await screen.findByTestId('workflow-run-trigger-lifecycle-readback');
        expect(within(readback).getByText('deleted')).toBeInTheDocument();
        expect(within(readback).getByText('Deleted from trigger list')).toBeInTheDocument();
        expect(within(readback).getByText('2')).toBeInTheDocument();
        expect(screen.getByText(/Nothing here yet/i)).toBeInTheDocument();
      } finally {
        deleteSpy.mockRestore();
        updateSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('blocks duplicate workflow run trigger bindings before calling the backend', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_triggers') {
            return {
              rows: [
                {
                  id: 'trigger_duplicate_guard',
                  source_workflow_template_id: 'tpl_trigger_source',
                  source_template_name: 'trigger_source_v1',
                  target_workflow_template_id: 'tpl_trigger_target',
                  target_template_name: 'trigger_target_v1',
                  source_statuses: ['completed'],
                  context_patch: {},
                  scope_type: 'tenant',
                  scope_id: 'org_trigger_author',
                  enabled: true,
                  last_scanned_completed_at: null,
                  created_at: '2026-05-26T10:00:00.000Z',
                  updated_at: '2026-05-26T10:00:00.000Z',
                  notes: 'existing trigger',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_trigger_source',
                  template_id: 'trigger_source_v1',
                  name: 'trigger_source_v1',
                  version: '1',
                  steps: [],
                },
                {
                  id: 'tpl_trigger_target',
                  template_id: 'trigger_target_v1',
                  name: 'trigger_target_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 2,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory' || resource === 'workflow_schedule_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_run_trigger_v1');

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-triggers')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-triggers'));
        await user.click(await screen.findByRole('button', { name: /^New trigger/ }));
        await user.click(await screen.findByRole('button', { name: /^Create trigger/ }));

        expect(createSpy).not.toHaveBeenCalled();
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'A workflow trigger for this source, target, and status already exists',
        );
      } finally {
        createSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('New trigger is permission-gated without workflows.write', async () => {
      const user = userEvent.setup();
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_run_trigger_v1');

      try {
        renderWithProviders(<RunsModule />, { capabilities: ['workflows.read'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-triggers')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-triggers'));

        const newTrigger = await screen.findByRole('button', { name: /^New trigger/ });
        expect(newTrigger).toBeDisabled();
        expect(newTrigger).toHaveTextContent('Workflow Update permission required');
        expect(newTrigger.querySelector('.cap-lock')).toHaveAttribute('title', 'Requires workflow update permission');
        await user.click(newTrigger);

        expect(createSpy).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('Source workflow template')).not.toBeInTheDocument();
      } finally {
        createSpy.mockRestore();
      }
    });

    it('switches to the Schedules tab and lists workflow_schedule_triggers rows', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(
        () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
        { timeout: 4000 },
      );
      const schedulesTab = screen.getByTestId('wf-runs-tab-schedules');
      await user.click(schedulesTab);
      // Schedule summary cell renders for at least one seeded schedule.
      await waitFor(() =>
        expect(screen.getAllByText(/Daily 04:00/).length).toBeGreaterThan(0),
      );
      expect(window.location.search).toContain('tab=schedules');
    });

    it('creates a workflow schedule and shows same-tab backend readback without reload', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let createdSchedule: Record<string, unknown> | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            const rows = createdSchedule
              ? [createdSchedule]
              : [];
            return {
              rows,
              total: rows.length,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_schedule_author',
                  template_id: 'schedule_author_v1',
                  name: 'schedule_author_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory' || resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_schedule_trigger_v1').mockImplementation(async (args) => {
        createdSchedule = {
          id: 'sched_author_readback',
          workflow_template_id: args.workflow_template_id,
          template_name: 'schedule_author_v1',
          schedule: args.schedule,
          schedule_summary: 'Every 15m',
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: 'org_schedule_author',
          enabled: args.enabled !== false,
          next_run_at: '2026-05-24T02:15:00.000Z',
          last_run_at: null,
          last_run_id: null,
          last_error: null,
          last_error_at: null,
          notes: args.notes ?? null,
        };
        return {
          ok: true,
          status: 'created',
          workflow_schedule_trigger_id: 'sched_author_readback',
          workflow_template_id: args.workflow_template_id,
          schedule: args.schedule,
          context_patch: args.context_patch ?? {},
          scope_type: 'tenant',
          scope_id: 'org_schedule_author',
          enabled: args.enabled !== false,
          next_run_at: '2026-05-24T02:15:00.000Z',
          notes: args.notes ?? null,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        const scheduleReadsBefore = listSpy.mock.calls.filter((call) => call[0] === 'workflow_schedule_triggers').length;
        await user.click(await screen.findByRole('button', { name: /^New schedule/ }));
        await user.clear(await screen.findByLabelText('Interval seconds'));
        await user.type(await screen.findByLabelText('Interval seconds'), '900');
        fireEvent.change(await screen.findByLabelText('Context patch JSON'), {
          target: { value: '{"branch":"rh_jed"}' },
        });
        await user.type(await screen.findByLabelText('Schedule notes'), 'operator schedule proof');
        await user.click(await screen.findByRole('button', { name: /^Create schedule/ }));

        await waitFor(() => expect(createSpy).toHaveBeenCalledWith({
          workflow_template_id: 'tpl_schedule_author',
          schedule: { type: 'interval', interval_seconds: 900 },
          context_patch: { branch: 'rh_jed' },
          enabled: true,
          notes: 'operator schedule proof',
        }));
        const readback = await screen.findByTestId('workflow-schedule-create-readback');
        expect(within(readback).getByText('Created')).toBeInTheDocument();
        expect(within(readback).getByText('Every 15m')).toBeInTheDocument();
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument();
        expect(screen.getByText('operator schedule proof')).toBeInTheDocument();
        const schedulesTable = screen.getByRole('table');
        expect(within(schedulesTable).getByText('schedule_author_v1')).toBeInTheDocument();
        expect(within(schedulesTable).getByText('Every 15m')).toBeInTheDocument();
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_schedule_triggers').length).toBeGreaterThan(
          scheduleReadsBefore,
        );
      } finally {
        createSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('New schedule is permission-gated without workflows.write', async () => {
      const user = userEvent.setup();
      const createSpy = vi.spyOn(apiMod, 'ui_create_workflow_schedule_trigger_v1');

      try {
        renderWithProviders(<RunsModule />, { capabilities: ['workflows.read'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));

        const newSchedule = await screen.findByRole('button', { name: /^New schedule/ });
        expect(newSchedule).toBeDisabled();
        expect(newSchedule).toHaveTextContent('Workflow Update permission required');
        expect(newSchedule.querySelector('.cap-lock')).toHaveAttribute('title', 'Requires workflow update permission');
        await user.click(newSchedule);

        expect(createSpy).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('Workflow template')).not.toBeInTheDocument();
      } finally {
        createSpy.mockRestore();
      }
    });

    it('Schedule Run-now is disabled without workflows.write and does not call the backend action', async () => {
      const user = userEvent.setup();
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1');
      renderWithProviders(<RunsModule />, { capabilities: ['shipments.read', 'workflows.read'] });
      // Wait for the table to mount, then switch to schedules tab.
      await waitFor(
        () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
        { timeout: 4000 },
      );
      await user.click(screen.getByTestId('wf-runs-tab-schedules'));
      // Find the row kebab and open it.
      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      // Run now option is rendered but disabled before any backend mutation can fire.
      const runNow = await screen.findByRole('option', { name: /Run now/ });
      expect(runNow).toBeInTheDocument();
      expect(runNow).toHaveAttribute('aria-disabled', 'true');
      expect(runNow).toHaveTextContent(/Requires workflow update permission/i);
      await user.click(runNow);
      expect(runNowSpy).not.toHaveBeenCalled();
      runNowSpy.mockRestore();
    });

    it('Schedule Run-now refreshes schedule and run readback in place', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let lastRunAt: string | null = null;
      let lastRunId: string | null = null;
      let lastRunStatus = 'pending';
      let lastRunError: string | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            return {
              rows: [
                {
                  id: 'sched_run_now_readback',
                  workflow_template_id: 'tpl_sched_run_now',
                  template_name: 'scheduled_run_now_template_v1',
                  schedule: { type: 'interval', interval_seconds: 3600 },
                  schedule_summary: 'Every 60 minutes',
                  context_patch: {},
                  scope_type: 'tenant',
                  scope_id: 'org_sched',
                  enabled: true,
                  next_run_at: '2026-05-24T01:50:00.000Z',
                  last_run_at: lastRunAt,
                  last_run_id: lastRunId,
                  last_error: null,
                  last_error_at: null,
                  notes: 'Run-now readback fixture',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory') {
            return {
              rows: lastRunId
                ? [
                    {
                      id: lastRunId,
                      run_id: 'WFR-SCHED',
                      template_id: 'tpl_sched_run_now',
                      workflow_template_id: 'tpl_sched_run_now',
                      template_name: 'scheduled_run_now_template_v1',
                      started_at: lastRunAt,
                      completed_at: null,
                      duration_ms: null,
                      status: 'pending',
                      workflow_status: lastRunStatus,
                      failure_reason: lastRunError,
                      error: lastRunError,
                      triggered_by: 'schedule',
                      correlation_id: 'cor_sched_run_now',
                    },
                  ]
                : [],
              total: lastRunId ? 1 : 0,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_sched_run_now',
                  template_id: 'scheduled_run_now_template_v1',
                  name: 'scheduled_run_now_template_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1').mockImplementation(async () => {
        lastRunAt = '2026-05-23T01:50:00.000Z';
        lastRunId = 'wfr_sched_run_now';
        lastRunStatus = 'failed';
        lastRunError = 'task_enqueue_dynamic: missing object at $.context.binding_payload.task';
        return {
          ok: true,
          status: 'workflow_started',
          workflow_schedule_trigger_id: 'sched_run_now_readback',
          workflow_template_id: 'tpl_sched_run_now',
          workflow_run_id: lastRunId,
          last_run_at: lastRunAt,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        await waitFor(() => expect(screen.getByText('Every 60 minutes')).toBeInTheDocument());
        const scheduleReadsBefore = listSpy.mock.calls.filter((call) => call[0] === 'workflow_schedule_triggers').length;
        const runReadsBefore = listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length;

        const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(kebabs[0]!);
        await user.click(await screen.findByRole('option', { name: /Run now/ }));

        await waitFor(() => expect(runNowSpy).toHaveBeenCalledWith('sched_run_now_readback'));
        const readback = await screen.findByTestId('workflow-schedule-run-now-readback');
        await waitFor(() => expect(within(readback).getByText(/May 23, 2026/)).toBeInTheDocument());
        expect(within(readback).getByText(/Started/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Failed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/The run needs attention before it can finish/i)).toBeInTheDocument();
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_schedule_triggers').length).toBeGreaterThan(
          scheduleReadsBefore,
        );
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length).toBeGreaterThan(
          runReadsBefore,
        );
      } finally {
        runNowSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('Schedule Run-now reads the exact created workflow run when the paged directory is stale', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const originalGetResource = apiMod.ui_get_resource_v1;
      let lastRunAt: string | null = null;
      let lastRunId: string | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            return {
              rows: [
                {
                  id: 'sched_run_now_exact_readback',
                  workflow_template_id: 'tpl_sched_run_now_exact',
                  template_name: 'scheduled_run_now_template_v1',
                  schedule: { type: 'interval', interval_seconds: 3600 },
                  schedule_summary: 'Every 60 minutes',
                  context_patch: {},
                  scope_type: 'tenant',
                  scope_id: 'org_sched',
                  enabled: true,
                  next_run_at: '2026-05-24T01:50:00.000Z',
                  last_run_at: lastRunAt,
                  last_run_id: lastRunId,
                  last_error: null,
                  last_error_at: null,
                  notes: 'Exact run readback fixture',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_sched_run_now_exact',
                  template_id: 'scheduled_run_now_template_v1',
                  name: 'scheduled_run_now_template_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(
        async (resource: string, id: string) => {
          if (resource === 'workflow_run_directory' && id === 'wfr_sched_run_now_exact') {
            return {
              id,
              run_id: 'WFR-SCHED-EXACT',
              template_id: 'tpl_sched_run_now_exact',
              workflow_template_id: 'tpl_sched_run_now_exact',
              template_name: 'scheduled_run_now_template_v1',
              started_at: lastRunAt,
              completed_at: '2026-05-23T01:51:00.000Z',
              duration_ms: 60000,
              status: 'completed',
              workflow_status: 'completed',
              failure_reason: null,
              error: null,
              triggered_by: 'schedule',
              correlation_id: 'cor_sched_run_now_exact',
            } as Awaited<ReturnType<typeof apiMod.ui_get_resource_v1>>;
          }
          return originalGetResource(resource, id);
        },
      );
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1').mockImplementation(async () => {
        lastRunAt = '2026-05-23T01:50:00.000Z';
        lastRunId = 'wfr_sched_run_now_exact';
        return {
          ok: true,
          status: 'workflow_started',
          workflow_schedule_trigger_id: 'sched_run_now_exact_readback',
          workflow_template_id: 'tpl_sched_run_now_exact',
          workflow_run_id: lastRunId,
          last_run_at: lastRunAt,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        await waitFor(() => expect(screen.getByText('Every 60 minutes')).toBeInTheDocument());

        const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(kebabs[0]!);
        await user.click(await screen.findByRole('option', { name: /Run now/ }));

        await waitFor(() => expect(runNowSpy).toHaveBeenCalledWith('sched_run_now_exact_readback'));
        await waitFor(() =>
          expect(getSpy).toHaveBeenCalledWith('workflow_run_directory', 'wfr_sched_run_now_exact'),
        );
        const readback = await screen.findByTestId('workflow-schedule-run-now-readback');
        await waitFor(() => expect(within(readback).getByText(/Started/i)).toBeInTheDocument());
        expect(within(readback).getByText(/Started/i)).toBeInTheDocument();
        expect(within(readback).queryByText(/Awaiting run readback/i)).not.toBeInTheDocument();
      } finally {
        runNowSpy.mockRestore();
        getSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('Schedule Run-now keeps same-context readback queued when exact run lookup is temporarily unavailable', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const originalGetResource = apiMod.ui_get_resource_v1;
      let lastRunAt: string | null = null;
      let lastRunId: string | null = null;
      toastStore.clearToasts();
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            return {
              rows: [
                {
                  id: 'sched_run_now_exact_retry',
                  workflow_template_id: 'tpl_sched_run_now_exact_retry',
                  template_name: 'scheduled_run_now_template_v1',
                  schedule: { type: 'interval', interval_seconds: 3600 },
                  schedule_summary: 'Every 60 minutes',
                  context_patch: {},
                  scope_type: 'tenant',
                  scope_id: 'org_sched',
                  enabled: true,
                  next_run_at: '2026-05-24T01:50:00.000Z',
                  last_run_at: lastRunAt,
                  last_run_id: lastRunId,
                  last_error: null,
                  last_error_at: null,
                  notes: 'Exact run retry fixture',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_sched_run_now_exact_retry',
                  template_id: 'scheduled_run_now_template_v1',
                  name: 'scheduled_run_now_template_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(
        async (resource: string, id: string) => {
          if (resource === 'workflow_run_directory' && id === 'wfr_sched_run_now_exact_retry') {
            throw new Error('temporary workflow_run_directory readback miss');
          }
          return originalGetResource(resource, id);
        },
      );
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1').mockImplementation(async () => {
        lastRunAt = '2026-05-23T01:50:00.000Z';
        lastRunId = 'wfr_sched_run_now_exact_retry';
        return {
          ok: true,
          status: 'workflow_started',
          workflow_schedule_trigger_id: 'sched_run_now_exact_retry',
          workflow_template_id: 'tpl_sched_run_now_exact_retry',
          workflow_run_id: lastRunId,
          last_run_at: lastRunAt,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        await waitFor(() => expect(screen.getByText('Every 60 minutes')).toBeInTheDocument());

        const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(kebabs[0]!);
        await user.click(await screen.findByRole('option', { name: /Run now/ }));

        await waitFor(() => expect(runNowSpy).toHaveBeenCalledWith('sched_run_now_exact_retry'));
        await waitFor(() =>
          expect(getSpy).toHaveBeenCalledWith('workflow_run_directory', 'wfr_sched_run_now_exact_retry'),
        );
        const readback = await screen.findByTestId('workflow-schedule-run-now-readback');
        expect(within(readback).getByText(/Started/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Waiting for saved data/i)).toBeInTheDocument();
        await waitFor(() =>
          expect(toastStore.getToasts().some((toast) => /^Queued/.test(toast.message))).toBe(true),
        );
        expect(toastStore.getToasts().some((toast) => /^Run-now failed/.test(toast.message))).toBe(false);
      } finally {
        toastStore.clearToasts();
        runNowSpy.mockRestore();
        getSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('Schedule Run-now preflight failure refreshes schedule readback without creating a workflow run', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const preflightError = 'workflow_schedule_trigger_preflight: missing object at $.context.binding_payload.task';
      let lastError: string | null = null;
      let lastErrorAt: string | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            return {
              rows: [
                {
                  id: 'sched_run_now_preflight',
                  workflow_template_id: 'tpl_sched_run_now_preflight',
                  template_name: 'workflow_binding_review_task_v1',
                  schedule: { type: 'interval', interval_seconds: 3600 },
                  schedule_summary: 'Every 60 minutes',
                  context_patch: {},
                  scope_type: 'tenant',
                  scope_id: 'org_sched',
                  enabled: true,
                  next_run_at: '2026-05-24T01:50:00.000Z',
                  last_run_at: null,
                  last_run_id: null,
                  last_error: lastError,
                  last_error_at: lastErrorAt,
                  notes: 'Run-now preflight fixture',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_sched_run_now_preflight',
                  template_id: 'workflow_binding_review_task_v1',
                  name: 'workflow_binding_review_task_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1').mockImplementation(async () => {
        lastError = preflightError;
        lastErrorAt = '2026-05-24T01:50:00.000Z';
        return {
          ok: true,
          status: 'preflight_failed',
          workflow_schedule_trigger_id: 'sched_run_now_preflight',
          workflow_template_id: 'tpl_sched_run_now_preflight',
          workflow_run_id: null,
          last_run_at: null,
          last_error: preflightError,
          last_error_at: lastErrorAt,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        await waitFor(() => expect(screen.getByText('Every 60 minutes')).toBeInTheDocument());
        const runReadsBefore = listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length;

        const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(kebabs[0]!);
        await user.click(await screen.findByRole('option', { name: /Run now/ }));

        await waitFor(() => expect(runNowSpy).toHaveBeenCalledWith('sched_run_now_preflight'));
        const readback = await screen.findByTestId('workflow-schedule-run-now-readback');
        expect(within(readback).getByText(/Setup check failed/i)).toBeInTheDocument();
        expect(within(readback).getByText(/The run needs attention before it can finish/i)).toBeInTheDocument();
        expect(within(readback).getByText(/Workflow run/i).nextElementSibling).toHaveTextContent(/Waiting for saved data/i);
        expect(within(readback).getByText(/Last run/i).nextElementSibling).toHaveTextContent('—');
        expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length).toBeLessThanOrEqual(
          runReadsBefore + 1,
        );
      } finally {
        runNowSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('Schedule payload repair clears preflight readback and can run the repaired schedule without reload', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      let contextPatch: Record<string, unknown> = {};
      let lastError: string | null = 'workflow_schedule_trigger_preflight: missing object at $.context.binding_payload.task';
      let lastErrorAt: string | null = '2026-05-24T01:50:00.000Z';
      let updatedAt = '2026-05-24T01:40:00.000Z';
      let lastRunAt: string | null = null;
      let lastRunId: string | null = null;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_schedule_triggers') {
            return {
              rows: [
                {
                  id: 'sched_payload_repair',
                  workflow_template_id: 'tpl_payload_repair',
                  template_name: 'workflow_binding.marketing_lead.review_requested.global.v1',
                  schedule: { type: 'interval', interval_seconds: 3600 },
                  schedule_summary: 'Every 60 minutes',
                  context_patch: contextPatch,
                  scope_type: 'tenant',
                  scope_id: 'org_sched',
                  enabled: true,
                  next_run_at: '2026-05-24T01:50:00.000Z',
                  last_run_at: lastRunAt,
                  last_run_id: lastRunId,
                  last_error: lastError,
                  last_error_at: lastErrorAt,
                  updated_at: updatedAt,
                  notes: 'Payload repair fixture',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_directory') {
            return {
              rows: lastRunId
                ? [
                    {
                      id: lastRunId,
                      run_id: 'WFR-REPAIRED',
                      template_id: 'tpl_payload_repair',
                      workflow_template_id: 'tpl_payload_repair',
                      template_name: 'workflow_binding.marketing_lead.review_requested.global.v1',
                      started_at: lastRunAt,
                      completed_at: null,
                      duration_ms: null,
                      status: 'pending',
                      workflow_status: 'pending',
                      failure_reason: null,
                      error: null,
                      triggered_by: 'schedule',
                      correlation_id: 'cor_payload_repair',
                    },
                  ]
                : [],
              total: lastRunId ? 1 : 0,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_payload_repair',
                  template_id: 'workflow_binding.marketing_lead.review_requested.global.v1',
                  name: 'workflow_binding.marketing_lead.review_requested.global.v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_run_triggers' || resource === 'workflow_run_steps') {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );
      const repairSpy = vi.spyOn(apiMod, 'ui_repair_workflow_schedule_task_payload_v1').mockImplementation(async () => {
        contextPatch = {
          binding_payload: {
            task: {
              task_type_key: 'marketing_lead_followup',
              organization_id: 'org_sched',
              queue_key: 'default',
            },
          },
        };
        lastError = null;
        lastErrorAt = null;
        updatedAt = '2026-05-24T02:00:00.000Z';
        return {
          ok: true,
          status: 'payload_repaired',
          workflow_schedule_trigger_id: 'sched_payload_repair',
          workflow_template_id: 'tpl_payload_repair',
          workflow_template_step_id: 'step_payload_repair',
          operation_name: 'binding_marketing_lead_review_task',
          task_type_key: 'marketing_lead_followup',
          queue_key: 'default',
          priority: 50,
          sla_minutes: null,
          resource_type: 'marketing_lead_request',
          resource_id: null,
          updated_at: updatedAt,
          context_patch: contextPatch,
        };
      });
      const runNowSpy = vi.spyOn(apiMod, 'ui_run_workflow_schedule_trigger_v1').mockImplementation(async () => {
        lastRunAt = '2026-05-24T02:01:00.000Z';
        lastRunId = 'wfr_payload_repair';
        return {
          ok: true,
          status: 'workflow_started',
          workflow_schedule_trigger_id: 'sched_payload_repair',
          workflow_template_id: 'tpl_payload_repair',
          workflow_run_id: lastRunId,
          last_run_at: lastRunAt,
        };
      });

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(
          () => expect(screen.getByTestId('wf-runs-tab-schedules')).toBeInTheDocument(),
          { timeout: 4000 },
        );
        await user.click(screen.getByTestId('wf-runs-tab-schedules'));
        await waitFor(() => expect(screen.getByText('Every 60 minutes')).toBeInTheDocument());

        const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
        await user.click(kebabs[0]!);
        await user.click(await screen.findByRole('option', { name: /Repair task details/ }));

        await waitFor(() => expect(repairSpy).toHaveBeenCalledWith('sched_payload_repair'));
        const repairReadback = await screen.findByTestId('workflow-schedule-task-payload-repair-readback');
        expect(within(repairReadback).getByText(/Task details repaired/i)).toBeInTheDocument();
        expect(within(repairReadback).getByText('marketing_lead_followup')).toBeInTheDocument();
        expect(within(repairReadback).getByText('binding_marketing_lead_review_task')).toBeInTheDocument();
        expect(
          within(repairReadback).getByText(/Saved task details are present/i),
        ).toBeInTheDocument();

        await user.click(within(repairReadback).getByRole('button', { name: /Run repaired schedule/i }));

        await waitFor(() => expect(runNowSpy).toHaveBeenCalledWith('sched_payload_repair'));
        const runNowReadback = await screen.findByTestId('workflow-schedule-run-now-readback');
        expect(within(runNowReadback).getByText(/Started/i)).toBeInTheDocument();
      } finally {
        runNowSpy.mockRestore();
        repairSpy.mockRestore();
        listSpy.mockRestore();
      }
    });
  });

  // W22 — paired projection view consumption (additive). The run drawer
  // title resolves template_name from `v_workflow_run_directory`
  // (supabase/migrations/202604302100_*) when the projection row is
  // present, falling back to the legacy seed shape otherwise. The
  // seed-mode projection mirrors the live view shape so the drawer
  // title stays deterministic across cutover.
  describe('W22 paired projection view (workflow_run_directory)', () => {
    beforeEach(() => {
      // Reset hash so the runs tab is the active tab on mount.
      window.location.hash = '#/workflows/runs';
    });

    it('row click opens drawer with template_name resolved through the directory projection', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      // The seed has WFR-3220 anchored to tpl_amend_cancel ("Shipment amend &
      // cancel"). Open its drawer and verify the title contains the canonical
      // template name (sourced via the directory projection FK join).
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));
      await waitFor(() =>
        expect(screen.getAllByText(/Shipment amend & cancel/).length).toBeGreaterThan(0),
      );
    });
  });

  // W35c-1 — canonical-first decision_log_id read.
  // workflow_run_steps.decision_log_id is a real canonical column (added via
  // supabase/migrations/202510110005_*.sql:336). The FE Run drawer's "Decision
  // trail" deep-link must prefer the canonical column over the legacy
  // `metadata.decision_log_id` fallback so live data flows correctly when the
  // canonical column is populated. Closes REAUDIT3/WORKFLOWS.md P1-1.
  describe('W35c-1 canonical-first decision_log_id deep-link', () => {
    beforeEach(() => {
      window.location.hash = '#/workflows/runs';
    });

    it('Decision trail deep-link uses canonical workflow_run_steps.decision_log_id when present', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      // Seed: wfr_3220 → wfs_1 (step_id=st_1) carries canonical
      // decision_log_id 'dlog_wfr_3220_st_1'. The step's rendered label comes
      // from the template (tpl_amend_cancel.steps[0].label = 'Amend requested').
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));
      await waitFor(() => expect(screen.getByText('Step timeline')).toBeInTheDocument());

      // Click the first step (template label 'Amend requested') to select it.
      // Multiple matches expected (header + step list + drawer body); pick the
      // first clickable instance.
      const firstStepMatches = await screen.findAllByText('Amend requested');
      await user.click(firstStepMatches[0]!);

      // Click "Decision trail" — deep-link should carry the canonical column value.
      const trail = await screen.findByRole('button', { name: /Decision trail/ });
      await user.click(trail);

      expect(window.location.search).toContain('decision_log_id=dlog_wfr_3220_st_1');
      // Negative guard: the metadata fallback id from a different step must NOT
      // appear in the route for this canonical-first read.
      expect(window.location.search).not.toContain('dlog_wfr_3220_st_4_legacy');
    });

    it('Decision trail deep-link falls back to metadata.decision_log_id when canonical column is absent', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      // Seed: wfr_3220 → wfs_4 (step_id=st_4) has no canonical decision_log_id,
      // only metadata.decision_log_id 'dlog_wfr_3220_st_4_legacy'. Template label
      // for st_4 in tpl_amend_cancel is 'Apply mutations'.
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));
      await waitFor(() => expect(screen.getByText('Step timeline')).toBeInTheDocument());

      const lastStep = await screen.findByText('Apply mutations');
      await user.click(lastStep);

      const trail = await screen.findByRole('button', { name: /Decision trail/ });
      await user.click(trail);

      expect(window.location.search).toContain('decision_log_id=dlog_wfr_3220_st_4_legacy');
    });
  });

  // W37 — capability-gating closure for the drawer-header "Replay run" Button +
  // the inspector "Replay from this step" Button. Mirrors the W35c-2 pattern
  // applied to review-queue: every write affordance gates on the canonical
  // capability the server-side RPC asserts (`workflows.write` for replay).
  // Closes REAUDIT4 WORKFLOWS NEW P1.
  describe('workflow_run_steps live projection', () => {
    beforeEach(() => {
      window.location.hash = '#/workflows/runs';
    });

    it('renders canonical step_status when live rows do not include legacy status', async () => {
      const stepsSpy = vi.spyOn(apiMod, 'ui_get_workflow_run_steps_v1').mockResolvedValue({
        workflow_run_id: 'wfr_3220',
        total: 1,
        rows: [
          {
            id: 'wfs_live_step_status',
            step_id: 'st_1',
            step_status: 'completed',
            duration_ms: 125,
            decision_log_id: 'dlog_live_step_status',
          },
        ],
      });
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });

      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));

      await waitFor(() => expect(screen.getAllByText('Completed').length).toBeGreaterThan(0));
      expect(screen.queryByText(/workflow_step_status\/ \(missing\)/)).not.toBeInTheDocument();
      stepsSpy.mockRestore();
    });

    it('updates the open drawer step timeline after replay without a browser reload', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_directory') {
            return {
              rows: [
                {
                  id: 'wfr_3220',
                  run_id: 'WFR-3220',
                  template_id: 'tpl_live_replay_refresh',
                  workflow_template_id: 'tpl_live_replay_refresh',
                  template_name: 'api_gateway_live_replay_refresh_v1',
                  started_at: '2026-05-12T20:00:00.000Z',
                  duration_ms: null,
                  status: 'in_progress',
                  workflow_status: 'in_progress',
                  triggered_by: 'api',
                  correlation_id: 'corr-live-replay-refresh',
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_live_replay_refresh',
                  template_id: 'api_gateway_live_replay_refresh_v1',
                  name: 'api_gateway_live_replay_refresh_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          return originalListResource(resource, opts);
        },
      );
      const completedStepReadback = {
        workflow_run_id: 'wfr_3220',
        total: 1,
        rows: [
          {
            id: 'wfs_live_replay_refresh',
            step_id: 'st_1',
            step_status: 'completed' as const,
            duration_ms: 42,
          },
        ],
      };
      const stepsSpy = vi
        .spyOn(apiMod, 'ui_get_workflow_run_steps_v1')
        .mockResolvedValueOnce({
          workflow_run_id: 'wfr_3220',
          total: 1,
          rows: [
            {
              id: 'wfs_live_replay_refresh',
              step_id: 'st_1',
              step_status: 'pending' as const,
              duration_ms: null,
            },
          ],
        })
        .mockResolvedValue(completedStepReadback);
      const startSpy = vi.spyOn(apiMod, 'start_workflow_run').mockResolvedValue({
        ok: true,
        workflow_run_id: 'wfr_3220_replay',
        workflow_template_id: 'tpl_dispatch',
        workflow_status: 'pending',
        dry_run: false,
        idempotency_key: '',
        correlation_id: '',
        started_at: new Date().toISOString(),
        canonical_entrypoint: 'progress_workflow_run',
      });
      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });

        await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
        await user.click(screen.getByText('WFR-3220'));
        const drawer = await screen.findByRole('dialog');
        await waitFor(() =>
          expect(within(drawer).getAllByText(/workflow_step_status\/pending|Pending/).length).toBeGreaterThan(0),
        );

        const directoryReadsBeforeReplay = listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length;
        await user.click(within(drawer).getByRole('button', { name: /^Replay run$/ }));
        await waitFor(() =>
          expect(within(drawer).getAllByText(/workflow_step_status\/completed|Completed/).length).toBeGreaterThan(0),
        );
        expect(startSpy).toHaveBeenCalledWith(
          'tpl_live_replay_refresh',
          expect.objectContaining({
            from_step_id: 'st_1',
            replay_of: 'wfr_3220',
            ui: expect.objectContaining({ replay_of: 'wfr_3220' }),
          }),
        );
        await waitFor(() =>
          expect(listSpy.mock.calls.filter((call) => call[0] === 'workflow_run_directory').length).toBeGreaterThan(
            directoryReadsBeforeReplay,
          ),
        );
      } finally {
        stepsSpy.mockRestore();
        startSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('renders missing run start time as empty instead of an epoch date in the drawer', async () => {
      const originalListResource = apiMod.ui_list_resource_v1;
      const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
        async (resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
          if (resource === 'workflow_run_directory') {
            return {
              rows: [
                {
                  id: 'wfr_missing_started_at',
                  run_id: 'WFR-NOSTART',
                  template_id: 'tpl_missing_started_at',
                  workflow_template_id: 'tpl_missing_started_at',
                  template_name: 'missing_started_at_v1',
                  started_at: null,
                  completed_at: null,
                  duration_ms: null,
                  status: 'cancelled',
                  workflow_status: 'cancelled',
                  triggered_by: 'manual',
                  correlation_id: null,
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (resource === 'workflow_templates') {
            return {
              rows: [
                {
                  id: 'tpl_missing_started_at',
                  template_id: 'missing_started_at_v1',
                  name: 'missing_started_at_v1',
                  version: '1',
                  steps: [],
                },
              ],
              total: 1,
              page: 0,
              page_size: 50,
            } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
          }
          if (
            resource === 'workflow_run_triggers' ||
            resource === 'workflow_schedule_triggers' ||
            resource === 'workflow_run_steps'
          ) {
            return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<
              ReturnType<typeof apiMod.ui_list_resource_v1>
            >;
          }
          return originalListResource(resource, opts);
        },
      );

      try {
        const user = userEvent.setup();
        renderWithProviders(<RunsModule />, { capabilities: ['all'] });
        await waitFor(() => expect(screen.getByText('WFR-NOSTART')).toBeInTheDocument());
        await user.click(screen.getByText('WFR-NOSTART'));
        await waitFor(() => expect(screen.getAllByText('missing_started_at_v1').length).toBeGreaterThan(1));
        expect(document.body.textContent ?? '').not.toContain('1970');
      } finally {
        listSpy.mockRestore();
      }
    });

    it('filters run history by the selected row template from row actions', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      const rowActions = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(rowActions[0]!);
      const filter = await screen.findByRole('option', { name: /Filter by template/ });
      await user.click(filter);
      await waitFor(() => expect(screen.getByText('Filtered by template')).toBeInTheDocument());
      expect(screen.getByRole('tab', { name: /Workflow runs/ })).toHaveTextContent(/Runs\s+·\s+\d+\s+\/\s+\d+/);
      expect(window.location.search).toContain('template=');
    });
  });

  describe('W37 capability gating on drawer Replay buttons', () => {
    beforeEach(() => {
      window.location.hash = '#/workflows/runs';
    });

    it('drawer-header "Replay run" Button is disabled when workflows.write is missing', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, { capabilities: ['workflows.read'] });
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));
      await waitFor(() => expect(screen.getByText('Step timeline')).toBeInTheDocument());
      // Multiple Buttons share the label between drawer header and inspector;
      // assert at least one matches and EVERY match is disabled with the
      // CapabilityLock chip rendered.
      const replayButtons = await screen.findAllByRole('button', { name: /Replay run/ });
      expect(replayButtons.length).toBeGreaterThan(0);
      for (const btn of replayButtons) {
        expect(btn).toBeDisabled();
      }
    });

    it('drawer-header "Replay run" Button is enabled when workflows.write is present', async () => {
      const user = userEvent.setup();
      renderWithProviders(<RunsModule />, {
        capabilities: ['workflows.read', 'workflows.write'],
      });
      await waitFor(() => expect(screen.getByText('WFR-3220')).toBeInTheDocument());
      await user.click(screen.getByText('WFR-3220'));
      await waitFor(() => expect(screen.getByText('Step timeline')).toBeInTheDocument());
      const replay = (await screen.findAllByRole('button', { name: /Replay run/ }))[0]!;
      expect(replay).not.toBeDisabled();
    });
  });
});
