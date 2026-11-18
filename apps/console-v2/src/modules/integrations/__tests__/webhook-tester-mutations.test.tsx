// webhook-tester-mutations.test.tsx — Phase C5 mutation specs for the
// /integrations/webhook-tester surface. Covers webhook_inbox replay +
// force-status when the tester is deep-linked to a real inbox row
// (`?inbox_id=...`).
//
// Backed by:
//   - useReplayWebhookInbox        (Phase C5 → webhook_inbox_replay_v1)
//   - useForceWebhookInboxStatus   (Phase C5 → webhook_inbox_force_status_v1)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeQueryClient, renderWithProviders } from '@/test/render';
import { WebhookTesterModule } from '@/modules/integrations/webhook-tester';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';

const ORIGINAL_LOCATION = window.location.href;

describe('WebhookTesterModule (Phase C5 mutations)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let replaySpy: TypedSpy<typeof apiMod, 'webhook_inbox_replay_v1'>;
  let forceSpy: TypedSpy<typeof apiMod, 'webhook_inbox_force_status_v1'>;
  beforeEach(() => {
    replaySpy = typedSpy(apiMod, 'webhook_inbox_replay_v1');
    forceSpy = typedSpy(apiMod, 'webhook_inbox_force_status_v1');
    // Set inbox_id query param so the tester reads it from window.location.
    window.history.replaceState({}, '', '/integrations/webhook-tester?inbox_id=wbk_test_001');
  });
  afterEach(() => {
    replaySpy.mockRestore();
    forceSpy.mockRestore();
    window.history.replaceState({}, '', ORIGINAL_LOCATION);
  });

  it('renders plugin read permission failures without leaking backend diagnostics', async () => {
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'integration_plugins') {
          throw new Error('42501 integration plugin permission denied');
        }
        return realList(resource, opts);
      },
    );
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      expect(await screen.findByText('Webhook plugin access required')).toBeInTheDocument();
      expect(screen.getByText('You do not have permission to read webhook test plugins.')).toBeInTheDocument();
      expect(screen.queryByText('42501 integration plugin permission denied')).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('shows receiver duplicate replay outcome from backend readback without reloading', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 202,
      correlation_id: 'idem-wbk-replay-ui',
      idempotency_key: 'idem-wbk-replay-ui',
      ack_outcome: 'ack_replayed',
      ack_status_code: 202,
      ack_reason: 'duplicate delivery replayed from original inbox row',
      workflow_run_id: 'wfr_replay_ui',
      webhook_id: 'wbk_replay_ui',
      canonical_intent: 'shipment.create',
      webhook_processing_status: 'succeeded',
      is_terminal: true,
      shipment_id: 'shp_replay_ui',
      tracking_number: '2600REPLAY',
      response: {},
      workflow_steps: [],
    });
    const user = userEvent.setup();
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'], queryClient });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_replay_token');
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            auth_token: 'src_live_replay_token',
            idempotency_key: expect.any(String),
          }),
        );
      });
      expect(await screen.findByText('Receiver outcome')).toBeInTheDocument();
      expect(screen.getAllByText('Duplicate replayed').length).toBeGreaterThan(0);
      expect(screen.getByText(/HTTP 202/)).toBeInTheDocument();
      expect(screen.getByText(/Idempotency idem-wbk-replay-ui/)).toBeInTheDocument();
      expect(screen.getByText('Correlation')).toBeInTheDocument();
      expect(screen.getByText('idem-wbk-replay-ui')).toBeInTheDocument();
      expect(screen.getByText(/duplicate delivery replayed from original inbox row/)).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: /Response/i }));
      expect(await screen.findByText('Receiver request confirmation')).toBeInTheDocument();
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('Duplicate replayed');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('202 OK');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('idem-wbk-replay-ui');
      expect(screen.getByLabelText('Receiver response body')).toHaveTextContent('{}');

      await waitFor(() => {
        expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
          queryKey: ['list', 'webhook_inbox'],
          type: 'active',
        }));
        expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
          queryKey: ['list', 'webhook_inbox_directory'],
          type: 'active',
        }));
      });
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'webhook_inbox'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'webhook_inbox_directory'],
        refetchType: 'active',
      }));

      const hrefBeforeDrawer = window.location.href;
      await user.click(screen.getByRole('button', { name: /Open receiver inbox event/i }));
      expect(await screen.findByText('Inbox event confirmation')).toBeInTheDocument();
      expect(screen.getByLabelText('Receiver inbox event context')).toHaveTextContent('wbk_replay_ui');
      expect(screen.getByLabelText('Receiver inbox event context')).toHaveTextContent('Duplicate replayed');
      expect(window.location.href).toBe(hrefBeforeDrawer);
    } finally {
      invalidateSpy.mockRestore();
      refetchSpy.mockRestore();
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('prioritizes response replay evidence over accepted ack outcome', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 202,
      correlation_id: 'idem-wbk-response-replay-ui',
      idempotency_key: 'idem-wbk-response-replay-ui',
      ack_outcome: 'ack_sent',
      response_outcome: 'response_replayed',
      ack_status_code: 202,
      workflow_run_id: 'wfr_response_replay_ui',
      webhook_id: 'wbk_response_replay_ui',
      canonical_intent: 'shipment.create',
      webhook_processing_status: 'succeeded',
      is_terminal: true,
      shipment_id: 'shp_response_replay_ui',
      tracking_number: '2600RESPRP',
      response: { status: 'accepted_async', correlation_id: 'idem-wbk-response-replay-ui' },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_response_replay_token');
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalled();
      });
      expect(await screen.findByText('Receiver outcome')).toBeInTheDocument();
      expect(screen.getAllByText('Duplicate replayed').length).toBeGreaterThan(0);
      expect(screen.queryByText(/^Accepted$/)).not.toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: /Response/i }));
      expect(await screen.findByText('Receiver request confirmation')).toBeInTheDocument();
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('Duplicate replayed');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('202 OK');
    } finally {
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('shows terminal receiver failures ahead of async acceptance in the response inspector', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 202,
      correlation_id: 'idem-wbk-terminal-failure-ui',
      idempotency_key: 'idem-wbk-terminal-failure-ui',
      response_outcome: 'accepted',
      workflow_run_id: 'wfr_terminal_failure_ui',
      webhook_id: 'wbk_terminal_failure_ui',
      canonical_intent: 'shipment.created',
      webhook_processing_status: 'failed',
      error_message:
        'execute_shipment_create_v1: missing required webhook shipment recipient/address Authorization: Bearer terminal-error-bearer api_key=terminal-error-api-key',
      is_terminal: true,
      shipment_id: null,
      tracking_number: null,
      response: {
        status: 'accepted_async',
        idempotency_key: 'idem-wbk-terminal-failure-ui',
        'idempotency-key': 'idem-wbk-terminal-failure-ui-header',
        correlation_id: 'corr-wbk-terminal-failure-ui',
        mapping_key: 'first-tenant.shipment.create',
        auth_token: 'raw-source-token-must-not-render',
        signature: 'sha256=raw-signature-must-not-render',
        callback: '/functions/v1/webhook-receiver?token=raw-source-token-must-not-render&signature=raw-signature-must-not-render&keep=value',
        nested: { api_key: 'raw-api-key-must-not-render' },
      },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_failure_token');
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalled();
      });
      expect(await screen.findByText('Receiver outcome')).toBeInTheDocument();
      expect(screen.getAllByText('Terminal failure').length).toBeGreaterThan(0);
      expect(screen.getByText('not created - failed')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Sending/i })).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /Replay receiver POST/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
      expect(document.body).toHaveTextContent('Authorization: Bearer [redacted]');
      expect(document.body).toHaveTextContent('api_key=[redacted]');
      expect(document.body).not.toHaveTextContent('terminal-error-bearer');
      expect(document.body).not.toHaveTextContent('terminal-error-api-key');
      await user.click(screen.getByRole('tab', { name: /Response/i }));
      expect(await screen.findByText('Receiver request confirmation')).toBeInTheDocument();
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('Terminal failure');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('202 Needs attention');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('not created - failed');
      expect(screen.getByLabelText('Receiver request confirmation')).toHaveTextContent('idem-wbk-terminal-failure-ui');
      const responseJson = screen.getByLabelText('Receiver response body');
      expect(responseJson).toHaveTextContent('[redacted]');
      expect(responseJson).toHaveTextContent('keep=value');
      expect(responseJson).toHaveTextContent('idem-wbk-terminal-failure-ui');
      expect(responseJson).toHaveTextContent('idem-wbk-terminal-failure-ui-header');
      expect(responseJson).toHaveTextContent('corr-wbk-terminal-failure-ui');
      expect(responseJson).toHaveTextContent('first-tenant.shipment.create');
      expect(responseJson).not.toHaveTextContent('raw-source-token-must-not-render');
      expect(responseJson).not.toHaveTextContent('raw-signature-must-not-render');
      expect(responseJson).not.toHaveTextContent('raw-api-key-must-not-render');
      await user.click(screen.getByRole('button', { name: /Open receiver inbox event/i }));
      const drawerContext = await screen.findByLabelText('Receiver inbox event context');
      expect(drawerContext).toHaveTextContent('Authorization: Bearer [redacted]');
      expect(drawerContext).toHaveTextContent('api_key=[redacted]');
      expect(drawerContext).not.toHaveTextContent('terminal-error-bearer');
      expect(drawerContext).not.toHaveTextContent('terminal-error-api-key');
    } finally {
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('rejects non-UUID receiver idempotency keys before calling the backend', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest');
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_invalid_id_token');
      const idempotency = await screen.findByLabelText(/Idempotency key/i);
      await user.clear(idempotency);
      await user.type(idempotency, 'not-a-uuid');
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      expect(receiverSpy).not.toHaveBeenCalled();
      expect((await screen.findAllByText('Receiver request failed')).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Idempotency value must be a UUID/i).length).toBeGreaterThan(0);
      expect(screen.getByLabelText('Receiver request failure details')).toHaveTextContent('not-a-uuid');
    } finally {
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('shows backend readback progress while the receiver request is still pending', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    let resolveReceiver!: (value: apiMod.RunWebhookReceiverTestResult) => void;
    const receiverPromise = new Promise<apiMod.RunWebhookReceiverTestResult>((resolve) => {
      resolveReceiver = resolve;
    });
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockReturnValue(receiverPromise);
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_pending_token');
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      const progress = await screen.findByLabelText('Receiver request progress');
      expect(progress).toHaveTextContent('Receiver request in progress');
      expect(progress).toHaveTextContent('Waiting for webhook receiver and backend readback');
      expect(screen.getByRole('button', { name: /Sending/i })).toBeDisabled();

      await act(async () => {
        resolveReceiver({
          ok: true,
          receiver_status: 202,
          correlation_id: 'idem-wbk-pending-ui',
          idempotency_key: 'idem-wbk-pending-ui',
          ack_outcome: 'ack_sent',
          ack_status_code: 202,
          workflow_run_id: 'wfr_pending_ui',
          webhook_id: 'wbk_pending_ui',
          canonical_intent: 'shipment.create',
          webhook_processing_status: 'failed',
          error_message: 'provider credential missing',
          is_terminal: true,
          shipment_id: null,
          tracking_number: null,
          response: {},
          workflow_steps: [],
        });
      });

      expect(await screen.findByText('Receiver outcome')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByLabelText('Receiver request progress')).not.toBeInTheDocument();
      });
      expect(screen.getAllByText('Terminal failure').length).toBeGreaterThan(0);
    } finally {
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('reconciles backend auth rejection readback when the receiver request stays unresolved', async () => {
    const liveBackendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const idempotencyKey = '11111111-2222-4333-8444-555555555555';
    const receiverSpy = vi
      .spyOn(apiMod, 'runWebhookReceiverTest')
      .mockReturnValue(new Promise<apiMod.RunWebhookReceiverTestResult>(() => {}));
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_auth_rejections') {
          expect(opts?.filter).toMatchObject({ correlation_id: idempotencyKey });
          return {
            rows: [
              {
                id: '90124f1d-bbd6-4287-8d90-3dfa9da9725f',
                failure_code: 'unauthorized webhook source',
                failure_message: 'Unauthorized webhook source',
                http_status: 401,
                correlation_id: idempotencyKey,
                source_label: null,
                source_identifier: null,
                source_resolved: false,
                rejection_class: 'unauthorized',
              },
            ],
            total: 1,
            page: 0,
            page_size: 1,
          };
        }
        return realList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      await user.type(await screen.findByLabelText(/Source token/i), 'src_live_reject_token');
      const idempotency = await screen.findByLabelText(/Idempotency key/i);
      await user.clear(idempotency);
      await user.type(idempotency, idempotencyKey);
      await user.click(await screen.findByRole('button', { name: /^Send receiver request/ }));

      expect(await screen.findByText('Receiver outcome')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByLabelText('Receiver request progress')).not.toBeInTheDocument();
      });
      expect(screen.getAllByText('Auth rejected').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/HTTP 401/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(idempotencyKey, { exact: false }).length).toBeGreaterThan(0);
      expect(screen.getByText('not created - authentication rejected')).toBeInTheDocument();
      expect(screen.getByText('Source could not be matched')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
      expect(receiverSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: idempotencyKey,
        }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'webhook_auth_rejections',
        expect.objectContaining({
          filter: { correlation_id: idempotencyKey },
          page_size: 1,
        }),
      );
      expect(screen.queryByRole('button', { name: /Sending/i })).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
      receiverSpy.mockRestore();
      seedModeSpy.mockRestore();
      liveBackendSpy.mockRestore();
    }
  });

  it('Replay button fires webhook_inbox_replay_v1 with canonical webhook_inbox_id (Wave 8 RE-AUDIT)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
    // Wait for plugins to load + first plugin to be auto-selected.
    await waitFor(() => {
      expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
    });
    // Need at least one diagnostic run before Replay can fire (Replay button is
    // disabled until the trace exists).
    const runBtn = await screen.findByRole('button', { name: /^Run plugin check/ });
    await user.click(runBtn);
    await waitFor(() => {
      expect(screen.getByText(/Last run/)).toBeInTheDocument();
    });
    const replayBtn = await screen.findByRole('button', { name: /^Replay inbox$/ });
    await user.click(replayBtn);
    await waitFor(() => {
      expect(replaySpy).toHaveBeenCalled();
    });
    // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #1): canonical Phase B6 RPC contract
    // key is `webhook_inbox_id` (migration 202604280219).
    const args = replaySpy.mock.calls[0]?.[0] as
      | { webhook_inbox_id?: string; inbox_id?: string }
      | undefined;
    expect(args?.webhook_inbox_id).toBe('wbk_test_001');
    expect(args?.inbox_id).toBeUndefined();
  });

  it('Replay button reports preserved terminal failures without rerunning plugin diagnostics', async () => {
    replaySpy.mockResolvedValue({
      ok: true,
      status: 'preserved_terminal_failure',
      replay_queued: false,
      webhook_inbox_id: 'wbk_test_001',
      preserved_status: 'failed',
    } as never);
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const runSpy = vi.spyOn(apiMod, 'runPluginTest');
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      const runBtn = await screen.findByRole('button', { name: /^Run plugin check/ });
      await user.click(runBtn);
      await waitFor(() => {
        expect(screen.getByText(/Last run/)).toBeInTheDocument();
      });
      const callsBeforeReplay = runSpy.mock.calls.length;
      const replayBtn = await screen.findByRole('button', { name: /^Replay inbox$/ });
      await user.click(replayBtn);
      await waitFor(() => {
        expect(replaySpy).toHaveBeenCalled();
      });
      expect(runSpy.mock.calls.length).toBe(callsBeforeReplay);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringContaining('Replay not queued · terminal failure preserved'),
          'warn',
        );
      });
    } finally {
      runSpy.mockRestore();
      toastSpy.mockRestore();
    }
  });

  it('Replay button queues linked inbox replay without rerunning plugin diagnostics', async () => {
    replaySpy.mockResolvedValue({
      ok: true,
      status: 'replay_queued',
      replay_queued: true,
      webhook_inbox_id: 'wbk_test_001',
      prior_status: 'failed',
    } as never);
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const runSpy = vi.spyOn(apiMod, 'runPluginTest');
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      const runBtn = await screen.findByRole('button', { name: /^Run plugin check/ });
      await user.click(runBtn);
      await waitFor(() => {
        expect(screen.getByText(/Last run/)).toBeInTheDocument();
      });
      const callsBeforeReplay = runSpy.mock.calls.length;
      const replayBtn = await screen.findByRole('button', { name: /^Replay inbox$/ });
      await user.click(replayBtn);
      await waitFor(() => {
        expect(replaySpy).toHaveBeenCalledWith({
          webhook_inbox_id: 'wbk_test_001',
          reason: 'operator_replay',
        });
      });
      expect(runSpy.mock.calls.length).toBe(callsBeforeReplay);
      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringContaining('Replay queued'),
          'good',
        );
      });

      expect(await screen.findByText('Linked inbox replay confirmation')).toBeInTheDocument();
      expect(screen.getByLabelText('Linked inbox replay confirmation')).toHaveTextContent('wbk_test_001');
      expect(screen.getByLabelText('Linked inbox replay confirmation')).toHaveTextContent('Replay queued');
      expect(screen.getByLabelText('Linked inbox replay confirmation')).toHaveTextContent('Inbox and directory updated');
      expect(screen.getByText(/plugin checks are not rerun/i)).toBeInTheDocument();
    } finally {
      runSpy.mockRestore();
      toastSpy.mockRestore();
    }
  });

  it('Force-status select fires webhook_inbox_force_status_v1 with canonical keys (Wave 8 RE-AUDIT)', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const user = userEvent.setup();
    try {
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      // Run a plugin check first so the outcome select becomes enabled.
      const runBtn = await screen.findByRole('button', { name: /^Run plugin check/ });
      await user.click(runBtn);
      await waitFor(() => {
        expect(screen.getByText(/Last run/)).toBeInTheDocument();
      });
      const select = screen.getByLabelText(/Set inbox outcome/) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '500' } });
      await waitFor(() => {
        expect(forceSpy).toHaveBeenCalled();
      });
      // Wave 8 RE-AUDIT (INTEGRATIONS.md P0 #2): canonical Phase B6 RPC keys are
      // `webhook_inbox_id` + `target_status` (migration 202604280220).
      const args = forceSpy.mock.calls[0]?.[0] as
        | {
            webhook_inbox_id?: string;
            inbox_id?: string;
            target_status?: string;
            status?: string;
          }
        | undefined;
      expect(args?.webhook_inbox_id).toBe('wbk_test_001');
      expect(args?.inbox_id).toBeUndefined();
      expect(args?.target_status).toBe('failed');
      expect(args?.status).toBeUndefined();

      await user.click(screen.getByRole('tab', { name: /response/i }));
      expect(await screen.findByText(/Inbox outcome change requested/i)).toBeInTheDocument();
      expect(screen.queryByText(/Showing seed\/local simulated response/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/500 ERR/i)).not.toBeInTheDocument();
    } finally {
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });
});
