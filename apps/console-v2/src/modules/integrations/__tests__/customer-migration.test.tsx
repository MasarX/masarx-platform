import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { CustomerMigrationModule } from '@/modules/integrations/customer-migration';
import * as api from '@/lib/api';

const sourceRow = {
  id: 'lms_logistics_legacy',
  display_name: 'Example Legacy CRM',
  provider_name: 'Example Source Provider',
  plugin_key: 'customer-logistics-migration',
  plugin_id: 'plg_customer_migration',
  plugin_version_id: 'plgv_customer_migration_1',
  plugin_binding_id: 'plgb_customer_migration_api_route',
  plugin_version_no: 1,
  plugin_status: 'active',
  plugin_version_status: 'active',
  plugin_binding_enabled: true,
  status: 'active',
};

const batchId = 'test-batch-001';
const migrationPayload = {
  client: { name: 'Example Migration Client', slug: 'example-migration-client' },
  customers: [
    { external_id: 'FIXTURE-001', name: 'Example Recipient One', phone: '+12025550101' },
    { external_id: 'FIXTURE-002', name: 'Example Recipient Two', phone: '+12025550102' },
  ],
};

async function enterMigrationInput(
  user: ReturnType<typeof userEvent.setup>,
  payload: object = migrationPayload,
) {
  await user.type(screen.getByLabelText(/External batch ID/i), batchId);
  await user.click(screen.getByLabelText(/JSON payload/i));
  await user.paste(JSON.stringify(payload));
}

const secondSourceRow = {
  ...sourceRow,
  id: 'lms_second_source',
  display_name: 'Second Logistics Source',
};

const profileRow = {
  id: 'lmp_clients_customers',
  source_id: sourceRow.id,
  display_name: 'Clients and customers',
  status: 'active',
};

const secondProfileRow = {
  ...profileRow,
  id: 'lmp_second_profile',
  source_id: secondSourceRow.id,
  display_name: 'Second profile',
};

const importedClientRow = {
  id: 'cl_riyadh_fresh',
  name: 'Example Migration Client',
};

const importedRecipientRows = [
  { id: 'rec_1', name: 'Example Recipient One', external_id: 'FIXTURE-001' },
  { id: 'rec_2', name: 'Example Recipient Two', external_id: 'FIXTURE-002' },
];

const importJobRow = {
  id: 'imp_customer_migration',
  status: 'completed',
  kind: 'client_customer_migration',
  row_count: 3,
  error_count: 0,
};

const configResult: api.LogisticsCustomerMigrationConfigResult = {
  ok: true,
  source_id: sourceRow.id,
  profile_id: profileRow.id,
  plugin_id: sourceRow.plugin_id,
  plugin_version_id: sourceRow.plugin_version_id,
  plugin_binding_id: sourceRow.plugin_binding_id,
  decision_log_id: 'dlog_customer_migration_config',
  profile_config_sha256: 'a'.repeat(64),
  status: 'configured',
  onboarding_readiness: { ok: true, blocking_count: 0 },
};

const previewResult: api.LogisticsCustomerMigrationResult = {
  ok: true,
  request_id: importJobRow.id,
  import_job_id: importJobRow.id,
  request_key: `example-legacy-crm:${batchId}`,
  status: 'queued',
  mode: 'dry_run',
  plugin_id: sourceRow.plugin_id,
  plugin_version_id: sourceRow.plugin_version_id,
  plugin_binding_id: sourceRow.plugin_binding_id,
  imported_client_id: null,
  imported_recipient_ids: [],
  validation_summary: { clients: 1, recipients: 2, errors: [], ok: true },
  result_summary: { preview: true, would_create_clients: 1, would_import_recipients: 2 },
  redaction_summary: { secret_fields_redacted: 0, payload_sample: 'not_stored' },
  workflow_run_id: 'wfr_customer_migration_preview',
  decision_log_id: 'dlog_customer_migration_preview',
  domain_event_ids: ['evt_queued', 'evt_preview'],
  migration_item_ids: ['lmi_preview_client', 'lmi_preview_customer_1', 'lmi_preview_customer_2'],
  idempotency_reused: false,
};

const executeResult: api.LogisticsCustomerMigrationResult = {
  ...previewResult,
  status: 'completed',
  mode: 'execute',
  imported_client_id: importedClientRow.id,
  imported_recipient_ids: importedRecipientRows.map((row) => row.id),
  result_summary: { preview: false, imported_clients: 1, imported_recipients: 2 },
  workflow_run_id: 'wfr_customer_migration_execute',
  decision_log_id: 'dlog_customer_migration_execute',
  domain_event_ids: ['evt_queued', 'evt_running', 'evt_completed'],
  migration_item_ids: ['lmi_execute_client', 'lmi_execute_customer_1', 'lmi_execute_customer_2'],
};

