// templates.test.tsx — Workflow Studio (Claim D + Phase C5) coverage.
// - Asserts the studio renders, lists templates, swaps the palette tab to
//   Operations and binds an op to the active step.
// - Asserts capability gating: when user lacks `workflows.write` (canonical
//   B6 surface gate; replaces legacy `workflow_runs.write`), the primary
//   write actions render as disabled CapabilityLock-decorated buttons.
// - Asserts canvas keyboard navigation: ArrowRight on the wrap shifts the
//   selected step, mirroring AGENTS.md's a11y requirement (no keyboard trap,
//   no mouse-only flows).
// - Phase C5: asserts Activate / Deactivate fires
//   ui_set_workflow_template_status_v1.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { TemplatesModule } from '@/modules/workflows/templates';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

describe('TemplatesModule (Workflow Studio)', () => {
  it('mounts and lists templates from workflow_templates', async () => {
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    // Title "Template Studio" comes from the topbar brand block.
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    // First seeded template is "Exampleparcel KSA inbound intake".
    await waitFor(() => expect(screen.getByText('Exampleparcel KSA inbound intake')).toBeInTheDocument());
  });

  it('shows a denied state without issuing protected workflow template reads', async () => {
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const opsSpy = typedSpy(apiMod, 'ui_list_operation_templates_v1');
    try {
      renderWithProviders(<TemplatesModule />, { capabilities: [] });

      expect(await screen.findByText(/You do not have permission to view workflow templates/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).not.toContain('workflow_templates');
        expect(resources).not.toContain('recent_workflow_events');
        expect(resources).not.toContain('workflow_runs');
        expect(resources).not.toContain('workflow_template_directory');
        expect(opsSpy).not.toHaveBeenCalled();
      });
      expect(screen.queryByRole('button', { name: /New template/i })).not.toBeInTheDocument();
    } finally {
      opsSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('switches to Operations tab and exposes operation catalog rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Exampleparcel KSA inbound intake')).toBeInTheDocument());
    const opsTab = screen.getByRole('tab', { name: 'Operations' });
    await user.click(opsTab);
    expect(opsTab).toHaveAttribute('aria-selected', 'true');
    // Operations are derived from workflow_template_steps.op — at least one
    // canonical op should appear (e.g. mapping.apply or shipments.create_v1).
    await waitFor(() => {
      const list = document.querySelectorAll('.wf-palette__list .wf-tpl-card');
      expect(list.length).toBeGreaterThan(0);
    });
  });

  it('disables write actions when capability workflows.write is missing', async () => {
    // Wave 5 RE-AUDIT (WORKFLOWS.md P1): templates lifecycle write actions
    // gate on the canonical `workflows.write` capability — matches B6 RPCs
    // (ui_set_workflow_template_status_v1 / ui_create_workflow_template_v1
    // assert this key) and the seed-raw/navigation.js workflow nav.
    renderWithProviders(<TemplatesModule />, {
      capabilities: ['shipments.read', 'workflows.read'], // explicitly without workflows.write
    });
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    const newBtn = screen.getByRole('button', { name: /New template/ });
    expect(newBtn).toBeDisabled();
    const testRunBtn = screen.getByRole('button', { name: /Test run/ });
    expect(testRunBtn).toBeDisabled();
    // Capability lock chip surfaces the missing capability for accessibility.
    expect(screen.getAllByText(/Workflow update permission required/i).length).toBeGreaterThan(0);
  });

  it('runs a template test through the workflow mutation hook and refreshes run history without reload', async () => {
    const user = userEvent.setup();
    const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
    const templateId = 'tpl_test_run_readback';
    const stepId = 'step_test_run_readback';
    const workflowRunId = 'wfr-test-01';
    const templateRow = {
      id: templateId,
      template_id: 'TPL-TEST-RUN-READBACK',
      name: 'Template test readback workflow',
      version: 'v1.0.0',
      status: 'active',
      trigger: 'webhook.shipment.created',
      scope_type: 'tenant',
      scope_id: tenantId,
      steps: [
        {
          id: stepId,
          workflow_template_id: templateId,
          sequence_order: 1,
          operation_name: 'webhook.receive',
          kind: 'trigger',
          label: 'Receive webhook',
          metadata: { kind: 'trigger', label: 'Receive webhook' },
        },
      ],
    };
    let workflowRuns: Array<Record<string, unknown>> = [];
    let progressReadbackCompleted = false;
    let workflowRunReadsAfterProgress = 0;
    const originalListResource = apiMod.ui_list_resource_v1;
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    const startSpy = typedSpy(apiMod, 'start_workflow_run');
    const progressSpy = typedSpy(apiMod, 'progress_workflow_run');

    listSpy.mockImplementation((resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
      if (resource === 'workflow_templates') {
        expect(opts?.filter).toEqual({ scope_id: tenantId });
        return Promise.resolve({ rows: [templateRow], total: 1, page: 0, page_size: 200 } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      if (resource === 'workflow_template_directory') {
        return Promise.resolve({
          rows: [{
            id: templateId,
            workflow_template_id: templateId,
            template_id: 'TPL-TEST-RUN-READBACK',
            name: 'Template test readback workflow',
            status: 'active',
            step_count: 1,
            active_run_count: 0,
            total_run_count: workflowRuns.length,
            last_run_at: workflowRuns[0]?.started_at ?? null,
            last_run_status: workflowRuns[0]?.status ?? null,
            binding_count: 0,
            is_published: true,
          }],
          total: 1,
          page: 0,
          page_size: 200,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      if (resource === 'workflow_runs') {
        if (progressReadbackCompleted) workflowRunReadsAfterProgress += 1;
        return Promise.resolve({ rows: workflowRuns, total: workflowRuns.length, page: 0, page_size: 200 } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      if (resource === 'recent_workflow_events') {
        return Promise.resolve({ rows: [], total: 0, page: 0, page_size: 200 } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      return originalListResource(resource, opts);
    });
    startSpy.mockImplementation(async (id, context) => {
      expect(id).toBe(templateId);
      expect(context).toBeDefined();
      expect(context?.ui).toMatchObject({
        dry_run: true,
        sample_payload: { example: true },
      });
      workflowRuns = [{
        id: workflowRunId,
        workflow_template_id: templateId,
        workflow_status: 'completed',
        started_at: '2026-05-25T10:00:00.000Z',
        duration_ms: 42,
      }];
      return {
        ok: true,
        workflow_run_id: workflowRunId,
        workflow_template_id: templateId,
        workflow_status: 'running',
        dry_run: true,
        idempotency_key: 'idem_test_run_readback',
        correlation_id: 'cor_test_run_readback',
        started_at: '2026-05-25T10:00:00.000Z',
        canonical_entrypoint: 'progress_workflow_run',
      };
    });
    progressSpy.mockImplementation(async () => {
      progressReadbackCompleted = true;
      return {
        ok: true,
        workflow_run_id: workflowRunId,
        workflow_status: 'completed',
        duration_ms: 42,
        steps: [{
          id: 'wfrs-test-01',
          step_id: stepId,
          label: 'Receive webhook',
          kind: 'trigger',
          status: 'completed',
          duration_ms: 42,
        }],
      };
    });

    try {
      renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_workflow_test_run_readback',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getByText('Template test readback workflow')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Test run/ }));
      await user.click(screen.getByRole('button', { name: /^Run$/ }));

      await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
      expect(progressSpy).toHaveBeenCalledWith(workflowRunId);
      await waitFor(() => expect(workflowRunReadsAfterProgress).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getAllByText('Receive webhook').length).toBeGreaterThan(2));
      await user.click(screen.getByRole('button', { name: 'History' }));
      await waitFor(() => expect(screen.getByText(workflowRunId)).toBeInTheDocument());
    } finally {
      progressSpy.mockRestore();
      startSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('canvas keyboard nav: ArrowRight moves selection to next step', async () => {
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    const canvas = screen.getByRole('region', { name: /Workflow template canvas/ });
    canvas.focus();
    // The active step starts at st_1 (trigger). Press ArrowRight → st_2 should
    // become aria-pressed=true.
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await waitFor(() => {
      const pressed = within(canvas).getAllByRole('button', { pressed: true });
      expect(pressed.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders validation chip surfacing real lint issues (non-blocking)', async () => {
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    // Either validation issues are present (chip count visible) or "Valid" badge
    // shows. Both paths satisfy the contract — what matters is one of them
    // ALWAYS renders so authors get immediate feedback.
    await waitFor(() => {
      const valid = screen.queryByText('Valid');
      const issues = screen.queryByText(/issues?/);
      expect(valid !== null || issues !== null).toBe(true);
    });
  });

  it('keeps backend implementation names out of visible template UI copy', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Operations' }));
    await waitFor(() => {
      const list = document.querySelectorAll('.wf-palette__list .wf-tpl-card');
      expect(list.length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: 'Triggers' }));
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    expect(document.body.textContent ?? '').not.toMatch(
      /workflow_template_steps|workflow_step_action|public\.operation_templates|operation_templates|start_workflow_run|progress_workflow_run|mapping_configs|event_extraction|ui_presentation_policy/,
    );
  });

  it('scopes tenant-cloned workflow templates to the active tenant and renders operator labels', async () => {
    const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
    const otherTenantId = '89078ce2-729a-4b5b-8b40-c749e1605055';
    const originalListResource = apiMod.ui_list_resource_v1;
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    listSpy.mockImplementation((resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
      if (resource === 'workflow_templates') {
        expect(opts?.filter).toEqual({ scope_id: tenantId });
        return Promise.resolve({
          rows: [
            {
              id: 'tpl_active_tenant_signup',
              name: `workflow_binding.tenant_signup.review_requested.global.v1__tenant__${tenantId.replace(/-/g, '')}`,
              template_id: `workflow_binding.tenant_signup.review_requested.global.v1__tenant__${tenantId.replace(/-/g, '')}`,
              version: 3,
              status: 'active',
              trigger: 'tenant_signup',
              scope_type: 'tenant',
              scope_id: tenantId,
              metadata: {
                binding_key: 'tenant_signup',
                stage_key: 'review_requested',
                source_version: 2,
                bootstrap_scope_type: 'tenant',
                bootstrap_scope_id: tenantId,
              },
              steps: [
                {
                  id: 'step_active_review',
                  workflow_template_id: 'tpl_active_tenant_signup',
                  sequence_order: 1,
                  operation_name: 'binding_tenant_signup_review_task',
                  metadata: { kind: 'action', label: 'Create review task' },
                },
              ],
            },
            {
              id: 'tpl_other_tenant_signup',
              name: `workflow_binding.tenant_signup.review_requested.global.v1__tenant__${otherTenantId.replace(/-/g, '')}`,
              template_id: `workflow_binding.tenant_signup.review_requested.global.v1__tenant__${otherTenantId.replace(/-/g, '')}`,
              version: 3,
              status: 'active',
              trigger: 'tenant_signup',
              scope_type: 'tenant',
              scope_id: otherTenantId,
              metadata: {
                binding_key: 'tenant_signup',
                stage_key: 'review_requested',
                source_version: 2,
                bootstrap_scope_type: 'tenant',
                bootstrap_scope_id: otherTenantId,
              },
              steps: [],
            },
          ],
          total: 2,
          page: 0,
          page_size: 200,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      if (resource === 'workflow_template_directory' || resource === 'workflow_runs' || resource === 'recent_workflow_events') {
        return Promise.resolve({
          rows: [],
          total: 0,
          page: 0,
          page_size: 200,
        } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
      }
      return originalListResource(resource, opts);
    });

    try {
      renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_platform_test',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getByText('Tenant Signup - Review Requested')).toBeInTheDocument());
      expect(document.body.textContent ?? '').not.toContain('workflow_binding.tenant_signup');
      expect(document.body.textContent ?? '').not.toContain(otherTenantId.replace(/-/g, ''));
    } finally {
      listSpy.mockRestore();
    }
  });

  it('trigger composer add/remove controls update the condition rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
    await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Triggers' }));
    await waitFor(() => {
      expect(document.querySelector('.modal')).not.toBeNull();
    });
    expect(document.querySelectorAll('.wf-trigger-cond').length).toBe(1);
    await user.click(screen.getByRole('button', { name: /\+ Add condition/ }));
    await waitFor(() => {
      expect(document.querySelectorAll('.wf-trigger-cond').length).toBe(2);
    });
    const removeButtons = screen.getAllByRole('button', { name: /Remove condition/ });
    await user.click(removeButtons[0]!);
    await waitFor(() => {
      expect(document.querySelectorAll('.wf-trigger-cond').length).toBe(1);
    });
  });

  describe('Phase C5 mutation specs', () => {
    // W56-E — typed spy helper preserves the precise MockInstance shape returned
    // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
    let createSpy: TypedSpy<typeof apiMod, 'ui_create_workflow_template_v1'>;
    let statusSpy: TypedSpy<typeof apiMod, 'ui_set_workflow_template_status_v1'>;
    let createStepSpy: TypedSpy<typeof apiMod, 'ui_create_workflow_template_step_v1'>;
    let updateStepSpy: TypedSpy<typeof apiMod, 'ui_update_workflow_template_step_v1'>;
    let duplicateStepSpy: TypedSpy<typeof apiMod, 'ui_duplicate_workflow_template_step_v1'>;
    let deleteStepSpy: TypedSpy<typeof apiMod, 'ui_delete_workflow_template_step_v1'>;
    let diffSpy: TypedSpy<typeof apiMod, 'workflow_template_version_diff_v1'>;
    let restoreSpy: TypedSpy<typeof apiMod, 'restore_workflow_template_v1'>;
    let listResourceSpy: TypedSpy<typeof apiMod, 'ui_list_resource_v1'> | null = null;
    let listOperationsSpy: TypedSpy<typeof apiMod, 'ui_list_operation_templates_v1'> | null = null;
    beforeEach(() => {
      createSpy = typedSpy(apiMod, 'ui_create_workflow_template_v1');
      statusSpy = typedSpy(apiMod, 'ui_set_workflow_template_status_v1');
      createStepSpy = typedSpy(apiMod, 'ui_create_workflow_template_step_v1');
      updateStepSpy = typedSpy(apiMod, 'ui_update_workflow_template_step_v1');
      duplicateStepSpy = typedSpy(apiMod, 'ui_duplicate_workflow_template_step_v1');
      deleteStepSpy = typedSpy(apiMod, 'ui_delete_workflow_template_step_v1');
      diffSpy = typedSpy(apiMod, 'workflow_template_version_diff_v1');
      restoreSpy = typedSpy(apiMod, 'restore_workflow_template_v1');
    });
    afterEach(() => {
      createSpy.mockRestore();
      statusSpy.mockRestore();
      createStepSpy.mockRestore();
      updateStepSpy.mockRestore();
      duplicateStepSpy.mockRestore();
      deleteStepSpy.mockRestore();
      diffSpy.mockRestore();
      restoreSpy.mockRestore();
      listResourceSpy?.mockRestore();
      listOperationsSpy?.mockRestore();
      listResourceSpy = null;
      listOperationsSpy = null;
    });

    it('New template scopes to the active tenant and focuses backend readback without reload', async () => {
      const user = userEvent.setup();
      const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
      const createdTemplateId = 'tpl_created_same_context';
      const createdName = 'Browser workflow create readback';
      const initialTemplate = {
        id: 'tpl_initial_same_context',
        template_id: 'TPL-INITIAL-SAME-CONTEXT',
        name: 'Initial same-context workflow',
        version: 'v1.0.0',
        status: 'active',
        trigger: 'webhook.shipment.created',
        scope_type: 'tenant',
        scope_id: tenantId,
        metadata: { trigger_event: 'webhook.shipment.created' },
        steps: [
          {
            id: 'step_initial_same_context',
            workflow_template_id: 'tpl_initial_same_context',
            sequence_order: 1,
            operation_name: 'webhook.receive',
            kind: 'trigger',
            label: 'Initial trigger',
            metadata: { kind: 'trigger', label: 'Initial trigger' },
          },
        ],
      };
      let workflowTemplates: Array<Record<string, unknown>> = [initialTemplate];
      const originalListResource = apiMod.ui_list_resource_v1;
      listResourceSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      listResourceSpy.mockImplementation((resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
        if (resource === 'workflow_templates') {
          expect(opts?.filter).toEqual({ scope_id: tenantId });
          return Promise.resolve({
            rows: workflowTemplates,
            total: workflowTemplates.length,
            page: 0,
            page_size: 200,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
        }
        if (resource === 'workflow_template_directory' || resource === 'workflow_runs' || resource === 'recent_workflow_events') {
          return Promise.resolve({
            rows: [],
            total: 0,
            page: 0,
            page_size: 200,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
        }
        return originalListResource(resource, opts);
      });
      createSpy.mockImplementation(async (args) => {
        expect(args).toMatchObject({
          name: createdName,
          scope_type: 'tenant',
          scope_id: tenantId,
        });
        workflowTemplates = [
          {
            id: createdTemplateId,
            template_id: 'TPL-CREATED-SAME-CONTEXT',
            name: createdName,
            version: 'v1.0.0',
            status: 'draft',
            trigger: String(args.trigger ?? 'webhook.shipment.created'),
            scope_type: 'tenant',
            scope_id: tenantId,
            metadata: { trigger_event: String(args.trigger ?? 'webhook.shipment.created') },
            steps: [],
          },
          ...workflowTemplates,
        ];
        return {
          ok: true,
          workflow_template_id: createdTemplateId,
          scope_type: 'tenant',
          scope_id: tenantId,
          status: 'draft',
          correlation_id: 'cor_template_scope_readback',
        } as never;
      });

      const { queryClient } = renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_platform_workflow_scope',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getByText('Initial same-context workflow')).toBeInTheDocument());
      await user.click(await screen.findByRole('button', { name: /^New template/ }));
      await user.type(await screen.findByPlaceholderText(/Pickup wave assigner/i), createdName);
      await user.click(await screen.findByRole('button', { name: /^Create$/ }));

      await waitFor(() => expect(createSpy).toHaveBeenCalled());
      await waitFor(() => expect(screen.getAllByText(createdName).length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByText('No steps in this template')).toBeInTheDocument());
      const activeCard = Array.from(document.querySelectorAll('.wf-tpl-card.is-active')).find((el) =>
        (el.textContent ?? '').includes(createdName),
      );
      expect(activeCard).toBeTruthy();
      const createReadback = await screen.findByTestId('workflow-template-promotion-readback');
      await waitFor(() => {
        expect(within(createReadback).getByText('Confirmed from saved data')).toBeInTheDocument();
      });
      expect(within(createReadback).getByText('Create draft')).toBeInTheDocument();
      expect(within(createReadback).getByText('Template recorded')).toBeInTheDocument();
      expect(within(createReadback).getByText(/reference recorded/i)).toBeInTheDocument();
    });

    it('Activate / Deactivate button fires ui_set_workflow_template_status_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      const btn = await screen.findByRole('button', { name: /^(Activate|Deactivate)/ });
      expect(btn.className).toMatch(btn.textContent?.includes('Deactivate') ? /btn--danger/ : /btn--primary/);
      await user.click(btn);
      await waitFor(() => {
        expect(statusSpy).toHaveBeenCalled();
      });
      const args = statusSpy.mock.calls[0]?.[0] as { template_id?: string; status?: string } | undefined;
      expect(args?.template_id).toBeTruthy();
      expect(args?.status).toMatch(/active|inactive/);
    });

    it('Publish button fires ui_create_workflow_template_v1 with clone_from', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      const publishBtn = await screen.findByRole('button', { name: /^Publish/ });
      await user.click(publishBtn);
      await waitFor(() => {
        expect(createSpy).toHaveBeenCalled();
      });
      const args = createSpy.mock.calls[0]?.[0] as { name?: string; clone_from?: string } | undefined;
      expect(args?.name).toBeTruthy();
      expect(args?.clone_from).toBeTruthy();
      expect(args?.name).toContain(' copy ');
      expect(args?.name).not.toBe(args?.clone_from);
    });

    it('diffs and restores a template version through backend readback without reload', async () => {
      const user = userEvent.setup();
      const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
      const sourceTemplateId = 'tpl_restore_source';
      const currentTemplateId = 'tpl_restore_current';
      const sourceStep = {
        id: 'step_restore_source',
        workflow_template_id: sourceTemplateId,
        sequence_order: 1,
        operation_name: 'webhook.receive',
        metadata: { kind: 'trigger', label: 'Source trigger' },
        handler_key: 'workflow_binding_noop',
        handler_version: 'v1',
        enabled: true,
      };
      const currentStep = {
        id: 'step_restore_current',
        workflow_template_id: currentTemplateId,
        sequence_order: 1,
        operation_name: 'mapping.apply',
        metadata: { kind: 'action', label: 'Current mapping' },
        handler_key: 'mapping_apply',
        handler_version: 'v1',
        enabled: true,
      };
      let workflowTemplates: Array<Record<string, unknown>> = [
        {
          id: currentTemplateId,
          template_id: 'TPL-RESTORE-CURRENT',
          name: 'Restore proof workflow',
          version: '2',
          status: 'draft',
          trigger: 'webhook.shipment.created',
          scope_type: 'tenant',
          scope_id: tenantId,
          metadata: { source_template_id: sourceTemplateId, source_version: '1' },
          versions: ['2', '1'],
          steps: [currentStep],
        },
        {
          id: sourceTemplateId,
          template_id: 'TPL-RESTORE-SOURCE',
          name: 'Restore proof workflow',
          version: '1',
          status: 'inactive',
          trigger: 'webhook.shipment.created',
          scope_type: 'tenant',
          scope_id: tenantId,
          metadata: { trigger_event: 'webhook.shipment.created' },
          versions: ['2', '1'],
          steps: [sourceStep],
        },
      ];
      const originalListResource = apiMod.ui_list_resource_v1;
      listResourceSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      listResourceSpy.mockImplementation((resource: string, opts?: Parameters<typeof apiMod.ui_list_resource_v1>[1]) => {
        if (resource === 'workflow_templates') {
          expect(opts?.filter).toEqual({ scope_id: tenantId });
          return Promise.resolve({
            rows: workflowTemplates,
            total: workflowTemplates.length,
            page: 0,
            page_size: 200,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
        }
        if (resource === 'workflow_template_directory') {
          return Promise.resolve({
            rows: workflowTemplates.map((template) => ({
              id: template.id,
              workflow_template_id: template.id,
              template_id: template.template_id,
              name: template.name,
              version: template.version,
              status: template.status,
              scope_id: template.scope_id,
              step_count: Array.isArray(template.steps) ? template.steps.length : 0,
              active_run_count: 0,
              total_run_count: 0,
              last_run_at: null,
              last_run_status: null,
              binding_count: 0,
              is_published: false,
            })),
            total: workflowTemplates.length,
            page: 0,
            page_size: 200,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
        }
        if (resource === 'workflow_runs' || resource === 'recent_workflow_events') {
          return Promise.resolve({
            rows: [],
            total: 0,
            page: 0,
            page_size: 200,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>);
        }
        return originalListResource(resource, opts);
      });
      diffSpy.mockResolvedValue({
        ok: true,
        workflow_template_id: currentTemplateId,
        source_workflow_template_id: sourceTemplateId,
        current_version: '2',
        source_version: '1',
        current_step_count: 1,
        source_step_count: 1,
        added_steps: [],
        removed_steps: [],
        modified_steps: [{
          sequence_order: 1,
          source: { id: sourceStep.id, sequence_order: 1, operation_name: 'webhook.receive', label: 'Source trigger' },
          current: { id: currentStep.id, sequence_order: 1, operation_name: 'mapping.apply', label: 'Current mapping' },
        }],
        unchanged_steps: [],
      } as never);
      restoreSpy.mockImplementation(async () => {
        workflowTemplates = workflowTemplates.map((template) => {
          if (template.id !== currentTemplateId) return template;
          return {
            ...template,
            version: '3',
            metadata: {
              ...(template.metadata as Record<string, unknown>),
              source_template_id: sourceTemplateId,
              restored_from_template_id: sourceTemplateId,
              restored_from_version: '1',
            },
            steps: [{
              ...sourceStep,
              id: 'step_restore_new_readback',
              workflow_template_id: currentTemplateId,
            }],
          };
        });
        return {
          ok: true,
          workflow_template_id: currentTemplateId,
          source_workflow_template_id: sourceTemplateId,
          restored_version: '3',
          source_version: '1',
          restored_step_count: 1,
          correlation_id: 'cor_template_restore_readback',
        } as never;
      });

      renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_platform_workflow_restore',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getAllByText('Restore proof workflow').length).toBeGreaterThan(0));
      await user.click(await screen.findByRole('button', { name: /^Diff$/ }));
      await waitFor(() => expect(diffSpy).toHaveBeenCalledWith({
        workflow_template_id: currentTemplateId,
        source_workflow_template_id: sourceTemplateId,
      }));
      expect(await screen.findByText('Source trigger')).toBeInTheDocument();
      expect(screen.getAllByText('Current mapping').length).toBeGreaterThan(0);
      await user.click(await screen.findByRole('button', { name: /^Restore to 1$/ }));
      await waitFor(() => expect(restoreSpy).toHaveBeenCalledWith({
        workflow_template_id: currentTemplateId,
        source_workflow_template_id: sourceTemplateId,
        reason: 'Console Template Studio restore from 1',
      }));
      const restoreCard = await screen.findByTestId('workflow-template-restore-readback');
      await waitFor(() => {
        expect(within(restoreCard).getByText('Confirmed from saved data')).toBeInTheDocument();
        expect(within(restoreCard).getByText(/expected 3/)).toBeInTheDocument();
        expect(within(restoreCard).getByText(/expected 1/)).toBeInTheDocument();
      });
      await waitFor(() => expect(screen.getAllByText('Source trigger').length).toBeGreaterThan(0));
    });

    it('Publish and Activate show backend-confirmed template promotion readback without reload', async () => {
      const user = userEvent.setup();
      const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
      const sourceTemplateId = 'tpl_promotion_source';
      const cloneTemplateId = 'tpl_promotion_clone';
      let omitCloneDirectory = false;
      let clonePublished = true;
      let appendExtraCloneStep = false;
      const workflowTemplates: Array<Record<string, unknown>> = [
        {
          id: sourceTemplateId,
          template_id: 'TPL-PROMOTION-SOURCE',
          name: 'Promotion proof workflow',
          version: 'v1.0.0',
          status: 'inactive',
          trigger: 'webhook.shipment.created',
          scope_type: 'tenant',
          scope_id: tenantId,
          metadata: { trigger_event: 'webhook.shipment.created' },
          steps: [
            {
              id: 'step_promotion_source',
              workflow_template_id: sourceTemplateId,
              sequence_order: 1,
              operation_name: 'webhook.receive',
              kind: 'trigger',
              label: 'Promotion trigger',
              op: 'webhook.receive',
              metadata: { kind: 'trigger', label: 'Promotion trigger' },
            },
          ],
        },
      ];
      const directoryRows = () =>
        workflowTemplates.map((template) => ({
          id: template.id,
          workflow_template_id: template.id,
          template_id: template.template_id,
          name: template.name,
          status: template.status,
          step_count: Array.isArray(template.steps)
            ? template.steps.length + (appendExtraCloneStep && template.id === cloneTemplateId ? 1 : 0)
            : 0,
          active_run_count: 0,
          total_run_count: 0,
          last_run_at: null,
          last_run_status: null,
          binding_count: 0,
          is_published: template.id === cloneTemplateId ? clonePublished : template.status === 'active',
        })).filter((template) => !(omitCloneDirectory && template.id === cloneTemplateId));
      const originalListResource = apiMod.ui_list_resource_v1;
      listResourceSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      listResourceSpy.mockImplementation((resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'workflow_templates') {
          return Promise.resolve({ rows: [...workflowTemplates], total: workflowTemplates.length, page: 0, page_size: 200 });
        }
        if (resource === 'workflow_template_directory') {
          return Promise.resolve({ rows: directoryRows(), total: workflowTemplates.length, page: 0, page_size: 200 });
        }
        if (resource === 'workflow_runs' || resource === 'recent_workflow_events') {
          return Promise.resolve({ rows: [], total: 0, page: 0, page_size: 200 });
        }
        return originalListResource(resource, opts);
      });
      createSpy.mockImplementation(async (args) => {
        expect(args.clone_from).toBe(sourceTemplateId);
        expect(String(args.name)).toMatch(/^Promotion proof workflow copy /);
        workflowTemplates.unshift({
          ...workflowTemplates[0]!,
          id: cloneTemplateId,
          template_id: 'TPL-PROMOTION-CLONE',
          name: args.name,
          status: 'inactive',
          metadata: {
            ...(workflowTemplates[0]!.metadata as Record<string, unknown>),
            source_template_id: sourceTemplateId,
          },
        });
        return {
          ok: true,
          workflow_template_id: cloneTemplateId,
          correlation_id: 'cor_template_promotion_readback',
        } as never;
      });
      statusSpy.mockImplementation(async (args) => {
        const row = workflowTemplates.find((template) => template.id === args.template_id);
        if (row) row.status = args.status;
        return {
          ok: true,
          workflow_template_id: args.template_id,
          status: args.status,
        } as never;
      });

      const { queryClient } = renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_platform_workflow_promotion',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getByText('Promotion proof workflow')).toBeInTheDocument());
      await user.click(await screen.findByRole('button', { name: /^Publish/ }));

      const publishReadback = await screen.findByTestId('workflow-template-promotion-readback');
      await waitFor(() => expect(within(publishReadback).getByText('Confirmed from saved data')).toBeInTheDocument());
      expect(within(publishReadback).getByText('Clone draft')).toBeInTheDocument();
      expect(within(publishReadback).getByText('Template recorded')).toBeInTheDocument();
      expect(within(publishReadback).getByText(/Source template recorded/i)).toBeInTheDocument();
      expect(within(publishReadback).getByText('1 / 0 (expected steps 1)')).toBeInTheDocument();
      expect(within(publishReadback).getByText(/reference recorded/i)).toBeInTheDocument();

      const refreshTemplateReadback = () => act(async () => {
        await queryClient.invalidateQueries();
      });

      appendExtraCloneStep = true;
      await refreshTemplateReadback();
      await waitFor(() => expect(within(publishReadback).getByText('Waiting for saved data')).toBeInTheDocument());

      appendExtraCloneStep = false;
      await refreshTemplateReadback();
      await waitFor(() => expect(within(publishReadback).getByText('Confirmed from saved data')).toBeInTheDocument());

      await user.click(await screen.findByRole('button', { name: /^Activate/ }));
      const statusReadback = await screen.findByTestId('workflow-template-promotion-readback');
      await waitFor(() => expect(within(statusReadback).getByText('Status change')).toBeInTheDocument());
      await waitFor(() => expect(within(statusReadback).getByText('Active')).toBeInTheDocument());
      expect(within(statusReadback).getByText('Yes')).toBeInTheDocument();

      clonePublished = false;
      await refreshTemplateReadback();
      await waitFor(() => expect(within(statusReadback).getByText('Waiting for saved data')).toBeInTheDocument());

      clonePublished = true;
      omitCloneDirectory = true;
      await refreshTemplateReadback();
      await waitFor(() => expect(within(statusReadback).getByText('Waiting for saved data')).toBeInTheDocument());
    });

    it('operation bind persists selected step through ui_update_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: 'Operations' }));
      await waitFor(() => {
        expect(document.querySelectorAll('.wf-palette__list .wf-tpl-card').length).toBeGreaterThan(0);
      });
      const firstOp = document.querySelector('.wf-palette__list .wf-tpl-card');
      expect(firstOp).toBeTruthy();
      await user.click(firstOp as HTMLElement);
      await waitFor(() => expect(updateStepSpy).toHaveBeenCalled());
      const args = updateStepSpy.mock.calls[0]?.[0] as apiMod.UpdateWorkflowTemplateStepArgs | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.workflow_template_step_id).toBeTruthy();
      expect(args?.patch?.operation_name).toBeTruthy();
    });

    it('trigger composer persists trigger policy through ui_update_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Triggers' }));
      await user.click(await screen.findByRole('button', { name: /Apply trigger/ }));

      await waitFor(() => expect(updateStepSpy).toHaveBeenCalled());
      const args = updateStepSpy.mock.calls.at(-1)?.[0] as
        | apiMod.UpdateWorkflowTemplateStepArgs
        | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.workflow_template_step_id).toBeTruthy();
      expect(args?.patch?.condition_jsonlogic).toBeTruthy();
      expect(args?.patch?.metadata).toMatchObject({
        trigger_event: expect.any(String),
        trigger_conditions: expect.any(Array),
      });
    });

    it('Pin sample data persists step metadata and shows same-context readback', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Pin sample data'));

      await waitFor(() => expect(updateStepSpy).toHaveBeenCalled());
      const args = updateStepSpy.mock.calls.at(-1)?.[0] as
        | apiMod.UpdateWorkflowTemplateStepArgs
        | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.workflow_template_step_id).toBeTruthy();
      expect(args?.patch?.metadata).toMatchObject({
        console_sample_pin: expect.objectContaining({
          workflow_template_id: args?.workflow_template_id,
          workflow_template_step_id: args?.workflow_template_step_id,
          source: 'console_v2.workflow_template_step_action',
        }),
      });

      const readback = await screen.findByTestId('workflow-template-step-action-readback');
      expect(within(readback).getByText('Confirmed from saved data')).toBeInTheDocument();
      expect(within(readback).getByText('Pin sample data')).toBeInTheDocument();
      expect(within(readback).getByText('Step recorded')).toBeInTheDocument();
    });

    it('Decision trail step action opens the reusable decision evidence drawer', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Decision trail'));

      await waitFor(() => {
        expect(screen.getByText(/Decisions, settings resolutions, and audit entries/i)).toBeInTheDocument();
      });
      expect(updateStepSpy).not.toHaveBeenCalled();
    });

    it('Add step palette persists through ui_create_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Add step/ }));
      await waitFor(() => expect(document.querySelector('.palette__item')).toBeTruthy());
      const firstItem = document.querySelector('.palette__item');
      await user.click(firstItem as HTMLElement);
      await waitFor(() => expect(createStepSpy).toHaveBeenCalled());
      const args = createStepSpy.mock.calls[0]?.[0] as apiMod.CreateWorkflowTemplateStepArgs | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.step?.operation_name).toBeTruthy();
    });

    it('blank template Add trigger creates the first step through ui_create_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      const blankTemplate = {
        id: 'tpl_blank_first_step',
        template_id: 'TPL-BLANK-V1',
        name: 'Blank first-step workflow',
        version: 'v1.0.0',
        status: 'inactive',
        trigger: 'webhook.shipment.created',
        versions: ['v1.0.0'],
        steps: [],
      };
      const triggerOperation: apiMod.OperationTemplate = {
        id: 'op_webhook_receive',
        operation_name: 'webhook.receive',
        kind: 'trigger',
        category: 'webhook',
        timeout_seconds: 30,
        description: 'Inbound entrypoint for webhook.receive',
      };
      const nonTriggerOperation: apiMod.OperationTemplate = {
        id: 'op_mapping_apply',
        operation_name: 'mapping.apply',
        kind: 'transform',
        category: 'mapping',
        timeout_seconds: 30,
        description: 'Mapping transform',
      };
      const originalListResource = apiMod.ui_list_resource_v1;
      listResourceSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      listResourceSpy.mockImplementation((resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'workflow_templates') {
          return Promise.resolve({ rows: [blankTemplate], total: 1 });
        }
        return originalListResource(resource, opts);
      });
      listOperationsSpy = typedSpy(apiMod, 'ui_list_operation_templates_v1');
      listOperationsSpy.mockResolvedValue({
        rows: [nonTriggerOperation, triggerOperation],
        total: 2,
      });

      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Blank first-step workflow')).toBeInTheDocument());
      const addTrigger = await screen.findByRole('button', { name: /Add trigger/ });
      expect(addTrigger).toBeEnabled();

      await user.click(addTrigger);
      await waitFor(() => expect(document.querySelector('.palette__item')).toBeTruthy());
      expect(document.body.textContent ?? '').toContain('webhook.receive');
      expect(document.body.textContent ?? '').not.toContain('mapping.apply');

      await user.click(document.querySelector('.palette__item') as HTMLElement);
      await waitFor(() => expect(createStepSpy).toHaveBeenCalled());
      const args = createStepSpy.mock.calls[0]?.[0] as apiMod.CreateWorkflowTemplateStepArgs | undefined;
      expect(args?.workflow_template_id).toBe('tpl_blank_first_step');
      expect(args?.step?.operation_name).toBe('webhook.receive');
      expect(args?.step?.kind).toBe('trigger');
      expect(args?.step?.sequence_order).toBe(1);
      expect(args?.step?.metadata).toMatchObject({
        trigger_event: 'webhook.shipment.created',
      });
    });

    it('keeps created, duplicated, and deleted steps reconciled from backend readback without reload', async () => {
      const user = userEvent.setup();
      const tenantId = '0df679dd-6f41-4b27-8a7b-dac5fb8d3a53';
      const templateId = 'tpl_step_lifecycle_readback';
      const createdStepId = 'step_created_backend_readback';
      const duplicatedStepId = 'step_duplicated_backend_readback';
      const triggerOperation: apiMod.OperationTemplate = {
        id: 'op_webhook_receive_readback',
        operation_name: 'webhook.receive',
        kind: 'trigger',
        category: 'webhook',
        timeout_seconds: 30,
        description: 'Inbound webhook receive step',
      };
      let steps: Array<Record<string, unknown>> = [];
      const templateRow = () => ({
        id: templateId,
        template_id: 'TPL-STEP-LIFECYCLE',
        name: 'Backend step lifecycle workflow',
        version: 'v1.0.0',
        status: 'inactive',
        trigger: 'webhook.shipment.created',
        scope_type: 'tenant',
        scope_id: tenantId,
        metadata: { trigger_event: 'webhook.shipment.created' },
        steps,
      });
      const originalListResource = apiMod.ui_list_resource_v1;
      listResourceSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      listResourceSpy.mockImplementation((resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'workflow_templates') {
          expect(opts?.filter).toEqual({ scope_id: tenantId });
          return Promise.resolve({ rows: [templateRow()], total: 1, page: 0, page_size: 200 });
        }
        if (resource === 'workflow_template_directory') {
          return Promise.resolve({
            rows: [{
              id: templateId,
              workflow_template_id: templateId,
              template_id: 'TPL-STEP-LIFECYCLE',
              name: 'Backend step lifecycle workflow',
              status: 'inactive',
              step_count: steps.length,
              active_run_count: 0,
              total_run_count: 0,
              last_run_at: null,
              last_run_status: null,
              binding_count: 0,
              is_published: false,
            }],
            total: 1,
            page: 0,
            page_size: 200,
          });
        }
        if (resource === 'workflow_runs' || resource === 'recent_workflow_events') {
          return Promise.resolve({ rows: [], total: 0, page: 0, page_size: 200 });
        }
        return originalListResource(resource, opts);
      });
      listOperationsSpy = typedSpy(apiMod, 'ui_list_operation_templates_v1');
      listOperationsSpy.mockResolvedValue({ rows: [triggerOperation], total: 1 });
      createStepSpy.mockImplementation(async (args) => {
        steps = [{
          id: createdStepId,
          workflow_template_id: templateId,
          sequence_order: 1,
          operation_name: String(args.step.operation_name),
          kind: String(args.step.kind),
          label: String(args.step.label),
          op: String(args.step.operation_name),
          metadata: { kind: String(args.step.kind), label: String(args.step.label) },
        }];
        return {
          ok: true,
          workflow_template_id: templateId,
          workflow_template_step_id: createdStepId,
          action: 'created',
          correlation_id: 'cor_step_created_readback',
        } as never;
      });
      duplicateStepSpy.mockImplementation(async () => {
        steps = [
          steps[0]!,
          {
            ...steps[0]!,
            id: duplicatedStepId,
            sequence_order: 2,
            metadata: {
              ...(steps[0]!.metadata as Record<string, unknown>),
              duplicated_from_step_id: createdStepId,
            },
          },
        ];
        return {
          ok: true,
          workflow_template_id: templateId,
          workflow_template_step_id: duplicatedStepId,
          source_workflow_template_step_id: createdStepId,
          action: 'duplicated',
          correlation_id: 'cor_step_duplicated_readback',
        } as never;
      });
      deleteStepSpy.mockImplementation(async () => {
        steps = steps.filter((step) => step.id !== duplicatedStepId);
        return {
          ok: true,
          workflow_template_id: templateId,
          workflow_template_step_id: duplicatedStepId,
          deleted: true,
          soft_deleted: false,
          action: 'deleted',
          correlation_id: 'cor_step_deleted_readback',
        } as never;
      });

      renderWithProviders(<TemplatesModule />, {
        identity: {
          user: {
            id: 'usr_platform_workflow_step_lifecycle',
            access_scope_type: 'platform',
            access_scope_id: null,
            organization_id: tenantId,
          },
          scope: { tenant: { id: tenantId, label: 'First Tenant Retail', rank: 2 } },
          capabilities: ['all'],
        },
      });

      await waitFor(() => expect(screen.getByText('Backend step lifecycle workflow')).toBeInTheDocument());
      await user.click(await screen.findByRole('button', { name: /Add trigger/ }));
      await user.click(await screen.findByText('webhook.receive'));
      await waitFor(() => expect(createStepSpy).toHaveBeenCalled());
      await waitFor(() => {
        expect(document.querySelector(`.wf-node.is-active[data-step-id="${createdStepId}"]`)).not.toBeNull();
      });
      expect(screen.queryByText('No step selected')).not.toBeInTheDocument();

      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Duplicate step'));
      await waitFor(() => expect(duplicateStepSpy).toHaveBeenCalled());
      await waitFor(() => {
        expect(document.querySelector(`.wf-node.is-active[data-step-id="${duplicatedStepId}"]`)).not.toBeNull();
      });

      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Delete step'));
      await user.click(await screen.findByRole('button', { name: /^Delete$/ }));
      await waitFor(() => expect(deleteStepSpy).toHaveBeenCalled());
      await waitFor(() => {
        expect(document.querySelector(`.wf-node[data-step-id="${duplicatedStepId}"]`)).toBeNull();
        expect(document.querySelector(`.wf-node.is-active[data-step-id="${createdStepId}"]`)).not.toBeNull();
      });
    });

    it('Duplicate step action persists through ui_duplicate_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Duplicate step'));
      await waitFor(() => expect(duplicateStepSpy).toHaveBeenCalled());
      const args = duplicateStepSpy.mock.calls[0]?.[0] as apiMod.DuplicateWorkflowTemplateStepArgs | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.workflow_template_step_id).toBeTruthy();
    });

    it('Delete step confirmation persists through ui_delete_workflow_template_step_v1', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() => expect(screen.getByText('Template Studio')).toBeInTheDocument());
      await user.click(screen.getByTitle('Step actions'));
      await user.click(await screen.findByText('Delete step'));
      await user.click(await screen.findByRole('button', { name: /^Delete$/ }));
      await waitFor(() => expect(deleteStepSpy).toHaveBeenCalled());
      const args = deleteStepSpy.mock.calls[0]?.[0] as apiMod.DeleteWorkflowTemplateStepArgs | undefined;
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.workflow_template_step_id).toBeTruthy();
    });
  });

  // W22 — paired projection view consumption (additive). The studio palette
  // renders per-template counter chips sourced from
  // `v_workflow_template_directory` (supabase/migrations/202604302110_*).
  // The seed-mode projection mirrors the live view shape so the palette
  // counters stay deterministic across cutover.
  describe('W22 paired projection view (workflow_template_directory)', () => {
    it('renders palette template cards with run-count chips sourced from the directory projection', async () => {
      renderWithProviders(<TemplatesModule />, { capabilities: ['all'] });
      await waitFor(() =>
        expect(screen.getByText('Exampleparcel KSA inbound intake')).toBeInTheDocument(),
      );
      // The seed has multiple workflow_runs anchored to tpl_intake_exampleparcel
      // (WFR-3221, WFR-3218, WFR-3217, WFR-3215), so the palette card for
      // Exampleparcel KSA inbound intake should display "<n> runs" chip from the
      // total_run_count projection.
      const cards = document.querySelectorAll('.wf-palette__list .wf-tpl-card');
      expect(cards.length).toBeGreaterThan(0);
      // At least one card must surface the canonical counter chip (".. runs"
      // mono text). Asserting presence is enough — seed counts can shift
      // across waves but the projection seam stays canonical.
      const runsChips = Array.from(document.querySelectorAll('.wf-tpl-card__runs'));
      const haveCount = runsChips.some((el) => /\d+\s+runs/.test(el.textContent ?? ''));
      expect(haveCount).toBe(true);
    });
  });
});
