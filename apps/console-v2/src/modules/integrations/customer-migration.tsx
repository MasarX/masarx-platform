import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useResourceList } from '@/lib/queries';
import * as api from '@/lib/api';
import { pushToast } from '@/components/toastStore';

interface MigrationSource extends Record<string, unknown> {
  id: string;
  display_name: string;
  provider_name?: string | null;
  plugin_key?: string | null;
  plugin_id?: string | null;
  plugin_version_id?: string | null;
  plugin_binding_id?: string | null;
  plugin_version_no?: number | null;
  plugin_status?: string | null;
  plugin_version_status?: string | null;
  plugin_binding_enabled?: boolean | null;
  status: string;
}

interface MigrationProfile extends Record<string, unknown> {
  id: string;
  source_id: string;
  display_name: string;
  status: string;
  mapping_rules?: Record<string, unknown> | null;
  validation_rules?: Record<string, unknown> | null;
}

interface MigrationRequest extends Record<string, unknown> {
  id: string;
  import_job_id: string;
  request_key: string;
  mode: string;
  status: string;
  external_batch_id: string;
  imported_client_id?: string | null;
  imported_client_name?: string | null;
  imported_recipient_ids?: string[] | null;
  plugin_id?: string | null;
  plugin_version_id?: string | null;
  plugin_binding_id?: string | null;
  validation_summary?: Record<string, unknown> | null;
  result_summary?: Record<string, unknown> | null;
  redaction_summary?: Record<string, unknown> | null;
  error_summary?: Record<string, unknown> | null;
  workflow_run_id?: string | null;
  decision_log_id?: string | null;
  updated_at?: string | null;
}

interface ImportJob extends Record<string, unknown> {
  id: string;
  status: string;
  kind?: string | null;
  row_count?: number | null;
  error_count?: number | null;
}

interface RecipientRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  external_id?: string | null;
}

type MigrationResult = api.LogisticsCustomerMigrationResult & {
  workflow_run_id?: string | null;
  decision_log_id?: string | null;
  error?: { code?: string; details?: unknown };
};

const DEFAULT_MAPPING_RULES = {
  version: 1,
  objects: {
    client: {
      source_path: '$.client',
      field_mappings: {
        name: '$.name',
        slug: '$.slug',
        sla_tier: '$.sla',
      },
    },
  },
  collections: {
    recipients: {
      source_path: '$.customers[*]',
      field_mappings: {
        external_id: '$.external_id',
        name: '$.name',
        phone_number: '$.phone',
        email: '$.email',
      },
    },
  },
};

const DEFAULT_VALIDATION_RULES = {
  version: 1,
  required_paths: ['$.client.name', '$.client.slug'],
  required_collections: [
    { path: '$.recipients', min_items: 1, required_fields: ['name', 'phone_number'] },
  ],
  limits: {
    max_recipients: 100,
    max_payload_bytes: 262144,
  },
  conflict_policy: {
    client_slug: 'fail',
    recipient_external_id: 'fail',
    recipient_phone_number: 'fail',
  },
};

const SAMPLE_PAYLOAD = JSON.stringify(
  {
    client: { name: 'Example Migration Client', slug: 'example-migration-client', sla: 'standard' },
    customers: [
      { external_id: 'FIXTURE-001', name: 'Example Recipient One', phone: '+12025550101', email: 'recipient-one@example.invalid' },
      { external_id: 'FIXTURE-002', name: 'Example Recipient Two', phone: '+12025550102', email: 'recipient-two@example.invalid' },
    ],
  },
  null,
  2,
);

const DEFAULT_MAPPING_RULES_TEXT = JSON.stringify(DEFAULT_MAPPING_RULES, null, 2);
const DEFAULT_VALIDATION_RULES_TEXT = JSON.stringify(DEFAULT_VALIDATION_RULES, null, 2);

function summaryValue(summary: Record<string, unknown> | null | undefined, key: string): string {
  const value = summary?.[key];
  if (value == null || value === '') return '0';
  if (Array.isArray(value)) return String(value.length);
  return String(value);
}

