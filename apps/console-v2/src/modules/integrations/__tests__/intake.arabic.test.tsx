// intake.arabic.test.tsx: the intake page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { IntakeModule } from '@/modules/integrations/intake';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-intake';
import arShell from '@/lib/seed-raw/i18n/areas/ar/shell';

const AR = ar.integrationsIntake.intakeModule;
const TENANT_ID = 'org_rashed';
const SOURCE_LABEL = 'Exampleparcel KSA production';
// A short inbox id is shown whole inside the event reference.
const INBOX_ID = 'wbk7';
// Supplied data shown as-is: the inbox id and the source label.
const DATA = [INBOX_ID, 'Exampleparcel', 'KSA', 'production'];

let inboxRows: Array<Record<string, unknown>> = [];

function inboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INBOX_ID,
    organization_id: TENANT_ID,
    webhook_source_id: 'whs_exampleparcel_ksa',
    source_label: SOURCE_LABEL,
    source_identifier: 'exampleparcel-ksa-prod',
    provider_type_label: 'Webhook',
    created_at: '2026-05-10T12:00:00Z',
    processing_status: 'failed',
    event_type: 'shipment.created',
    payload_size: 1024,
    external_id: 'AMZ-TEST-001',
    workflow_run_id: null,
    workflow_run_status: null,
    shipment_id: null,
    tracking_number: null,
    mapping_config_id: 'mc_exampleparcel_ksa',
    mapping_label: 'exampleparcel_ksa_v3.shipment_inbound',
    mapping_target: 'shipments.create',
    mapping_version: 3,
    mapping_rules_count: 13,
    is_terminal: true,
    is_actionable: true,
    replay_count: 0,
    force_status_count: 0,
    last_replay_action: null,
    last_replay_actor: null,
    last_replay_at: null,
    ...overrides,
  };
}

function listResult(rows: Array<Record<string, unknown>>) {
  return { rows: rows.map((row) => ({ ...row })), total: rows.length, page: 0, page_size: rows.length } as never;
}

function filteredInbox(opts?: apiMod.ListOpts) {
  const filter = opts?.filter as Record<string, unknown> | undefined;
  let rows = inboxRows;
  if (typeof filter?.organization_id === 'string') rows = rows.filter((row) => row.organization_id === filter.organization_id);
  if (typeof filter?.id === 'string') rows = rows.filter((row) => row.id === filter.id);
  return listResult(rows);
}

function renderArabicIntake() {
  return renderWithProviders(<IntakeModule />, {
    locale: 'ar',
    identity: {
      capabilities: ['all'],
      user: { access_scope_type: 'tenant', access_scope_id: null, organization_id: TENANT_ID },
      scope: { tenant: { id: TENANT_ID, label: 'Rashed Logistics', rank: 2 } },
    },
  });
}

