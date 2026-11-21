export interface LogisticsCustomerMigrationArgs extends Record<string, unknown> {
  source_id: string;
  profile_id: string;
  external_batch_id: string;
  payload: Record<string, unknown>;
  dry_run?: boolean;
}

export interface LogisticsCustomerMigrationConfigArgs extends Record<string, unknown> {
  source_key?: string;
  display_name: string;
  provider_name?: string | null;
  profile_key?: string;
  profile_display_name?: string;
  auth_mode?: string;
  mapping_rules: Record<string, unknown>;
  validation_rules?: Record<string, unknown>;
  redaction_profile?: Record<string, unknown>;
}

export interface LogisticsCustomerMigrationConfigResult extends Record<string, unknown> {
  ok: boolean;
  source_id: string;
  profile_id: string;
  plugin_id: string;
  plugin_version_id: string;
  plugin_binding_id: string;
  decision_log_id: string;
  profile_config_sha256: string;
  status: string;
  onboarding_readiness?: Record<string, unknown>;
  mapping_summary?: Record<string, unknown>;
  redaction_summary?: Record<string, unknown>;
}

export interface LogisticsCustomerMigrationResult extends Record<string, unknown> {
  ok: boolean;
  request_id: string;
  import_job_id: string;
  request_key: string;
  status: string;
  mode: string;
  plugin_id: string;
  plugin_version_id: string;
  plugin_binding_id: string;
  imported_client_id?: string | null;
  imported_recipient_ids: string[];
  validation_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  redaction_summary: Record<string, unknown>;
  workflow_run_id?: string | null;
  workflow_progress?: Record<string, unknown> | null;
  decision_log_id?: string | null;
  domain_event_ids: string[];
  migration_item_ids: string[];
  idempotency_reused?: boolean;
  error?: { code?: string; details?: unknown };
}

const PERSISTED_FAIL_CLOSED_MIGRATION_CODES: ReadonlySet<string> = new Set([
  'idempotency_identity_mismatch',
  'import_job_cancelled',
  'migration_execution_failed',
  'workflow_progress_failed',
  'workflow_progress_not_terminal',
]);

function requireNonEmptyStringField(
  result: Record<string, unknown>,
  field: string,
  contract: string,
): void {
  if (typeof result[field] !== 'string' || !String(result[field]).trim()) {
    throw new Error(`${contract} did not return ${field} backend evidence`);
  }
}

function requireObjectField(
  result: Record<string, unknown>,
  field: string,
  contract: string,
): void {
  const value = result[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${contract} did not return ${field} backend evidence`);
  }
}

export function assertLogisticsCustomerMigrationConfigEvidence(
  result: LogisticsCustomerMigrationConfigResult,
): void {
  const contract = 'Customer migration config';
  for (const field of [
    'source_id',
    'profile_id',
    'plugin_id',
    'plugin_version_id',
    'plugin_binding_id',
    'decision_log_id',
    'profile_config_sha256',
  ]) {
    requireNonEmptyStringField(result, field, contract);
  }
}

export function assertLogisticsCustomerMigrationResultEvidence(
  result: LogisticsCustomerMigrationResult,
): void {
  const contract = 'Customer migration';
  for (const field of [
    'request_id',
    'import_job_id',
    'request_key',
    'status',
    'mode',
    'plugin_id',
    'plugin_version_id',
    'plugin_binding_id',
    'workflow_run_id',
    'decision_log_id',
  ]) {
    requireNonEmptyStringField(result, field, contract);
  }
  for (const field of ['validation_summary', 'result_summary', 'redaction_summary']) {
    requireObjectField(result, field, contract);
  }
  for (const field of ['imported_recipient_ids', 'domain_event_ids', 'migration_item_ids']) {
    if (!Array.isArray(result[field])) {
      throw new Error(`${contract} did not return ${field} backend evidence`);
    }
  }
}

export function isPersistedLogisticsCustomerMigrationValidationFailure(
  result: LogisticsCustomerMigrationResult,
): boolean {
  return result.ok === false
    && result.status === 'failed'
    && result.error?.code === 'validation_failed'
    && Boolean(result.import_job_id || result.request_id);
}

export function isPersistedLogisticsCustomerMigrationOutcome(
  result: LogisticsCustomerMigrationResult,
): boolean {
  const errorCode = result.error?.code;
  return result.ok === false
    && typeof errorCode === 'string'
    && PERSISTED_FAIL_CLOSED_MIGRATION_CODES.has(errorCode)
    && Boolean(result.import_job_id || result.request_id)
    && Boolean(result.workflow_run_id)
    && Boolean(result.decision_log_id);
}