function installBackendListReadback() {
  return vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string) => {
    const rows = resource === 'logistics_migration_sources'
      ? [sourceRow, secondSourceRow]
      : resource === 'logistics_migration_profiles'
        ? [profileRow, secondProfileRow]
        : resource === 'clients'
          ? [importedClientRow]
          : resource === 'recipients'
            ? importedRecipientRows
            : resource === 'import_jobs'
              ? [importJobRow]
              : [];
    return { rows, total: rows.length } as never;
  });
}

const previewCapabilities = [
  'integration_plugins.read',
  'imports.read',
  'imports.write',
  'clients.read',
  'recipients.read',
  'audit_log.read',
  'workflows.read',
];

const fullCapabilities = [
  ...previewCapabilities,
  'integration_plugins.write',
  'integration_plugins.test',
  'integration_plugins.approve',
  'integration_plugins.activate',
  'clients.write',
  'recipients.write',
];

describe('CustomerMigrationModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('previews, executes, and shows same-context backend readback', async () => {
    const user = userEvent.setup();
    installBackendListReadback();
    const configSpy = vi
      .spyOn(api, 'ui_upsert_logistics_customer_migration_config_v1')
      .mockResolvedValue(configResult);
    const executeSpy = vi
      .spyOn(api, 'ui_execute_logistics_customer_migration_v1')
      .mockImplementation(async (args) => args.dry_run ? previewResult : executeResult);

    renderWithProviders(<CustomerMigrationModule />, {
      capabilities: fullCapabilities,
    });

    expect(await screen.findByRole('heading', { name: /Customer migration/i })).toBeInTheDocument();
    await screen.findByRole('option', { name: /Example Legacy CRM/i });

    await user.click(screen.getByRole('button', { name: /^Save config$/i }));
    await waitFor(() => {
      expect(configSpy).toHaveBeenCalledWith(expect.objectContaining({
        source_key: 'example-legacy-crm',
        mapping_rules: expect.objectContaining({
          version: 1,
          objects: expect.objectContaining({ client: expect.any(Object) }),
          collections: expect.objectContaining({ recipients: expect.any(Object) }),
        }),
        validation_rules: expect.objectContaining({
          version: 1,
          limits: {
            max_recipients: 100,
            max_payload_bytes: 262144,
          },
          conflict_policy: expect.objectContaining({ client_slug: 'fail' }),
        }),
      }));
    });
    expect(await screen.findByText(`Decision: ${configResult.decision_log_id}`)).toBeInTheDocument();
    expect(screen.getByText(/customer-logistics-migration/i)).toBeInTheDocument();
    expect(screen.getByText('Plugin status: active')).toBeInTheDocument();
    expect(screen.getByText(/Onboarding readiness: Ready/i)).toBeInTheDocument();

    const previewButton = screen.getByRole('button', { name: /^Preview$/i });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    expect(screen.getByLabelText(/External batch ID/i)).toHaveValue('');
    expect(screen.getByLabelText(/JSON payload/i)).toHaveValue('');
    await user.click(previewButton);
    await user.click(screen.getByRole('button', { name: /^Execute$/i }));
    expect(executeSpy).not.toHaveBeenCalled();

    await enterMigrationInput(user);
    await user.click(previewButton);
    await waitFor(() => expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
      dry_run: true,
      external_batch_id: batchId,
      payload: migrationPayload,
    })));
    expect(await screen.findByText(/queued \/ dry_run/i)).toBeInTheDocument();
    expect(screen.getByText(/Redacted fields: 0/i)).toBeInTheDocument();

    const executeButton = screen.getByRole('button', { name: /^Execute$/i });
    await waitFor(() => expect(executeButton).not.toBeDisabled());
    await user.click(executeButton);
    await waitFor(() => expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ dry_run: false })));
    expect(await screen.findByText(/completed \/ execute/i)).toBeInTheDocument();
    expect(await screen.findByText(/Imported client: Example Migration Client/i)).toBeInTheDocument();
    expect(screen.getByText(/Recipients: 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Imported recipients: Example Recipient One, Example Recipient Two/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Import job: ${importJobRow.id}`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(/Workflow:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Decision:/i).length).toBeGreaterThanOrEqual(2);
  });

  it('does not expose secret values in visible readback after preview', async () => {
    const user = userEvent.setup();
    installBackendListReadback();
    vi.spyOn(api, 'ui_execute_logistics_customer_migration_v1').mockResolvedValue({
      ...previewResult,
      redaction_summary: { secret_fields_redacted: 1, payload_sample: 'not_stored' },
    });

    renderWithProviders(<CustomerMigrationModule />, {
      capabilities: previewCapabilities,
    });

    await screen.findByRole('option', { name: /Example Legacy CRM/i });
    await enterMigrationInput(user, { ...migrationPayload, credentials: { api_key: 'redacted-in-ui' } });
    await user.click(screen.getByRole('button', { name: /^Preview$/i }));

    await screen.findByText(/queued \/ dry_run/i);
    expect(screen.getByRole('heading', { name: /Run readback/i }).parentElement).not.toHaveTextContent('redacted-in-ui');
    expect(screen.getByText(/Redacted fields: 1/i)).toBeInTheDocument();
  });

  it('allows preview but blocks execution without client and recipient write access', async () => {
    installBackendListReadback();

    renderWithProviders(<CustomerMigrationModule />, {
      capabilities: previewCapabilities,
    });

    await screen.findByRole('option', { name: /Example Legacy CRM/i });
    expect(screen.getByRole('button', { name: /^Preview$/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^Execute$/i })).toBeDisabled();
    expect(screen.getByText(/Client and recipient write access is required/i)).toBeInTheDocument();
  });

  it('blocks mutations when required audit and workflow readback access is missing', async () => {
    installBackendListReadback();
    const configSpy = vi.spyOn(api, 'ui_upsert_logistics_customer_migration_config_v1');
    const executeSpy = vi.spyOn(api, 'ui_execute_logistics_customer_migration_v1');

    renderWithProviders(<CustomerMigrationModule />, {
      capabilities: fullCapabilities.filter(
        (capability) => !['audit_log.read', 'workflows.read'].includes(capability),
      ),
    });

    await screen.findByRole('option', { name: /Example Legacy CRM/i });
    expect(screen.getByRole('button', { name: /^Save config$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Preview$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Execute$/i })).toBeDisabled();
    expect(screen.getByText(/audit read access are required to save configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/audit, and workflow read access are required to preview/i)).toBeInTheDocument();
    expect(configSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('keeps persisted backend validation failures visible in the same run context', async () => {
    const user = userEvent.setup();
    installBackendListReadback();
    vi.spyOn(api, 'ui_execute_logistics_customer_migration_v1').mockResolvedValue({
      ok: false,
      request_id: 'imp_validation_failed',
      import_job_id: 'imp_validation_failed',
      request_key: `example-legacy-crm:${batchId}`,
      status: 'failed',
      mode: 'dry_run',
      plugin_id: sourceRow.plugin_id,
      plugin_version_id: sourceRow.plugin_version_id,
      plugin_binding_id: sourceRow.plugin_binding_id,
      imported_recipient_ids: [],
      validation_summary: { clients: 0, recipients: 0, errors: 1 },
      result_summary: {},
      redaction_summary: { secret_fields_redacted: 0, payload_sample: 'not_stored' },
      workflow_run_id: 'wfr_validation_failed',
      decision_log_id: 'dlog_validation_failed',
      domain_event_ids: ['evt_validation_failed'],
      migration_item_ids: [],
      error: { code: 'validation_failed' },
    });

    renderWithProviders(<CustomerMigrationModule />, {
      capabilities: previewCapabilities,
    });

    await screen.findByRole('option', { name: /Example Legacy CRM/i });
    await enterMigrationInput(user, { client: { name: 'Example Invalid Client' }, customers: [] });
    await user.click(screen.getByRole('button', { name: /^Preview$/i }));

    expect(await screen.findByText(/failed \/ dry_run/i)).toBeInTheDocument();
    expect(screen.getByText(/Validation errors: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Error: validation_failed/i)).toBeInTheDocument();
    expect(screen.getByText(/wfr_validation_failed/i)).toBeInTheDocument();
    expect(screen.getByText(/dlog_validation_failed/i)).toBeInTheDocument();
  });

  it('clears stale profile and result when the operator changes source', async () => {
    const user = userEvent.setup();
    installBackendListReadback();
    vi.spyOn(api, 'ui_execute_logistics_customer_migration_v1').mockResolvedValue(previewResult);

    renderWithProviders(<CustomerMigrationModule />, { capabilities: previewCapabilities });

    await screen.findByRole('option', { name: /Example Legacy CRM/i });
    await enterMigrationInput(user);
    await user.click(screen.getByRole('button', { name: /^Preview$/i }));
    expect(await screen.findByText(/queued \/ dry_run/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^Source$/i), secondSourceRow.id);

    expect(screen.getByText(/Result: No run yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Profile$/i)).toHaveValue(secondProfileRow.id);
  });
});