async function openInboxRowActions(user: ReturnType<typeof userEvent.setup>) {
  const sourceCell = await screen.findByText(SOURCE_LABEL);
  const row = sourceCell.closest('tr') as HTMLTableRowElement;
  await user.click(within(row).getByRole('button', { name: arShell.shell.table.rowActions }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('IntakeModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/intake');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    toastStore.clearToasts();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<IntakeModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsIntake.intakeModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsIntake.intakeModule.webhookInboxDirectory);
    expect(findUntranslated(copy, ['Webhook'])).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<IntakeModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsIntake.intakeModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsIntake.intakeModule.titleAccent')).toBe('Inbound');
    expect(englishT('integrationsIntake.intakeModule.webhookInbox')).toBe('Webhook inbox');
    expect(lookup(ar, 'integrationsIntake.intakeModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  describe('webhook inbox rows', () => {
    let replaySpy: TypedSpy<typeof apiMod, 'webhook_inbox_replay_v1'>;

    beforeEach(() => {
      inboxRows = [inboxRow()];
      const realList = apiMod.ui_list_resource_v1;
      const realComplete = apiMod.ui_list_resource_complete;
      vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'marketing_intake_recent' || resource === 'marketing_intake_metrics_24h') return listResult([]);
        if (resource === 'webhook_inbox_directory') return filteredInbox(opts);
        return realList(resource, opts);
      });
      vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_inbox_directory') return filteredInbox(opts);
        if (resource === 'workflow_run_directory' || resource === 'domain_events') return listResult([]);
        return realComplete(resource, opts);
      });
      replaySpy = typedSpy(apiMod, 'webhook_inbox_replay_v1');
    });

    it('shows the missing acknowledgement chip in Arabic', async () => {
      renderArabicIntake();
      const [chip] = await screen.findAllByText(AR.noAcknowledgementYet);
      expect(findUntranslated(chip!)).toEqual([]);
    });

    it('explains disabled inbox row actions in Arabic', async () => {
      inboxRows = [inboxRow({ processing_status: 'processed', is_terminal: true, is_actionable: false })];
      const user = userEvent.setup();
      renderArabicIntake();
      await openInboxRowActions(user);

      const cases: Array<[string, string]> = [
        [AR.createFreshIntake, AR.freshIntakeFailedOnly],
        [AR.viewWorkflowRun, AR.noWorkflowRunYet],
      ];
      for (const [label, reason] of cases) {
        const option = await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(label)}`) });
        expect(option).toHaveClass('is-disabled');
        expect(option).toHaveTextContent(reason);
        expect(findUntranslated(option)).toEqual([]);
      }
    });

    it('reports a queued retry in one Arabic sentence', async () => {
      replaySpy.mockImplementation(async () => {
        inboxRows = [inboxRow({ processing_status: 'processing', is_terminal: false, is_actionable: false, replay_count: 1, last_replay_action: 'retry' })];
        return { ok: true, status: 'replay_queued', replay_queued: true, webhook_inbox_id: INBOX_ID, prior_status: 'failed' } as never;
      });
      const user = userEvent.setup();
      renderArabicIntake();
      await openInboxRowActions(user);
      await user.click(await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(AR.retryInboxEvent)}`) }));

      const reference = fill(ar.integrationsIntake.reference.event, { value: INBOX_ID });
      await waitFor(() => {
        expect(toastStore.getToasts().map((toast) => toast.message)).toContain(fill(AR.retryQueued, { reference }));
      });
      const box = document.createElement('div');
      box.textContent = toastStore.getToasts().map((toast) => toast.message).join(' ');
      expect(findUntranslated(box, DATA)).toEqual([]);
    });

    it('reports a preserved terminal failure on replay in one Arabic sentence', async () => {
      replaySpy.mockImplementation(async () => {
        inboxRows = [inboxRow({ replay_count: 1, last_replay_action: 'replay', last_replay_at: '2026-05-10T12:06:00Z' })];
        return { ok: true, status: 'preserved_terminal_failure', replay_queued: false, webhook_inbox_id: INBOX_ID, preserved_status: 'failed' } as never;
      });
      const user = userEvent.setup();
      renderArabicIntake();
      await openInboxRowActions(user);
      await user.click(await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(AR.replayInboxEvent)}`) }));

      const reference = fill(ar.integrationsIntake.reference.event, { value: INBOX_ID });
      await waitFor(() => {
        const toast = toastStore.getToasts().find((entry) => entry.message === fill(AR.replayNotQueued, { reference }));
        expect(toast?.tone).toBe('warn');
      });
      const box = document.createElement('div');
      box.textContent = toastStore.getToasts().map((toast) => toast.message).join(' ');
      expect(findUntranslated(box, DATA)).toEqual([]);
    });
  });

  it('keeps one whole sentence per replay outcome in both languages', () => {
    const reference = 'Event ref wbk7';
    expect(fill(englishT('integrationsIntake.intakeModule.retryQueued'), { reference })).toBe(`Retry queued · ${reference}`);
    expect(fill(englishT('integrationsIntake.intakeModule.retryNotQueued'), { reference })).toBe(`Retry not queued · terminal failure preserved · ${reference}`);
    expect(fill(englishT('integrationsIntake.intakeModule.replayQueued'), { reference })).toBe(`Replay queued · ${reference}`);
    expect(fill(englishT('integrationsIntake.intakeModule.replayNotQueued'), { reference })).toBe(`Replay not queued · terminal failure preserved · ${reference}`);
    expect(englishT('integrationsIntake.intakeModule.noAcknowledgementYet')).toBe('No acknowledgement yet');
    const box = document.createElement('div');
    box.textContent = [AR.retryNotQueued, AR.replayQueued, AR.duplicateReplayed, AR.retryAction, AR.replayAction]
      .map((text) => fill(text, { reference: '' }))
      .join(' ');
    expect(findUntranslated(box)).toEqual([]);
  });
});