function statusTone(status: string) {
  if (status === 'completed' || status === 'validated' || status === 'active' || status === 'configured') return 'good';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

export function CustomerMigrationModule() {
  const canReadPlugin = useCapability(CAP.INTEGRATION_PLUGINS_READ);
  const canWritePlugin = useCapability(CAP.INTEGRATION_PLUGINS_WRITE);
  const canTestPlugin = useCapability(CAP.INTEGRATION_PLUGINS_TEST);
  const canApprovePlugin = useCapability(CAP.INTEGRATION_PLUGINS_APPROVE);
  const canActivatePlugin = useCapability(CAP.INTEGRATION_PLUGINS_ACTIVATE);
  const canReadImports = useCapability(CAP.IMPORTS_READ);
  const canWriteImports = useCapability(CAP.IMPORTS_WRITE);
  const canReadClients = useCapability(CAP.CLIENTS_READ);
  const canWriteClients = useCapability(CAP.CLIENTS_WRITE);
  const canReadRecipients = useCapability(CAP.RECIPIENTS_READ);
  const canWriteRecipients = useCapability(CAP.RECIPIENTS_WRITE);
  const canReadAudit = useCapability(CAP.AUDIT_LOG_READ);
  const canReadWorkflows = useCapability(CAP.WORKFLOWS_READ);
  const canConfigure = canReadPlugin
    && canWritePlugin
    && canTestPlugin
    && canApprovePlugin
    && canActivatePlugin
    && canReadAudit;
  const canPreview = canReadPlugin
    && canReadImports
    && canWriteImports
    && canReadClients
    && canReadRecipients
    && canReadAudit
    && canReadWorkflows;
  const canExecute = canPreview && canWriteClients && canWriteRecipients;
  const sourcesQuery = useResourceList<MigrationSource>('logistics_migration_sources', undefined, { enabled: canReadPlugin });
  const profilesQuery = useResourceList<MigrationProfile>('logistics_migration_profiles', undefined, { enabled: canReadPlugin });
  const requestsQuery = useResourceList<MigrationRequest>('logistics_migration_requests', undefined, { enabled: canReadImports });
  const importJobsQuery = useResourceList<ImportJob>('import_jobs', undefined, { enabled: canReadImports });
  const clientsQuery = useResourceList<Record<string, unknown>>('clients', undefined, { enabled: canReadClients });
  const recipientsQuery = useResourceList<RecipientRow>('recipients', undefined, { enabled: canReadRecipients });
  const [sourceId, setSourceId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [displayName, setDisplayName] = useState('Example Legacy CRM');
  const [sourceKey, setSourceKey] = useState('example-legacy-crm');
  const [providerName, setProviderName] = useState('Example Source Provider');
  const [profileName, setProfileName] = useState('Clients and customers');
  const [profileKey, setProfileKey] = useState('clients-and-customers');
  const [mappingRules, setMappingRules] = useState(DEFAULT_MAPPING_RULES_TEXT);
  const [validationRules, setValidationRules] = useState(DEFAULT_VALIDATION_RULES_TEXT);
  const [externalBatchId, setExternalBatchId] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState<'config' | 'preview' | 'execute' | null>(null);
  const [configResult, setConfigResult] = useState<api.LogisticsCustomerMigrationConfigResult | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);

  const sources = sourcesQuery.data?.rows ?? [];
  const selectedSourceId = sourceId || sources[0]?.id || '';
  const profilesForSource = selectedSourceId
    ? profilesQuery.data?.rows.filter((profile) => profile.source_id === selectedSourceId) ?? []
    : profilesQuery.data?.rows ?? [];
  const selectedProfileId = profilesForSource.some((profile) => profile.id === profileId)
    ? profileId
    : profilesForSource[0]?.id || '';
  const selectedSource = sources.find((source) => source.id === selectedSourceId);
  const selectedProfile = profilesForSource.find((profile) => profile.id === selectedProfileId);
  const requests = requestsQuery.data?.rows ?? [];
  const importedClient = result?.imported_client_id
    ? (clientsQuery.data?.rows ?? []).find((row) => row.id === result.imported_client_id)
    : null;
  const importedRecipients = (result?.imported_recipient_ids ?? [])
    .map((id) => (recipientsQuery.data?.rows ?? []).find((row) => row.id === id))
    .filter((row): row is RecipientRow => Boolean(row));
  const importJob = result?.import_job_id
    ? (importJobsQuery.data?.rows ?? []).find((row) => row.id === result.import_job_id)
    : null;

  const requestColumns = useMemo<DataTableColumn<MigrationRequest>[]>(
    () => [
      { key: 'request_key', label: 'Request' },
      { key: 'mode', label: 'Mode' },
      {
        key: 'status',
        label: 'Status',
        render: (_raw, row) => <Chip kind={statusTone(row.status)} label={row.status} />,
      },
      {
        key: 'validation',
        label: 'Validation',
        render: (_raw, row) =>
          `${summaryValue(row.validation_summary, 'clients')} client / ${summaryValue(row.validation_summary, 'recipients')} recipients / ${summaryValue(row.validation_summary, 'errors')} errors`,
      },
      {
        key: 'redaction',
        label: 'Redaction',
        render: (_raw, row) => `${summaryValue(row.redaction_summary, 'secret_fields_redacted')} fields`,
      },
      { key: 'workflow_run_id', label: 'Workflow run' },
      { key: 'decision_log_id', label: 'Decision' },
      { key: 'updated_at', label: 'Updated' },
    ],
    [],
  );

  async function saveConfig() {
    if (!canConfigure) return;
    setBusy('config');
    try {
      const parsedMapping = JSON.parse(mappingRules) as Record<string, unknown>;
      const parsedValidation = JSON.parse(validationRules) as Record<string, unknown>;
      const response = await api.ui_upsert_logistics_customer_migration_config_v1({
        source_key: sourceKey.trim(),
        display_name: displayName.trim(),
        provider_name: providerName.trim(),
        profile_key: profileKey.trim(),
        profile_display_name: profileName.trim(),
        auth_mode: 'api_key',
        mapping_rules: parsedMapping,
        validation_rules: parsedValidation,
      });
      setConfigResult(response);
      setSourceId(response.source_id);
      setProfileId(response.profile_id);
      setResult(null);
      await Promise.all([sourcesQuery.refetch(), profilesQuery.refetch()]);
      pushToast('Migration config saved', 'good');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Config save failed', 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function run(mode: 'preview' | 'execute') {
    if ((mode === 'execute' ? !canExecute : !canPreview) || !selectedSourceId || !selectedProfileId) return;
    const batchId = externalBatchId.trim();
    if (!batchId || !payload.trim()) {
      pushToast('Enter an external batch ID and a JSON payload.', 'warn');
      return;
    }
    setBusy(mode);
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const response = await api.ui_execute_logistics_customer_migration_v1({
        source_id: selectedSourceId,
        profile_id: selectedProfileId,
        external_batch_id: batchId,
        payload: parsed,
        dry_run: mode === 'preview',
      }) as MigrationResult;
      setResult(response);
      await Promise.all([
        requestsQuery.refetch(),
        importJobsQuery.refetch(),
        clientsQuery.refetch(),
        recipientsQuery.refetch(),
      ]);
      pushToast(
        response.ok === false
          ? response.error?.code === 'validation_failed'
            ? 'Migration validation failed'
            : 'Migration failed'
          : mode === 'preview'
            ? 'Migration preview ready'
            : 'Customer migration executed',
        response.ok === false ? 'warn' : 'good',
      );
    } catch (err) {
      await Promise.all([requestsQuery.refetch(), importJobsQuery.refetch()]);
      pushToast(err instanceof Error ? err.message : 'Migration failed', 'danger');
    } finally {
      setBusy(null);
    }
  }

  function changeSource(nextSourceId: string) {
    setSourceId(nextSourceId);
    setProfileId('');
    setConfigResult(null);
    setResult(null);
  }

  if (!canReadPlugin || !canReadImports) {
    return (
      <StateView
        kind="denied"
        title="Customer migration is not available"
        hint="Integration plugin and import read access are required."
      />
    );
  }

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Integrations"
        titleAccent="Customer"
        titlePlain="migration"
      />

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>Plugin config</h2>
            <p>Source, profile, and mapping rows used by migration preview and execution.</p>
          </div>
          <div className="action-row">
            <Button onClick={() => void saveConfig()} disabled={!canConfigure || busy != null}>
              {busy === 'config' ? 'Saving...' : 'Save config'}
            </Button>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Source name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            Source key
            <input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} />
          </label>
          <label>
            Provider
            <input value={providerName} onChange={(event) => setProviderName(event.target.value)} />
          </label>
          <label>
            Profile name
            <input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
          </label>
          <label>
            Profile key
            <input value={profileKey} onChange={(event) => setProfileKey(event.target.value)} />
          </label>
        </div>
        <div className="split-panel">
          <label>
            Mapping rules
            <textarea value={mappingRules} onChange={(event) => setMappingRules(event.target.value)} rows={12} />
          </label>
          <label>
            Validation rules
            <textarea value={validationRules} onChange={(event) => setValidationRules(event.target.value)} rows={12} />
          </label>
        </div>
        {!canConfigure ? (
          <p>Plugin read, write, test, approve, activate, and audit read access are required to save configuration.</p>
        ) : null}
        <div className="split-panel">
          <div className="readback-card">
            <h3>Config readback</h3>
            <p>Source: {selectedSource?.display_name ?? configResult?.source_id ?? 'Not saved'}</p>
            <p>Profile: {selectedProfile?.display_name ?? configResult?.profile_id ?? 'Not saved'}</p>
            <p>Plugin: {selectedSource?.plugin_key ?? configResult?.plugin_id ?? 'Not saved'}</p>
            <p>Version: {selectedSource?.plugin_version_id ?? configResult?.plugin_version_id ?? 'Not saved'}</p>
            <p>Binding: {selectedSource?.plugin_binding_id ?? configResult?.plugin_binding_id ?? 'Not saved'}</p>
            <p>Plugin status: {selectedSource?.plugin_version_status ?? configResult?.status ?? 'Not saved'}</p>
            <p>
              Onboarding readiness: {configResult?.onboarding_readiness
                ? configResult.onboarding_readiness.ok === true
                  ? 'Ready'
                  : `Blocked (${String(configResult.onboarding_readiness.blocking_count ?? 0)})`
                : 'Not checked'}
            </p>
            <p>Decision: {configResult?.decision_log_id ?? 'Not saved'}</p>
          </div>
        </div>
      </div>

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>Migration run</h2>
            <p>Preview validates stored mapping and rules before workflow execution creates client and recipient records.</p>
          </div>
          <div className="action-row">
            <Button onClick={() => void run('preview')} disabled={!canPreview || busy != null || !selectedSourceId || !selectedProfileId}>
              {busy === 'preview' ? 'Previewing...' : 'Preview'}
            </Button>
            <Button kind="primary" onClick={() => void run('execute')} disabled={!canExecute || busy != null || !selectedSourceId || !selectedProfileId}>
              {busy === 'execute' ? 'Executing...' : 'Execute'}
            </Button>
          </div>
        </div>
        {canPreview && !canExecute ? (
          <p>Client and recipient write access is required to execute. Preview remains available.</p>
        ) : null}
        {!canPreview ? (
          <p>Import write plus client, recipient, audit, and workflow read access are required to preview.</p>
        ) : null}
        <div className="form-grid">
          <label>
            Source
            <select value={selectedSourceId} onChange={(event) => changeSource(event.target.value)}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            Profile
            <select value={selectedProfileId} onChange={(event) => setProfileId(event.target.value)}>
              {profilesForSource.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            External batch ID (required)
            <input
              value={externalBatchId}
              onChange={(event) => setExternalBatchId(event.target.value)}
              placeholder="example-batch-001"
              required
            />
          </label>
        </div>
        <div className="split-panel">
          <label>
            JSON payload (required)
            <textarea
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder={SAMPLE_PAYLOAD}
              rows={14}
              required
            />
          </label>
          <div className="readback-card">
            <h3>Run readback</h3>
            <p>Result: {result ? `${result.status} / ${result.mode}` : 'No run yet'}</p>
            <p>Import job: {result?.import_job_id ?? 'No run yet'}</p>
            <p>Imported client: {importedClient ? String(importedClient.name) : result?.imported_client_id ?? 'Not created'}</p>
            <p>Recipients: {summaryValue(result?.result_summary, 'imported_recipients')}</p>
            <p>
              Imported recipients: {importedRecipients.length > 0
                ? importedRecipients.map((recipient) => recipient.name ?? recipient.id).join(', ')
                : result?.imported_recipient_ids?.join(', ') || 'Not created'}
            </p>
            <p>Validation errors: {summaryValue(result?.validation_summary, 'errors')}</p>
            <p>Redacted fields: {summaryValue(result?.redaction_summary, 'secret_fields_redacted')}</p>
            <p>Idempotency: {result?.idempotency_reused ? 'Existing import job reused' : result ? 'New import job' : 'Not checked'}</p>
            <p>Plugin version: {result?.plugin_version_id ?? 'No run yet'}</p>
            <p>Plugin binding: {result?.plugin_binding_id ?? 'No run yet'}</p>
            <p>Job readback: {importJob ? `${importJob.status} / ${importJob.row_count ?? 0} rows` : 'No run yet'}</p>
            <p>Workflow: {result?.workflow_run_id ?? 'No run yet'}</p>
            <p>Decision: {result?.decision_log_id ?? 'No run yet'}</p>
            <p>Events: {result?.domain_event_ids?.length ?? 0}</p>
            <p>Error: {result?.error?.code ?? 'None'}</p>
          </div>
        </div>
      </div>

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>Migration import jobs</h2>
            <p>Canonical import lifecycle with workflow, plugin, validation, and target lineage.</p>
          </div>
        </div>
        <DataTable
          rows={requests}
          columns={requestColumns}
          viewKey="customer-migration-import-jobs"
          entityKind="migration import job"
          emptyText={requestsQuery.isLoading ? 'Loading migration import jobs...' : 'No migration import jobs yet.'}
        />
      </div>
    </section>
  );
}
