// intake-mutations.test.tsx — Phase C5 mutation specs for the
// /integrations/intake surface (CLAIM-INTEGRATIONS-WORKFLOWS-WIRING).
//
// Backed by:
//   - useReplayWebhookInbox      (Phase C5 → webhook_inbox_replay_v1)
//   - useForceWebhookInboxStatus (Phase C5 → webhook_inbox_force_status_v1)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { IntakeModule } from '@/modules/integrations/intake';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

const TEST_TENANT_ID = 'org_rashed';

const MARKETING_INTAKE_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'mkt_test_001',
    received_at: '2026-05-10T11:50:00Z',
    email: 'lead@example.com',
    company: 'Acme Live Lead',
    volume: '10k-60k',
    role: 'Ops',
    source: '/#contact-sales',
    ip_hash: 'ip_hash_test_001',
    turnstile_status: 'verified',
    dedupe_status: 'new',
    rate_limit_status: 'ok',
    decision: 'accepted',
    task_id: '8a5159f6-5b78-4823-89f0-f38c4cf0cdfc',
    workflow_run_id: '7257419f-2879-4592-a221-9e45fcce9d4e',
    dispatch_id: 'dsp_marketing_test_001',
  },
];

const MARKETING_METRIC_ROWS: Array<Record<string, unknown>> = [
  {
    total: 1,
    verified: 1,
    turnstile_failed: 0,
    rate_limited: 0,
    dedupe_dropped: 0,
  },
];

const WEBHOOK_INBOX_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'wbk_test_failed',
    organization_id: TEST_TENANT_ID,
    webhook_source_id: 'whs_exampleparcel_ksa',
    source_label: 'Exampleparcel KSA production',
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
  },
];

function listResult(rows: Array<Record<string, unknown>>): Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>> {
  return {
    rows: rows.map((row) => ({ ...row })),
    total: rows.length,
    page: 0,
    page_size: rows.length,
  } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
}

function renderIntakeModule() {
  return renderWithProviders(<IntakeModule />, {
    identity: {
      capabilities: ['all'],
      user: {
        access_scope_type: 'tenant',
        access_scope_id: null,
        organization_id: TEST_TENANT_ID,
      },
      scope: {
        tenant: { id: TEST_TENANT_ID, label: 'Rashed Logistics', rank: 2 },
      },
    },
  });
}

async function openWebhookInboxRowActions(user: ReturnType<typeof userEvent.setup>) {
  const sourceCell = await screen.findByText('Exampleparcel KSA production');
  const row = sourceCell.closest('tr');
  expect(row).toBeTruthy();
  await user.click(within(row as HTMLTableRowElement).getByRole('button', { name: /Row actions/i }));
}

