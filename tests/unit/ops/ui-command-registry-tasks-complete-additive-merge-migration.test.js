const fs = require('fs');
const path = require('path');

describe('tasks.complete additive merge migration chain', () => {
  const mergeMigrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1.sql',
  );
  const unlockRepairPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202604102320_tasks_complete_additive_merge_unlock_repair_v1.sql',
  );

  test('keeps tasks.complete schema additive by field key', () => {
    const body = fs.readFileSync(mergeMigrationPath, 'utf8');

    expect(body).toContain(
      "SELECT pg_advisory_lock(hashtext('202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1'))",
    );
    expect(body).toContain("IF v_command->>'key' = 'tasks.complete' THEN");
    expect(body).toContain("jsonb_strip_nulls(v_existing_field || v_required_field)");
    expect(body).toContain("IF NOT (COALESCE(v_existing_field->>'key', '') = ANY (v_required_keys)) THEN");
    expect(body).toContain("'version', 'v6'");
    expect(body).toContain("'otp_code'");
    expect(body).toContain("'recipient_identity_kind'");
    expect(body).toContain("'recipient_identity_last4'");
    expect(body).toContain("'payment_receipt_context'");
  });

  test('repairs the leaked advisory lock with an append-only follow-up migration', () => {
    const body = fs.readFileSync(unlockRepairPath, 'utf8');

    expect(body).toContain(
      "SELECT pg_advisory_lock(hashtext('202604102320_tasks_complete_additive_merge_unlock_repair_v1'))",
    );
    expect(body).toContain(
      "SELECT pg_advisory_unlock(hashtext('202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1'))",
    );
    expect(body).toContain(
      "SELECT pg_advisory_unlock(hashtext('202604102320_tasks_complete_additive_merge_unlock_repair_v1'))",
    );
  });
});
