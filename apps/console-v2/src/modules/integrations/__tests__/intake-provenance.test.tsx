// intake-provenance.test.tsx — mounts the IntakeModule and asserts the
// derived "Shipment" column renders in-place context actions for inbox rows
// whose workflow_run_id resolves to a shipment.* aggregate, plus the
// provenance drawer surfaces the full chain.
//
// Backend evidence:
//   - webhook_inbox.workflow_run_id (supabase/migrations/202510110004_webhook_integration.sql:214+)
//   - domain_events { resource_type, resource_id, workflow_run_id, event_type='shipment.*' }

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/test/render';
import { IntakeModule } from '@/modules/integrations/intake';
import * as api from '@/lib/api';
import { qk } from '@/lib/queries';
import { CAP } from '@/lib/capabilities';
import * as toastStore from '@/components/toastStore';

const MARKETING_INTAKE_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'mkt_1001',
    received_at: '2026-05-10T11:50:00Z',
    email: 'lead@example.com',
    company: 'Acme Live Lead',
    volume: '10k-60k',
    role: 'Ops',
    source: '/#contact-sales',
    ip_hash: 'ip_hash_1001',
    turnstile_status: 'verified',
    dedupe_status: 'new',
    rate_limit_status: 'ok',
    decision: 'accepted',
    task_id: '8a5159f6-5b78-4823-89f0-f38c4cf0cdfc',
    workflow_run_id: '7257419f-2879-4592-a221-9e45fcce9d4e',
    dispatch_id: 'dsp_marketing_1001',
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

const WEBHOOK_INBOX_DIRECTORY_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'wbk_7738',
    organization_id: 'org_rashed',
    webhook_source_id: 'whs_exampleparcel_ksa',
    source_label: 'Exampleparcel KSA production',
    source_identifier: 'exampleparcel-ksa-prod',
    provider_type_label: 'Shopify',
    created_at: '2026-05-10T12:00:00Z',
    processing_status: 'succeeded',
    event_type: 'shipment.created',
    payload_size: 1024,
    external_id: 'AMZ-7738',
    idempotency_key: 'idem-wbk-7738',
    response_outcome: 'response_replayed',
    response_status_code: 202,
    response_reason: 'duplicate delivery replayed from original inbox row',
    workflow_run_id: 'wfr_3215',
    workflow_run_status: 'completed',
    shipment_id: 'shp_9381502',
    tracking_number: 'TRK-9381502',
    shipment_status: 'created',
    mapping_config_id: 'mc_exampleparcel_ksa',
    mapping_label: 'exampleparcel_ksa_v3.shipment_inbound',
    mapping_target: 'shipments.create',
    mapping_version: 3,
    mapping_rules_count: 13,
    is_terminal: true,
    is_actionable: false,
  },
  {
    id: 'wbk_7737',
    organization_id: 'org_rashed',
    webhook_source_id: 'whs_woo_ksa',
    source_label: 'WooCommerce KSA',
    source_identifier: 'woocommerce-ksa',
    provider_type_label: 'WooCommerce',
    created_at: '2026-05-10T11:55:00Z',
    processing_status: 'pending',
    event_type: 'webhook.received',
    payload_size: 512,
    external_id: 'WOO-7737',
    workflow_run_id: null,
    workflow_run_status: null,
    shipment_id: null,
    tracking_number: null,
    shipment_status: null,
    mapping_config_id: 'mc_woo_ksa',
    mapping_label: 'woo_ksa_v1.shipment_inbound',
    mapping_target: 'shipments.create',
    mapping_version: 1,
    mapping_rules_count: 7,
    is_terminal: false,
    is_actionable: true,
  },
  {
    id: 'wbk_failed_mapping',
    organization_id: 'org_rashed',
    webhook_source_id: 'whs_failed_mapping',
    source_label: 'Failed mapping source',
    source_identifier: 'failed-mapping-source',
    provider_type_label: 'Generic',
    created_at: '2026-05-10T11:50:00Z',
    processing_status: 'failed',
    event_type: 'shipment.created',
    payload_size: 400,
    external_id: 'FAILED-MAPPING-1',
    workflow_run_id: 'wfr_failed_mapping',
    workflow_run_status: 'failed',
    shipment_id: null,
    tracking_number: null,
    shipment_status: null,
    mapping_config_id: 'mc_failed_mapping',
    mapping_label: 'failed.mapping.shipments.create',
    mapping_target: 'shipments.create',
    mapping_version: 2,
    mapping_rules_count: 5,
    error_message:
      'webhook shipment.create did not enqueue shipment materialization workflow Authorization: Bearer failed-provenance-bearer api_key=failed-provenance-api-key',
    replay_count: 1,
    last_replay_action: 'replay',
    last_replay_actor: 'Platform Operator',
    last_replay_at: '2026-05-15T09:32:55.566Z',
    is_terminal: true,
    is_actionable: true,
  },
];

const WEBHOOK_AUTH_REJECTION_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'iar_webhook_unresolved_token_test',
    service: 'webhook_receiver',
    surface: 'webhook_receiver',
    credential_kind: 'source_token',
    failure_code: 'unauthorized webhook source',
    failure_message: 'Webhook source token was invalid or disabled.',
    http_status: 401,
    organization_id: null,
    source_id: null,
    source_label: null,
    source_identifier: null,
    correlation_id: '3d3d3488-0749-43f3-a76c-720310076e17',
    request_id: '3d3d3488-0749-43f3-a76c-720310076e17',
    method: 'POST',
    path: '/functions/v1/webhook-receiver',
    token_fingerprint: 'sha256:unresolved',
    request_headers: {
      authorization: 'Bearer plain-secret-token',
      'x-webhook-token': 'plain-secret-token',
      'x-forwarded-url': '/functions/v1/webhook-receiver?token=plain-secret-token&keep=value',
    },
    metadata: {
      edge_stage: 'workflow_intake_webhook',
      response_outcome: 'response_failed',
    },
    occurred_at: '2026-05-10T12:06:00Z',
    source_resolved: false,
  },
  {
    id: 'iar_webhook_invalid_token_test',
    service: 'webhook_receiver',
    surface: 'webhook_receiver',
    credential_kind: 'source_token',
    failure_code: 'invalid_token',
    failure_message: 'Webhook source token was invalid or disabled.',
    http_status: 401,
    organization_id: 'org_rashed',
    source_id: 'whs_exampleparcel_ksa',
    source_label: 'Exampleparcel KSA production',
    source_identifier: 'exampleparcel-ksa-prod',
    correlation_id: '5e5ee6f6-8f10-49f7-9f29-2c5cfc9d7b16',
    request_id: 'req_webhook_invalid_token_test',
    method: 'POST',
    path: '/functions/v1/webhook-receiver?api_key=plain-secret&signature=plain-signature',
    token_fingerprint: 'sha256:test',
    request_headers: {
      authorization: 'Bearer plain-secret-token',
      'x-webhook-token': 'plain-secret-token',
      'x-forwarded-url': '/functions/v1/webhook-receiver?token=plain-secret-token&keep=value',
    },
    metadata: {
      edge_stage: 'workflow_intake_webhook',
    },
    occurred_at: '2026-05-10T12:05:00Z',
    source_resolved: true,
  },
  {
    id: 'iar_webhook_retired_token_test',
    service: 'webhook_receiver',
    surface: 'webhook_receiver',
    credential_kind: 'source_token',
    failure_code: 'unauthorized webhook source',
    failure_message: 'Unauthorized webhook source',
    http_status: 401,
    organization_id: 'org_demo',
    source_id: 'whs_chrome_current',
    source_label: 'chrome-current-webhook-source-1778436200',
    source_identifier: 'source-1000-21254c78-cb01-47b9-9ae0-057096a7596c',
    client_label: 'Demo Client A',
    sender_label: 'Demo Sender A',
    correlation_id: '00e37288-d101-458c-91a5-a1109a584c44',
    request_id: 'retired-webhook-ext-test',
    method: 'POST',
    path: 'http://edge-runtime.example.invalid:8081/webhook-receiver',
    token_fingerprint: 'sha256:retired',
    request_headers: {
      authorization: 'Bearer retired-secret-token',
      apikey: 'retired-secret-api-key',
      'x-webhook-token': 'retired-secret-token',
      'x-forwarded-url': '/functions/v1/webhook-receiver?token=retired-secret-token&keep=value',
    },
    metadata: {
      edge_stage: 'workflow_intake_webhook',
      response_outcome: 'response_failed',
      source_resolution: 'retired_webhook_source_token',
      retired_token_history_id: 'history-secret-id',
    },
    occurred_at: '2026-05-16T05:52:26Z',
    source_resolved: true,
  },
  {
    id: 'iar_webhook_hmac_signature_test',
    service: 'webhook_receiver',
    surface: 'webhook_receiver',
    credential_kind: 'hmac_signature',
    failure_code: 'hmac_signature_mismatch',
    failure_message: 'HMAC signature mismatch',
    http_status: 400,
    organization_id: 'org_rashed',
    source_id: 'whs_hmac_source',
    source_label: 'Console V2 HMAC Source',
    source_identifier: 'console-v2-webhook-hmac-source',
    client_label: 'Demo Client A',
    sender_label: 'Demo Sender A',
    correlation_id: '11111111-2222-4333-8444-555555555555',
    request_id: 'console-v2-hmac-invalid-1',
    method: 'POST',
    path: '/functions/v1/webhook-receiver?signature=plain-hmac-signature&keep=value',
    token_fingerprint: 'sha256:hmac-signature-readback',
    request_headers: {
      authorization: 'Bearer hmac-secret-token',
      'x-webhook-token': 'hmac-secret-token',
      'x-signature': 'plain-hmac-signature',
      'idempotency-key': 'console-v2-hmac-invalid-1',
    },
    metadata: {
      edge_stage: 'workflow_intake_webhook_core_v1',
      auth_surface: 'hmac_signature',
      hmac_header: 'x-signature',
      provided_signature_present: true,
    },
    occurred_at: '2026-05-16T06:05:26Z',
    source_resolved: true,
  },
];

