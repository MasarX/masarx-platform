import { describe, expect, it } from 'vitest';
import {
  assertLogisticsCustomerMigrationConfigEvidence,
  assertLogisticsCustomerMigrationResultEvidence,
  isPersistedLogisticsCustomerMigrationOutcome,
  isPersistedLogisticsCustomerMigrationValidationFailure,
  type LogisticsCustomerMigrationConfigResult,
  type LogisticsCustomerMigrationResult,
} from '../customer-logistics-migration';

const configResult: LogisticsCustomerMigrationConfigResult = {
  ok: true,
  source_id: 'source-1',
  profile_id: 'profile-1',
  plugin_id: 'plugin-1',
  plugin_version_id: 'plugin-version-1',
  plugin_binding_id: 'plugin-binding-1',
  decision_log_id: 'decision-1',
  profile_config_sha256: 'a'.repeat(64),
  status: 'configured',
};

const migrationResult: LogisticsCustomerMigrationResult = {
  ok: true,
  request_id: 'request-1',
  import_job_id: 'request-1',
  request_key: 'source-1:batch-1',
  status: 'completed',
  mode: 'execute',
  plugin_id: 'plugin-1',
  plugin_version_id: 'plugin-version-1',
  plugin_binding_id: 'plugin-binding-1',
  imported_recipient_ids: ['recipient-1'],
  validation_summary: {},
  result_summary: {},
  redaction_summary: {},
  workflow_run_id: 'workflow-1',
  decision_log_id: 'decision-1',
  domain_event_ids: ['event-1'],
  migration_item_ids: ['item-1'],
};

describe('customer logistics migration backend evidence contract', () => {
  it('requires every config identity needed for backend readback', () => {
    expect(() => assertLogisticsCustomerMigrationConfigEvidence(configResult)).not.toThrow();
    expect(() => assertLogisticsCustomerMigrationConfigEvidence({
      ...configResult,
      plugin_binding_id: '',
    })).toThrow(/plugin_binding_id backend evidence/i);
  });

  it('requires request, workflow, decision, and summary evidence', () => {
    expect(() => assertLogisticsCustomerMigrationResultEvidence(migrationResult)).not.toThrow();
    expect(() => assertLogisticsCustomerMigrationResultEvidence({
      ...migrationResult,
      workflow_run_id: null,
    })).toThrow(/workflow_run_id backend evidence/i);
  });

  it('recognizes only persisted validation failures as visible backend outcomes', () => {
    expect(isPersistedLogisticsCustomerMigrationValidationFailure({
      ...migrationResult,
      ok: false,
      status: 'failed',
      error: { code: 'validation_failed' },
    })).toBe(true);
    expect(isPersistedLogisticsCustomerMigrationValidationFailure({
      ...migrationResult,
      ok: false,
      status: 'failed',
      import_job_id: '',
      request_id: '',
    })).toBe(false);
  });

  it('accepts only recognized persisted fail-closed outcomes for same-context readback', () => {
    expect(isPersistedLogisticsCustomerMigrationOutcome({
      ...migrationResult,
      ok: false,
      error: { code: 'idempotency_identity_mismatch' },
    })).toBe(true);
    expect(isPersistedLogisticsCustomerMigrationOutcome({
      ...migrationResult,
      ok: false,
      status: 'failed',
      error: { code: 'workflow_progress_failed' },
    })).toBe(true);
    expect(isPersistedLogisticsCustomerMigrationOutcome({
      ...migrationResult,
      ok: false,
      status: 'queued',
      error: { code: 'unknown_backend_failure' },
    })).toBe(false);
    expect(() => assertLogisticsCustomerMigrationResultEvidence({
      ...migrationResult,
      imported_recipient_ids: undefined as never,
    })).toThrow(/imported_recipient_ids backend evidence/i);
  });
});
