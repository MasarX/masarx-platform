const fs = require('fs');
const path = require('path');

const migrationName = '202607051030_webhook_source_binding_failure_readback_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

describe('external intake webhook source-binding failure readback migration', () => {
  test('persists sender/client binding failures as terminal webhook inbox rows', () => {
    const sql = readMigration();

    expect(sql).toContain('webhook_source_missing_sender_client_inbox_readback_v1');
    expect(sql).toContain('PERFORM insert_webhook_inbox_record(');
    expect(sql).toContain("processing_status = 'failed'");
    expect(sql).toContain('processed_at = now()');
    expect(sql).toContain('error_message = v_ack_reason');
    expect(sql).toContain("ack_outcome = 'ack_failed'");
    expect(sql).toContain("ack_reason = 'webhook_source_missing_sender_client'");
    expect(sql).toContain("p_resource_type := 'webhook_inbox'");
  });

  test('preserves idempotency and replay readback without starting workflow state', () => {
    const sql = readMigration();

    expect(sql).toContain("v_idempotency_key := NULLIF(v_headers->>lower(COALESCE(v_idempotency_config->>'header', 'Idempotency-Key')), '')");
    expect(sql).toContain('FROM webhook_ack_history');
    expect(sql).toContain("p_decision_outcome := 'response_replayed'");
    expect(sql).toContain("'ack_outcome', 'ack_replayed'");
    expect(sql).toContain("'workflow_run_id', NULL");
    expect(sql).toContain("'followup_workflow_run_id', NULL");
  });

  test('keeps the patch bounded and append-only', () => {
    const sql = readMigration();

    expect(sql).toContain("pg_advisory_lock(hashtext('202607051030_webhook_source_binding_failure_readback_v1'))");
    expect(sql).toContain("pg_advisory_unlock(hashtext('202607051030_webhook_source_binding_failure_readback_v1'))");
    expect(sql).toContain("COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)");
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/TRUNCATE\s+/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\./i);
  });
});