const WORKFLOW_RUN_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'wfr_3215',
    status: 'completed',
    correlation_id: 'cor_3215',
    workflow_template_key: 'shipment.create',
  },
];

const DOMAIN_EVENT_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'evt_3215',
    workflow_run_id: 'wfr_3215',
    correlation_id: 'cor_3215',
    event_type: 'shipment.created',
    resource_type: 'shipment',
    resource_id: 'shp_9381502',
  },
];

const LOOKUP_ROWS: Record<string, Array<Record<string, unknown>>> = {
  turnstile_status: [{ value: 'verified', label: 'Verified', tone: 'good' }],
  dedupe_status: [{ value: 'new', label: 'New', tone: 'info' }],
  rate_limit_status: [{ value: 'ok', label: 'OK', tone: 'good' }],
  marketing_decision: [{ value: 'accepted', label: 'Accepted', tone: 'good' }],
  processing_status: [
    { value: 'pending', label: 'Pending', tone: 'warn' },
    { value: 'succeeded', label: 'Succeeded', tone: 'good', metadata: { is_terminal_success: true } },
    { value: 'completed', label: 'Completed', tone: 'good', metadata: { is_terminal_success: true } },
    { value: 'failed', label: 'Failed', tone: 'danger', metadata: { is_terminal_failure: true } },
  ],
  workflow_run_status: [
    { value: 'completed', label: 'Completed', tone: 'good' },
    { value: 'succeeded', label: 'Succeeded', tone: 'good' },
    { value: 'failed', label: 'Failed', tone: 'danger' },
    { value: 'running', label: 'Running', tone: 'info' },
  ],
  webhook_source_state: [
    { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true },
    { value: 'disabled', label: 'Disabled', tone: 'neutral' },
  ],
  provenance_shipment_state: [
    { value: 'matched', label: 'Shipment matched', tone: 'good' },
    { value: 'unmatched', label: 'Shipment pending', tone: 'neutral' },
  ],
};

function listResult(rows: Array<Record<string, unknown>>): Awaited<ReturnType<typeof api.ui_list_resource_v1>> {
  return {
    rows: rows.map((row) => ({ ...row })),
    total: rows.length,
  } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
}

function paletteItemByLabel(label: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
    (node) => node.querySelector('.palette__item-label')?.textContent?.trim() === label,
  );
  expect(item, `missing palette item ${label}`).toBeTruthy();
  return item as HTMLElement;
}

