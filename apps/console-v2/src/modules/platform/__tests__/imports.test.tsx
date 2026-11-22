// imports.test.tsx - verifies the canonical /platform/imports surface
// (W16-5). Replaces the legacy PREVIEW-wizard tests with DataTable +
// drawer + cap-gate + Submit/Cancel coverage.
//
// Capability key SSOT: registry.js capability catalog + access_control_policy
//   import jobs use imports.read/imports.write, while file import runs and
//   mapping profile decisions use mappings.read/mappings.write per the
//   tabular_import_runs registry contract.
// Canonical RPC SSOT: supabase/migrations/202604301905_import_job_rpcs_v1.sql
//   (import_job_create_v1, import_job_cancel_v1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ImportsModule } from '@/modules/platform/imports';
import * as api from '@/lib/api';

const FULL_IMPORT_CAPS = ['imports.read', 'imports.write', 'mappings.read', 'mappings.write'];
const FULL_IMPORT_SHIPMENT_CAPS = [...FULL_IMPORT_CAPS, 'shipments.read', 'shipments.write'];
const FULL_IMPORT_WORKFLOW_CAPS = [...FULL_IMPORT_SHIPMENT_CAPS, 'workflows.read', 'requests.read'];

const IMPORT_TEST_LOOKUPS: Record<string, ReturnType<typeof api.getLookups>> = {
  import_job_kind: [
    { value: 'shipments', label: 'Shipments', rank: 10 },
    { value: 'senders', label: 'Senders', rank: 20 },
    { value: 'recipients', label: 'Recipients', rank: 30 },
  ],
  import_job_source: [
    { value: 'file_upload', label: 'File upload', rank: 10, is_default: true, metadata: { requires_prepared_file: true } },
    { value: 'api', label: 'API', rank: 20, metadata: { requires_prepared_file: false } },
    { value: 'manual', label: 'Manual', rank: 30, metadata: { requires_prepared_file: false } },
  ],
  import_job_status: [
    { value: 'queued', label: 'Queued', rank: 10, metadata: { is_queued: true, is_active: true, is_cancellable: true } },
    { value: 'running', label: 'Running', rank: 20, metadata: { is_running: true, is_active: true, is_cancellable: true } },
    { value: 'completed', label: 'Completed', rank: 30, metadata: { is_completed: true, is_active: false, is_cancellable: false } },
    { value: 'failed', label: 'Failed', rank: 40, metadata: { is_failed: true, is_active: false, is_cancellable: false } },
    { value: 'cancelled', label: 'Cancelled', rank: 50, metadata: { is_active: false, is_cancellable: false } },
  ],
  tabular_import_run_status: [
    { value: 'prepared', label: 'Prepared', rank: 10, metadata: { is_active: true, is_terminal: false, is_cancellable: true } },
    { value: 'queued', label: 'Queued', rank: 20, metadata: { is_active: true, is_terminal: false, is_cancellable: true } },
    { value: 'processing', label: 'Processing', rank: 30, metadata: { is_active: true, is_terminal: false, is_cancellable: true } },
    { value: 'completed', label: 'Completed', rank: 40, metadata: { is_active: false, is_terminal: true, is_cancellable: false } },
    { value: 'completed_with_errors', label: 'Completed with errors', rank: 50, metadata: { is_active: false, is_terminal: true, is_cancellable: false } },
    { value: 'failed', label: 'Failed', rank: 60, metadata: { is_active: false, is_terminal: true, is_cancellable: false } },
    { value: 'canceled', label: 'Canceled', rank: 70, metadata: { is_active: false, is_terminal: true, is_cancellable: false } },
  ],
  tabular_import_write_mode: [
    { value: 'create', label: 'Create', rank: 10 },
    { value: 'upsert', label: 'Upsert', rank: 20 },
  ],
};

const importRuleRegistry = {
  shipments: {
    key: 'shipments',
    import: {
      enabled: true,
      accepted_formats: ['csv', 'xls', 'xlsx'],
      allow_upsert: false,
      identity_columns: ['tracking_number', 'client_reference_number'],
      default_write_mode: 'create',
    },
    columns: [
      { key: 'tracking_number', label: 'Tracking number', import: { enabled: true, aliases: ['tracking_number'] } },
      {
        key: 'recipient_id',
        label: 'Recipient',
        import: {
          enabled: true,
          reference: {
            resource: 'recipients',
            allow_inline_node: true,
            inline_node_key: 'recipient',
            mapping_prefixes: ['recipient'],
          },
        },
      },
      {
        key: 'destination_address_id',
        label: 'Destination address',
        import: {
          enabled: true,
          reference: {
            resource: 'addresses',
            allow_inline_node: true,
            inline_node_key: 'destination_address',
            mapping_prefixes: ['destination_address', 'address'],
          },
        },
      },
      {
        key: 'status',
        label: 'Status',
        import: {
          enabled: true,
          required: true,
          default_value: 'pending',
          lookup: { category: 'shipment_status' },
        },
      },
    ],
  },
  recipients: {
    key: 'recipients',
    columns: [
      { key: 'name', label: 'Name', import: { enabled: true, aliases: ['name', 'recipient_name'] } },
    ],
  },
  addresses: {
    key: 'addresses',
    columns: [
      { key: 'raw_input', label: 'Raw input', import: { enabled: true, aliases: ['address_line_1'] } },
      {
        key: 'validation_status',
        label: 'Validation status',
        import: {
          enabled: true,
          required: true,
          default_value: 'pending',
          lookup: { category: 'address_validation_status' },
        },
      },
    ],
  },
};

function csvImportFile(contents: string, name = 'shipments.csv'): File {
  const file = new File([contents], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', {
    configurable: true,
    value: vi.fn().mockResolvedValue(contents),
  });
  return file;
}

const queuedImportJob = {
  id: 'imp_2026_04_30_004',
  organization_id: 'org_rashed',
  kind: 'senders',
  source: 'api',
  status: 'queued',
  submitted_at: '2026-04-30T08:00:00.000Z',
  started_at: null,
  completed_at: null,
  submitted_by_user_id: 'usr_import_ops',
  row_count: 4,
  error_count: 0,
  error_summary: null,
  correlation_id: 'cor_import_queued',
};

const failedImportJob = {
  id: 'imp_2026_04_30_005',
  organization_id: 'org_rashed',
  kind: 'shipments',
  source: 'csv',
  status: 'failed',
  submitted_at: '2026-04-30T09:00:00.000Z',
  started_at: '2026-04-30T09:01:00.000Z',
  completed_at: '2026-04-30T09:03:00.000Z',
  submitted_by_user_id: 'usr_import_ops',
  row_count: 8,
  error_count: 2,
  error_summary: {
    csv_header_missing: {
      required: ['tracking_number'],
      row_count: 8,
    },
  },
  correlation_id: 'cor_import_failed',
};

function mockImportJobRows() {
  const realList = api.ui_list_resource_v1;
  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
    async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'import_jobs') {
        return { rows: [queuedImportJob, failedImportJob], total: 2 };
      }
      if (resource === 'import_job_directory') {
        return {
          rows: [
            {
              id: queuedImportJob.id,
              tenant_label: 'Rashed Logistics',
              submitted_by_label: 'Import Operator',
              submitted_by_email: 'imports@example.test',
              row_count_value: 4,
              error_count_value: 0,
              is_terminal: false,
              is_active: true,
              is_failed: false,
              has_errors: false,
              duration_seconds: null,
              queue_wait_seconds: 30,
              age_seconds: 120,
              error_summary_count: 0,
            },
            {
              id: failedImportJob.id,
              tenant_label: 'Rashed Logistics',
              submitted_by_label: 'Import Operator',
              submitted_by_email: 'imports@example.test',
              row_count_value: 8,
              error_count_value: 2,
              is_terminal: true,
              is_active: false,
              is_failed: true,
              has_errors: true,
              duration_seconds: 120,
              queue_wait_seconds: 60,
              age_seconds: 360,
              error_summary_count: 1,
            },
          ],
          total: 2,
        };
      }
      return realList(resource, opts);
    },
  );
}

function mockTabularImportRunReadback(runId: string, overrides: Record<string, unknown> = {}) {
  const realGet = api.ui_get_resource_v1;
  vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
    async (resource: string, id: string) => {
      if (resource === 'tabular_import_runs' && id === runId) {
        return {
          id,
          resource_key: 'shipments',
          relation_name: 'shipments',
          write_mode: 'create',
          status: 'queued',
          source_format: 'csv',
          source_file_name: 'shipments.csv',
          total_rows: 1,
          rows: [],
          ...overrides,
        };
      }
      return realGet(resource, id);
    },
  );
}

