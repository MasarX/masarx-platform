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
import { fill, useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
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
      { key: 'request_key', label: t('integrationsCustomerMigration.customerMigrationModule.request') },
      { key: 'mode', label: t('integrationsCustomerMigration.customerMigrationModule.mode') },
      {
        key: 'status',
        label: t('integrationsCustomerMigration.customerMigrationModule.status'),
        render: (_raw, row) => <Chip kind={statusTone(row.status)} label={row.status} />,
      },
      {
        key: 'validation',
        label: t('integrationsCustomerMigration.customerMigrationModule.validation'),
        render: (_raw, row) =>
          `${summaryValue(row.validation_summary, 'clients')} client / ${summaryValue(row.validation_summary, 'recipients')} recipients / ${summaryValue(row.validation_summary, 'errors')} errors`,
      },
      {
        key: 'redaction',
        label: t('integrationsCustomerMigration.customerMigrationModule.redaction'),
        render: (_raw, row) => `${summaryValue(row.redaction_summary, 'secret_fields_redacted')} fields`,
      },
      { key: 'workflow_run_id', label: t('integrationsCustomerMigration.customerMigrationModule.workflowRun') },
      { key: 'decision_log_id', label: t('integrationsCustomerMigration.customerMigrationModule.decision') },
      { key: 'updated_at', label: t('integrationsCustomerMigration.customerMigrationModule.updated') },
    ],
    [t],
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
      pushToast(t('integrationsCustomerMigration.customerMigrationModule.migrationConfigSaved'), 'good');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : t('integrationsCustomerMigration.customerMigrationModule.configSaveFailed'), 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function run(mode: 'preview' | 'execute') {
    if ((mode === 'execute' ? !canExecute : !canPreview) || !selectedSourceId || !selectedProfileId) return;
    const batchId = externalBatchId.trim();
    if (!batchId || !payload.trim()) {
      pushToast(t('integrationsCustomerMigration.customerMigrationModule.enterAnExternalBatch'), 'warn');
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
            ? t('integrationsCustomerMigration.customerMigrationModule.migrationValidationFailed')
            : t('integrationsCustomerMigration.customerMigrationModule.migrationFailed')
          : mode === 'preview'
            ? t('integrationsCustomerMigration.customerMigrationModule.migrationPreviewReady')
            : t('integrationsCustomerMigration.customerMigrationModule.customerMigrationExecuted'),
        response.ok === false ? 'warn' : 'good',
      );
    } catch (err) {
      await Promise.all([requestsQuery.refetch(), importJobsQuery.refetch()]);
      pushToast(err instanceof Error ? err.message : t('integrationsCustomerMigration.customerMigrationModule.migrationFailed'), 'danger');
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
        title={t('integrationsCustomerMigration.customerMigrationModule.customerMigrationIsNot')}
        hint={t('integrationsCustomerMigration.customerMigrationModule.integrationPluginAndImport')}
      />
    );
  }

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow={t('integrationsCustomerMigration.customerMigrationModule.integrations')}
        titleAccent={t('integrationsCustomerMigration.customerMigrationModule.titleAccent')}
        titlePlain={t('integrationsCustomerMigration.customerMigrationModule.titlePlain')}
      />

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>{t('integrationsCustomerMigration.customerMigrationModule.pluginConfig')}</h2>
            <p>{t('integrationsCustomerMigration.customerMigrationModule.sourceProfileAndMapping')}</p>
          </div>
          <div className="action-row">
            <Button onClick={() => void saveConfig()} disabled={!canConfigure || busy != null}>
              {busy === 'config' ? t('integrationsCustomerMigration.customerMigrationModule.saving') : t('integrationsCustomerMigration.customerMigrationModule.saveConfig')}
            </Button>
          </div>
        </div>
        <div className="form-grid">
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.sourceName')}
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.sourceKey')}
            <input value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} />
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.provider')}
            <input value={providerName} onChange={(event) => setProviderName(event.target.value)} />
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.profileName')}
            <input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.profileKey')}
            <input value={profileKey} onChange={(event) => setProfileKey(event.target.value)} />
          </label>
        </div>
        <div className="split-panel">
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.mappingRules')}
            <textarea value={mappingRules} onChange={(event) => setMappingRules(event.target.value)} rows={12} />
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.validationRules')}
            <textarea value={validationRules} onChange={(event) => setValidationRules(event.target.value)} rows={12} />
          </label>
        </div>
        {!canConfigure ? (
          <p>{t('integrationsCustomerMigration.customerMigrationModule.pluginReadWriteTest')}</p>
        ) : null}
        <div className="split-panel">
          <div className="readback-card">
            <h3>{t('integrationsCustomerMigration.customerMigrationModule.configReadback')}</h3>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.source'), { value: String(selectedSource?.display_name ?? configResult?.source_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.profile'), { value: String(selectedProfile?.display_name ?? configResult?.profile_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.plugin'), { value: String(selectedSource?.plugin_key ?? configResult?.plugin_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.version'), { value: String(selectedSource?.plugin_version_id ?? configResult?.plugin_version_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.binding'), { value: String(selectedSource?.plugin_binding_id ?? configResult?.plugin_binding_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.pluginStatus'), { value: String(selectedSource?.plugin_version_status ?? configResult?.status ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
            <p>
              {fill(t('integrationsCustomerMigration.customerMigrationModule.onboardingReadiness'), { value: String(configResult?.onboarding_readiness
                ? configResult.onboarding_readiness.ok === true
                  ? t('integrationsCustomerMigration.customerMigrationModule.ready')
                  : fill(t('integrationsCustomerMigration.customerMigrationModule.blocked'), { value: String(String(configResult.onboarding_readiness.blocking_count ?? 0)) })
                : t('integrationsCustomerMigration.customerMigrationModule.notChecked')) })}
            </p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.decision2'), { value: String(configResult?.decision_log_id ?? t('integrationsCustomerMigration.customerMigrationModule.notSaved')) })}</p>
          </div>
        </div>
      </div>

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>{t('integrationsCustomerMigration.customerMigrationModule.migrationRun')}</h2>
            <p>{t('integrationsCustomerMigration.customerMigrationModule.previewValidatesStoredMapping')}</p>
          </div>
          <div className="action-row">
            <Button onClick={() => void run('preview')} disabled={!canPreview || busy != null || !selectedSourceId || !selectedProfileId}>
              {busy === 'preview' ? t('integrationsCustomerMigration.customerMigrationModule.previewing') : t('integrationsCustomerMigration.customerMigrationModule.preview')}
            </Button>
            <Button kind="primary" onClick={() => void run('execute')} disabled={!canExecute || busy != null || !selectedSourceId || !selectedProfileId}>
              {busy === 'execute' ? t('integrationsCustomerMigration.customerMigrationModule.executing') : t('integrationsCustomerMigration.customerMigrationModule.execute')}
            </Button>
          </div>
        </div>
        {canPreview && !canExecute ? (
          <p>{t('integrationsCustomerMigration.customerMigrationModule.clientAndRecipientWrite')}</p>
        ) : null}
        {!canPreview ? (
          <p>{t('integrationsCustomerMigration.customerMigrationModule.importWritePlusClient')}</p>
        ) : null}
        <div className="form-grid">
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.source2')}
            <select value={selectedSourceId} onChange={(event) => changeSource(event.target.value)}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.profile2')}
            <select value={selectedProfileId} onChange={(event) => setProfileId(event.target.value)}>
              {profilesForSource.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.externalBatchIdRequired')}
            <input
              value={externalBatchId}
              onChange={(event) => setExternalBatchId(event.target.value)}
              placeholder={t('integrationsCustomerMigration.customerMigrationModule.exampleBatch001')}
              required
            />
          </label>
        </div>
        <div className="split-panel">
          <label>
            {t('integrationsCustomerMigration.customerMigrationModule.jsonPayloadRequired')}
            <textarea
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder={SAMPLE_PAYLOAD}
              rows={14}
              required
            />
          </label>
          <div className="readback-card">
            <h3>{t('integrationsCustomerMigration.customerMigrationModule.runReadback')}</h3>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.result'), { value: String(result ? `${result.status} / ${result.mode}` : t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.importJob'), { value: String(result?.import_job_id ?? t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.importedClient'), { value: String(importedClient ? String(importedClient.name) : result?.imported_client_id ?? t('integrationsCustomerMigration.customerMigrationModule.notCreated')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.recipients'), { value: String(summaryValue(result?.result_summary, 'imported_recipients')) })}</p>
            <p>
              {fill(t('integrationsCustomerMigration.customerMigrationModule.importedRecipients'), { value: String(importedRecipients.length > 0
                ? importedRecipients.map((recipient) => recipient.name ?? recipient.id).join(', ')
                : result?.imported_recipient_ids?.join(', ') || t('integrationsCustomerMigration.customerMigrationModule.notCreated')) })}
            </p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.validationErrors'), { value: String(summaryValue(result?.validation_summary, 'errors')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.redactedFields'), { value: String(summaryValue(result?.redaction_summary, 'secret_fields_redacted')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.idempotency'), { value: String(result?.idempotency_reused ? t('integrationsCustomerMigration.customerMigrationModule.existingImportJobReused') : result ? t('integrationsCustomerMigration.customerMigrationModule.newImportJob') : t('integrationsCustomerMigration.customerMigrationModule.notChecked')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.pluginVersion'), { value: String(result?.plugin_version_id ?? t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.pluginBinding'), { value: String(result?.plugin_binding_id ?? t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.jobReadback'), { value: String(importJob ? fill(t('integrationsCustomerMigration.customerMigrationModule.rows'), { status: String(importJob.status), value: String(importJob.row_count ?? 0) }) : t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.workflow'), { value: String(result?.workflow_run_id ?? t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.decision2'), { value: String(result?.decision_log_id ?? t('integrationsCustomerMigration.customerMigrationModule.noRunYet')) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.events'), { value: String(result?.domain_event_ids?.length ?? 0) })}</p>
            <p>{fill(t('integrationsCustomerMigration.customerMigrationModule.error'), { value: String(result?.error?.code ?? t('integrationsCustomerMigration.customerMigrationModule.none')) })}</p>
          </div>
        </div>
      </div>

      <div className="surface-panel">
        <div className="section-header">
          <div>
            <h2>{t('integrationsCustomerMigration.customerMigrationModule.migrationImportJobs')}</h2>
            <p>{t('integrationsCustomerMigration.customerMigrationModule.canonicalImportLifecycleWith')}</p>
          </div>
        </div>
        <DataTable
          rows={requests}
          columns={requestColumns}
          viewKey="customer-migration-import-jobs"
          entityKind="migration import job"
          emptyText={requestsQuery.isLoading ? t('integrationsCustomerMigration.customerMigrationModule.loadingMigrationImportJobs') : t('integrationsCustomerMigration.customerMigrationModule.noMigrationImportJobs')}
        />
      </div>
    </section>
  );
}