describe('IntakeModule · provenance enrichment', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/integrations/intake');
    const realList = api.ui_list_resource_v1;
    const realGet = api.ui_get_resource_v1;
    const realComplete = api.ui_list_resource_complete;
    const realGetLookups = api.getLookups;
    const realLookupRow = api.lookupRow;

    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const filter = opts?.filter as Record<string, unknown> | undefined;
      if (resource === 'marketing_intake_recent') return listResult(MARKETING_INTAKE_ROWS);
      if (resource === 'marketing_intake_metrics_24h') return listResult(MARKETING_METRIC_ROWS);
      if (resource === 'webhook_inbox_directory') {
        const rows = typeof filter?.id === 'string'
          ? WEBHOOK_INBOX_DIRECTORY_ROWS.filter((row) => row.id === filter.id)
          : WEBHOOK_INBOX_DIRECTORY_ROWS;
        return listResult(rows);
      }
      if (resource === 'webhook_auth_rejections') {
        const rows = typeof filter?.organization_id === 'string'
          ? WEBHOOK_AUTH_REJECTION_ROWS.filter((row) => row.organization_id === filter.organization_id)
          : WEBHOOK_AUTH_REJECTION_ROWS;
        return listResult(rows);
      }
      return realList(resource, opts);
    });
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'webhook_auth_rejections') {
        return WEBHOOK_AUTH_REJECTION_ROWS.find((row) => row.id === id) as never;
      }
      return realGet(resource, id) as never;
    });
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const filter = opts?.filter as Record<string, unknown> | undefined;
      if (resource === 'webhook_inbox_directory') {
        const rows = typeof filter?.id === 'string'
          ? WEBHOOK_INBOX_DIRECTORY_ROWS.filter((row) => row.id === filter.id)
          : WEBHOOK_INBOX_DIRECTORY_ROWS;
        return listResult(rows) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (resource === 'webhook_auth_rejections') {
        const rows = typeof filter?.organization_id === 'string'
          ? WEBHOOK_AUTH_REJECTION_ROWS.filter((row) => row.organization_id === filter.organization_id)
          : WEBHOOK_AUTH_REJECTION_ROWS;
        return listResult(rows) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (resource === 'workflow_run_directory') {
        const rows = typeof filter?.id === 'string'
          ? WORKFLOW_RUN_ROWS.filter((row) => row.id === filter.id)
          : WORKFLOW_RUN_ROWS;
        return listResult(rows) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (resource === 'domain_events') {
        const rows = typeof filter?.workflow_run_id === 'string'
          ? DOMAIN_EVENT_ROWS.filter((row) => row.workflow_run_id === filter.workflow_run_id)
          : DOMAIN_EVENT_ROWS;
        return listResult(rows) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      return realComplete(resource, opts);
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category: string) => {
      if (category in LOOKUP_ROWS) return LOOKUP_ROWS[category] as ReturnType<typeof api.getLookups>;
      return realGetLookups(category);
    });
    vi.spyOn(api, 'lookupRow').mockImplementation((category: string, value: string) => {
      const row = LOOKUP_ROWS[category]?.find((candidate) => candidate.value === value);
      if (row) return row as unknown as ReturnType<typeof api.lookupRow>;
      return realLookupRow(category, value);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('denies webhooks.read without issuing protected intake reads', async () => {
    window.history.replaceState({}, '', '/integrations/intake?inbox_id=wbk_7738');
    const listSpy = vi.mocked(api.ui_list_resource_v1);
    const completeSpy = vi.mocked(api.ui_list_resource_complete);

    renderWithProviders(<IntakeModule />, { capabilities: ['webhooks.write'] });

    expect(await screen.findByText('You do not have permission to view inbound requests.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        listSpy.mock.calls.filter(
          ([resource]) =>
            resource === 'marketing_intake_recent' ||
            resource === 'marketing_intake_metrics_24h' ||
            resource === 'webhook_inbox_directory' ||
            resource === 'webhook_auth_rejections',
        ),
      ).toEqual([]);
      expect(
        completeSpy.mock.calls.filter(
          ([resource]) => resource === 'workflow_run_directory' || resource === 'domain_events',
        ),
      ).toEqual([]);
    });
  });

  it('mounts and renders the inbox table with the Shipment column', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });
    // Page header always renders.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    // Wait for the inbox table to populate (resource list resolves async).
    await waitFor(() => {
      const tables = document.querySelectorAll('.dt__table');
      expect(tables.length).toBeGreaterThan(0);
    });
    // The "Shipment" column header must be present.
    await waitFor(() => {
      expect(screen.getAllByText('Shipment').length).toBeGreaterThan(0);
    });
  });

  it('renders marketing lead intake from the canonical lead projection with lineage', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Marketing lead intake - recent')).toBeInTheDocument();
    expect(await screen.findByText('Acme Live Lead')).toBeInTheDocument();
    expect(screen.getByText('lead@example.com')).toBeInTheDocument();
    expect(screen.getByText(/8a5159f6-5b78-4823-89f0-f38c4cf0cdfc/)).toBeInTheDocument();
    expect(screen.getByText(/7257419f-2879-4592-a221-9e45fcce9d4e/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh marketing lead intake' })).toBeInTheDocument();
  });

  it('renders the External Intake workspace actions and routes by operator click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await screen.findByRole('toolbar', { name: /External Intake workspace/i });
    expect(screen.getByRole('group', { name: 'Setup intake actions' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Test intake actions' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Review intake actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Sources & tokens/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Provider credentials/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Intake mappings/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Inbox failures & replay/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Test webhook intake/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open API request intake/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Open Routing rules/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Open API request intake/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/insights/api-gateway');
    });
  });

  it('keeps External Intake workspace actions permission-gated', async () => {
    renderWithProviders(<IntakeModule />, {
      capabilities: [CAP.WEBHOOKS_READ],
    });

    await screen.findByRole('toolbar', { name: /External Intake workspace/i });
    expect(screen.getByRole('button', { name: /Open Sources & tokens/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Inbox failures & replay/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open Test webhook intake/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Open Routing rules/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Open API request intake/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Open Intake mappings/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Open Provider credentials/i })).toBeDisabled();
  });

  it('renders intake status chips from canonical lookup labels instead of unknown fallbacks', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OK').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Unknown Turnstile status/i)).toBeNull();
    expect(screen.queryByText(/Unknown Dedupe status/i)).toBeNull();
    expect(screen.queryByText(/Unknown rate-limit status/i)).toBeNull();
  });

  it('renders provider type labels from the intake directory projection', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Shopify').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WooCommerce').length).toBeGreaterThan(0);
  });

  it('renders mapping evidence from the intake directory projection', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Mapping').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/exampleparcel_ksa_v3\.shipment_inbound/).length).toBeGreaterThan(0);
  });

  it('renders provider duplicate replay outcome and idempotency from backend readback', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      const tables = document.querySelectorAll('.dt-wrap');
      const inboxTable = Array.from(tables).find((table) =>
        table.textContent?.includes('Receiver outcome'),
      ) as HTMLElement | undefined;
      expect(inboxTable).toBeTruthy();
      expect(inboxTable).toHaveTextContent('Duplicate replayed');
      expect(inboxTable).toHaveTextContent('idem-wbk-7738');
    });
  });

  it('searches webhook inbox by full backend idempotency key', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      const tables = document.querySelectorAll('.dt-wrap');
      const inboxTable = Array.from(tables).find((table) =>
        table.textContent?.includes('Receiver outcome'),
      ) as HTMLElement | undefined;
      expect(inboxTable).toBeTruthy();
      expect(inboxTable).toHaveTextContent('idem-wbk-7738');
      expect(inboxTable).toHaveTextContent('WooCommerce KSA');
    });

    const tables = document.querySelectorAll('.dt-wrap');
    const inboxTable = Array.from(tables).find((table) =>
      table.textContent?.includes('Receiver outcome'),
    ) as HTMLElement;
    await user.type(
      within(inboxTable).getByPlaceholderText('Search…'),
      'idem-wbk-7738',
    );

    await waitFor(() => {
      expect(inboxTable).toHaveTextContent('idem-wbk-7738');
      expect(inboxTable).toHaveTextContent('Exampleparcel KSA production');
      expect(inboxTable).not.toHaveTextContent('WooCommerce KSA');
    });
  });

  it('keeps the webhook inbox in the primary scroll frame before downstream intake sections', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await screen.findByText('Webhook inbox');

    const primaryFrame = document.querySelector('.intake-table-frame--primary') as HTMLElement | null;
    expect(primaryFrame).toBeTruthy();
    expect(primaryFrame).toHaveTextContent('Workflow reference');
    expect(primaryFrame).toHaveTextContent('Exampleparcel KSA production');
    expect(primaryFrame?.querySelector('.dt-wrap')).toBeTruthy();

    const marketingHeading = screen.getByText('Marketing lead intake - recent');
    expect(
      primaryFrame!.compareDocumentPosition(marketingHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('row action opens the focused workflow run in-place when intake projection has workflow_run_id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await screen.findByText('Webhook inbox');
    await waitFor(() => {
      const tables = document.querySelectorAll('.dt-wrap');
      expect(tables.length).toBeGreaterThanOrEqual(3);
      const inboxTable = Array.from(tables).find((table) =>
        table.textContent?.includes('Workflow reference'),
      ) as HTMLElement | undefined;
      expect(inboxTable).toBeTruthy();
      expect(inboxTable).toHaveTextContent('Exampleparcel KSA production');
    });

    const tables = document.querySelectorAll('.dt-wrap');
    const inboxTable = Array.from(tables).find((table) =>
      table.textContent?.includes('Workflow reference'),
    ) as HTMLElement | undefined;
    expect(inboxTable).toBeTruthy();
    const sourceRow = Array.from(inboxTable!.querySelectorAll<HTMLTableRowElement>('tbody tr'))
      .find((row) => row.textContent?.includes('Exampleparcel KSA production'));
    expect(sourceRow).toBeTruthy();

    await user.click(within(sourceRow as HTMLTableRowElement).getByRole('button', { name: /Row actions/ }));
    const viewWorkflowRun = await screen.findByRole('option', { name: /^View workflow run/i });
    await user.click(viewWorkflowRun);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer).toBeTruthy();
      expect(drawer).toHaveTextContent('Workflow run context');
      expect(drawer).toHaveTextContent('wfr_3215');
      expect(drawer).toHaveTextContent('shipment.create');
      expect(drawer).toHaveTextContent('shipment.created');
      expect(window.location.pathname).toBe('/integrations/intake');
    });
  });

  it('opens the shipment context drawer from inbox shipment references without primary navigation links', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });
    // wbk_7741 → wfr_3221 → shipment.created shp_9381999 (per intake.js +
    // workflows.js + decisions.js seed)... actually wfr_3221 only emits
    // route_run.assigned per current decisions.js; the only mapped chain
    // currently is wbk_7738 → wfr_3215 → shipment.created shp_9381502.
    // Assert by data-testid which is set on every shipment context action.
    await waitFor(() => {
      const buttons = document.querySelectorAll('button[data-testid="inbox-shipment-context-button"]');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[data-testid="inbox-shipment-context-button"]'),
    );
    for (const button of buttons) {
      expect(button).not.toHaveAttribute('href');
      expect(button.textContent).toMatch(/Shipment ref/i);
      expect(button.textContent).toMatch(/shp_/i);
    }

    await user.click(buttons[0]!);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent).toMatch(/Shipment context/);
    });
  });

  it('renders an em-dash for inbox rows that have no resolved shipment yet', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const tables = document.querySelectorAll('.dt__table');
      expect(tables.length).toBeGreaterThan(0);
    });
    // At least one row in the seed (wbk_7737) has no workflow_run_id, so its
    // Shipment cell should render the placeholder dash.
    await waitFor(() => {
      const dashes = Array.from(document.querySelectorAll('.dt__table tbody td .mono'))
        .filter((el) => (el.textContent ?? '').trim() === '—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('opens failed webhook intake provenance with backend error readback and no shipment handoff', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr');
    expect(failedRow).not.toBeNull();
    expect(failedRow?.textContent).toMatch(/1 replay/);
    expect(failedRow?.textContent).toMatch(/Platform Operator/);

    await user.click(failedRow as Element);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer?.textContent).toMatch(/Failed mapping source/);
      expect(drawer?.textContent).toMatch(/Failed/);
      expect(drawer?.textContent).toMatch(/Replay history/);
      expect(drawer?.textContent).toMatch(/1 replay/);
      expect(drawer?.textContent).toMatch(/operator_replay|replay/);
      expect(drawer?.textContent).toMatch(/Platform Operator/);
      expect(drawer?.textContent).toMatch(/webhook shipment\.create did not enqueue shipment materialization workflow/);
      expect(drawer?.textContent).toMatch(/Authorization: Bearer \[redacted\]/);
      expect(drawer?.textContent).toMatch(/api_key=\[redacted\]/);
      expect(drawer?.textContent).not.toMatch(/failed-provenance-bearer/);
      expect(drawer?.textContent).not.toMatch(/failed-provenance-api-key/);
      expect(drawer?.textContent).toMatch(/not yet emitted/);
      expect(within(drawer as HTMLElement).queryByTestId('prov-shipment-context-button')).toBeNull();
      expect(within(drawer as HTMLElement).getByRole('button', { name: /Open mapping/i })).toBeEnabled();
    });

    await user.click(screen.getByRole('button', { name: /Open mapping/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/integrations/mapping');
      expect(window.location.search).toContain('focus=mc_failed_mapping');
      expect(window.location.search).toContain('inbox_id=wbk_failed_mapping');
    });
  });

  it('opens the provenance drawer with source → inbox → run → shipment chain', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });
    await waitFor(() => {
      const buttons = document.querySelectorAll('button[data-testid="inbox-shipment-context-button"]');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
    const shipmentButtonInRow = document.querySelector(
      'button[data-testid="inbox-shipment-context-button"]',
    );
    const rowWithShipment = shipmentButtonInRow?.closest('tr');
    expect(rowWithShipment).not.toBeNull();
    await user.click(rowWithShipment as Element);
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    // Operator-facing chain card labels must be present in the drawer body.
    const drawer = document.querySelector('.drawer')!;
    expect(drawer.textContent).toMatch(/Source/);
    expect(drawer.textContent).toMatch(/Inbox event/);
    expect(drawer.textContent).toMatch(/Receiver acknowledgement/);
    expect(drawer.textContent).toMatch(/Duplicate replayed/);
    expect(drawer.textContent).toMatch(/idem-wbk-7738/);
    expect(drawer.textContent).toMatch(/duplicate delivery replayed from original inbox row/);
    expect(drawer.textContent).toMatch(/Mapping/);
    expect(drawer.textContent).toMatch(/Workflow run/);
    expect(drawer.textContent).toMatch(/Shipment/);
    expect(drawer.textContent).toMatch(/Event ref/);
    expect(drawer.textContent).toMatch(/wbk_\d+/);
    expect(drawer.textContent).toMatch(/whs_/);
    // Footer must include the activity action.
    const footer = drawer.querySelector('.drawer__footer');
    expect(footer?.textContent).toMatch(/Open activity/);
    const shipmentButton = within(drawer as HTMLElement).getByTestId('prov-shipment-context-button');
    expect(shipmentButton).not.toHaveAttribute('href');

    await user.click(shipmentButton);
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent).toMatch(/Shipment context/);
    });
  });

  it('renders rejected webhook auth readback from the backend ledger without fake inbox or shipment actions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(screen.getByText('Rejected webhook requests')).toBeTruthy();
      expect(screen.getAllByText('Request rejected').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Exampleparcel KSA production').length).toBeGreaterThan(0);
    });

    const listCallsBeforeRefresh = vi.mocked(api.ui_list_resource_complete).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Refresh rejected webhook requests/i }));
    await waitFor(() => {
      expect(vi.mocked(api.ui_list_resource_complete).mock.calls.length)
        .toBeGreaterThan(listCallsBeforeRefresh);
    });

    const rejectedRow = Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'))
      .find((row) => row.textContent?.includes('Request rejected') && row.textContent?.includes('Exampleparcel KSA production'));
    expect(rejectedRow).toBeTruthy();
    await user.click(rejectedRow as HTMLTableRowElement);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer?.textContent).toMatch(/Rejected webhook request/);
      expect(drawer?.textContent).toMatch(/5e5ee6f6-8f10-49f7-9f29-2c5cfc9d7b16/);
      expect(drawer?.textContent).toMatch(/Source check failed/);
      expect(drawer?.textContent).toMatch(/PathProtected/);
      expect(drawer?.textContent).not.toMatch(/plain-secret/);
      expect(drawer?.textContent).not.toMatch(/req_webhook_invalid_token_test/);
      expect(drawer?.textContent).toMatch(/Request details protected/);
      expect(drawer?.textContent).toMatch(/Sensitive request headers and rejection details are hidden/);
      expect(within(drawer).queryByTestId('prov-shipment-context-button')).toBeNull();
      expect(within(drawer).queryByText(/Open shipment/i)).toBeNull();
    });
  });

  it('refreshes rejected webhook auth from backend readback without a browser reload', async () => {
    const user = userEvent.setup();
    const liveRejectedTokenRow = {
      ...WEBHOOK_AUTH_REJECTION_ROWS[1],
      id: 'iar_webhook_disabled_token_live_readback',
      source_label: 'Disabled live source',
      correlation_id: 'disabled-token-live-readback-correlation',
      request_id: 'disabled-token-live-readback-request',
      occurred_at: '2026-05-10T12:08:00Z',
      metadata: {
        edge_stage: 'workflow_intake_webhook',
        source_resolution: 'disabled_webhook_source_token',
      },
    };
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    let authRejectionReads = 0;
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_auth_rejections') {
        authRejectionReads += 1;
        return listResult(
          authRejectionReads > 1
            ? [liveRejectedTokenRow, ...WEBHOOK_AUTH_REJECTION_ROWS]
            : WEBHOOK_AUTH_REJECTION_ROWS,
        ) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(screen.queryByText('disabled-token-live-readback-correlation')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /Refresh rejected webhook requests/i }));
    expect(await screen.findByText('disabled-token-live-readback-correlation')).toBeTruthy();
    expect(screen.getByText('Disabled live source')).toBeTruthy();
  });

  it('keeps rejected webhook auth failures readable when webhook inbox directory is unavailable', async () => {
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        throw new Error('ui_list_resource_v1 unknown resource webhook_inbox_directory');
      }
      if (resource === 'webhook_auth_rejections') {
        return listResult(WEBHOOK_AUTH_REJECTION_ROWS) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(await screen.findByText('Webhook inbox unavailable')).toBeTruthy();
    expect(await screen.findByText('Rejected webhook requests')).toBeTruthy();
    expect(screen.getByText('Unresolved source')).toBeTruthy();
    expect(screen.getByText('3d3d3488-0749-43f3-a76c-720310076e17')).toBeTruthy();
  });

  it('keeps rejected webhook auth current from backend readback without manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'resolveSettings').mockImplementation(async (category: string) => {
      if (category === 'live_tail_policy') {
        return {
          category: 'live_tail_policy',
          value: { webhook_auth_rejection_refetch_interval_ms: 500 },
          resolved_from: 'global',
          ladder_path: [],
          settings_resolution_id: 'srlv_webhook_auth_rejection_poll_test',
          override_of: null,
        } as Awaited<ReturnType<typeof api.resolveSettings>>;
      }
      throw new Error(`Unhandled settings category ${category}`);
    });

    const liveRejectedTokenRow = {
      ...WEBHOOK_AUTH_REJECTION_ROWS[1],
      id: 'iar_webhook_disabled_token_auto_readback',
      source_label: 'Auto disabled source',
      correlation_id: 'disabled-token-auto-readback-correlation',
      request_id: 'disabled-token-auto-readback-request',
      occurred_at: '2026-05-10T12:09:00Z',
      metadata: {
        edge_stage: 'workflow_intake_webhook',
        source_resolution: 'disabled_webhook_source_token',
      },
    };
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    let authRejectionReads = 0;
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_auth_rejections') {
        authRejectionReads += 1;
        return listResult(
          authRejectionReads > 2
            ? [liveRejectedTokenRow, ...WEBHOOK_AUTH_REJECTION_ROWS]
            : WEBHOOK_AUTH_REJECTION_ROWS,
        ) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(screen.queryByText('disabled-token-auto-readback-correlation')).toBeNull();
    await vi.advanceTimersByTimeAsync(750);

    await waitFor(() => {
      expect(screen.getByText('disabled-token-auto-readback-correlation')).toBeTruthy();
      expect(screen.getByText('Auto disabled source')).toBeTruthy();
    });
  });

  it('keeps externally received SNA webhook inbox rows current from backend readback without manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(api, 'resolveSettings').mockImplementation(async (category: string) => {
      if (category === 'live_tail_policy') {
        return {
          category: 'live_tail_policy',
          value: { webhook_inbox_refetch_interval_ms: 500 },
          resolved_from: 'global',
          ladder_path: [],
          settings_resolution_id: 'srlv_webhook_inbox_sna_poll_test',
          override_of: null,
        } as Awaited<ReturnType<typeof api.resolveSettings>>;
      }
      throw new Error(`Unhandled settings category ${category}`);
    });

    const liveSnaInboxRow = {
      ...WEBHOOK_INBOX_DIRECTORY_ROWS[0],
      id: 'wbk_maps_sna_auto_refetch',
      webhook_source_id: 'whs_maps_sna_auto_refetch',
      source_label: 'Maps SNA live source',
      source_identifier: 'maps-sna-live-source',
      created_at: '2026-05-10T12:13:00Z',
      idempotency_key: 'MAPS-SNA-AUTO-REFETCH-1778742300000',
      external_id: 'MAPS-SNA-AUTO-REFETCH-REF',
      workflow_run_id: 'wfr_maps_sna_auto_refetch',
      shipment_id: 'shp_maps_sna_auto_refetch',
      tracking_number: 'TRK-MAPS-SNA-AUTO-REFETCH',
      mapping_label: 'maps_sna.shipment_inbound',
      mapping_target: 'shipments.create',
    };
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    let inboxReads = 0;
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        inboxReads += 1;
        const rows = inboxReads > 1
          ? [liveSnaInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS]
          : WEBHOOK_INBOX_DIRECTORY_ROWS;
        return listResult(rows) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(screen.queryByText('MAPS-SNA-AUTO-REFETCH-1778742300000')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1250);
    });

    await waitFor(() => {
      expect(inboxReads).toBeGreaterThan(1);
      const tables = document.querySelectorAll('.dt-wrap');
      const inboxTable = Array.from(tables).find((table) =>
        table.textContent?.includes('Receiver outcome'),
      ) as HTMLElement | undefined;
      expect(inboxTable).toBeTruthy();
      expect(inboxTable).toHaveTextContent('MAPS-SNA-AUTO-REFETCH-1778742300000');
      expect(inboxTable).toHaveTextContent('Maps SNA live source');
      expect(inboxTable).toHaveTextContent('shp_maps_sna_auto_refetch');
    });

    const inboxTable = Array.from(document.querySelectorAll<HTMLElement>('.dt-wrap')).find((table) =>
      table.textContent?.includes('Receiver outcome'),
    ) as HTMLElement;
    const liveSnaRow = Array.from(inboxTable.querySelectorAll<HTMLTableRowElement>('tbody tr')).find((row) =>
      row.textContent?.includes('MAPS-SNA-AUTO-REFETCH-1778742300000'),
    );
    expect(liveSnaRow).toBeTruthy();
    const shipmentButton = within(liveSnaRow as HTMLTableRowElement).getByTestId('inbox-shipment-context-button');
    expect(shipmentButton).toHaveTextContent('shp_maps_sna_auto_refetch');
    await act(async () => {
      await user.click(shipmentButton);
    });

    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent).toMatch(/Shipment context/);
    });
  });

  it('describes signature-failed source authentication in the empty rejected-auth state', async () => {
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_auth_rejections') {
        return listResult([]) as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      }
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    expect(await screen.findByText('No rejected webhook requests')).toBeTruthy();
    expect(screen.getByText(/signature-failed source tokens/i)).toBeTruthy();
  });

  it('lists unresolved webhook token rejections without tenant-filtering them out', async () => {
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(screen.getByText('Rejected webhook requests')).toBeTruthy();
      expect(screen.getByText('Unresolved source')).toBeTruthy();
      expect(screen.getByText('3d3d3488-0749-43f3-a76c-720310076e17')).toBeTruthy();
    });

    const authListCall = vi.mocked(api.ui_list_resource_complete).mock.calls.find(
      ([resource]) => resource === 'webhook_auth_rejections',
    );
    expect(authListCall).toBeTruthy();
    expect((authListCall?.[1] as api.ListOpts | undefined)?.filter).toBeUndefined();
    expect((authListCall?.[1] as api.ListOpts | undefined)?.sort).toMatchObject({
      key: 'occurred_at',
      dir: 'desc',
    });
  });

  it('renders retired webhook source-token rejections with resolved source lineage and redacted headers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(screen.getByText('Rejected webhook requests')).toBeTruthy();
      expect(screen.getByText('chrome-current-webhook-source-1778436200')).toBeTruthy();
      expect(screen.getByText('00e37288-d101-458c-91a5-a1109a584c44')).toBeTruthy();
    });

    const retiredRow = Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'))
      .find((row) => row.textContent?.includes('00e37288-d101-458c-91a5-a1109a584c44'));
    expect(retiredRow).toBeTruthy();
    await user.click(retiredRow as HTMLTableRowElement);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer?.textContent).toMatch(/Rejected webhook request/);
      expect(drawer?.textContent).toMatch(/Request details protected/);
      expect(drawer?.textContent).toMatch(/00e37288-d101-458c-91a5-a1109a584c44/);
      expect(drawer?.textContent).toMatch(/chrome-current-webhook-source-1778436200/);
      expect(drawer?.textContent).toMatch(/Demo Client A/);
      expect(drawer?.textContent).toMatch(/Demo Sender A/);
      expect(drawer?.textContent).toMatch(/Source check failed/);
      expect(drawer?.textContent).toMatch(/Sensitive request headers and rejection details are hidden/);
      expect(drawer?.textContent).not.toMatch(/retired-secret/);
      expect(drawer?.textContent).not.toMatch(/retired-webhook-ext-test/);
      expect(drawer?.textContent).not.toMatch(/retired_token_history_id/);
      expect(within(drawer).queryByTestId('prov-shipment-context-button')).toBeNull();
      expect(within(drawer).queryByText(/Open shipment/i)).toBeNull();
    });
  });

  it('renders webhook HMAC signature rejections with source lineage and redacted signature evidence', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(screen.getByText('Rejected webhook requests')).toBeTruthy();
      expect(screen.getByText('Console V2 HMAC Source')).toBeTruthy();
    });

    const hmacRow = Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'))
      .find((row) => row.textContent?.includes('Console V2 HMAC Source'));
    expect(hmacRow).toBeTruthy();
    await user.click(hmacRow as HTMLTableRowElement);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer') as HTMLElement;
      expect(drawer?.textContent).toMatch(/Rejected webhook request/);
      expect(drawer?.textContent).toMatch(/Request details protected/);
      expect(drawer?.textContent).toMatch(/11111111-2222-4333-8444-555555555555/);
      expect(drawer?.textContent).toMatch(/Console V2 HMAC Source/);
      expect(drawer?.textContent).toMatch(/Source check failed/);
      expect(drawer?.textContent).toMatch(/Sensitive request headers and rejection details are hidden/);
      expect(drawer?.textContent).not.toMatch(/console-v2-hmac-invalid-1/);
      expect(drawer?.textContent).not.toMatch(/hmac_signature/);
      expect(drawer?.textContent).not.toMatch(/auth_surface/);
      expect(drawer?.textContent).not.toMatch(/plain-hmac-signature/);
      expect(drawer?.textContent).not.toMatch(/hmac-secret-token/);
      expect(within(drawer).queryByTestId('prov-shipment-context-button')).toBeNull();
      expect(within(drawer).queryByText(/Open shipment/i)).toBeNull();
    });
  });

  it('refreshes the visible webhook inbox from backend readback without a browser reload', async () => {
    const user = userEvent.setup();
    const newApiInboxRow = {
      ...WEBHOOK_INBOX_DIRECTORY_ROWS[0],
      id: 'wbk_direct_api_visible',
      created_at: '2026-05-10T12:10:00Z',
      idempotency_key: 'direct-api-visible-1778709676473',
      external_id: 'DIRECT-API-VISIBLE-REF',
      workflow_run_id: 'wfr_direct_api_visible',
      shipment_id: 'shp_direct_api_visible',
      tracking_number: 'TRK-DIRECT-API-VISIBLE',
    };
    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    let webhookInboxDirectoryReads = 0;
    const readWebhookInboxDirectory = async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (typeof filter?.id === 'string') {
          const rows = [newApiInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS].filter((row) => row.id === filter.id);
          return listResult(rows);
        }
        webhookInboxDirectoryReads += 1;
        return listResult(
          webhookInboxDirectoryReads > 1
            ? [newApiInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS]
            : WEBHOOK_INBOX_DIRECTORY_ROWS,
        );
      }
      return null;
    };
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const webhookReadback = await readWebhookInboxDirectory(resource, opts);
      if (webhookReadback) return webhookReadback;
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const webhookReadback = await readWebhookInboxDirectory(resource, opts);
      if (webhookReadback) return webhookReadback as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(screen.getByText('Webhook inbox')).toBeInTheDocument();
      expect(screen.queryByText(/direct-api-visible-1778709676473/)).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /Refresh webhook inbox/i }));

    await waitFor(() => {
      expect(document.body).toHaveTextContent('direct-api-visible-1778709676473');
      expect(document.body).toHaveTextContent('shp_direct_api_visible');
    });
  });

  it('replays an inbox event and refreshes the open provenance drawer from focused backend readback without reload', async () => {
    const user = userEvent.setup();
    let replayed = false;
    const replaySpy = vi.spyOn(api, 'webhook_inbox_replay_v1').mockImplementation(async () => {
      replayed = true;
      return {
        ok: true,
        status: 'replay_queued',
        replay_queued: true,
        webhook_inbox_id: 'wbk_failed_mapping',
        prior_status: 'failed',
      };
    });
    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    const focusedReadbackCalls: Array<api.ListOpts | undefined> = [];
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (filter?.id === 'wbk_failed_mapping') {
          focusedReadbackCalls.push(opts);
        }
        const rows = WEBHOOK_INBOX_DIRECTORY_ROWS.map((row) =>
          row.id === 'wbk_failed_mapping' && replayed
            ? {
                ...row,
                replay_count: 2,
                last_replay_action: 'replay',
                last_replay_actor: 'Platform Operator',
                last_replay_at: '2026-05-15T12:20:00Z',
              }
            : row,
        );
        if (typeof filter?.id === 'string') {
          return listResult(rows.filter((row) => row.id === filter.id));
        }
        return listResult(rows);
      }
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr') as HTMLTableRowElement;
    expect(failedRow.textContent).toContain('1 replay');
    await user.click(failedRow);

    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer?.textContent).toMatch(/Replay history/);
      expect(drawer?.textContent).toMatch(/1 replay/);
      expect(drawer?.textContent).toMatch(/Platform Operator/);
      expect(window.location.pathname).toBe('/integrations/intake');
    });

    const initialDrawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(initialDrawer).getByRole('button', { name: /^Replay inbox$/i }));

    await waitFor(() => {
      expect(replaySpy).toHaveBeenCalledWith({
        webhook_inbox_id: 'wbk_failed_mapping',
        reason: 'operator_replay',
      });
    });
    await waitFor(() => {
      const drawer = document.querySelector('.drawer');
      expect(drawer?.textContent).toMatch(/2 replays/);
      expect(drawer?.textContent).toMatch(/replay/);
      expect(drawer?.textContent).toMatch(/Platform Operator/);
      expect(window.location.pathname).toBe('/integrations/intake');
      expect(window.location.search).toContain('inbox_id=wbk_failed_mapping');
      expect(focusedReadbackCalls.some((opts) => {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        return filter?.id === 'wbk_failed_mapping';
      })).toBe(true);
    });
  });

  it('keeps replay state unchanged when backend readback does not show the replay ledger', async () => {
    const user = userEvent.setup();
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const replaySpy = vi.spyOn(api, 'webhook_inbox_replay_v1').mockResolvedValue({
      ok: true,
      status: 'replay_queued',
      replay_queued: true,
      webhook_inbox_id: 'wbk_failed_mapping',
      prior_status: 'failed',
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr') as HTMLTableRowElement;
    expect(failedRow.textContent).toContain('1 replay');
    await user.click(within(failedRow).getByRole('button', { name: /Row actions/i }));
    await user.click(await screen.findByRole('option', { name: /^Replay inbox event/ }));

    await waitFor(() => expect(replaySpy).toHaveBeenCalled());
    await waitFor(() => {
      expect(document.body).toHaveTextContent('1 replay');
      expect(document.body).not.toHaveTextContent('2 replays');
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Replay failed.*confirmation did not show replay ledger increment/i),
        'danger',
      );
    });
  });

  it('forces an inbox status and shows backend-readback status plus ledger without reload', async () => {
    const user = userEvent.setup();
    let forced = false;
    const forceSpy = vi.spyOn(api, 'webhook_inbox_force_status_v1').mockImplementation(async () => {
      forced = true;
      return {
        ok: true,
        webhook_inbox_id: 'wbk_7737',
        forced_status: 'failed',
      };
    });
    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const rows = WEBHOOK_INBOX_DIRECTORY_ROWS.map((row) =>
          row.id === 'wbk_7737' && forced
            ? {
                ...row,
                processing_status: 'failed',
                force_status_count: 1,
                last_replay_action: 'force_status',
                last_replay_actor: 'Platform Operator',
                last_replay_at: '2026-05-15T12:32:00Z',
              }
            : row,
        );
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (typeof filter?.id === 'string') {
          return listResult(rows.filter((row) => row.id === filter.id));
        }
        return listResult(rows);
      }
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const source = await screen.findByText('WooCommerce KSA');
    const row = source.closest('tr') as HTMLTableRowElement;
    expect(row.textContent).toContain('Pending');
    await user.click(within(row).getByRole('button', { name: /Row actions/i }));
    await user.click(await screen.findByRole('option', { name: /^Force status: failed/ }));

    await waitFor(() => {
      expect(forceSpy).toHaveBeenCalledWith({
        webhook_inbox_id: 'wbk_7737',
        target_status: 'failed',
        reason: 'operator_force_failed',
      });
    });
    await waitFor(() => {
      expect(document.body).toHaveTextContent('Failed');
      expect(document.body).toHaveTextContent('force_status');
      expect(document.body).toHaveTextContent('Platform Operator');
    });
  });

  it('creates a fresh backend intake attempt from a failed inbox row and shows it without reload', async () => {
    const user = userEvent.setup();
    const freshInboxRow = {
      ...WEBHOOK_INBOX_DIRECTORY_ROWS[2],
      id: 'wbk_fresh_intake_retry',
      created_at: '2026-05-15T10:15:00Z',
      processing_status: 'in_progress',
      idempotency_key: 'console-fresh-intake:wbk_failed_mapping:new',
      external_id: 'FAILED-MAPPING-1-FRESH',
      workflow_run_id: 'wfr_fresh_intake_retry',
      workflow_run_status: 'running',
      replay_count: 0,
      last_replay_action: null,
      last_replay_actor: null,
      error_message: null,
    };
    let freshVisible = false;
    const retrySpy = vi.spyOn(api, 'ui_retry_webhook_inbox_as_new_intake_v1').mockImplementation(async () => {
      freshVisible = true;
      return {
        ok: true,
        status: 'new_intake_started',
        retry_queued: true,
        webhook_inbox_id: 'wbk_failed_mapping',
        original_webhook_inbox_id: 'wbk_failed_mapping',
        new_webhook_inbox_id: 'wbk_fresh_intake_retry',
        new_idempotency_key: 'console-fresh-intake:wbk_failed_mapping:new',
      };
    });
    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        const rows = freshVisible ? [freshInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS] : WEBHOOK_INBOX_DIRECTORY_ROWS;
        if (typeof filter?.id === 'string') {
          return listResult(rows.filter((row) => row.id === filter.id));
        }
        return listResult(rows);
      }
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr') as HTMLTableRowElement;
    expect(failedRow).toBeTruthy();

    await user.click(within(failedRow).getByRole('button', { name: /Row actions/i }));
    await user.click(await screen.findByRole('option', { name: /^Create fresh intake/ }));

    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledWith({
        webhook_inbox_id: 'wbk_failed_mapping',
        reason: 'operator_create_fresh_intake',
      });
    });
    await waitFor(() => {
      expect(document.body).toHaveTextContent('FAILED-MAPPING-1-FRESH');
      expect(document.body).toHaveTextContent('console-fresh-intake:wbk_failed_mapping:new');
      expect(document.body).toHaveTextContent('wfr_fresh_intake_retry');
    });
  });

  it('shows external resend remediation readback on the failed inbox row without reload', async () => {
    const user = userEvent.setup();
    let externalResendRecorded = false;
    const retrySpy = vi.spyOn(api, 'ui_retry_webhook_inbox_as_new_intake_v1').mockImplementation(async () => {
      externalResendRecorded = true;
      return {
        ok: true,
        status: 'external_resend_required',
        webhook_inbox_id: 'wbk_failed_mapping',
        original_webhook_inbox_id: 'wbk_failed_mapping',
        retry_queued: false,
        reason: 'source_token_not_recoverable',
      };
    });
    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const rows = WEBHOOK_INBOX_DIRECTORY_ROWS.map((row) => {
          if (row.id !== 'wbk_failed_mapping' || !externalResendRecorded) return row;
          return {
            ...row,
            replay_count: 0,
            last_replay_action: 'retry_as_new_intake',
            last_replay_actor: 'Platform Operator',
            last_replay_at: '2026-05-15T11:49:37Z',
          };
        });
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (typeof filter?.id === 'string') {
          return listResult(rows.filter((row) => row.id === filter.id));
        }
        return listResult(rows);
      }
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });

    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr') as HTMLTableRowElement;
    expect(failedRow).toBeTruthy();

    await user.click(within(failedRow).getByRole('button', { name: /Row actions/i }));
    await user.click(await screen.findByRole('option', { name: /^Create fresh intake/ }));

    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledWith({
        webhook_inbox_id: 'wbk_failed_mapping',
        reason: 'operator_create_fresh_intake',
      });
    });
    await waitFor(() => {
      expect(document.body).toHaveTextContent('Ledger update');
      expect(document.body).toHaveTextContent('retry_as_new_intake');
      expect(document.body).toHaveTextContent('Platform Operator');
    });
  });

  it('refetches cached webhook inbox rows on page entry so identifier search starts from backend readback', async () => {
    const newApiInboxRow = {
      ...WEBHOOK_INBOX_DIRECTORY_ROWS[0],
      id: 'wbk_initial_mount_refetch',
      created_at: '2026-05-10T12:12:00Z',
      idempotency_key: 'initial-mount-refetch-1778742200000',
      external_id: 'INITIAL-MOUNT-REFETCH-REF',
      workflow_run_id: 'wfr_initial_mount_refetch',
      shipment_id: 'shp_initial_mount_refetch',
      tracking_number: 'TRK-INITIAL-MOUNT-REFETCH',
    };
    const tenantOpts = { filter: { organization_id: 'org_rashed' } };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(qk.list('webhook_inbox_directory', tenantOpts), listResult(WEBHOOK_INBOX_DIRECTORY_ROWS));

    const baseList = vi.mocked(api.ui_list_resource_v1).getMockImplementation();
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    const readInitialMountInbox = async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'webhook_inbox_directory') {
        const filter = opts?.filter as Record<string, unknown> | undefined;
        if (typeof filter?.id === 'string') {
          const rows = [newApiInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS].filter((row) => row.id === filter.id);
          return listResult(rows);
        }
        return listResult([newApiInboxRow, ...WEBHOOK_INBOX_DIRECTORY_ROWS]);
      }
      return null;
    };
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const webhookReadback = await readInitialMountInbox(resource, opts);
      if (webhookReadback) return webhookReadback;
      if (!baseList) throw new Error(`Unhandled resource ${resource}`);
      return baseList(resource, opts);
    });
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      const webhookReadback = await readInitialMountInbox(resource, opts);
      if (webhookReadback) return webhookReadback as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
      if (!baseComplete) throw new Error(`Unhandled complete resource ${resource}`);
      return baseComplete(resource, opts);
    });

    renderWithProviders(<IntakeModule />, {
      capabilities: ['all'],
      queryClient,
      identity: {
        capabilities: ['all'],
        scope: { tenant: { id: 'org_rashed', label: 'Rashed tenant', rank: 2 } },
        user: {
          access_scope_type: 'tenant',
          organization_id: 'org_rashed',
        },
      },
    });

    await screen.findByText('Webhook inbox');

    await waitFor(() => {
      expect(document.body).toHaveTextContent('initial-mount-refetch-1778742200000');
      expect(document.body).toHaveTextContent('shp_initial_mount_refetch');
    });
  });

  it('keeps projected workflow run evidence visible when enrichment rows are unavailable', async () => {
    const user = userEvent.setup();
    const baseComplete = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    const projectionSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'webhook_inbox_directory') {
          return {
            rows: [
              {
                id: 'wbk_projected_run_fallback',
                organization_id: 'org_rashed',
                webhook_source_id: 'whs_projected_run_fallback',
                source_label: 'Projected run source',
                source_identifier: 'projected-run-source',
                provider_type_label: 'Generic',
                created_at: '2026-05-10T18:00:00Z',
                processing_status: 'processed',
                event_type: 'shipment.created',
                payload_size: 1024,
                external_id: 'PROJECTED-RUN-1',
                workflow_run_id: 'wfr_projected_run_fallback',
                workflow_run_status: 'succeeded',
                shipment_id: 'shp_projected_run_fallback',
                tracking_number: 'TRACK-PROJECTED-RUN',
                shipment_status: 'pending',
                mapping_config_id: 'mc_projected_run',
                mapping_label: 'projected.run.shipment_inbound',
                mapping_target: 'shipments.create',
                mapping_version: 1,
                mapping_rules_count: 3,
                is_terminal: true,
                is_actionable: false,
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
        }
        return listResult([]);
      },
    );
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'webhook_inbox_directory') {
          return {
            rows: [
              {
                id: 'wbk_projected_run_fallback',
                organization_id: 'org_rashed',
                webhook_source_id: 'whs_projected_run_fallback',
                source_label: 'Projected run source',
                source_identifier: 'projected-run-source',
                provider_type_label: 'Generic',
                created_at: '2026-05-10T18:00:00Z',
                processing_status: 'processed',
                event_type: 'shipment.created',
                payload_size: 1024,
                external_id: 'PROJECTED-RUN-1',
                workflow_run_id: 'wfr_projected_run_fallback',
                workflow_run_status: 'succeeded',
                shipment_id: 'shp_projected_run_fallback',
                tracking_number: 'TRACK-PROJECTED-RUN',
                shipment_status: 'pending',
                mapping_config_id: 'mc_projected_run',
                mapping_label: 'projected.run.shipment_inbound',
                mapping_target: 'shipments.create',
                mapping_version: 1,
                mapping_rules_count: 3,
                is_terminal: true,
                is_actionable: false,
              },
            ],
            total: 1,
          } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        if (resource === 'workflow_run_directory') {
          return { rows: [], total: 0 } as Awaited<ReturnType<typeof api.ui_list_resource_complete>>;
        }
        return baseComplete?.(resource, opts) ?? listResult([]);
      },
    );

    try {
      renderWithProviders(<IntakeModule />, { capabilities: ['all'] });
      await waitFor(() => {
        const buttons = document.querySelectorAll('button[data-testid="inbox-shipment-context-button"]');
        expect(buttons.length).toBeGreaterThanOrEqual(1);
      });
      const shipmentButtonInRow = document.querySelector(
        'button[data-testid="inbox-shipment-context-button"]',
      );
      const rowWithShipment = shipmentButtonInRow?.closest('tr');
      expect(rowWithShipment).not.toBeNull();
      await user.click(rowWithShipment as Element);

      await waitFor(() => {
        const drawerText = document.querySelector('.drawer')?.textContent ?? '';
        expect(drawerText).toMatch(/Workflow run/);
        expect(drawerText).toMatch(/Run ref fallback \(wfr_projected_run_fallback\)/);
        expect(drawerText).toMatch(/Succeeded/);
      });
    } finally {
      projectionSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('auto-opens a focused inbox event from the deep-link query and reads the exact projection row', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    window.history.replaceState({}, '', '/integrations/intake?inbox_id=wbk_7738');

    try {
      renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

      await waitFor(() => {
        expect(document.querySelector('.drawer')?.textContent).toMatch(/wbk_7738/);
      });
      expect(
        listSpy.mock.calls.some(([resource, opts]) => {
          const filter = (opts as api.ListOpts | undefined)?.filter as Record<string, unknown> | undefined;
          return resource === 'webhook_inbox_directory' && filter?.id === 'wbk_7738';
        }),
      ).toBe(true);
      expect(
        listSpy.mock.calls.some(([resource, opts]) => {
          const filter = (opts as api.ListOpts | undefined)?.filter as Record<string, unknown> | undefined;
          return resource === 'webhook_inbox' && filter?.id === 'wbk_7738';
        }),
      ).toBe(false);
      expect(document.querySelector('.drawer')?.textContent).toMatch(/Mapping/);
      expect(document.querySelector('.drawer')?.textContent).not.toMatch(/Mapping ref none/);
      expect(document.querySelector('.drawer')?.textContent).toMatch(/Shipment/);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('scopes provenance reads to workflow ids from visible inbox rows', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(
        listSpy.mock.calls.some(([resource, opts]) => {
          const filter = (opts as api.ListOpts | undefined)?.filter as Record<string, unknown> | undefined;
          return resource === 'workflow_run_directory' && typeof filter?.id === 'string';
        }),
      ).toBe(true);
    });

    expect(listSpy.mock.calls.some(([resource]) => resource === 'workflow_runs')).toBe(false);
    expect(
      listSpy.mock.calls.some(([resource, opts]) => {
        const filter = (opts as api.ListOpts | undefined)?.filter as Record<string, unknown> | undefined;
        return resource === 'domain_events' && typeof filter?.workflow_run_id === 'string';
      }),
    ).toBe(true);
    listSpy.mockRestore();
  });

  it('renders webhook inbox rows for webhooks.read users without workflow-read enrichment', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');
    const replaySpy = vi.spyOn(api, 'webhook_inbox_replay_v1').mockRejectedValue(new Error('locked replay called'));
    const retrySpy = vi
      .spyOn(api, 'ui_retry_webhook_inbox_as_new_intake_v1')
      .mockRejectedValue(new Error('locked fresh intake called'));
    const forceSpy = vi
      .spyOn(api, 'webhook_inbox_force_status_v1')
      .mockRejectedValue(new Error('locked force status called'));
    renderWithProviders(<IntakeModule />, { capabilities: [CAP.WEBHOOKS_READ] });

    expect(await screen.findByText('Inbound intake related data unavailable')).toBeInTheDocument();
    expect(screen.getByText(`Capability denied: ${CAP.WORKFLOWS_READ}`)).toBeInTheDocument();
    expect((await screen.findAllByText('Exampleparcel KSA production')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Row actions' }).length).toBeGreaterThan(0);

    const failedSource = await screen.findByText('Failed mapping source');
    const failedRow = failedSource.closest('tr') as HTMLTableRowElement;
    expect(failedRow).toBeTruthy();
    await user.click(within(failedRow).getByRole('button', { name: /Row actions/i }));

    const lockedLabels = [
      'Retry inbox event',
      'Replay inbox event',
      'Create fresh intake',
      'Force status: failed',
    ];
    for (const label of lockedLabels) {
      const item = paletteItemByLabel(label);
      expect(item).toHaveClass('is-disabled');
      expect(item).toHaveTextContent('Requires webhook update permission');
      await user.click(item);
    }
    expect(paletteItemByLabel('View provenance')).not.toHaveClass('is-disabled');
    expect(replaySpy).not.toHaveBeenCalled();
    expect(retrySpy).not.toHaveBeenCalled();
    expect(forceSpy).not.toHaveBeenCalled();
    expect(listSpy.mock.calls.some(([resource]) => resource === 'workflow_run_directory')).toBe(false);
    expect(listSpy.mock.calls.some(([resource]) => resource === 'domain_events')).toBe(false);
    listSpy.mockRestore();
  });

  it('keeps the inbox visible when provenance reads are denied', async () => {
    const baseList = vi.mocked(api.ui_list_resource_complete).getMockImplementation();
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'domain_events') {
          throw new Error('42501 domain events permission denied');
        }
        return baseList?.(resource, opts) ?? listResult([]);
      },
    );
    try {
      renderWithProviders(<IntakeModule />, { capabilities: ['all'] });

      expect(await screen.findByText('Inbound intake related data unavailable')).toBeInTheDocument();
      expect(screen.getByText('42501 domain events permission denied')).toBeInTheDocument();
      expect((await screen.findAllByText('Exampleparcel KSA production')).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('button', { name: 'Row actions' }).length).toBeGreaterThan(0);
    } finally {
      listSpy.mockRestore();
    }
  });
});