describe('IntakeModule (Phase C5 mutations)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let replaySpy: TypedSpy<typeof apiMod, 'webhook_inbox_replay_v1'>;
  let forceSpy: TypedSpy<typeof apiMod, 'webhook_inbox_force_status_v1'>;
  let retryAsNewSpy: TypedSpy<typeof apiMod, 'ui_retry_webhook_inbox_as_new_intake_v1'>;
  beforeEach(() => {
    window.history.replaceState({}, '', '/integrations/intake');
    WEBHOOK_INBOX_ROWS[0] = {
      ...WEBHOOK_INBOX_ROWS[0],
      processing_status: 'failed',
      is_terminal: true,
      is_actionable: true,
      replay_count: 0,
      force_status_count: 0,
      last_replay_action: null,
      last_replay_actor: null,
      last_replay_at: null,
    };
    const realList = apiMod.ui_list_resource_v1;
    const realComplete = apiMod.ui_list_resource_complete;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
      const filter = opts?.filter as Record<string, unknown> | undefined;
      if (resource === 'marketing_intake_recent') return listResult(MARKETING_INTAKE_ROWS);
      if (resource === 'marketing_intake_metrics_24h') return listResult(MARKETING_METRIC_ROWS);
      if (resource === 'webhook_inbox_directory') {
        let rows = WEBHOOK_INBOX_ROWS;
        if (typeof filter?.organization_id === 'string') {
          rows = rows.filter((row) => row.organization_id === filter.organization_id);
        }
        if (typeof filter?.id === 'string') {
          rows = rows.filter((row) => row.id === filter.id);
        }
        return listResult(rows);
      }
      return realList(resource, opts);
    });
    vi.spyOn(apiMod, 'ui_list_resource_complete').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
      const filter = opts?.filter as Record<string, unknown> | undefined;
      if (resource === 'webhook_inbox_directory') {
        let rows = WEBHOOK_INBOX_ROWS;
        if (typeof filter?.organization_id === 'string') {
          rows = rows.filter((row) => row.organization_id === filter.organization_id);
        }
        if (typeof filter?.id === 'string') {
          rows = rows.filter((row) => row.id === filter.id);
        }
        return listResult(rows) as Awaited<ReturnType<typeof apiMod.ui_list_resource_complete>>;
      }
      if (resource === 'workflow_run_directory' || resource === 'domain_events') {
        return listResult([]) as Awaited<ReturnType<typeof apiMod.ui_list_resource_complete>>;
      }
      return realComplete(resource, opts);
    });
    replaySpy = typedSpy(apiMod, 'webhook_inbox_replay_v1');
    forceSpy = typedSpy(apiMod, 'webhook_inbox_force_status_v1');
    retryAsNewSpy = typedSpy(apiMod, 'ui_retry_webhook_inbox_as_new_intake_v1');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Retry row action fires webhook_inbox_replay_v1 with canonical webhook_inbox_id (Wave 8 RE-AUDIT)', async () => {
    const user = userEvent.setup();
    renderIntakeModule();
    await openWebhookInboxRowActions(user);
    const retry = await screen.findByRole('option', { name: /^Retry/ });
    await user.click(retry);
    await waitFor(() => {
      expect(replaySpy).toHaveBeenCalled();
    });
    // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1): canonical Phase B6 RPC
    // contract key is `webhook_inbox_id` (migration 202604280219).
    const args = replaySpy.mock.calls[0]?.[0] as
      | { webhook_inbox_id?: string; inbox_id?: string; reason?: string }
      | undefined;
    expect(args?.webhook_inbox_id).toBeTruthy();
    expect(args?.inbox_id).toBeUndefined();
    expect(args?.reason).toBe('operator_retry');
  });

  it('Replay row action fires webhook_inbox_replay_v1 with canonical webhook_inbox_id + replay reason', async () => {
    const user = userEvent.setup();
    renderIntakeModule();
    await openWebhookInboxRowActions(user);
    const replay = await screen.findByRole('option', { name: /^Replay/ });
    await user.click(replay);
    await waitFor(() => {
      expect(replaySpy).toHaveBeenCalled();
    });
    const args = replaySpy.mock.calls[0]?.[0] as
      | { webhook_inbox_id?: string; inbox_id?: string; reason?: string }
      | undefined;
    expect(args?.webhook_inbox_id).toBeTruthy();
    expect(args?.inbox_id).toBeUndefined();
    expect(args?.reason).toBe('operator_replay');
  });

  it('Replay row action shows the backend-refetched inbox status without a reload', async () => {
    replaySpy.mockImplementation(async () => {
      WEBHOOK_INBOX_ROWS[0] = {
        ...WEBHOOK_INBOX_ROWS[0],
        processing_status: 'processing',
        is_terminal: false,
        is_actionable: false,
        replay_count: 1,
        last_replay_action: 'replay',
        last_replay_actor: 'Platform Operator',
      };
      return {
        ok: true,
        status: 'replay_queued',
        replay_queued: true,
        webhook_inbox_id: 'wbk_test_failed',
        prior_status: 'failed',
      } as never;
    });
    const user = userEvent.setup();
    renderIntakeModule();
    expect((await screen.findAllByText(/^Failed$/i)).length).toBeGreaterThan(0);
    await openWebhookInboxRowActions(user);
    const replay = await screen.findByRole('option', { name: /^Replay/ });
    await user.click(replay);
    await waitFor(() => {
      expect(screen.getAllByText(/Processing/i).length).toBeGreaterThan(0);
      expect(screen.getByTestId('inbound-intake-action-readback')).toHaveTextContent(/Replay/i);
      expect(screen.getByTestId('inbound-intake-action-readback')).toHaveTextContent(/ledger replay/i);
    });
  });

  it('Replay row action reports preserved terminal failures instead of queued replay', async () => {
    replaySpy.mockImplementation(async () => {
      WEBHOOK_INBOX_ROWS[0] = {
        ...WEBHOOK_INBOX_ROWS[0],
        replay_count: 1,
        last_replay_action: 'replay',
        last_replay_actor: 'Platform Operator',
        last_replay_at: '2026-05-10T12:05:00Z',
      };
      return {
        ok: true,
        status: 'preserved_terminal_failure',
        replay_queued: false,
        webhook_inbox_id: 'wbk_live',
        preserved_status: 'failed',
      } as never;
    });
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    try {
      renderIntakeModule();
      await openWebhookInboxRowActions(user);
      const replay = await screen.findByRole('option', { name: /^Replay/ });
      await user.click(replay);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringContaining('Replay not queued · terminal failure preserved'),
          'warn',
        );
      });
    } finally {
      toastSpy.mockRestore();
    }
  });

  it('Retry row action reports preserved terminal failures instead of queued retry', async () => {
    replaySpy.mockImplementation(async () => {
      WEBHOOK_INBOX_ROWS[0] = {
        ...WEBHOOK_INBOX_ROWS[0],
        replay_count: 1,
        last_replay_action: 'replay',
        last_replay_actor: 'Platform Operator',
        last_replay_at: '2026-05-10T12:06:00Z',
      };
      return {
        ok: true,
        status: 'preserved_terminal_failure',
        replay_queued: false,
        webhook_inbox_id: 'wbk_live',
        preserved_status: 'failed',
      } as never;
    });
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    try {
      renderIntakeModule();
      await openWebhookInboxRowActions(user);
      const retry = await screen.findByRole('option', { name: /^Retry/ });
      await user.click(retry);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringContaining('Retry not queued · terminal failure preserved'),
          'warn',
        );
      });
    } finally {
      toastSpy.mockRestore();
    }
  });

  it('Replay row action rejects preserved-terminal readback when no new replay ledger is visible', async () => {
    replaySpy.mockResolvedValue({
      ok: true,
      status: 'preserved_terminal_failure',
      replay_queued: false,
      webhook_inbox_id: 'wbk_live',
      preserved_status: 'failed',
    } as never);
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    try {
      renderIntakeModule();
      await openWebhookInboxRowActions(user);
      const replay = await screen.findByRole('option', { name: /^Replay/ });
      await user.click(replay);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringMatching(/Replay failed.*confirmation did not show replay ledger increment/i),
          'danger',
        );
      });
      expect(screen.queryByTestId('inbound-intake-action-readback')).not.toBeInTheDocument();
    } finally {
      toastSpy.mockRestore();
    }
  });

  it('Force status row action fires webhook_inbox_force_status_v1 with canonical keys (Wave 8 RE-AUDIT)', async () => {
    const user = userEvent.setup();
    renderIntakeModule();
    await openWebhookInboxRowActions(user);
    const force = await screen.findByRole('option', { name: /Force status: failed/ });
    await user.click(force);
    await waitFor(() => {
      expect(forceSpy).toHaveBeenCalled();
    });
    // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #2): canonical Phase B6 RPC keys
    // are `webhook_inbox_id` + `target_status` (migration 202604280220).
    const args = forceSpy.mock.calls[0]?.[0] as
      | {
          webhook_inbox_id?: string;
          inbox_id?: string;
          target_status?: string;
          status?: string;
        }
      | undefined;
    expect(args?.webhook_inbox_id).toBeTruthy();
    expect(args?.inbox_id).toBeUndefined();
    expect(args?.target_status).toBe('failed');
    expect(args?.status).toBeUndefined();
  });

  it('Open in Test webhook intake row action links the selected inbox row for tester force-status proof', async () => {
    const user = userEvent.setup();
    renderIntakeModule();
    await openWebhookInboxRowActions(user);
    const openTester = await screen.findByRole('option', { name: /^Open in Test webhook intake/ });

    await user.click(openTester);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/integrations/webhook-tester');
      expect(new URLSearchParams(window.location.search).get('inbox_id')).toBe('wbk_test_failed');
    });
  });

  it('Force status row action shows the backend-refetched failed status without a reload', async () => {
    WEBHOOK_INBOX_ROWS[0] = {
      ...WEBHOOK_INBOX_ROWS[0],
      processing_status: 'processing',
      is_terminal: false,
      is_actionable: false,
    };
    forceSpy.mockImplementation(async () => {
      WEBHOOK_INBOX_ROWS[0] = {
        ...WEBHOOK_INBOX_ROWS[0],
        processing_status: 'failed',
        is_terminal: true,
        is_actionable: true,
        force_status_count: 1,
        last_replay_action: 'operator_force_failed',
      };
      return {
        ok: true,
        webhook_inbox_id: 'wbk_test_failed',
        prior_status: 'processing',
        forced_status: 'failed',
      } as never;
    });
    const user = userEvent.setup();
    renderIntakeModule();
    expect((await screen.findAllByText(/^Processing$/i)).length).toBeGreaterThan(0);
    await openWebhookInboxRowActions(user);
    const force = await screen.findByRole('option', { name: /Force status: failed/ });
    await user.click(force);
    await waitFor(() => {
      expect(screen.getAllByText(/^Failed$/i).length).toBeGreaterThan(0);
      expect(screen.getByTestId('inbound-intake-action-readback')).toHaveTextContent(/Force status/i);
      expect(screen.getByTestId('inbound-intake-action-readback')).toHaveTextContent(/ledger operator_force_failed/i);
      expect(screen.getByTestId('inbound-intake-action-readback')).toHaveTextContent(/force 1/i);
    });
  });

  it('Create fresh intake shows backend-confirmed remediation ledger without relying on toast-only proof', async () => {
    retryAsNewSpy.mockImplementation(async () => {
      WEBHOOK_INBOX_ROWS[0] = {
        ...WEBHOOK_INBOX_ROWS[0],
        replay_count: 1,
        last_replay_action: 'retry_as_new_intake',
        last_replay_actor: 'Platform Operator',
        last_replay_at: '2026-05-10T12:10:00Z',
      };
      return {
        ok: true,
        status: 'external_resend_required',
        webhook_inbox_id: 'wbk_test_failed',
        reason: 'source_token_not_recoverable',
      } as never;
    });
    const user = userEvent.setup();
    renderIntakeModule();
    await openWebhookInboxRowActions(user);
    const createFresh = await screen.findByRole('option', { name: /^Create fresh intake/ });
    await user.click(createFresh);
    await waitFor(() => {
      const readback = screen.getByTestId('inbound-intake-action-readback');
      expect(readback).toHaveTextContent(/Create fresh intake/i);
      expect(readback).toHaveTextContent(/ledger retry_as_new_intake/i);
      expect(readback).toHaveTextContent(/replay 1/i);
    });
  });

  it('Create fresh intake rejects stale retry-as-new-intake readback from a previous remediation', async () => {
    WEBHOOK_INBOX_ROWS[0] = {
      ...WEBHOOK_INBOX_ROWS[0],
      replay_count: 0,
      last_replay_action: 'retry_as_new_intake',
      last_replay_actor: 'Platform Operator',
      last_replay_at: '2026-05-10T12:10:00Z',
    };
    retryAsNewSpy.mockResolvedValue({
      ok: true,
      status: 'external_resend_required',
      webhook_inbox_id: 'wbk_test_failed',
      reason: 'source_token_not_recoverable',
    } as never);
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    try {
      renderIntakeModule();
      await openWebhookInboxRowActions(user);
      const createFresh = await screen.findByRole('option', { name: /^Create fresh intake/ });
      await user.click(createFresh);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringMatching(/Fresh intake failed.*new retry-as-new-intake remediation ledger/i),
          'danger',
        );
      });
      expect(screen.queryByTestId('inbound-intake-action-readback')).not.toBeInTheDocument();
    } finally {
      toastSpy.mockRestore();
    }
  });
});