describe('ImportsModule (W16-5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const realGetLookups = api.getLookups;
    const realLookupRow = api.lookupRow;
    vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
      IMPORT_TEST_LOOKUPS[category] ?? realGetLookups(category),
    );
    vi.spyOn(api, 'lookupRow').mockImplementation((category: string, value: string) =>
      IMPORT_TEST_LOOKUPS[category]?.find((row) => row.value === value) ?? realLookupRow(category, value),
    );
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. mount + KPI strip
  it('mounts the page header + KPI strip when granted imports.read', async () => {
    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_CAPS,
    });
    expect(await screen.findByTestId('imports-page')).toBeInTheDocument();
    const kpi = await screen.findByTestId('imports-kpi-strip');
    expect(kpi).toBeInTheDocument();
    // KPI labels are visible (KPI strip has 5 cards).
    expect(within(kpi).getByText(/^Total imports$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Queued$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Running$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Completed today$/i)).toBeInTheDocument();
    expect(within(kpi).getByText(/^Failed today$/i)).toBeInTheDocument();
  });

  it('reads import jobs and import job directory through the active tenant lens', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'import_jobs',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'import_job_directory',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'tabular_import_runs',
        expect.objectContaining({ filter: { organization_id: 'org_rashed' } }),
      );
    });
    listSpy.mockRestore();
  });

  it('renders file import runs from tabular_import_runs and opens a domain drawer', async () => {
    const user = userEvent.setup();
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'tabular_import_runs') {
          return {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000901',
                organization_id: 'org_rashed',
                resource_key: 'shipments',
                relation_name: 'shipments',
                write_mode: 'create',
                status: 'queued',
                source_format: 'csv',
                source_file_name: 'shipments-import.csv',
                total_rows: 2,
                will_create: 2,
                will_update: 0,
                will_skip: 0,
                blocked_count: 0,
                warning_count: 0,
                created_count: 1,
                updated_count: 0,
                skipped_count: 0,
                failed_count: 0,
                task_id: '00000000-0000-4000-8000-000000000902',
                mapping_config_id: '00000000-0000-4000-8000-000000000903',
                profile_name: 'Daily shipments',
                created_at: '2026-05-09T08:00:00.000Z',
                updated_at: '2026-05-09T08:01:00.000Z',
              },
            ],
            total: 1,
          };
        }
        if (resource === 'shipment_directory') {
          return {
            rows: [
              {
                id: 'shp_import_1',
                tracking_number: 'MX-IMPORT-1',
                client_label: 'Scope Client',
                sender_label: 'Scope Sender',
                recipient_label: 'Jane Import',
                destination_city: 'Riyadh',
                label_count: 0,
              },
            ],
            total: 1,
          };
        }
        if (resource === 'label_jobs') {
          return { rows: [], total: 0 };
        }
        return realList(resource, opts);
      },
    );
    const realGet = api.ui_get_resource_v1;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
      async (resource: string, id: string) => {
        if (resource === 'tabular_import_runs' && id === '00000000-0000-4000-8000-000000000901') {
          return {
            id,
            organization_id: 'org_rashed',
            resource_key: 'shipments',
            relation_name: 'shipments',
            write_mode: 'create',
            status: 'completed',
            source_format: 'csv',
            source_file_name: 'shipments-import.csv',
            total_rows: 2,
            will_create: 2,
            will_update: 0,
            will_skip: 0,
            blocked_count: 0,
            warning_count: 1,
            created_count: 1,
            updated_count: 0,
            skipped_count: 0,
            failed_count: 0,
            task_id: '00000000-0000-4000-8000-000000000902',
            mapping_config_id: '00000000-0000-4000-8000-000000000903',
            report_id: '00000000-0000-4000-8000-000000000904',
            profile_name: 'Daily shipments',
            created_at: '2026-05-09T08:00:00.000Z',
            updated_at: '2026-05-09T08:01:00.000Z',
            summary: {
              rule_source: 'manual',
              resolved_rules: [
                { source_column: 'recipient_name', target_field: 'recipient.name' },
              ],
            },
            rows: [
              {
                row_number: 1,
                action: 'create',
                execution_status: 'succeeded',
                target_record_id: 'shp_import_1',
                workflow_run_id: 'wfr_import_901',
                workflow_status: 'completed',
                primary_result: {
                  workflow_run_id: 'wfr_import_901',
                  workflow_status: 'completed',
                  workflow_template_id: 'tpl_shipment_manual_create',
                },
                diagnostics: [
                  { level: 'warn', code: 'address_geocode_pending', message: 'Geocoding will run after import.' },
                ],
                related_nodes: [
                  {
                    node_key: 'recipient',
                    node_label: 'Recipient',
                    target_resource: 'recipients',
                    target_label: 'Recipient',
                    target_record_id: 'rcp_import_1',
                    execution_status: 'succeeded',
                  },
                  {
                    node_key: 'destination_address',
                    node_label: 'Destination address',
                    target_resource: 'addresses',
                    target_label: 'Address',
                    target_record_id: 'addr_import_1',
                    execution_status: 'succeeded',
                  },
                ],
              },
            ],
            report: {
              id: '00000000-0000-4000-8000-000000000904',
              result_payload: {
                created_count: 1,
                failed_count: 0,
              },
            },
          };
        }
        if (resource === 'shipments' && id === 'shp_import_1') {
          return {
            id,
            tracking_number: 'MX-IMPORT-1',
            client_reference_number: 'IMP-REF-1',
            carrier_reference_number: null,
            status: 'created',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            promised_delivery_date: null,
            destination_city: 'Riyadh',
          };
        }
        return realGet(resource, id);
      },
    );
    const realComplete = api.ui_list_resource_complete;
    const completeSpy = vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'workflow_run_directory') {
          return {
            rows: [
              {
                id: 'wfr_import_901',
                workflow_status: 'completed',
                template_name: 'shipment_manual_create_v1',
                correlation_id: 'cor_import_901',
              },
            ],
            total: 1,
            page: 0,
            page_size: 1,
          };
        }
        if (resource === 'domain_events') {
          return {
            rows: [
              {
                id: 'evt_import_901',
                event_type: 'shipment.created',
                resource_type: 'shipment',
                resource_id: 'shp_import_1',
                workflow_run_id: 'wfr_import_901',
                correlation_id: 'cor_import_901',
              },
            ],
            total: 1,
            page: 0,
            page_size: 1,
          };
        }
        return realComplete(resource, opts);
      },
    );

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_WORKFLOW_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    const tableWrap = await screen.findByTestId('imports-file-runs-table-wrap');
    expect(within(tableWrap).getByText('shipments-import.csv')).toBeInTheDocument();

    fireEvent.click(within(tableWrap).getByText('shipments-import.csv').closest('tr')!);
    const drawer = await screen.findByTestId('imports-file-run-drawer');
    expect(within(drawer).getByText(/^File import run$/)).toBeInTheDocument();
    expect(within(drawer).getByText(/^Mapping profile$/)).toBeInTheDocument();
    expect(within(drawer).getByText('Daily shipments')).toBeInTheDocument();
    expect(await screen.findByTestId('imports-file-run-readback')).toHaveTextContent(/Run details loaded/i);
    expect(within(drawer).getByText(/^Will create$/)).toBeInTheDocument();
    const handoff = await screen.findByTestId('imports-file-run-handoff');
    expect(within(handoff).getByText('shp_import_1')).toBeInTheDocument();
    expect(within(handoff).getByText('rcp_import_1')).toBeInTheDocument();
    expect(within(handoff).getByText('addr_import_1')).toBeInTheDocument();
    expect(within(handoff).getByText('wfr_import_901')).toBeInTheDocument();
    expect(within(handoff).getByText('completed')).toBeInTheDocument();
    expect(within(drawer).getByTestId('imports-file-run-diagnostics').textContent).toMatch(/Geocoding will run after import/);
    expect(within(drawer).getByTestId('imports-file-run-summary').textContent).toMatch(/Resolved Rules/);
    expect(within(drawer).getByTestId('imports-file-run-report').textContent).toMatch(/Result Payload/);
    await user.click(
      within(handoff).getByRole('button', { name: /^Open shipment context shp_import_1$/i }),
    );
    expect(await screen.findByText('MX-IMPORT-1')).toBeInTheDocument();

    fireEvent.click(within(tableWrap).getByText('shipments-import.csv').closest('tr')!);
    const reopenedDrawer = await screen.findByTestId('imports-file-run-drawer');
    const reopenedHandoff = await within(reopenedDrawer).findByTestId('imports-file-run-handoff');
    await user.click(
      within(reopenedHandoff).getByRole('button', { name: /^Open import workflow context wfr_import_901$/i }),
    );
    expect(await screen.findByText('Workflow run context')).toBeInTheDocument();
    expect(await screen.findByText('shipment_manual_create_v1')).toBeInTheDocument();
    expect(await screen.findByText('shipment.created')).toBeInTheDocument();
    expect(completeSpy).toHaveBeenCalledWith(
      'workflow_run_directory',
      expect.objectContaining({ filter: { id: 'wfr_import_901' } }),
    );
    expect(completeSpy).toHaveBeenCalledWith(
      'domain_events',
      expect.objectContaining({ filter: { workflow_run_id: 'wfr_import_901' } }),
    );
  });

  it('refreshes active started file runs until shipment handoff appears without reload', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000912';
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        intervalCallbacks.push(() => {
          handler();
        });
      }
      return intervalCallbacks.length as unknown as ReturnType<typeof window.setInterval>;
    }) as unknown as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);

    const realList = api.ui_list_resource_v1;
    let listRunCalls = 0;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'tabular_import_runs') {
          listRunCalls += 1;
          const completed = listRunCalls > 1;
          return {
            rows: [
              {
                id: runId,
                organization_id: 'org_rashed',
                resource_key: 'shipments',
                relation_name: 'shipments',
                write_mode: 'create',
                status: completed ? 'completed' : 'queued',
                source_format: 'csv',
                source_file_name: 'async-shipments.csv',
                total_rows: 1,
                will_create: 1,
                will_update: 0,
                will_skip: 0,
                blocked_count: 0,
                warning_count: 0,
                created_count: completed ? 1 : 0,
                updated_count: 0,
                skipped_count: 0,
                failed_count: 0,
                task_id: '00000000-0000-4000-8000-000000000913',
                started_at: '2026-05-12T10:00:00.000Z',
                completed_at: completed ? '2026-05-12T10:00:05.000Z' : null,
                created_at: '2026-05-12T09:59:00.000Z',
                updated_at: completed ? '2026-05-12T10:00:05.000Z' : '2026-05-12T10:00:00.000Z',
              },
            ],
            total: 1,
          };
        }
        if (resource === 'import_jobs' || resource === 'import_job_directory') {
          return { rows: [], total: 0 };
        }
        if (resource === 'shipment_directory') {
          return {
            rows: [
              {
                id: 'shp_import_async',
                tracking_number: 'MX-IMPORT-ASYNC',
                client_label: 'Scope Client',
                sender_label: 'Scope Sender',
                recipient_label: 'Async Import',
                destination_city: 'Riyadh',
                label_count: 0,
              },
            ],
            total: 1,
          };
        }
        if (resource === 'label_jobs') {
          return { rows: [], total: 0 };
        }
        return realList(resource, opts);
      },
    );

    const realGet = api.ui_get_resource_v1;
    let getRunCalls = 0;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
      async (resource: string, id: string) => {
        if (resource === 'tabular_import_runs' && id === runId) {
          getRunCalls += 1;
          const completed = getRunCalls > 1;
          return {
            id,
            organization_id: 'org_rashed',
            resource_key: 'shipments',
            relation_name: 'shipments',
            write_mode: 'create',
            status: completed ? 'completed' : 'queued',
            source_format: 'csv',
            source_file_name: 'async-shipments.csv',
            total_rows: 1,
            will_create: 1,
            will_update: 0,
            will_skip: 0,
            blocked_count: 0,
            warning_count: 0,
            created_count: completed ? 1 : 0,
            updated_count: 0,
            skipped_count: 0,
            failed_count: 0,
            task_id: '00000000-0000-4000-8000-000000000913',
            started_at: '2026-05-12T10:00:00.000Z',
            completed_at: completed ? '2026-05-12T10:00:05.000Z' : null,
            created_at: '2026-05-12T09:59:00.000Z',
            updated_at: completed ? '2026-05-12T10:00:05.000Z' : '2026-05-12T10:00:00.000Z',
            rows: completed
              ? [
                  {
                    row_number: 1,
                    action: 'create',
                    execution_status: 'succeeded',
                    target_record_id: 'shp_import_async',
                    related_nodes: [
                      {
                        node_key: 'recipient',
                        node_label: 'Recipient',
                        target_resource: 'recipients',
                        target_label: 'Recipient',
                        target_record_id: 'rcp_import_async',
                        execution_status: 'succeeded',
                      },
                      {
                        node_key: 'destination_address',
                        node_label: 'Destination address',
                        target_resource: 'addresses',
                        target_label: 'Address',
                        target_record_id: 'addr_import_async',
                        execution_status: 'succeeded',
                      },
                    ],
                  },
                ]
              : [],
          };
        }
        if (resource === 'shipments' && id === 'shp_import_async') {
          return {
            id,
            tracking_number: 'MX-IMPORT-ASYNC',
            status: 'created',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            destination_city: 'Riyadh',
          };
        }
        return realGet(resource, id);
      },
    );

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    const tableWrap = await screen.findByTestId('imports-file-runs-table-wrap');
    await user.click(within(tableWrap).getByText('async-shipments.csv').closest('tr')!);
    const drawer = await screen.findByTestId('imports-file-run-drawer');
    expect(await screen.findByTestId('imports-file-run-live-watch')).toHaveTextContent(/refresh automatically/i);
    expect(within(drawer).queryByTestId('imports-file-run-handoff')).not.toBeInTheDocument();

    await waitFor(() => expect(intervalCallbacks.length).toBeGreaterThan(0));
    await act(async () => {
      for (const callback of intervalCallbacks) callback();
    });

    await waitFor(() => expect(getRunCalls).toBeGreaterThan(1));

    const handoff = await screen.findByTestId('imports-file-run-handoff');
    expect(within(handoff).getByText('shp_import_async')).toBeInTheDocument();
    expect(within(handoff).getByText('rcp_import_async')).toBeInTheDocument();
    expect(within(handoff).getByText('addr_import_async')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('imports-file-run-live-watch')).not.toBeInTheDocument());
    await waitFor(() => expect(listRunCalls).toBeGreaterThan(1));

    await user.click(
      within(handoff).getByRole('button', { name: /^Open shipment context shp_import_async$/i }),
    );
    expect(await screen.findByText('MX-IMPORT-ASYNC')).toBeInTheDocument();
  });

  it('renders completed shipment handoff from backend summary row preview readback', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000914';
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'tabular_import_runs') {
          return {
            rows: [
              {
                id: runId,
                organization_id: 'org_rashed',
                resource_key: 'shipments',
                relation_name: 'shipments',
                write_mode: 'create',
                status: 'completed',
                source_format: 'csv',
                source_file_name: 'summary-handoff.csv',
                total_rows: 1,
                will_create: 1,
                will_update: 0,
                will_skip: 0,
                blocked_count: 0,
                warning_count: 0,
                created_count: 1,
                updated_count: 0,
                skipped_count: 0,
                failed_count: 0,
                created_at: '2026-05-12T10:00:00.000Z',
                updated_at: '2026-05-12T10:00:05.000Z',
              },
            ],
            total: 1,
          };
        }
        if (resource === 'shipment_directory') {
          return {
            rows: [
              {
                id: 'shp_summary_import_1',
                tracking_number: 'MX-SUMMARY-IMPORT-1',
                client_label: 'Scope Client',
                sender_label: 'Scope Sender',
                recipient_label: 'Summary Import Recipient',
                destination_city: 'Riyadh',
                label_count: 0,
              },
            ],
            total: 1,
          };
        }
        if (resource === 'label_jobs') {
          return { rows: [], total: 0 };
        }
        return realList(resource, opts);
      },
    );

    const realGet = api.ui_get_resource_v1;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
      async (resource: string, id: string) => {
        if (resource === 'tabular_import_runs' && id === runId) {
          return {
            id,
            organization_id: 'org_rashed',
            resource_key: 'shipments',
            relation_name: 'shipments',
            write_mode: 'create',
            status: 'completed',
            source_format: 'csv',
            source_file_name: 'summary-handoff.csv',
            total_rows: 1,
            will_create: 1,
            will_update: 0,
            will_skip: 0,
            blocked_count: 0,
            warning_count: 0,
            created_count: 1,
            updated_count: 0,
            skipped_count: 0,
            failed_count: 0,
            summary: {
              rows_preview: [
                {
                  row_number: 1,
                  action: 'create',
                  execution_status: 'succeeded',
                  target_record_id: 'shp_summary_import_1',
                  related_nodes: [
                    {
                      node_key: 'recipient',
                      node_label: 'Recipient',
                      target_resource: 'recipients',
                      target_label: 'Recipient',
                      target_record_id: 'rcp_summary_import_1',
                      execution_status: 'succeeded',
                    },
                    {
                      node_key: 'destination_address',
                      node_label: 'Destination address',
                      target_resource: 'addresses',
                      target_label: 'Address',
                      target_record_id: 'addr_summary_import_1',
                      execution_status: 'succeeded',
                    },
                  ],
                },
              ],
            },
            created_at: '2026-05-12T10:00:00.000Z',
            updated_at: '2026-05-12T10:00:05.000Z',
          };
        }
        if (resource === 'shipments' && id === 'shp_summary_import_1') {
          return {
            id,
            tracking_number: 'MX-SUMMARY-IMPORT-1',
            client_reference_number: 'SUMMARY-REF-1',
            status: 'created',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            destination_city: 'Riyadh',
          };
        }
        return realGet(resource, id);
      },
    );

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    const tableWrap = await screen.findByTestId('imports-file-runs-table-wrap');
    await user.click(within(tableWrap).getByText('summary-handoff.csv').closest('tr')!);
    const drawer = await screen.findByTestId('imports-file-run-drawer');
    expect(
      within(drawer).queryByText('No shipment, recipient, or address handoff records are available yet.'),
    ).not.toBeInTheDocument();

    const handoff = await screen.findByTestId('imports-file-run-handoff');
    expect(within(handoff).getByText('shp_summary_import_1')).toBeInTheDocument();
    expect(within(handoff).getByText('rcp_summary_import_1')).toBeInTheDocument();
    expect(within(handoff).getByText('addr_summary_import_1')).toBeInTheDocument();

    await user.click(
      within(handoff).getByRole('button', { name: /^Open shipment context shp_summary_import_1$/i }),
    );
    expect(await screen.findByText('MX-SUMMARY-IMPORT-1')).toBeInTheDocument();
  });

  it('keeps mixed partial-success shipment handoff and failed row diagnostics separated', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000915';
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'tabular_import_runs') {
          return {
            rows: [
              {
                id: runId,
                organization_id: 'org_rashed',
                resource_key: 'shipments',
                relation_name: 'shipments',
                write_mode: 'create',
                status: 'completed_with_errors',
                source_format: 'csv',
                source_file_name: 'partial-shipments.csv',
                total_rows: 2,
                will_create: 2,
                will_update: 0,
                will_skip: 0,
                blocked_count: 0,
                warning_count: 0,
                created_count: 1,
                updated_count: 0,
                skipped_count: 0,
                failed_count: 1,
                completed_at: '2026-06-06T09:00:00.000Z',
                created_at: '2026-06-06T08:59:00.000Z',
                updated_at: '2026-06-06T09:00:00.000Z',
              },
            ],
            total: 1,
          };
        }
        if (resource === 'shipment_directory') {
          return {
            rows: [
              {
                id: 'shp_partial_success_1',
                tracking_number: 'MX-PARTIAL-1',
                client_label: 'Scope Client',
                sender_label: 'Scope Sender',
                recipient_label: 'Partial Success Recipient',
                destination_city: 'Riyadh',
                label_count: 0,
              },
            ],
            total: 1,
          };
        }
        if (resource === 'label_jobs') {
          return { rows: [], total: 0 };
        }
        return realList(resource, opts);
      },
    );

    const realGet = api.ui_get_resource_v1;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
      async (resource: string, id: string) => {
        if (resource === 'tabular_import_runs' && id === runId) {
          return {
            id,
            organization_id: 'org_rashed',
            resource_key: 'shipments',
            relation_name: 'shipments',
            write_mode: 'create',
            status: 'completed_with_errors',
            source_format: 'csv',
            source_file_name: 'partial-shipments.csv',
            total_rows: 2,
            will_create: 2,
            will_update: 0,
            will_skip: 0,
            blocked_count: 0,
            warning_count: 0,
            created_count: 1,
            updated_count: 0,
            skipped_count: 0,
            failed_count: 1,
            rows: [
              {
                row_number: 1,
                action: 'create',
                execution_status: 'succeeded',
                target_record_id: 'shp_partial_success_1',
                workflow_run_id: 'wfr_partial_success_1',
                workflow_status: 'completed',
                related_nodes: [
                  {
                    node_key: 'recipient',
                    node_label: 'Recipient',
                    target_resource: 'recipients',
                    target_label: 'Recipient',
                    target_record_id: 'rcp_partial_success_1',
                    execution_status: 'succeeded',
                  },
                ],
              },
              {
                row_number: 2,
                action: 'create',
                execution_status: 'failed',
                diagnostics: [
                  {
                    level: 'error',
                    code: 'recipient_phone_invalid',
                    message: 'Recipient phone is invalid for row 2.',
                  },
                ],
              },
            ],
            report: {
              result_payload: {
                created_count: 1,
                failed_count: 1,
              },
            },
            completed_at: '2026-06-06T09:00:00.000Z',
            created_at: '2026-06-06T08:59:00.000Z',
            updated_at: '2026-06-06T09:00:00.000Z',
          };
        }
        if (resource === 'shipments' && id === 'shp_partial_success_1') {
          return {
            id,
            tracking_number: 'MX-PARTIAL-1',
            status: 'created',
            service_type: 'standard',
            cod_amount: 0,
            cod_currency: 'SAR',
            destination_city: 'Riyadh',
          };
        }
        return realGet(resource, id);
      },
    );

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    const tableWrap = await screen.findByTestId('imports-file-runs-table-wrap');
    await user.click(within(tableWrap).getByText('partial-shipments.csv').closest('tr')!);
    const drawer = await screen.findByTestId('imports-file-run-drawer');

    const outcome = await within(drawer).findByTestId('imports-file-run-outcome');
    expect(outcome).toHaveTextContent('Partial import summary');
    expect(outcome).toHaveTextContent('Created 1, updated 0, skipped 0, failed 1, blocked 0');
    expect(outcome).toHaveTextContent(
      'Successful shipment handoff rows and failed row diagnostics are shown separately in this import summary.',
    );

    const handoff = await within(drawer).findByTestId('imports-file-run-handoff');
    expect(within(handoff).getByText('shp_partial_success_1')).toBeInTheDocument();
    expect(within(handoff).getByText('rcp_partial_success_1')).toBeInTheDocument();
    expect(within(handoff).queryByText('recipient_phone_invalid')).not.toBeInTheDocument();
    expect(within(drawer).getByTestId('imports-file-run-diagnostics')).toHaveTextContent(
      'Recipient phone is invalid for row 2.',
    );

    await user.click(
      within(handoff).getByRole('button', { name: /^Open shipment context shp_partial_success_1$/i }),
    );
    expect(await screen.findByText('MX-PARTIAL-1')).toBeInTheDocument();
  });

  it('cancels a cancellable file import run and refreshes drawer readback without reload', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000911';
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'tabular_import_runs') {
          return {
            rows: [
              {
                id: runId,
                organization_id: 'org_rashed',
                resource_key: 'shipments',
                relation_name: 'shipments',
                write_mode: 'create',
                status: 'queued',
                source_format: 'csv',
                source_file_name: 'cancel-me.csv',
                total_rows: 4,
                will_create: 4,
                will_update: 0,
                will_skip: 0,
                created_at: '2026-05-09T08:00:00.000Z',
                updated_at: '2026-05-09T08:01:00.000Z',
              },
            ],
            total: 1,
          };
        }
        return realList(resource, opts);
      },
    );

    const realGet = api.ui_get_resource_v1;
    let getRunCalls = 0;
    vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(
      async (resource: string, id: string) => {
        if (resource === 'tabular_import_runs' && id === runId) {
          getRunCalls += 1;
          return {
            id,
            organization_id: 'org_rashed',
            resource_key: 'shipments',
            relation_name: 'shipments',
            write_mode: 'create',
            status: getRunCalls > 1 ? 'canceled' : 'queued',
            source_format: 'csv',
            source_file_name: 'cancel-me.csv',
            total_rows: 4,
            will_create: 4,
            will_update: 0,
            will_skip: 0,
            summary: getRunCalls > 1 ? {
              cancellation: {
                reason: 'operator confirmed duplicate file run',
                canceled_at: '2026-05-09T08:02:00.000Z',
              },
              cancel_reason: 'operator confirmed duplicate file run',
            } : {},
            created_at: '2026-05-09T08:00:00.000Z',
            updated_at: '2026-05-09T08:01:00.000Z',
          };
        }
        return realGet(resource, id);
      },
    );
    const cancelSpy = vi.spyOn(api, 'resource_import_studio_cancel_v1').mockResolvedValue({
      ok: true,
      run: {
        id: runId,
        status: 'canceled',
        canceled_at: '2026-05-09T08:02:00.000Z',
        completed_at: '2026-05-09T08:02:00.000Z',
        summary: {
          cancellation: {
            reason: 'operator confirmed duplicate file run',
            canceled_at: '2026-05-09T08:02:00.000Z',
          },
          cancel_reason: 'operator confirmed duplicate file run',
        },
      },
      correlation_id: 'cor_cancel_file_run',
    });

    const { queryClient } = renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');

    const tableWrap = await screen.findByTestId('imports-file-runs-table-wrap');
    await user.click(within(tableWrap).getByText('cancel-me.csv').closest('tr')!);

    const drawer = await screen.findByTestId('imports-file-run-drawer');
    expect(within(drawer).getByText('Queued')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /^Retry/i })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /^Cancel run$/i }));

    const modal = await screen.findByTestId('imports-cancel-modal');
    expect(within(modal).getByText(runId)).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: /^Confirm cancellation$/i })).toBeDisabled();
    await user.type(
      within(modal).getByLabelText(/^Cancellation reason$/i),
      'operator confirmed duplicate file run',
    );
    await user.click(within(modal).getByRole('button', { name: /^Confirm cancellation$/i }));

    await waitFor(() =>
      expect(cancelSpy).toHaveBeenCalledWith({
        run_id: runId,
        reason: 'operator confirmed duplicate file run',
      }),
    );
    expect(await screen.findByTestId('imports-file-run-cancel-readback')).toHaveTextContent(
      /Cancel confirmed with status canceled/i,
    );
    await waitFor(() => expect(within(drawer).getByText('Canceled')).toBeInTheDocument());
    expect(within(drawer).getAllByText('operator confirmed duplicate file run').length).toBeGreaterThan(0);
    expect(await screen.findByTestId('imports-file-run-terminal-guard')).toHaveTextContent(
      /Terminal file runs cannot be changed/i,
    );
    expect(within(drawer).queryByRole('button', { name: /^Retry/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /^Reopen/i })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        type: 'active',
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], refetchType: 'active' }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], type: 'active' }),
    );
    expect(getRunCalls).toBeGreaterThanOrEqual(2);
  });

  // 2. capability gate (negative)
  it('shows denied state when imports.read is missing (capability gate negative)', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<ImportsModule />, { capabilities: [] });
    expect(
      await screen.findByText(/Import jobs management requires import access permission/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('import_jobs');
      expect(resources).not.toContain('import_job_directory');
      expect(resources).not.toContain('tabular_import_runs');
    });
    listSpy.mockRestore();
  });

  it('denies file import run reads and upload actions when mappings.read is missing', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<ImportsModule />, {
      capabilities: ['imports.read', 'imports.write', 'mappings.write'],
    });

    expect(await screen.findByText(/File import run history requires mapping read permission/i)).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).toContain('import_jobs');
      expect(resources).toContain('import_job_directory');
      expect(resources).not.toContain('tabular_import_runs');
    });
    const uploadButton = screen.getByRole('button', { name: /Upload file/i });
    expect(uploadButton).toBeDisabled();
    expect(within(uploadButton).getByText(/Mappings Read permission required/i)).toBeInTheDocument();
    await user.click(uploadButton);
    expect(screen.queryByTestId('imports-submit-modal')).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  it('shows a read-error state when the backend import_jobs read fails', async () => {
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'import_jobs') {
          throw new Error('backend unavailable');
        }
        return realList(resource, opts);
      },
    );

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    expect(await screen.findByText(/Import jobs unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/This section could not load\. Please try again or contact an administrator\./i)).toBeInTheDocument();
    expect(screen.queryByText(/backend unavailable/i)).not.toBeInTheDocument();
  });

  // 3. happy submit
  it('Submit modal Submit button calls import_job_create_v1 and opens backend-readback drawer without reload', async () => {
    const user = userEvent.setup();
    let includeCreatedJob = false;
    const createdJob = {
      id: 'imp_test_001',
      organization_id: 'org_rashed',
      kind: 'shipments',
      source: 'api',
      status: 'queued',
      submitted_at: '2026-05-12T08:00:00.000Z',
      started_at: null,
      completed_at: null,
      submitted_by_user_id: 'usr_import_ops',
      row_count: 0,
      error_count: 0,
      error_summary: null,
      correlation_id: 'cor_x',
    };
    const createdDirectory = {
      id: 'imp_test_001',
      tenant_label: 'Rashed Logistics',
      submitted_by_label: 'Import Operator',
      row_count_value: 0,
      error_count_value: 0,
      is_terminal: false,
      is_active: true,
      is_failed: false,
      has_errors: false,
      duration_seconds: null,
      queue_wait_seconds: 0,
      age_seconds: 0,
      error_summary_count: 0,
    };
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'import_jobs') {
        return { rows: includeCreatedJob ? [createdJob] : [], total: includeCreatedJob ? 1 : 0 };
      }
      if (resource === 'import_job_directory') {
        return { rows: includeCreatedJob ? [createdDirectory] : [], total: includeCreatedJob ? 1 : 0 };
      }
      if (resource === 'tabular_import_runs') {
        return { rows: [], total: 0 };
      }
      return realList(resource, opts);
    });
    const spy = vi.spyOn(api, 'import_job_create_v1').mockImplementation(async () => {
      includeCreatedJob = true;
      return {
      ok: true,
      import_job_id: 'imp_test_001',
      status: 'queued',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
      };
    });
    const readbackSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (resource === 'import_jobs' && id === 'imp_test_001') {
        return createdJob as never;
      }
      if (resource === 'import_job_directory' && id === 'imp_test_001') {
        return createdDirectory as never;
      }
      return null;
    });
    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    // Open the Submit modal via the page-header "New import" button.
    const newBtn = await screen.findByRole('button', { name: /^New import/i });
    await user.click(newBtn);
    const modalBody = await screen.findByTestId('imports-submit-modal');
    expect(modalBody).toBeInTheDocument();
    // Submit with default kind=shipments; direct submit excludes file_upload
    // because files must prepare through resource-import-studio first.
    const submitBtn = screen.getByRole('button', { name: /^Submit$/i });
    await user.click(submitBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      kind: 'shipments',
      source: 'api',
      organization_id: 'org_rashed',
    });
    expect(readbackSpy).toHaveBeenCalledWith('import_jobs', 'imp_test_001');
    expect(readbackSpy).toHaveBeenCalledWith('import_job_directory', 'imp_test_001');
    const drawer = await screen.findByTestId('imports-job-drawer');
    expect(within(drawer).getByText('Job reference')).toBeInTheDocument();
    expect(within(drawer).getAllByText('Recorded').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Import Operator')).toBeInTheDocument();
    expect(within(drawer).getByText('Queued')).toBeInTheDocument();
    const table = await screen.findByTestId('imports-table-wrap');
    expect(table.querySelector('[aria-label="Open import_jobs imp_test_001"]')).toBeInTheDocument();
    expect(within(table).getByText('Shipments')).toBeInTheDocument();
    expect(within(table).getByText('API')).toBeInTheDocument();
    expect(within(table).getByText('Queued')).toBeInTheDocument();
  });

  it('Submit modal keeps the operator in place when submitted import readback is missing', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'import_job_create_v1').mockResolvedValue({
      ok: true,
      import_job_id: 'imp_missing_readback',
      status: 'queued',
      correlation_id: 'cor_missing',
      settings_resolution_id: 'srlv_missing',
    });
    vi.spyOn(api, 'ui_get_resource_v1').mockResolvedValue(null);
    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    await user.click(await screen.findByRole('button', { name: /^New import/i }));
    expect(await screen.findByTestId('imports-submit-modal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Submit$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('imports-submit-modal')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('imports-job-drawer')).not.toBeInTheDocument();
  });

  // 4. happy cancel via drawer
  it('Drawer Cancel button requires operator reason and refreshes cancelled readback in the same drawer', async () => {
    const user = userEvent.setup();
    let cancelled = false;
    const cancelledReason = 'operator confirmed duplicate file';
    const cancelledJob = {
      ...queuedImportJob,
      status: 'cancelled',
      completed_at: '2026-04-30T08:05:00.000Z',
      cancelled_reason: cancelledReason,
      correlation_id: 'cor_import_cancelled',
    };
    const queuedDirectory = {
      id: queuedImportJob.id,
      tenant_label: 'Rashed Logistics',
      submitted_by_label: 'Import Operator',
      submitted_by_email: 'imports@example.test',
      row_count_value: 4,
      error_count_value: 0,
      is_terminal: false,
      is_active: true,
      is_failed: false,
      has_errors: false,
      duration_seconds: null,
      queue_wait_seconds: 30,
      age_seconds: 120,
      error_summary_count: 0,
    };
    const cancelledDirectory = {
      ...queuedDirectory,
      is_terminal: true,
      is_active: false,
      duration_seconds: 300,
      age_seconds: 300,
    };
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'import_jobs') {
        return { rows: [cancelled ? cancelledJob : queuedImportJob], total: 1 };
      }
      if (resource === 'import_job_directory') {
        return { rows: [cancelled ? cancelledDirectory : queuedDirectory], total: 1 };
      }
      if (resource === 'tabular_import_runs') {
        return { rows: [], total: 0 };
      }
      return realList(resource, opts);
    });
    const readbackSpy = vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
      if (id === queuedImportJob.id && resource === 'import_jobs') {
        return (cancelled ? cancelledJob : queuedImportJob) as never;
      }
      if (id === queuedImportJob.id && resource === 'import_job_directory') {
        return (cancelled ? cancelledDirectory : queuedDirectory) as never;
      }
      return null;
    });
    const spy = vi.spyOn(api, 'import_job_cancel_v1').mockImplementation(async () => {
      cancelled = true;
      return {
        ok: true,
        import_job_id: queuedImportJob.id,
        status: 'cancelled',
        correlation_id: 'cor_x',
        settings_resolution_id: 'srlv_x',
      };
    });
    const { queryClient } = renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_CAPS,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');
    // The seeded queued job (imp_2026_04_30_004) is the only kind=senders
    // row and the only row with status=Queued; both render as lookup-chip
    // labels in the DataTable, so we can find it deterministically by the
    // unique "Senders" cell text.
    const sendersCell = await screen.findByText('Senders');
    const queuedRow = sendersCell.closest('tr')!;
    await user.click(queuedRow);
    const drawer = await screen.findByTestId('imports-job-drawer');
    expect(drawer).toBeInTheDocument();
    // Drawer footer has the "Cancel job" button (not in drawer body; drawers
    // render the footer outside the body div).
    const cancelBtn = await screen.findByRole('button', { name: /^Cancel job$/i });
    await user.click(cancelBtn);
    const modal = await screen.findByTestId('imports-cancel-modal');
    const confirm = within(modal).getByRole('button', { name: /^Confirm cancellation$/i });
    expect(confirm).toBeDisabled();
    await user.type(
      within(modal).getByLabelText(/^Cancellation reason$/i),
      'operator confirmed duplicate file',
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        import_job_id: queuedImportJob.id,
        reason: cancelledReason,
      }),
    );
    expect(readbackSpy).toHaveBeenCalledWith('import_jobs', queuedImportJob.id);
    expect(readbackSpy).toHaveBeenCalledWith('import_job_directory', queuedImportJob.id);
    await waitFor(() => expect(screen.queryByTestId('imports-cancel-modal')).not.toBeInTheDocument());
    const refreshedDrawer = await screen.findByTestId('imports-job-drawer');
    expect(within(refreshedDrawer).getByText('Cancelled')).toBeInTheDocument();
    expect(within(refreshedDrawer).getByText(cancelledReason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel job$/i })).not.toBeInTheDocument();
    const table = await screen.findByTestId('imports-table-wrap');
    expect(within(table).getByText('Cancelled')).toBeInTheDocument();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['list', 'import_job_directory'],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['list', 'import_job_directory'],
        type: 'active',
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'import_jobs', queuedImportJob.id],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'import_jobs', queuedImportJob.id],
        type: 'active',
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'import_job_directory', queuedImportJob.id],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'import_job_directory', queuedImportJob.id],
        type: 'active',
      }),
    );
  });

  it('does not expose Cancel job when backend status metadata is active but not cancellable', async () => {
    const user = userEvent.setup();
    const activeNonCancellableJob = {
      ...queuedImportJob,
      id: 'imp_2026_04_30_active_hold',
      status: 'active_hold',
      correlation_id: 'cor_import_active_hold',
    };
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: api.ListOpts) => {
      if (resource === 'import_jobs') {
        return { rows: [activeNonCancellableJob], total: 1 };
      }
      if (resource === 'import_job_directory') {
        return {
          rows: [
            {
              id: activeNonCancellableJob.id,
              tenant_label: 'Rashed Logistics',
              submitted_by_label: 'Import Operator',
              submitted_by_email: 'imports@example.test',
              row_count_value: 4,
              error_count_value: 0,
              is_terminal: false,
              is_active: true,
              is_failed: false,
              has_errors: false,
              duration_seconds: null,
              queue_wait_seconds: 30,
              age_seconds: 120,
              error_summary_count: 0,
            },
          ],
          total: 1,
        };
      }
      if (resource === 'tabular_import_runs') {
        return { rows: [], total: 0 };
      }
      return realList(resource, opts);
    });
    vi.spyOn(api, 'getLookups').mockImplementation((category: string) => {
      if (category === 'import_job_status') {
        return [
          ...IMPORT_TEST_LOOKUPS.import_job_status,
          {
            value: 'active_hold',
            label: 'Active hold',
            rank: 60,
            metadata: { is_active: true, is_cancellable: false },
          },
        ];
      }
      return IMPORT_TEST_LOOKUPS[category] ?? [];
    });
    vi.spyOn(api, 'lookupRow').mockImplementation((category: string, value: string) => {
      if (category === 'import_job_status' && value === 'active_hold') {
        return {
          value,
          label: 'Active hold',
          metadata: { is_active: true, is_cancellable: false },
        };
      }
      return IMPORT_TEST_LOOKUPS[category]?.find((row) => row.value === value) ?? null;
    });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_CAPS,
    });

    const activeHoldCell = await screen.findByText('Active hold');
    await user.click(activeHoldCell.closest('tr')!);
    const drawer = await screen.findByTestId('imports-job-drawer');
    expect(within(drawer).getByText('Active hold')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cancel job$/i })).not.toBeInTheDocument();
  });

  // 5. failure mode - completed job exposes error_summary jsonb
  it('renders error_summary jsonb pretty-print for failed jobs', async () => {
    const user = userEvent.setup();
    mockImportJobRows();
    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });
    // The seeded failed job (imp_2026_04_30_005) is the only row with
    // status=Failed (the lookup chip label is "Failed"). Find it via the
    // unique cell text.
    const failedCell = await screen.findByText('Failed');
    const failedRow = failedCell.closest('tr')!;
    await user.click(failedRow);
    const drawer = await screen.findByTestId('imports-job-drawer');
    const errPane = within(drawer).getByTestId('imports-job-error-summary');
    expect(errPane.textContent).toMatch(/Csv Header Missing/);
    expect(errPane.textContent).toMatch(/2 fields/);
  });

  // 6. New import is capability-gated
  it('disables "New import" when imports.write is missing (capability gate)', async () => {
    renderWithProviders(<ImportsModule />, { capabilities: ['imports.read'] });
    const newBtn = await screen.findByRole('button', { name: /^New import/i });
    expect(newBtn).toBeDisabled();
    // CapabilityLock chip should be appended inside the disabled button so
    // the operator can see why it's locked.
    expect(within(newBtn).getByText(/Import update permission required/i)).toBeInTheDocument();
  });

  it('disables file upload when mappings.write is missing (registry capability gate)', async () => {
    renderWithProviders(<ImportsModule />, {
      capabilities: ['imports.read', 'imports.write', 'mappings.read'],
    });

    const uploadBtn = await screen.findByRole('button', { name: /^Upload file/i });
    expect(uploadBtn).toBeDisabled();
    expect(within(uploadBtn).getByText(/Mappings Write permission required/i)).toBeInTheDocument();
  });

  // 7. W28 paired projection view consumption tests
  it('W28: renders the import job directory page-header pill', async () => {
    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_CAPS,
    });
    expect(await screen.findByText(/^Import job directory$/)).toBeInTheDocument();
  });

  it('W28: drawer KvGrid surfaces directory-derived rows (Tenant, Duration, Queue wait, Error entries)', async () => {
    const user = userEvent.setup();
    mockImportJobRows();
    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    // Open a completed job drawer (imp_2026_04_30_001; kind=Shipments,
    // first completed seed).
    const failedCell = await screen.findByText('Failed');
    const failedRow = failedCell.closest('tr')!;
    await user.click(failedRow);
    const drawer = await screen.findByTestId('imports-job-drawer');
    // KvRow labels for the W28 directory derivations.
    expect(within(drawer).getByText(/^Tenant$/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/^Duration$/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/^Queue wait$/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/^Error entries$/i)).toBeInTheDocument();
  });

  it('prepares and starts a CSV/XLS/XLSX file through resource-import-studio', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000123';
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [
        { source_column: 'tracking_number', target_field: 'tracking_number', enabled: true },
        { source_column: 'recipient_name', target_field: 'recipient.name', enabled: true, node_key: 'recipient' },
        {
          source_column: 'address_line_1',
          target_field: 'destination_address.raw_input',
          enabled: true,
          node_key: 'destination_address',
        },
      ],
      correlation_id: 'cor_prepare',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: {
        id: runId,
        status: 'queued',
        resource_key: 'shipments',
        source_file_name: 'shipments.csv',
        total_rows: 1,
        started_at: '2026-05-11T22:00:00.000Z',
      },
      report: null,
      correlation_id: 'cor_start',
    });
    mockTabularImportRunReadback(runId, {
      organization_id: 'org_rashed',
      will_create: 1,
      will_update: 0,
      will_skip: 0,
      blocked_count: 0,
      warning_count: 0,
      created_at: '2026-05-11T21:59:00.000Z',
      started_at: '2026-05-11T22:00:00.000Z',
    });
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);

    const { queryClient } = renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = csvImportFile('tracking_number,recipient_name,address_line_1\nMX-1,Jane Import,King Fahd Road\n');
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    await waitFor(() => expect(prepareSpy).toHaveBeenCalled());
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        resource_key: 'shipments',
        write_mode: 'create',
        rule_source: 'manual',
        rules: expect.arrayContaining([
          expect.objectContaining({
            source_column: 'tracking_number',
            target_field: 'tracking_number',
            enabled: true,
          }),
          expect.objectContaining({
            source_column: 'recipient_name',
            target_field: 'recipient.name',
            enabled: true,
          }),
          expect.objectContaining({
            source_column: 'address_line_1',
            target_field: 'destination_address.raw_input',
            enabled: true,
          }),
        ]),
        scope_context: expect.objectContaining({
          tenant: 'org_rashed',
          organization_id: 'org_rashed',
          source: 'file_upload',
        }),
      }),
    );

    expect(screen.queryByRole('option', { name: /^Validate only$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Upsert$/i })).not.toBeInTheDocument();

    expect(await screen.findByText(new RegExp(runId))).toBeInTheDocument();
    const mappingPreview = await screen.findByTestId('resource-import-studio-mapping-preview');
    expect(within(mappingPreview).getAllByText('tracking_number').length).toBeGreaterThanOrEqual(1);
    expect(within(mappingPreview).getByText('recipient_name')).toBeInTheDocument();
    expect(within(mappingPreview).getByText('recipient.name')).toBeInTheDocument();
    expect(within(mappingPreview).getByText('address_line_1')).toBeInTheDocument();
    expect(within(mappingPreview).getByText('destination_address.raw_input')).toBeInTheDocument();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], refetchType: 'active' }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], type: 'active' }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        type: 'active',
      }),
    );
    invalidateSpy.mockClear();
    refetchSpy.mockClear();

    await user.click(screen.getByRole('button', { name: /^Start prepared run$/i }));

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith({ run_id: runId }));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], refetchType: 'active' }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({ queryKey: ['list', 'tabular_import_runs'], type: 'active' }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        refetchType: 'active',
      }),
    );
    await waitFor(() =>
      expect(refetchSpy).toHaveBeenCalledWith({
        queryKey: ['resource', 'tabular_import_runs', runId],
        type: 'active',
      }),
    );
    expect(screen.queryByTestId('imports-submit-modal')).not.toBeInTheDocument();
    const drawer = await screen.findByTestId('imports-file-run-drawer');
    expect(within(drawer).getByText('Run reference')).toBeInTheDocument();
    expect(within(drawer).getByText('Recorded')).toBeInTheDocument();
    expect(within(drawer).getByText('Queued')).toBeInTheDocument();
    expect(await screen.findByTestId('imports-file-run-readback')).toHaveTextContent(/Run details loaded/i);
  });

  it('derives accepted file formats from the backend import policy and rejects unsupported files', async () => {
    const user = userEvent.setup({ applyAccept: false });
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1');

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const input = await screen.findByLabelText(/CSV\/XLS\/XLSX file/i);
    expect(input).toHaveAttribute('accept', '.csv,.xls,.xlsx');
    await user.upload(input, new File(['tracking_number\nMX-1\n'], 'shipments.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio action failed')).toBeInTheDocument();
    expect(screen.getByText(/File type \.txt is not accepted for shipments/i)).toBeInTheDocument();
    expect(screen.getByText(/Accepted formats: csv, xls, xlsx/i)).toBeInTheDocument();
    expect(prepareSpy).not.toHaveBeenCalled();

    await user.upload(input, csvImportFile('tracking_number\nMX-1\n', 'shipments.csv'));
    await waitFor(() => {
      expect(screen.queryByText('Import studio action failed')).not.toBeInTheDocument();
    });
  });

  it('keeps empty native import files actionable without calling the backend', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1');

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const input = await screen.findByLabelText(/CSV\/XLS\/XLSX file/i);
    await user.upload(input, new File([], 'shipments-empty.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio action failed')).toBeInTheDocument();
    expect(screen.getByText(/selected import file is empty/i)).toBeInTheDocument();
    expect(screen.getByTestId('resource-import-studio-run')).toHaveTextContent('No prepared file run.');
    expect(prepareSpy).not.toHaveBeenCalled();

    await user.upload(input, csvImportFile('tracking_number\nMX-1\n', 'shipments.csv'));
    await waitFor(() => {
      expect(screen.queryByText('Import studio action failed')).not.toBeInTheDocument();
    });
  });

  it('uses row-driven import limits and rejects oversized files before backend prepare', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getReadRegistry').mockReturnValue({
      ...importRuleRegistry,
      shipments: {
        ...importRuleRegistry.shipments,
        import: {
          ...importRuleRegistry.shipments.import,
          max_file_bytes: 12,
          max_rows: 10000,
        },
      },
    });
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1');

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    expect(await screen.findByTestId('resource-import-studio-limits')).toHaveTextContent('File 12 B');
    expect(screen.getByTestId('resource-import-studio-limits')).toHaveTextContent('Rows 10,000');

    const input = await screen.findByLabelText(/CSV\/XLS\/XLSX file/i);
    await user.upload(input, csvImportFile('tracking_number\nMX-1\n', 'shipments.csv'));
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio action failed')).toBeInTheDocument();
    expect(screen.getByText(/larger than the configured 12 B limit for shipments/i)).toBeInTheDocument();
    expect(screen.getByTestId('resource-import-studio-run')).toHaveTextContent('No prepared file run.');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('prepares pasted CSV rows through the same resource-import-studio backend path', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000321';
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [
        { source_column: 'tracking_number', target_field: 'tracking_number', enabled: true },
        { source_column: 'recipient_name', target_field: 'recipient.name', enabled: true, node_key: 'recipient' },
        {
          source_column: 'address_line_1',
          target_field: 'destination_address.raw_input',
          enabled: true,
          node_key: 'destination_address',
        },
      ],
      correlation_id: 'cor_prepare_pasted_csv',
    });
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_SHIPMENT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    await user.click(await screen.findByLabelText(/Paste CSV content/i));
    await user.paste('tracking_number,recipient_name,address_line_1\nMX-PASTE-1,Noura Paste,King Fahd Road\n');
    await user.click(screen.getByLabelText(/Pasted CSV file name/i));
    await user.paste('shipments-pasted-live.csv');
    const prepareButton = screen.getByRole('button', { name: /^Prepare file$/i });
    await waitFor(() => expect(prepareButton).toBeEnabled());
    await user.click(prepareButton);

    await waitFor(() => expect(prepareSpy).toHaveBeenCalled());
    const preparedFile = prepareSpy.mock.calls[0]?.[0]?.file;
    expect(preparedFile).toBeInstanceOf(File);
    expect(preparedFile?.name).toBe('shipments-pasted-live.csv');
    expect(preparedFile?.type).toBe('text/csv');
    expect(preparedFile?.size).toBeGreaterThan(0);
    expect(prepareSpy.mock.calls[0]?.[0]?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_column: 'tracking_number', target_field: 'tracking_number' }),
        expect.objectContaining({ source_column: 'recipient_name', target_field: 'recipient.name' }),
        expect.objectContaining({
          source_column: 'address_line_1',
          target_field: 'destination_address.raw_input',
        }),
        expect.objectContaining({
          target_field: 'status',
          value_mode: 'fixed',
          fixed_value: 'pending',
        }),
        expect.objectContaining({
          target_field: 'destination_address.validation_status',
          value_mode: 'fixed',
          fixed_value: 'pending',
        }),
      ]),
    );
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_key: 'shipments',
        write_mode: 'create',
        rule_source: 'manual',
        scope_context: expect.objectContaining({
          tenant: 'org_rashed',
          organization_id: 'org_rashed',
          source: 'file_upload',
        }),
      }),
    );
    expect(await screen.findByText(new RegExp(runId))).toBeInTheDocument();
    const mappingPreview = await screen.findByTestId('resource-import-studio-mapping-preview');
    expect(within(mappingPreview).getByText('recipient.name')).toBeInTheDocument();
  });

  it('fails closed when the import policy has no accepted file formats', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getReadRegistry').mockReturnValue({
      ...importRuleRegistry,
      shipments: {
        ...importRuleRegistry.shipments,
        import: {
          enabled: true,
          allow_upsert: false,
          identity_columns: ['tracking_number', 'client_reference_number'],
          default_write_mode: 'create',
        },
      },
    });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    expect(await screen.findByText('Import formats are not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Prepare file$/i })).toBeDisabled();
  });

  it('shows blocking prepare diagnostics and disables shipment import start', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000126';
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 1,
        valid_rows: 0,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: ['destination_address.city'],
        blocking_diagnostics: [
          {
            row: 1,
            fieldPath: 'cod_amount',
            code: 'number_parse_failed',
            message: 'COD Amount must be numeric.',
            blocking: true,
          },
          {
            row: 1,
            fieldPath: 'destination_address.province',
            code: 'related_required_field_missing',
            message: 'Required related field destination_address.province is missing on row 1.',
            blocking: true,
          },
          {
            row: 1,
            fieldPath: 'destination_address.validation_status',
            code: 'related_required_field_missing',
            message: 'Required related field destination_address.validation_status is missing on row 1.',
            blocking: true,
          },
        ],
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_blocked',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: runId, status: 'queued' },
      report: null,
      correlation_id: 'cor_start_blocked',
    });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = csvImportFile('tracking_number,cod_amount\nMX-1,not-money\n');
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText(/Blocked: 1 rows/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ready: 1 rows/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('resource-import-studio-unresolved-targets')).toHaveTextContent('destination_address.city');
    expect(screen.getByTestId('resource-import-studio-blocking-diagnostics')).toHaveTextContent('COD Amount must be numeric.');
    expect(screen.getByTestId('resource-import-studio-blocking-diagnostics')).toHaveTextContent('destination_address.province');
    expect(screen.getByTestId('resource-import-studio-blocking-diagnostics')).toHaveTextContent('destination_address.validation_status');
    expect(screen.getByTestId('resource-import-studio-plan')).toHaveTextContent('blocked 1');
    expect(screen.getByRole('button', { name: /^Start prepared run/i })).toBeDisabled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('permission-gates shipment import start on shipments.write', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000127';
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 1,
        valid_rows: 1,
        will_create: 1,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        blocking_diagnostics: [],
        warning_diagnostics: [],
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_permission',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: runId, status: 'queued' },
      report: null,
      correlation_id: 'cor_start_permission',
    });

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = csvImportFile('tracking_number\nMX-1\n');
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText(/Ready: 1 rows/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Start prepared run/i })).toBeDisabled();
    expect(screen.getByText(/shipment update/i)).toBeInTheDocument();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('passes selected client and sender scope into CSV/XLS/XLSX shipment import prepare', async () => {
    const user = userEvent.setup();
    const realList = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource: string, opts?: api.ListOpts) => {
        if (resource === 'client_summary') {
          return {
            rows: [
              {
                id: 'client_scope_1',
                client_id: 'client_scope_1',
                organization_id: 'org_rashed',
                name: 'Scope Client',
                status: 'active',
              },
            ],
            total: 1,
          };
        }
        if (resource === 'sender_summary') {
          return {
            rows: [
              {
                id: 'sender_scope_1',
                sender_id: 'sender_scope_1',
                client_id: 'client_scope_1',
                name: 'Scope Sender',
                client_label: 'Scope Client',
                status: 'active',
              },
            ],
            total: 1,
          };
        }
        return realList(resource, opts);
      },
    );
    const runId = '00000000-0000-4000-8000-000000000124';
    vi.spyOn(api, 'getReadRegistry').mockReturnValue(importRuleRegistry);
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_scope',
    });

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const expectImportLabel = (text: string, id: string) => {
      const label = document.querySelector(`label[for="${id}"]`);
      expect(label).toHaveTextContent(text);
    };
    expectImportLabel('Kind', 'resource-import-studio-kind');
    expectImportLabel('Client', 'resource-import-studio-client');
    expectImportLabel('Sender', 'resource-import-studio-sender');
    expectImportLabel('File', 'resource-import-studio-file');
    const clientPicker = screen.getByLabelText(/Import client/i);
    await waitFor(() => expect(clientPicker).toBeEnabled());
    await user.selectOptions(clientPicker, 'client_scope_1');
    const senderPicker = screen.getByLabelText(/Import sender/i);
    await waitFor(() => expect(senderPicker).toBeEnabled());
    await user.selectOptions(senderPicker, 'sender_scope_1');
    const file = csvImportFile('tracking_number\nMX-1\n');
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    await waitFor(() => expect(prepareSpy).toHaveBeenCalled());
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_key: 'shipments',
        rule_source: 'manual',
        rules: expect.arrayContaining([
          expect.objectContaining({
            source_column: 'tracking_number',
            target_field: 'tracking_number',
            enabled: true,
          }),
        ]),
        scope_context: expect.objectContaining({
          organization_id: 'org_rashed',
          tenant: 'org_rashed',
          client: 'client_scope_1',
          sender: 'sender_scope_1',
        }),
      }),
    );
  });

  it('derives shipment write-mode options from the backend import policy', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000125';
    vi.spyOn(api, 'getReadRegistry').mockReturnValue({
      ...importRuleRegistry,
      shipments: {
        ...importRuleRegistry.shipments,
        import: {
          ...importRuleRegistry.shipments.import,
          enabled: true,
          allow_upsert: true,
          identity_columns: ['tracking_number'],
          default_write_mode: 'upsert',
        },
      },
    });
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'upsert',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_upsert_policy',
    });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    expect(screen.getByRole('option', { name: /^Upsert$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Write mode/i)).toHaveValue('upsert');
    const file = csvImportFile('tracking_number\nMX-1\n');
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    await waitFor(() => expect(prepareSpy).toHaveBeenCalled());
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_key: 'shipments',
        write_mode: 'upsert',
      }),
    );
  });

  it('keeps file prepare permission failures visible as denied inside the upload modal', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockRejectedValue(
      new Error('42501 import mapping permission denied'),
    );

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = new File(['tracking_number\nMX-1\n'], 'shipments.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio permission denied')).toBeInTheDocument();
    expect(screen.getByText('42501 import mapping permission denied')).toBeInTheDocument();
    expect(screen.getByText(/Mappings Write permission required/i)).toBeInTheDocument();
  });

  it('keeps unmapped file headers actionable without creating a prepared run', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockRejectedValue(
      new Error('No import columns matched this file. Check the file headers or create a mapping profile before preparing it.'),
    );

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const input = await screen.findByLabelText(/CSV\/XLS\/XLSX file/i);
    await user.upload(input, new File(['foo,bar\n1,2\n'], 'shipments-wrong-headers.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio action failed')).toBeInTheDocument();
    expect(screen.getByText(/No import columns matched this file/i)).toBeInTheDocument();
    expect(screen.getByTestId('resource-import-studio-run')).toHaveTextContent('No prepared file run.');
    expect(screen.getByRole('button', { name: /^Start prepared run/i })).toBeDisabled();
  });

  it('clears stale file prepare errors when the operator changes the selected import file', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockRejectedValue(
      new Error('42501 import mapping permission denied'),
    );

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const input = await screen.findByLabelText(/CSV\/XLS\/XLSX file/i);
    await user.upload(input, new File(['tracking_number\nMX-1\n'], 'shipments.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText('Import studio permission denied')).toBeInTheDocument();
    expect(screen.getByText('42501 import mapping permission denied')).toBeInTheDocument();

    await user.upload(input, new File(['tracking_number\nMX-2\n'], 'shipments-next.csv', { type: 'text/csv' }));

    await waitFor(() => {
      expect(screen.queryByText('Import studio permission denied')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('42501 import mapping permission denied')).not.toBeInTheDocument();
    expect(screen.getByTestId('resource-import-studio-run')).toHaveTextContent('No prepared file run.');
  });

  it('shows prepared mapping profiles and starts with an update profile decision', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000456';
    const matchedProfileId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
    const selectedProfileId = '22222222-2222-4222-8222-222222222222';
    const prepareSpy = vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'create',
        total_rows: 2,
        valid_rows: 2,
        failed_count: 0,
      },
      profile_match: {
        id: matchedProfileId,
        profile_name: 'Daily shipments',
        write_mode: 'create',
        sheet_hint: 'Sheet1',
        header_fingerprint: 'fp_daily',
      },
      available_profiles: [
        {
          id: matchedProfileId,
          profile_name: 'Daily shipments',
          write_mode: 'create',
          sheet_hint: 'Sheet1',
          header_fingerprint: 'fp_daily',
        },
        {
          id: selectedProfileId,
          profile_name: 'Regional shipments',
          write_mode: 'upsert',
          sheet_hint: 'Sheet1',
          header_fingerprint: 'fp_regional',
        },
      ],
      resolved_rules: [],
      correlation_id: 'cor_prepare_profiles',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: runId, status: 'queued' },
      report: null,
      correlation_id: 'cor_start_profiles',
    });
    mockTabularImportRunReadback(runId, { total_rows: 2 });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = new File(['tracking_number\nMX-1\nMX-2\n'], 'shipments.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    await waitFor(() => expect(prepareSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(within(screen.getByTestId('resource-import-studio-profile-match')).getByText(/Daily shipments/i))
        .toBeInTheDocument(),
    );
    expect(screen.getByRole('option', { name: /Regional shipments/i })).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(/Available mapping profile/i),
      selectedProfileId,
    );
    await user.selectOptions(screen.getByLabelText(/Profile action/i), 'update');
    const profileNameInput = screen.getByLabelText(/Profile name/i);
    await user.clear(profileNameInput);
    await user.type(profileNameInput, 'Regional shipments revised');
    await user.click(screen.getByRole('button', { name: /^Start prepared run$/i }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({
        run_id: runId,
        save_profile: {
          mode: 'update',
          profile_id: selectedProfileId,
          profile_name: 'Regional shipments revised',
        },
      }),
    );
  });

  it('starts a prepared run with a new mapping profile save request', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000789';
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'upsert',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_new_profile',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: runId, status: 'queued' },
      report: null,
      correlation_id: 'cor_start_new_profile',
    });
    mockTabularImportRunReadback(runId, { write_mode: 'upsert' });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = new File(['tracking_number\nMX-1\n'], 'shipments.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText(/No header-fingerprint match/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Profile action/i), 'new');
    const profileNameInput = screen.getByLabelText(/Profile name/i);
    await user.clear(profileNameInput);
    await user.type(profileNameInput, 'New shipment import profile');
    await user.click(screen.getByRole('button', { name: /^Start prepared run$/i }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({
        run_id: runId,
        save_profile: {
          mode: 'new',
          profile_name: 'New shipment import profile',
        },
      }),
    );
  });

  it('blocks prepared import start when required mapping profile data is missing', async () => {
    const user = userEvent.setup();
    const runId = '00000000-0000-4000-8000-000000000790';
    vi.spyOn(api, 'resource_import_studio_prepare_v1').mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: runId,
        resource_key: 'shipments',
        write_mode: 'upsert',
        total_rows: 1,
        valid_rows: 1,
        failed_count: 0,
      },
      profile_match: null,
      available_profiles: [],
      resolved_rules: [],
      correlation_id: 'cor_prepare_missing_profile',
    });
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1').mockResolvedValue({
      ok: true,
      run: { id: runId, status: 'queued' },
      report: null,
      correlation_id: 'cor_start_missing_profile',
    });

    renderWithProviders(<ImportsModule />, {
      capabilities: FULL_IMPORT_SHIPMENT_CAPS,
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const file = new File(['tracking_number\nMX-1\n'], 'shipments.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText(/CSV\/XLS\/XLSX file/i), file);
    await user.click(screen.getByRole('button', { name: /^Prepare file$/i }));

    expect(await screen.findByText(/No header-fingerprint match/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Profile action/i), 'new');
    await user.clear(screen.getByLabelText(/Profile name/i));
    const startButton = screen.getByRole('button', { name: /^Start prepared run$/i });
    await waitFor(() => expect(startButton).toBeDisabled());
    await user.click(startButton);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('cancels the file upload profile-decision modal without starting a run', async () => {
    const user = userEvent.setup();
    const startSpy = vi.spyOn(api, 'resource_import_studio_start_v1');

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    expect(await screen.findByTestId('imports-submit-modal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('imports-submit-modal')).not.toBeInTheDocument(),
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not expose legacy import_job_create_v1 submit inside the file upload path', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(api, 'import_job_create_v1');

    renderWithProviders(<ImportsModule />, {
      identity: {
        capabilities: FULL_IMPORT_CAPS,
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Upload file$/i }));
    const modalBody = await screen.findByTestId('imports-submit-modal');

    expect(
      within(modalBody).queryByRole('button', { name: /^Submit$/i }),
    ).not.toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
