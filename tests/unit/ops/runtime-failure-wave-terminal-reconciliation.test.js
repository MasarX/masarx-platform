const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('runtime failure-wave terminal reconciliation', () => {
  const migration = read(
    'supabase/migrations/202608161870_runtime_failure_wave_terminal_reconciliation_v1.sql',
  );

  test('owns marketplace request creation in the exact scope without global-base fallback', () => {
    expect(migration).toContain("'marketplace_participant_request:' || v_scope_key");
    expect(migration).toContain('INSERT INTO public.marketplace_participant_requests');
    expect(migration).not.toMatch(/RETURN\s+public\.marketplace_participant_request_create_v1_base_/i);
    expect(migration).toContain("'dedupe_reason', v_dedupe_reason");
    expect(migration).not.toMatch(/'application_status_token',\s*v_existing\.public_status_token/i);
  });

  test('uses canonical participant lineage with bounded legacy read compatibility', () => {
    expect(migration).toContain("dd.metadata->>'marketplace_participant_request_id'");
    expect(migration).toContain("dce.payload->>'marketplace_participant_request_id'");
    expect(migration).toContain("dd.metadata->>'marketplace_request_id'");
    expect(migration).toContain("dce.payload->>'marketplace_request_id'");
    expect(migration).toContain("'decision_category', 'Canonical decision categories'");
    expect(migration).toContain("'fleet.driver_assigned'");
  });

  test('converges webhook policy schema and every settings scope to version three', () => {
    expect(migration).toContain("'{properties,workflow}'");
    expect(migration).toContain("'templates_by_intent'");
    expect(migration).toContain("'webhook_ingest_policy', 3");
    expect(migration).toMatch(/upsert_settings_value_v1\([\s\S]*v_setting\.value, 3/i);
  });

  test('routes invalid legacy address JSON to manual review and derives shipment lineage', () => {
    expect(migration).toMatch(/WHEN invalid_text_representation THEN/);
    expect(migration).toContain("'manual_review_reason', 'address_raw_input_not_json'");
    expect(migration).toContain('geocoding_manual_review_queue_task_sync_v1_base_202608161870');
    expect(migration).toContain('sender_id = COALESCE(v_review.sender_id, v_shipment.sender_id)');
    expect(migration).toContain('manual-review sender lineage conflicts with shipment');
  });

  test('keeps runtime fixtures aligned with current database contracts', () => {
    const ingress = read('supabase/tests/pgtap/0zz_ingress_persisted_header_redaction_v1.sql');
    const webhook = read('supabase/tests/pgtap/0zz_webhook_async_typed_intent_normalization_v1.sql');
    const auth = read('tests/e2e/utils/auth.ts');
    expect(ingress).toContain('workflow_run_step_id, created_at');
    expect(ingress).toContain('ingress audit evidence removes protected forwarding URLs');
    expect(webhook).toContain('COALESCE(s.cached_value, sv.value');
    expect(auth).toContain('form:has(input[name="email"]):visible');
    expect(auth).toContain('await expect(passwordMethodRadio).toBeChecked');
    expect(auth).toMatch(
      /if \(await recoverAuthenticatedShell\(\)\) \{[\s\S]*?return;[\s\S]*?\}\s*await ensurePasswordSubmissionReady\(\);\s*try\s*\{\s*await signInButton\.click/,
    );
  });
});
