// Light-weight integration tests for the BindingsModule. We mount through the
// real provider stack (renderWithProviders) and hit MSW-served reads. Tests
// focus on:
//   - The module mounts and renders the bindings table without crashing.
//   - The condition builder opens, accepts a row edit, exposes a friendly rule preview
//     preview, and validates input.
//   - The event tester opens and reports invalid JSON.
//   - Phase C5: New binding fires register_workflow_binding_v1; Test condition
//     row action fires simulate_binding_dispatch_v1.
//   - W11-6 (CLAIM-WORKFLOWS-DEFERRED): Dispatches tab surfaces the canonical
//     workflow_binding_dispatches ledger.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { BindingsModule } from './bindings';
import * as apiMod from '@/lib/api';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

async function mountAndWait() {
  const utils = renderWithProviders(<BindingsModule />);
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
  return utils;
}

describe('BindingsModule', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/workflows/bindings');
  });

  it('renders the page header and bindings table', async () => {
    await mountAndWait();
    expect(screen.getAllByText(/Bindings/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Stage')).toBeInTheDocument();
    // Event catalog visible.
    expect(screen.getByLabelText(/event catalog/i)).toBeInTheDocument();
  });

  it('shows a denied state without issuing protected workflow binding reads', async () => {
    const listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
    try {
      renderWithProviders(<BindingsModule />, { capabilities: [] });

      expect(await screen.findByText(/You do not have permission to view workflow bindings/i)).toBeInTheDocument();
      await waitFor(() => {
        const resources = listSpy.mock.calls.map(([resource]) => resource);
        expect(resources).not.toContain('workflow_bindings');
        expect(resources).not.toContain('workflow_templates');
        expect(resources).not.toContain('recent_workflow_events');
        expect(resources).not.toContain('workflow_binding_dispatches');
        expect(resources).not.toContain('workflow_binding_directory');
      });
      expect(screen.queryByRole('button', { name: /^New binding/i })).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('opens a binding from the event catalog with the keyboard (WCAG 2.5.7, #301)', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    const card = screen.getAllByLabelText(/Open binding/i)[0]!;
    expect(card).not.toHaveAttribute('draggable');
    card.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button', { name: /Edit condition visually/i })).toBeInTheDocument();
  });

  it('opens condition builder modal on row action and shows a rule preview', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    // Open the first binding drawer via the event-card button.
    const cards = screen.getAllByLabelText(/Open binding/i);
    expect(cards.length).toBeGreaterThan(0);
    await user.click(cards[0]!);
    // Drawer is open; click "Edit condition visually".
    const editBtn = await screen.findByRole('button', { name: /Edit condition visually/i });
    await user.click(editBtn);
    const preview = await screen.findByTestId('wf-cond-rule-preview');
    expect(preview.textContent).toMatch(/sender|AND|ALL/i);
  });

  it('validates an invalid regex value with an error chip', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    const cards = screen.getAllByLabelText(/Open binding/i);
    await user.click(cards[0]!);
    const editBtn = await screen.findByRole('button', { name: /Edit condition visually/i });
    await user.click(editBtn);
    // Pick the first row's operator dropdown and switch to matches.
    const rows = await screen.findAllByTestId('wf-cond-row');
    const opSelect = within(rows[0]!).getByLabelText(/Operator/i) as HTMLSelectElement;
    await user.selectOptions(opSelect, 'matches');
    const valueInput = within(rows[0]!).getByLabelText(/Value/i) as HTMLInputElement;
    await user.clear(valueInput);
    // Invalid regex pattern — bare `(` does not parse.
    await user.type(valueInput, '(');
    // The validation pane shows an error (and the per-row chip also shows it,
    // so we assert that at least one match is present).
    expect(screen.getAllByText(/Invalid regex/i).length).toBeGreaterThan(0);
  });

  it('reports invalid details in the event tester', async () => {
    const user = userEvent.setup();
    await mountAndWait();
    const tester = await screen.findByRole('button', { name: /Test event/i });
    await user.click(tester);
    const textarea = await screen.findByLabelText(/Event details/i);
    await user.clear(textarea);
    // Use `userEvent.type` with `{{` to escape the `{` it treats as a special
    // key sequence opener.
    await user.type(textarea, '{{not-json');
    // The invalid details string surfaces in both the chip and the resolution
    // hint. We just need at least one to be visible.
    expect(screen.getAllByText(/invalid details/i).length).toBeGreaterThan(0);
  });

  it('gates the New binding header action and n shortcut without workflow update access', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BindingsModule />, { capabilities: ['workflows.read'] });
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    const newBinding = await screen.findByRole('button', { name: /^New binding/ });
    expect(newBinding).toBeDisabled();
    expect(screen.getAllByText(/Workflow Update permission required/i).length).toBeGreaterThan(0);

    await user.keyboard('n');
    expect(document.querySelector('.modal')).toBeNull();
  });

  describe('Phase C5 mutation specs', () => {
    // W56-E — typed spy helper preserves the precise MockInstance shape returned
    // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
    let registerSpy: TypedSpy<typeof apiMod, 'register_workflow_binding_v1'>;
    let simulateSpy: TypedSpy<typeof apiMod, 'simulate_binding_dispatch_v1'>;
    let proposeSpy: TypedSpy<typeof apiMod, 'proposeSettingsChange'>;
    let listSpy: TypedSpy<typeof apiMod, 'ui_list_resource_v1'>;
    let latestBindingKey = '';
    let latestBindingStatus = 'active';
    let latestBindingTemplateId = 'tpl_intake_exampleparcel';
    let latestBindingStage = 'default';
    let latestBindingCondition: Record<string, unknown> | null = null;
    beforeEach(() => {
      const listResource = apiMod.ui_list_resource_v1;
      latestBindingKey = '';
      latestBindingStatus = 'active';
      latestBindingTemplateId = 'tpl_intake_exampleparcel';
      latestBindingStage = 'default';
      latestBindingCondition = null;
      registerSpy = typedSpy(apiMod, 'register_workflow_binding_v1');
      simulateSpy = typedSpy(apiMod, 'simulate_binding_dispatch_v1');
      proposeSpy = typedSpy(apiMod, 'proposeSettingsChange');
      listSpy = typedSpy(apiMod, 'ui_list_resource_v1');
      registerSpy.mockImplementation(async (args) => {
        latestBindingKey = String(args.binding_key ?? latestBindingKey);
        latestBindingStatus = args.enabled === false ? 'disabled' : 'active';
        latestBindingTemplateId = String(args.workflow_template_id ?? latestBindingTemplateId);
        latestBindingStage = String(args.stage_key ?? latestBindingStage);
        latestBindingCondition = (args.condition as Record<string, unknown> | null | undefined) ?? latestBindingCondition;
        return {
          ok: true,
          workflow_binding_registration_id: 'wbr_bindings_readback_test',
          binding_key: args.binding_key,
          stage_key: latestBindingStage,
          workflow_template_id: latestBindingTemplateId,
          correlation_id: 'cor_bindings_readback_test',
        } as never;
      });
      listSpy.mockImplementation(async (resource, opts) => {
        const result = await listResource(resource, opts);
        if (!latestBindingKey || (resource !== 'workflow_bindings' && resource !== 'workflow_binding_directory')) {
          return result;
        }
        return {
          ...result,
          rows: result.rows.map((row) => {
            const r = row as Record<string, unknown>;
            const rowKey =
              typeof r.binding_key === 'string'
                ? r.binding_key
                : typeof r.event === 'string'
                  ? `${r.event}.${typeof r.stage_key === 'string' && r.stage_key.trim() ? r.stage_key : 'default'}`
                  : typeof r.id === 'string'
                    ? r.id
                    : '';
            if (rowKey !== latestBindingKey) return row;
            if (resource === 'workflow_binding_directory') {
              return {
                ...r,
                default_workflow_template_id: latestBindingTemplateId,
                is_active: latestBindingStatus === 'active',
              } as never;
            }
            return {
              ...r,
              status: latestBindingStatus,
              template_id: latestBindingTemplateId,
              workflow_template_id: latestBindingTemplateId,
              condition: latestBindingCondition,
            } as never;
          }),
        };
      });
    });
    afterEach(() => {
      registerSpy.mockRestore();
      simulateSpy.mockRestore();
      proposeSpy.mockRestore();
      listSpy.mockRestore();
    });

    it('Test condition row action fires simulate_binding_dispatch_v1 with canonical binding_key + stage_key', async () => {
      // Wave 5 RE-AUDIT (WORKFLOWS.md P1): canonical Phase B6 RPC contract
      // requires `binding_key` (composed `${event}.${stage}`, NOT row UUID)
      // AND `stage_key` (migration 202604280222). Call sites derive the
      // canonical pair from row.event + row.stage_key (default 'default').
      const user = userEvent.setup();
      await mountAndWait();
      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      const test = await screen.findByRole('option', { name: /Test condition/ });
      await user.click(test);
      await waitFor(() => {
        expect(simulateSpy).toHaveBeenCalled();
      });
      const args = simulateSpy.mock.calls[0]?.[0] as
        | { binding_key?: string; stage_key?: string; event?: string; inputs?: Record<string, unknown>; payload?: Record<string, unknown> }
        | undefined;
      expect(args?.binding_key).toBeTruthy();
      expect(args?.event).toBeTruthy();
      // Canonical contract: stage_key MUST be sent.
      expect(args?.stage_key).toBeTruthy();
      // Canonical binding_key shape is `${event}.${stage_key}`, never the row UUID.
      expect(args?.binding_key).toBe(`${args?.event}.${args?.stage_key}`);
      // W35c-3 — canonical RPC reads simulation inputs from `p_args->'inputs'`
      // (supabase/migrations/202604280222_*.sql:30). The FE callsite must send
      // the sample under `inputs` (not the legacy `payload` key) so live mode
      // executes against the intended event payload, not against an empty
      // `COALESCE(p_args->'inputs', '{}'::jsonb)` default.
      expect(args).toHaveProperty('inputs');
      expect(typeof args?.inputs).toBe('object');
      expect(args?.payload).toBeUndefined();
      const readback = await screen.findByTestId('workflow-binding-simulation-readback');
      expect(readback).toHaveTextContent(/Binding matched/i);
      expect(readback).toHaveTextContent(/Stage matched/i);
    });

    it('New binding modal sends canonical workflow_template_id (not template_id)', async () => {
      // Wave 5 RE-AUDIT (WORKFLOWS.md P0 #2): canonical Phase B6 RPC contract
      // key is `workflow_template_id` (migration 202604280221), not
      // `template_id`. Call sites send the canonical key; the api facade
      // adapter still translates `template_id` defensively.
      const user = userEvent.setup();
      await mountAndWait();
      // Open the New binding modal via the topbar button.
      const newBinding = await screen.findByRole('button', { name: /^New binding/ });
      await user.click(newBinding);
      // Click the "Create" button inside the modal to fire the mutation.
      const createBtn = await screen.findByRole('button', { name: /^Create$/ });
      await user.click(createBtn);
      await waitFor(() => {
        expect(registerSpy).toHaveBeenCalled();
      });
      const args = registerSpy.mock.calls[0]?.[0] as
        | { binding_key?: string; stage_key?: string; workflow_template_id?: string; template_id?: string }
        | undefined;
      // Canonical contract: workflow_template_id present, template_id absent.
      expect(args?.workflow_template_id).toBeTruthy();
      expect(args?.template_id).toBeUndefined();
      expect(args?.binding_key).toBeTruthy();
      expect(args?.stage_key).toBeTruthy();
    });

    it('Condition Save writes through register_workflow_binding_v1 with backend condition readback', async () => {
      const user = userEvent.setup();
      await mountAndWait();

      const cards = await screen.findAllByLabelText(/Open binding/i);
      await user.click(cards[0]!);
      const editBtn = await screen.findByRole('button', { name: /Edit condition visually/i });
      await user.click(editBtn);
      const save = await screen.findByRole('button', { name: /^Save$/ });
      await user.click(save);

      await waitFor(() => {
        expect(registerSpy).toHaveBeenCalled();
      });
      expect(proposeSpy).not.toHaveBeenCalled();
      const args = registerSpy.mock.calls.at(-1)?.[0] as
        | { binding_key?: string; stage_key?: string; workflow_template_id?: string; condition?: Record<string, unknown> | null }
        | undefined;
      expect(args).toMatchObject({
        binding_key: expect.any(String),
        stage_key: expect.any(String),
        workflow_template_id: expect.any(String),
        condition: expect.any(Object),
      });
      const readback = await screen.findByTestId('workflow-binding-mutation-readback');
      await waitFor(() =>
        expect(within(readback).getByText(/Confirmed from saved data/i)).toBeInTheDocument(),
      );
      expect(within(readback).getByTestId('workflow-binding-mutation-condition')).toHaveTextContent(/sender/i);
      expect(within(readback).getByTestId('workflow-binding-mutation-visible-table')).toHaveTextContent('Refreshed');
      expect(within(readback).getByTestId('workflow-binding-mutation-directory')).toHaveTextContent('Refreshed');
    });

    it('Disable and Re-enable actions write through register_workflow_binding_v1 for backend-backed status readback', async () => {
      const user = userEvent.setup();
      await mountAndWait();

      const cards = await screen.findAllByLabelText(/Open binding/i);
      await user.click(cards[0]!);
      const disable = await screen.findByRole('button', { name: /^Disable$/ });
      await user.click(disable);

      await waitFor(() => {
        expect(registerSpy).toHaveBeenCalled();
      });
      const disableArgs = registerSpy.mock.calls.at(-1)?.[0] as
        | { binding_key?: string; stage_key?: string; workflow_template_id?: string; enabled?: boolean; scope_type?: string }
        | undefined;
      expect(disableArgs?.binding_key).toBeTruthy();
      expect(disableArgs?.stage_key).toBeTruthy();
      expect(disableArgs?.workflow_template_id).toBeTruthy();
      expect(disableArgs?.enabled).toBe(false);
      expect(disableArgs?.scope_type).toBeTruthy();
      expect(proposeSpy).not.toHaveBeenCalled();

      const disabledRow = await screen.findByText(/^Disabled$/i);
      expect(disabledRow).toBeInTheDocument();
      const disableReadback = await screen.findByTestId('workflow-binding-mutation-readback');
      await waitFor(() =>
        expect(within(disableReadback).getByText(/Confirmed from saved data/i)).toBeInTheDocument(),
      );
      expect(within(disableReadback).getByTestId('workflow-binding-mutation-status')).toHaveTextContent('Disabled');
      expect(within(disableReadback).getByTestId('workflow-binding-mutation-visible-table')).toHaveTextContent('Refreshed');
      expect(within(disableReadback).getByTestId('workflow-binding-mutation-directory')).toHaveTextContent('Refreshed');
      expect(within(disableReadback).getByText(/Registration recorded/i)).toBeInTheDocument();

      const refreshedCards = await screen.findAllByLabelText(/Open binding/i);
      await user.click(refreshedCards[0]!);
      const reEnable = await screen.findByRole('button', { name: /^Re-enable$/ });
      await user.click(reEnable);

      await waitFor(() => {
        const latest = registerSpy.mock.calls.at(-1)?.[0] as
          | { enabled?: boolean }
          | undefined;
        expect(latest?.enabled).toBe(true);
      });
      await waitFor(() => {
        expect(screen.getAllByText(/^Active$/i).length).toBeGreaterThan(0);
      });
      const reenableReadback = await screen.findByTestId('workflow-binding-mutation-readback');
      await waitFor(() =>
        expect(within(reenableReadback).getByText(/Confirmed from saved data/i)).toBeInTheDocument(),
      );
      await waitFor(() => {
        expect(within(reenableReadback).getByTestId('workflow-binding-mutation-status')).toHaveTextContent('Active');
      });
    });
  });

  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — Dispatches tab surfaces the canonical
  // workflow_binding_dispatches ledger from
  // supabase/migrations/202603091331_workflow_binding_policy_substrate_v1.sql:224.
  describe('W11-6 Dispatches tab', () => {
    it('renders the page-level tab strip with both tabs', async () => {
      await mountAndWait();
      const tabs = await screen.findByTestId('wf-bindings-tabs');
      expect(tabs).toBeInTheDocument();
      expect(within(tabs).getByTestId('wf-bindings-tab-bindings')).toBeInTheDocument();
      expect(within(tabs).getByTestId('wf-bindings-tab-dispatches')).toBeInTheDocument();
    });

    it('switches to the Dispatches tab and lists workflow_binding_dispatches rows', async () => {
      const user = userEvent.setup();
      await mountAndWait();
      const dispatchesTab = await screen.findByTestId('wf-bindings-tab-dispatches');
      await user.click(dispatchesTab);
      // Seeded dispatches mention the canonical binding_key shape e.g. webhook.shipment.created.default.
      await waitFor(() =>
        expect(screen.getAllByText(/webhook\.shipment\.created\.default/).length).toBeGreaterThan(0),
      );
      // Clean URL deep-link is updated so the tab survives reload.
      expect(window.location.search).toContain('tab=dispatches');
    });

    it('shows outcome chips with canonical workflow_binding_dispatches.outcome enum', async () => {
      const user = userEvent.setup();
      await mountAndWait();
      const dispatchesTab = await screen.findByTestId('wf-bindings-tab-dispatches');
      await user.click(dispatchesTab);
      // The dispatches table should render at least one of each outcome from the seed:
      // started / completed / waiting / failed (canonical CHECK constraint).
      await waitFor(() => {
        expect(screen.getAllByText(/^completed$/i).length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText(/^started$/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/^failed$/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/^waiting$/i).length).toBeGreaterThan(0);
    });
  });

  // W22 — paired projection view consumption (additive). The bindings list
  // resolves template_name from `v_workflow_binding_directory`
  // (supabase/migrations/202604302120_*) via the most-recent dispatch FK
  // join when the projection row is present. The seed-mode projection
  // mirrors the live view shape so the binding rows stay deterministic
  // across cutover.
  describe('W22 paired projection view (workflow_binding_directory)', () => {
    it('renders binding rows with template_name resolved through the directory projection', async () => {
      await mountAndWait();
      // The seed has wbn_1 (event=webhook.shipment.created) bound to
      // tpl_intake_exampleparcel. Both the legacy template lookup and the
      // canonical projection (default_template_name from the most recent
      // dispatch wbd_3221) resolve to the same canonical name.
      // A single match would prove the rendering path stays canonical.
      await waitFor(() =>
        expect(screen.getAllByText(/Exampleparcel KSA inbound intake/).length).toBeGreaterThan(0),
      );
    });
  });

  // W37 — capability-gating closure for the bindings drawer + condition-builder
  // modal Save buttons. Same defect class as W35c-2 (review-queue) on a
  // different surface: every write affordance must gate on the canonical
  // capability the server RPC asserts (`workflows.write` for
  // register_workflow_binding_v1). Closes REAUDIT4 WORKFLOWS NEW P1.
  //
  // We use a source-grep regression guard (mirrors the W37-PLATFORM pattern)
  // because the existing 90-test mutation suite already exercises the
  // positive paths via spy assertions; any future revert that strips
  // `capability="workflows.write"` from these specific Buttons would fail
  // this guard at test time without depending on drawer DOM querying.
  describe('W37 capability gating on bindings drawer write affordances', () => {
    it('every drawer/modal Save-class Button carries capability="workflows.write"', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const file = path.resolve(__dirname, './bindings.tsx');
      const src = fs.readFileSync(file, 'utf8');

      // Helper: extract the `<Button ...>` (or self-closing) opening tag whose
      // body matches `re` and assert it has a workflows.write capability gate
      // — either as the string literal (legacy) or the canonical typed
      // `CAP.WORKFLOWS_WRITE` expression introduced by the Wave 10 codemod.
      const assertButtonGated = (re: RegExp, _name: string) => {
        // Match `<Button ... <re> ... />` or `<Button ... <re> ...></Button>`.
        // We strip the closing `/>` or `>` and only inspect the opening tag.
        const tagMatches = src.matchAll(/<Button\b([\s\S]*?)\/>/g);
        const matches = Array.from(tagMatches).filter((m) => re.test(m[1] ?? ''));
        expect(matches.length).toBeGreaterThan(0);
        for (const m of matches) {
          expect(m[1]).toMatch(/capability=(\{CAP\.WORKFLOWS_WRITE\}|"workflows\.write")/);
        }
      };

      // Drawer Save (condition builder modal footer)
      assertButtonGated(/label="Save"/, 'Save');
      // Drawer "Edit condition visually" entry point
      assertButtonGated(/label="Edit condition visually"/, 'Edit condition visually');
      // Drawer toggle status button — Cycle E2 (Workflows P1 #4) made the
      // label canonical-row-driven (`workflow_binding_status.metadata
      // .toggle_label`). The button now renders dynamically from the
      // resolved `toggleLabel` variable. Match the canonical shape so the
      // capability gate stays asserted at compile time.
      assertButtonGated(/label=\{toggleLabel\}/, 'workflow_binding_status toggle');
      // Bulk reassign modal footer (label is `Reassign ${rows.length}`)
      assertButtonGated(/label=\{`Reassign \$\{rows\.length\}`\}/, 'Reassign N');
      // Header New Binding entry point and matching keyboard shortcut route.
      assertButtonGated(/label="New binding"/, 'New binding');
    });

    it('keeps failed local preview persistence seed-only', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const file = path.resolve(__dirname, './bindings.tsx');
      const src = fs.readFileSync(file, 'utf8');

      expect(src).toContain('isConsoleSeedModeEnabled');
      expect(src).toContain('seedDiagnosticsEnabled');
      expect(src).not.toContain('(offline preview)');
      expect(src).toMatch(/if \(seedDiagnosticsEnabled\)[\s\S]*patchBinding\(row\.id, patch\)/);
      expect(src).toMatch(/pushToast\(`\$\{label\} failed/);
    });
  });
});
