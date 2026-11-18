// webhook-tester.test.tsx — covers the new request/response inspector,
// derivation helpers, replay button counter, and force-status simulation.
//
// Backed contract:
//   - Pure helpers (`deriveResponseStatus`, `buildRequestEnvelope`, `buildResponseEnvelope`)
//     are exported from the module and tested directly, mirroring what the inspector renders.
//   - Mount tests assert the headline market-parity surfaces exist (Request/Response tabs,
//     Replay button, Force-status select).

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import {
  WebhookTesterModule,
  buildWebhookSampleTemplateContext,
  createReceiverIdempotencyKey,
  isRenderedWebhookSamplePayload,
  renderWebhookSamplePayloadTemplate,
  resolveWebhookSamplePayload,
} from './webhook-tester';
import * as apiMod from '@/lib/api';
import { stashExternalIntakeSourceToken } from '@/lib/external-intake-token-handoff';
import {
  deriveResponseStatus,
  buildRequestEnvelope,
  buildResponseEnvelope,
} from './_webhook-tester/envelopes';

describe('webhook-tester · derivation helpers', () => {
  it('resolves sample payloads from lookup metadata without hardcoded row ids', () => {
    expect(
      resolveWebhookSamplePayload([
        {
          id: 'lkv_other',
          value: 'other',
          is_default: false,
          metadata: { payload: '{"ignored":true}' },
        },
        {
          id: 'lkv_default',
          value: 'default',
          is_default: true,
          metadata: { payload: { event: { type: 'shipment.created' } } },
        },
      ]),
    ).toContain('"shipment.created"');
  });

  it('renders row-driven sample payload tokens from the receiver idempotency key', () => {
    const template = JSON.stringify({
      event: { id: '{{event_id}}', timestamp: '{{timestamp_iso}}', type: 'shipment.created' },
      shipment: {
        reference: '{{shipment_reference_number}}',
        recipient: {
          external_id: '{{recipient_external_id}}',
          phone: '{{recipient_phone}}',
          email: '{{recipient_email}}',
        },
        destination: {
          line1: 'King Fahd Road',
          country: 'SA',
        },
      },
    });
    const context = buildWebhookSampleTemplateContext(
      'console-v2-abc.123',
      new Date('2026-05-08T12:00:00.000Z'),
    );

    const rendered = renderWebhookSamplePayloadTemplate(template, context);

    expect(rendered).toContain('console-v2-abc-123-REF');
    expect(rendered).toContain('console-v2-abc-123-REC');
    expect(rendered).toContain('+9665');
    expect(rendered).toContain('recipient+console-v2-abc-123@example.com');
    expect(rendered).toContain('2026-05-08T12:00:00.000Z');
    expect(isRenderedWebhookSamplePayload(rendered, template, 'console-v2-abc.123')).toBe(true);
  });

  it('generates receiver idempotency keys compatible with the live receiver UUID contract', () => {
    expect(createReceiverIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('returns 200 when all steps are ok', () => {
    expect(
      deriveResponseStatus([
        { name: 'verify_signature', ok: true, ms: 1 },
        { name: 'shipments.create', ok: true, ms: 50 },
      ]),
    ).toBe(200);
  });

  it('returns 0 when no steps recorded', () => {
    expect(deriveResponseStatus([])).toBe(0);
  });

  it('returns 400 when parse/verify step fails', () => {
    expect(
      deriveResponseStatus([
        { name: 'parse_payload', ok: false, ms: 1 },
        { name: 'shipments.create', ok: true, ms: 50 },
      ]),
    ).toBe(400);
  });

  it('returns 422 when mapping/validate step fails', () => {
    expect(
      deriveResponseStatus([
        { name: 'verify_signature', ok: true, ms: 1 },
        { name: 'apply_mapping', ok: false, ms: 5 },
      ]),
    ).toBe(422);
  });

  it('returns 500 when downstream step fails', () => {
    expect(
      deriveResponseStatus([
        { name: 'verify_signature', ok: true, ms: 1 },
        { name: 'shipments.create', ok: false, ms: 50 },
      ]),
    ).toBe(500);
  });

  it('builds a request envelope with method/url/headers/body', () => {
    const env = buildRequestEnvelope(
      { id: 'plg_x', name: 'X', version: 'v1' },
      '{"a":1}',
    );
    expect(env.method).toBe('POST');
    expect(env.url).toContain('/functions/v1/webhook-receiver');
    expect(env.headers['content-type']).toBe('application/json');
    expect(env.headers['idempotency-key']).toBe('<unique-event-id>');
    expect(env.headers['x-correlation-id']).toBe('<uuid>');
    expect(env.headers['x-webhook-token']).toBe('<source-token>');
    expect(env.headers['x-plugin-diagnostic']).toBe('plg_x');
    expect(env.body).toBe('{"a":1}');
  });

  it('response envelope honours forced status code', () => {
    const env = buildResponseEnvelope(
      [{ name: 'verify_signature', ok: true, ms: 1 }],
      150,
      '503',
    );
    expect(env.status).toBe(503);
    expect(env.ok).toBe(false);
    expect(env.body).toMatchObject({ accepted: false, status: 503 });
  });

  it('response envelope reflects auto-derived 200 with payload accepted body', () => {
    const env = buildResponseEnvelope(
      [{ name: 'verify_signature', ok: true, ms: 1 }],
      150,
      'auto',
    );
    expect(env.status).toBe(200);
    expect(env.ok).toBe(true);
    expect(env.body).toMatchObject({ accepted: true, processed_steps: 1, duration_ms: 150 });
  });
});

describe('webhook-tester · UI surface (market parity)', () => {
  it('renders Request and Response inspector tabs', async () => {
    renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { name: /Test webhook intake/i })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /^request$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /response/i })).toBeInTheDocument();
    expect(screen.getByText(/source token from Sources & tokens/i)).toBeInTheDocument();
    expect(screen.queryByText(/source token from Webhook sources/i)).not.toBeInTheDocument();
  });

  it('labels plugin diagnostics separately from real receiver intake', async () => {
    renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('button', { name: /^Run plugin check$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Run test$/i })).not.toBeInTheDocument();
    const replay = await screen.findByRole('button', { name: /^replay plugin check$/i });
    expect(replay).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send receiver request/i })).toBeInTheDocument();
  });

  it('exposes an outcome select (disabled before any run)', async () => {
    renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
    const force = await screen.findByLabelText(/Set expected outcome|Set inbox outcome/i);
    expect(force).toBeDisabled();
  });

  it('loads tenant-scoped plugins and backend lookup payloads for receiver proof', async () => {
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => realList(resource, opts),
    );
    try {
      renderWithProviders(<WebhookTesterModule />, {
        capabilities: ['all'],
        identity: {
          capabilities: ['all'],
          user: {
            organization_id: 'org_rashed',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
          scope: {
            tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
          },
        },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      expect(listSpy).toHaveBeenCalledWith(
        'integration_plugins',
        expect.objectContaining({
          filter: { organization_id: 'org_rashed' },
        }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'lookup_values',
        expect.objectContaining({
          filter: { category: 'webhook_sample_payload', status: 'active' },
        }),
      );
      await waitFor(() => {
        expect((screen.getByLabelText(/Sample payload/) as HTMLTextAreaElement).value).toContain(
          'shipment.created',
        );
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('honors catalog plugin and source handoff instead of defaulting to the first plugin', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const runSpy = vi.spyOn(apiMod, 'runPluginTest').mockResolvedValue({
      duration_ms: 42,
      steps: [{ name: 'selected-plugin-diagnostic', ms: 42, ok: true }],
    } as never);
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'integration_plugins') {
        return {
          rows: [
            { id: 'plg_first', name: 'First plugin', version: 'v1', vendor: 'A' },
            { id: 'plg_target', name: 'Target plugin', version: 'v2', vendor: 'B' },
          ],
          total: 2,
        };
      }
      if (resource === 'webhook_source_directory') {
        return {
          rows: [{
            id: 'whs_target',
            source_label: 'Target runtime source',
            source_identifier: 'target-runtime-source',
          }],
          total: 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          rows: [{
            id: 'payload_default',
            value: 'default',
            is_default: true,
            metadata: { payload: { event: { type: 'shipment.created' } } },
          }],
          total: 1,
        };
      }
      return { rows: [], total: 0 };
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester?plugin_id=plg_target&source_id=whs_target');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      const pluginSelect = await screen.findByLabelText(/Plugin/) as HTMLSelectElement;
      await waitFor(() => expect(pluginSelect.value).toBe('plg_target'));
      expect(await screen.findByTestId('webhook-tester-catalog-handoff')).toHaveTextContent('Target plugin');
      expect(screen.getByTestId('webhook-tester-catalog-handoff')).toHaveTextContent('Target runtime source');

      await user.click(await screen.findByRole('button', { name: /^Run plugin check/ }));
      await waitFor(() => {
        expect(runSpy).toHaveBeenCalledWith('plg_target', expect.anything());
      });
      expect(runSpy).not.toHaveBeenCalledWith('plg_first', expect.anything());
    } finally {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      listSpy.mockRestore();
      runSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('surfaces linked failed inbox context before replaying from a remediation handoff', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
      const filter = (opts?.filter ?? {}) as Record<string, unknown>;
      if (resource === 'integration_plugins') {
        return {
          rows: [{ id: 'plg_linked', name: 'Linked plugin', version: 'v1', vendor: 'MasarX' }],
          total: 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          rows: [{
            id: 'payload_default',
            value: 'default',
            is_default: true,
            metadata: { payload: { event: { type: 'shipment.created' } } },
          }],
          total: 1,
        };
      }
      if (resource === 'webhook_inbox_directory' && filter.id === 'wbk_failed_remediation') {
        return {
          rows: [{
            id: 'wbk_failed_remediation',
            source_label: 'Failed remediation source',
            mapping_config_id: 'mc_failed_remediation',
            mapping_label: 'failed.remediation.shipments.create',
            mapping_target: 'shipments.create',
            processing_status: 'failed',
            replay_count: 2,
            error_message: 'missing required webhook shipment recipient/address',
          }],
          total: 1,
          page: 1,
          page_size: 1,
        };
      }
      return { rows: [], total: 0 };
    });

    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester?inbox_id=wbk_failed_remediation');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      const context = await screen.findByTestId('webhook-tester-linked-inbox-context');
      expect(context).toHaveTextContent('Linked inbox remediation');
      expect(context).toHaveTextContent('wbk_failed_remediation');
      expect(context).toHaveTextContent('failed.remediation.shipments.create');
      expect(context).toHaveTextContent('2 attempts');
      expect(context).toHaveTextContent('missing required webhook shipment recipient/address');
      expect(within(context).getByRole('button', { name: /Open mapping remediation/i })).toBeEnabled();
      expect(within(context).getByRole('button', { name: /Open linked inbox event/i })).toBeEnabled();
      expect(listSpy).toHaveBeenCalledWith(
        'webhook_inbox_directory',
        expect.objectContaining({ filter: { id: 'wbk_failed_remediation' }, page_size: 1 }),
      );
    } finally {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      listSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('fails closed when a catalog handoff plugin is no longer visible', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const runSpy = vi.spyOn(apiMod, 'runPluginTest');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'integration_plugins') {
        return {
          rows: [{ id: 'plg_first', name: 'First plugin', version: 'v1', vendor: 'A' }],
          total: 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          rows: [{
            id: 'payload_default',
            value: 'default',
            is_default: true,
            metadata: { payload: { event: { type: 'shipment.created' } } },
          }],
          total: 1,
        };
      }
      return { rows: [], total: 0 };
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester?plugin_id=plg_missing');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      const pluginSelect = await screen.findByLabelText(/Plugin/) as HTMLSelectElement;
      await waitFor(() => expect(pluginSelect.value).toBe(''));
      expect(await screen.findByTestId('webhook-tester-catalog-handoff')).toHaveTextContent('plugin unavailable');
      const runButton = await screen.findByRole('button', { name: /^Run plugin check/ });
      expect(runButton).toBeDisabled();
      await user.click(runButton);
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      listSpy.mockRestore();
      runSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('lets plugin approvers run diagnostics without webhook mutation permissions', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const runSpy = vi.spyOn(apiMod, 'runPluginTest').mockResolvedValue({
      duration_ms: 64,
      steps: [{ name: 'approver-plugin-diagnostic', ms: 64, ok: true }],
    } as never);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
      if (resource === 'integration_plugins') {
        return {
          rows: [{ id: 'plg_approver_runtime', name: 'Approver Runtime Plugin', version: 'v1', vendor: 'MasarX' }],
          total: 1,
        };
      }
      if (resource === 'lookup_values') {
        return {
          rows: [{
            id: 'payload_default',
            value: 'default',
            is_default: true,
            metadata: { payload: { event: { type: 'shipment.created' } } },
          }],
          total: 1,
        };
      }
      return { rows: [], total: 0 };
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester?plugin_id=plg_approver_runtime');
      renderWithProviders(<WebhookTesterModule />, {
        capabilities: [
          'integration_plugins.read',
          'integration_plugins.test',
          'integration_plugins.approve',
          'integration_plugins.activate',
        ],
        identity: {
          capabilities: [
            'integration_plugins.read',
            'integration_plugins.test',
            'integration_plugins.approve',
            'integration_plugins.activate',
          ],
          user: {
            organization_id: 'org_rashed',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
          scope: {
            tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
          },
        },
      });

      expect(await screen.findByTestId('webhook-tester-catalog-handoff')).toHaveTextContent('Approver Runtime Plugin');
      const runButton = await screen.findByRole('button', { name: /^Run plugin check/ });
      expect(runButton).toBeEnabled();
      expect(screen.getByRole('button', { name: /Send receiver request/i })).toBeDisabled();

      await user.click(runButton);

      await waitFor(() => {
        expect(runSpy).toHaveBeenCalledWith('plg_approver_runtime', expect.anything());
      });
      expect(receiverSpy).not.toHaveBeenCalled();
      expect(await screen.findByText(/Last run/i)).toBeInTheDocument();
      expect(screen.getByText(/Approver Plugin Diagnostic/i)).toBeInTheDocument();
      expect(screen.queryByText(/approver-plugin-diagnostic/i)).not.toBeInTheDocument();
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('webhook_source_directory');
      expect(resources).not.toContain('webhook_inbox_directory');
    } finally {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      listSpy.mockRestore();
      receiverSpy.mockRestore();
      runSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('blocks live-mode webhook runs when no backend client is configured', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(false);
    const runSpy = vi.spyOn(apiMod, 'runPluginTest');
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      expect(await screen.findByText('Live intake setup required')).toBeInTheDocument();
      const runBtn = await screen.findByRole('button', { name: /^Run plugin check/ });
      expect(runBtn).toBeDisabled();
      await user.click(runBtn);
      expect(runSpy).not.toHaveBeenCalled();
      expect(screen.queryByText(/Last run/)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/Set inbox outcome/)).toBeDisabled();
    } finally {
      runSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('shows a denied state without webhook or plugin diagnostic read capability', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest');
    renderWithProviders(<WebhookTesterModule />, { capabilities: [] });

    expect(await screen.findByText(/You do not have permission to view webhook testing or plugin checks/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Plugin/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send receiver request/i })).not.toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('integration_plugins');
      expect(resources).not.toContain('lookup_values');
    });
    expect(receiverSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
    receiverSpy.mockRestore();
  });

  it('permission-gates receiver POST so read-only operators cannot submit backend mutations', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest');
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['webhooks.read'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      const sendButton = screen.getByRole('button', { name: /Send receiver request/i });
      expect(sendButton).toBeDisabled();
      await user.click(sendButton);
      expect(receiverSpy).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Receiver request evidence')).not.toBeInTheDocument();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('requires a visible source token before enabling receiver POST', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest');
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      const sendButton = screen.getByRole('button', { name: /Send receiver request/i });
      expect(sendButton).toBeDisabled();
      expect(screen.getByText(/Rotate or create a source token before sending a receiver POST/i)).toBeInTheDocument();
      await user.click(sendButton);
      expect(receiverSpy).not.toHaveBeenCalled();

      await user.type(screen.getByLabelText(/Source token/i), 'src_ready_token');
      expect(sendButton).toBeEnabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('clears a one-time source token handoff after loading it into the receiver POST form', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      diagnostic_only: false,
      idempotency_key: 'idem_handoff_submit',
      webhook_id: 'wh_handoff_submit',
      workflow_run_id: 'wf_handoff_submit',
      correlation_id: 'cor_handoff_submit',
      receiver_status: 202,
      ack_status_code: 202,
      ack_outcome: 'accepted',
      response_outcome: 'accepted',
      webhook_processing_status: 'processing',
      is_terminal: false,
      source_label: 'Handoff webhook source',
      mapping_label: 'Default shipment webhook intake',
      mapping_target: 'shipments.create',
      shipment_id: null,
      tracking_number: null,
      error_message: null,
      response: {
        status: 202,
        ok: true,
        body: { accepted: true },
      },
    } as Awaited<ReturnType<typeof apiMod.runWebhookReceiverTest>>);
    const token = 'src_handoff_token_webhook';
    sessionStorage.clear();
    stashExternalIntakeSourceToken('webhook-tester', {
      token,
      source_id: 'whs_handoff_webhook',
      source_name: 'Handoff webhook source',
    });
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });

      expect(await screen.findByLabelText(/Source token/i)).toHaveValue(token);
      expect(screen.getByRole('button', { name: /Send receiver request/i })).toBeEnabled();
      expect(sessionStorage.length).toBe(0);
      await userEvent.click(screen.getByRole('button', { name: /Send receiver request/i }));
      await waitFor(() => expect(receiverSpy).toHaveBeenCalledTimes(1));
      expect(sessionStorage.length).toBe(0);
    } finally {
      sessionStorage.clear();
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('labels seed receiver results as diagnostic-only evidence', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(true);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(false);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 20,
      correlation_id: 'diag_receiver',
      workflow_run_id: 'wfr_diag_receiver',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_diag_receiver',
      webhook_processing_status: 'in_progress',
      source_label: 'Seed diagnostic source',
      source_identifier: 'seed-diagnostic-source',
      provider_type_label: 'Seed diagnostic',
      mapping_config_id: null,
      mapping_label: null,
      mapping_target: 'shipments.create',
      mapping_version: null,
      mapping_rules_count: null,
      is_terminal: false,
      is_actionable: true,
      shipment_id: null,
      tracking_number: null,
      canonical_intent: 'shipment.create',
      response: { accepted: true, diagnostic_only: true },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Sends this test data through the webhook receiver/i)).toBeInTheDocument();

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'seed-diagnostic-token');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByText('Check only')).toBeInTheDocument();
      expect(screen.getByText('This receiver result is for review only.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('surfaces receiver auth-rejection backend readback without shipment or inbox actions', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 401,
      duration_ms: 246,
      correlation_id: '10000000-0000-4000-8000-000000000001',
      idempotency_key: '10000000-0000-4000-8000-000000000001',
      workflow_run_id: null,
      followup_workflow_run_id: null,
      webhook_id: null,
      webhook_processing_status: 'auth_rejected',
      source_label: 'API Browser Proof Source',
      source_identifier: 'api-browser-proof-source',
      provider_type_label: null,
      mapping_config_id: null,
      mapping_label: null,
      mapping_target: null,
      mapping_version: null,
      mapping_rules_count: null,
      is_terminal: true,
      is_actionable: false,
      shipment_id: null,
      tracking_number: null,
      canonical_intent: null,
      ack_status_code: 401,
      ack_outcome: 'auth_rejected',
      response_outcome: 'auth_rejected',
      ack_reason: 'retired_webhook_source_token',
      error_message: 'Retired webhook source token',
      auth_rejection_id: 'iar_receiver_auth_rejected',
      auth_rejection_failure_code: 'retired_webhook_source_token',
      auth_rejection_failure_message: 'Retired webhook source token',
      auth_rejection_http_status: 401,
      auth_rejection_source_label: 'API Browser Proof Source',
      auth_rejection_source_identifier: 'api-browser-proof-source',
      auth_rejection_source_resolved: true,
      auth_rejection_token_fingerprint: 'sha256:reader-safe-fingerprint',
      auth_rejection_rejection_class: 'unauthorized',
      response: {
        accepted: false,
        error: 'Unauthorized webhook source',
      },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'retired-source-token');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findAllByText(/Auth rejected/i)).not.toHaveLength(0);
      expect(screen.getAllByText(/Rejected/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Matched source/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/not created - authentication rejected/i).length).toBeGreaterThan(0);
      expect(screen.queryByText('iar_receiver_auth_rejected')).not.toBeInTheDocument();
      expect(screen.queryByText(/retired_webhook_source_token/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/reader-safe-fingerprint/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('sends a real receiver POST with source token, idempotency, signature, and payload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000002',
      workflow_run_id: 'wfr_live_receiver_001',
      followup_workflow_run_id: 'wfr_live_receiver_followup_001',
      webhook_id: 'wbk_live_receiver_001',
      webhook_processing_status: 'succeeded',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: true,
      is_actionable: false,
      shipment_id: 'shp_live_receiver_001',
      tracking_number: 'TRK-LIVE-001',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_001');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000002');
      await user.type(screen.getByLabelText(/HMAC signature/i), 'sha256=testsig');

      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalledTimes(1);
      });
      expect(receiverSpy).toHaveBeenCalledWith({
        auth_token: 'src_test_token_001',
        payload: expect.any(Object),
        idempotency_key: '10000000-0000-4000-8000-000000000002',
        signature: 'sha256=testsig',
      });
      expect(await screen.findByLabelText('Receiver request evidence')).toBeInTheDocument();
      expect(screen.getByText('wfr_live_receiver_001')).toBeInTheDocument();
      expect(screen.getByText(/Live receiver source/)).toBeInTheDocument();
      expect(screen.getByText(/live.receiver.shipment.create/)).toBeInTheDocument();
      expect(screen.getByText('TRK-LIVE-001')).toBeInTheDocument();
      expect(screen.getAllByText('shipments.create').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeEnabled();
      expect(screen.getByLabelText(/Source token/i)).toHaveValue('');
      expect(screen.getByRole('button', { name: /Replay receiver POST/i })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: /Replay receiver POST/i }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalledTimes(2);
      });
      expect(receiverSpy).toHaveBeenLastCalledWith({
        auth_token: 'src_test_token_001',
        payload: expect.any(Object),
        idempotency_key: '10000000-0000-4000-8000-000000000002',
        signature: 'sha256=testsig',
      });
      expect(screen.getByLabelText(/Source token/i)).toHaveValue('');
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('clears stale receiver shipment readback when the operator edits the next webhook payload', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000003',
      workflow_run_id: 'wfr_live_receiver_stale_guard',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_stale_guard',
      webhook_processing_status: 'succeeded',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_stale_guard',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: true,
      is_actionable: false,
      shipment_id: 'shp_live_receiver_stale_guard',
      tracking_number: 'TRK-STALE-WEBHOOK-001',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_stale_guard');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000003');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByLabelText('Receiver request evidence')).toBeInTheDocument();
      expect(screen.getByText('TRK-STALE-WEBHOOK-001')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeEnabled();

      fireEvent.change(screen.getByLabelText(/Sample payload/i), {
        target: {
          value: JSON.stringify({
            event: { type: 'shipment.created' },
            shipment: { reference_number: 'NEXT-WEBHOOK-REF' },
          }),
        },
      });

      await waitFor(() => {
        expect(screen.queryByLabelText('Receiver request evidence')).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /Open shipment drawer/i })).not.toBeInTheDocument();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps shipment drawer action disabled until receiver readback has a canonical shipment id', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000004',
      workflow_run_id: 'wfr_live_receiver_pending',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_pending',
      webhook_processing_status: 'in_progress',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: false,
      is_actionable: true,
      shipment_id: null,
      tracking_number: 'TRK-PENDING-001',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_pending');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000004');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByLabelText('Receiver request evidence')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Sending/i })).not.toBeInTheDocument();
      });
      expect(screen.getByText('TRK-PENDING-001 (pending shipment confirmation)')).toBeInTheDocument();
      expect(await screen.findByText('Shipment confirmation pending')).toBeInTheDocument();
      expect(screen.queryByText('Receiver accepted')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Replay receiver POST/i })).toBeEnabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps shipment drawer action disabled when shipment id exists before terminal inbox readback', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 202,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000005',
      workflow_run_id: 'wfr_live_receiver_nonterminal_shipment',
      followup_workflow_run_id: 'wfr_live_receiver_nonterminal_followup',
      webhook_id: 'wbk_live_receiver_nonterminal_shipment',
      webhook_processing_status: 'in_progress',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: false,
      is_actionable: true,
      shipment_id: 'shp_nonterminal_receiver_001',
      tracking_number: 'TRK-NONTERMINAL-001',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_nonterminal');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000005');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByLabelText('Receiver request evidence')).toBeInTheDocument();
      expect(screen.getByText('TRK-NONTERMINAL-001 (pending shipment confirmation)')).toBeInTheDocument();
      expect(await screen.findByText('Shipment confirmation pending')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('refreshes pending receiver evidence from canonical inbox readback before enabling the shipment drawer', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000006',
      workflow_run_id: 'wfr_live_receiver_refresh',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_refresh',
      webhook_processing_status: 'in_progress',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: false,
      is_actionable: true,
      shipment_id: null,
      tracking_number: 'TRK-REFRESH-PENDING',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_inbox_directory') {
          return {
            rows: [
              {
                id: 'wbk_live_receiver_refresh',
                workflow_run_id: 'wfr_live_receiver_refresh',
                idempotency_key: '10000000-0000-4000-8000-000000000006',
                correlation_id: '10000000-0000-4000-8000-000000000006',
                processing_status: 'succeeded',
                source_label: 'Live receiver source',
                source_identifier: 'live-receiver-source',
                provider_type_label: 'Generic webhook',
                mapping_config_id: 'mcfg_live_receiver_001',
                mapping_label: 'live.receiver.shipment.create',
                mapping_target: 'shipments.create',
                mapping_version: 3,
                mapping_rules_count: 4,
                is_terminal: true,
                is_actionable: false,
                shipment_id: 'shp_live_receiver_refresh',
                tracking_number: 'TRK-REFRESH-READY',
                canonical_intent: 'shipments.create',
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_refresh');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000006');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByText('TRK-REFRESH-PENDING (pending shipment confirmation)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();

      await waitFor(() => {
        expect(screen.getByText('TRK-REFRESH-READY')).toBeInTheDocument();
      }, { timeout: 4500 });
      expect(screen.getByText(/Succeeded/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeEnabled();
    } finally {
      listSpy.mockRestore();
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('fails closed when polling sees terminal shipment-create success without shipment readback', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000007',
      workflow_run_id: 'wfr_live_receiver_no_shipment',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_no_shipment',
      webhook_processing_status: 'in_progress',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: false,
      is_actionable: true,
      shipment_id: null,
      tracking_number: 'TRK-NO-SHIPMENT-PENDING',
      canonical_intent: 'shipment.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_inbox_directory') {
          return {
            rows: [
              {
                id: 'wbk_live_receiver_no_shipment',
                workflow_run_id: 'wfr_live_receiver_no_shipment',
                idempotency_key: '10000000-0000-4000-8000-000000000007',
                correlation_id: '10000000-0000-4000-8000-000000000007',
                processing_status: 'succeeded',
                source_label: 'Live receiver source',
                source_identifier: 'live-receiver-source',
                provider_type_label: 'Generic webhook',
                mapping_config_id: 'mcfg_live_receiver_001',
                mapping_label: 'live.receiver.shipment.create',
                mapping_target: 'shipments.create',
                mapping_version: 3,
                mapping_rules_count: 4,
                is_terminal: true,
                is_actionable: false,
                shipment_id: null,
                tracking_number: 'TRK-NO-SHIPMENT-PLANNED',
                canonical_intent: 'shipment.create',
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_no_shipment');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000007');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByText('TRK-NO-SHIPMENT-PENDING (pending shipment confirmation)')).toBeInTheDocument();
      await waitFor(() => {
        const evidence = screen.getByLabelText('Receiver request evidence');
        expect(within(evidence).getByText('Failed Missing Shipment Readback')).toBeInTheDocument();
        expect(
          within(evidence).getByText('Terminal shipment intake completed without shipment confirmation'),
        ).toBeInTheDocument();
        expect(within(evidence).getByText('not created - failed')).toBeInTheDocument();
      }, { timeout: 4500 });
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
      expect(screen.queryByText('TRK-NO-SHIPMENT-PLANNED')).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps disabled-source auth failures visible without fake receiver evidence', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi
      .spyOn(apiMod, 'runWebhookReceiverTest')
      .mockRejectedValue(
        new Error('Unauthorized webhook source Authorization: Bearer disabled-source-bearer api_key=disabled-source-api-key'),
      );
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'wrong-token');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000008');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByLabelText('Receiver request failure')).toBeInTheDocument();
      expect(document.body).toHaveTextContent('Unauthorized webhook source');
      expect(document.body).toHaveTextContent('Authorization: Bearer [redacted]');
      expect(document.body).toHaveTextContent('api_key=[redacted]');
      expect(document.body).not.toHaveTextContent('disabled-source-bearer');
      expect(document.body).not.toHaveTextContent('disabled-source-api-key');
      expect(screen.getAllByText('10000000-0000-4000-8000-000000000008').length).toBeGreaterThan(0);
      expect(screen.getByLabelText(/Source token/i)).toHaveValue('');
      expect(screen.queryByLabelText('Receiver request evidence')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Open receiver inbox event/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Open shipment drawer/i })).not.toBeInTheDocument();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps invalid HMAC receiver readback visible without enabling shipment handoff', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 400,
      duration_ms: 84,
      correlation_id: '10000000-0000-4000-8000-000000000009',
      workflow_run_id: null,
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_hmac_failed',
      webhook_processing_status: 'failed',
      source_label: 'HMAC receiver source',
      source_identifier: 'hmac-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_hmac_failed',
      mapping_label: 'live.receiver.shipment.create.hmac',
      mapping_target: 'shipments.create',
      mapping_version: 4,
      mapping_rules_count: 4,
      is_terminal: true,
      is_actionable: false,
      shipment_id: null,
      tracking_number: null,
      canonical_intent: 'shipments.create',
      ack_outcome: 'ack_failed',
      ack_status_code: 400,
      ack_reason: 'HMAC signature mismatch',
      error_message: 'HMAC signature mismatch',
      response: {
        accepted: false,
        ack_outcome: 'ack_failed',
        ack_status_code: 400,
        ack_reason: 'HMAC signature mismatch',
      },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_hmac_failed');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000009');
      await user.type(screen.getByLabelText(/HMAC signature/i), 'not-a-valid-signature');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      await waitFor(() => {
        expect(receiverSpy).toHaveBeenCalledWith({
          auth_token: 'src_test_token_hmac_failed',
          payload: expect.any(Object),
          idempotency_key: '10000000-0000-4000-8000-000000000009',
          signature: 'not-a-valid-signature',
        });
      });
      const evidence = await screen.findByLabelText('Receiver request evidence');
      expect(within(evidence).getByText('Terminal failure')).toBeInTheDocument();
      expect(within(evidence).getAllByText(/HMAC signature mismatch/).length).toBeGreaterThan(0);
      expect(within(evidence).getByText('not created - failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
      expect(screen.queryByLabelText('Receiver request failure')).not.toBeInTheDocument();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('refreshes pending receiver evidence to terminal failed without enabling shipment handoff', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 96,
      correlation_id: '10000000-0000-4000-8000-000000000010',
      workflow_run_id: 'wfr_live_receiver_mapping_failed',
      followup_workflow_run_id: null,
      webhook_id: 'wbk_live_receiver_mapping_failed',
      webhook_processing_status: 'in_progress',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_mapping_failed',
      mapping_label: 'live.receiver.shipment.create.mapping-failure',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: false,
      is_actionable: true,
      shipment_id: null,
      tracking_number: 'TRK-MAPFAIL-PENDING',
      canonical_intent: 'shipments.create',
      response: { accepted: true },
      workflow_steps: [],
    });
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: apiMod.ListOpts) => {
        if (resource === 'webhook_inbox_directory') {
          return {
            rows: [
              {
                id: 'wbk_live_receiver_mapping_failed',
                workflow_run_id: 'wfr_live_receiver_mapping_failed',
                idempotency_key: '10000000-0000-4000-8000-000000000010',
                correlation_id: '10000000-0000-4000-8000-000000000010',
                processing_status: 'failed',
                error_message:
                  'mapping failed: missing recipient.phone Authorization: Bearer mapping-failure-bearer api_key=mapping-failure-api-key',
                source_label: 'Live receiver source',
                source_identifier: 'live-receiver-source',
                provider_type_label: 'Generic webhook',
                mapping_config_id: 'mcfg_live_receiver_mapping_failed',
                mapping_label: 'live.receiver.shipment.create.mapping-failure',
                mapping_target: 'shipments.create',
                mapping_version: 3,
                mapping_rules_count: 4,
                is_terminal: true,
                is_actionable: false,
                shipment_id: null,
                tracking_number: null,
                canonical_intent: 'shipments.create',
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof apiMod.ui_list_resource_v1>>;
        }
        return realList(resource, opts);
      },
    );
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_mapping_failed');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000010');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      expect(await screen.findByText('TRK-MAPFAIL-PENDING (pending shipment confirmation)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();

      await waitFor(() => {
        const evidence = screen.getByLabelText('Receiver request evidence');
        expect(within(evidence).getByText('Failed')).toBeInTheDocument();
        expect(evidence).toHaveTextContent('mapping failed: missing recipient.phone');
        expect(evidence).toHaveTextContent('Authorization: Bearer [redacted]');
        expect(evidence).toHaveTextContent('api_key=[redacted]');
        expect(evidence).not.toHaveTextContent('mapping-failure-bearer');
        expect(evidence).not.toHaveTextContent('mapping-failure-api-key');
        expect(within(evidence).getByText('not created - failed')).toBeInTheDocument();
      }, { timeout: 4500 });
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
    } finally {
      listSpy.mockRestore();
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('keeps terminal mapping-failure receiver readback visible without enabling shipment handoff', async () => {
    const seedModeSpy = vi.spyOn(apiMod, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    const backendSpy = vi.spyOn(apiMod, 'hasConsoleLiveBackend').mockReturnValue(true);
    const receiverSpy = vi.spyOn(apiMod, 'runWebhookReceiverTest').mockResolvedValue({
      ok: true,
      receiver_status: 200,
      duration_ms: 118,
      correlation_id: '10000000-0000-4000-8000-000000000011',
      workflow_run_id: 'wfr_live_receiver_failed_payload',
      followup_workflow_run_id: 'wfr_live_receiver_failed_payload_followup',
      webhook_id: 'wbk_live_receiver_failed_payload',
      webhook_processing_status: 'failed',
      source_label: 'Live receiver source',
      source_identifier: 'live-receiver-source',
      provider_type_label: 'Generic webhook',
      mapping_config_id: 'mcfg_live_receiver_001',
      mapping_label: 'live.receiver.shipment.create',
      mapping_target: 'shipments.create',
      mapping_version: 3,
      mapping_rules_count: 4,
      is_terminal: true,
      is_actionable: false,
      shipment_id: null,
      tracking_number: null,
      canonical_intent: 'shipments.create',
      error_message: 'apply_mapping failed: required recipient.address.city is missing',
      response: {
        accepted: true,
        error: 'apply_mapping failed: required recipient.address.city is missing',
      },
      workflow_steps: [],
    });
    const user = userEvent.setup();
    try {
      window.history.replaceState({}, '', '/integrations/webhook-tester');
      renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getByLabelText(/Plugin/)).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText(/Source token/i));
      await user.type(screen.getByLabelText(/Source token/i), 'src_test_token_failed_payload');
      await user.clear(screen.getByLabelText(/Idempotency key/i));
      await user.type(screen.getByLabelText(/Idempotency key/i), '10000000-0000-4000-8000-000000000011');
      await user.click(screen.getByRole('button', { name: /Send receiver request/i }));

      const evidence = await screen.findByLabelText('Receiver request evidence');
      expect(evidence).toBeInTheDocument();
      expect(within(evidence).getByText('Failed')).toBeInTheDocument();
      expect(
        within(evidence).getByText('apply_mapping failed: required recipient.address.city is missing'),
      ).toBeInTheDocument();
      expect(within(evidence).getByText('not created - failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open receiver inbox event/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Open shipment drawer/i })).toBeDisabled();
    } finally {
      receiverSpy.mockRestore();
      backendSpy.mockRestore();
      seedModeSpy.mockRestore();
    }
  });

  it('switches between Request and Response panels', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WebhookTesterModule />, { capabilities: ['all'] });
    // Request panel is the default tab.
    expect(await screen.findByTestId('inspector-request')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /response/i }));
    await waitFor(() => expect(screen.getByTestId('inspector-response')).toBeInTheDocument());
  });
});
