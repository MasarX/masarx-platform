const fs = require('fs');
const path = require('path');

describe('shipment batch result contract migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161530_b3_shipment_batch_result_contract_v1.sql',
  );
  const body = fs.readFileSync(migrationPath, 'utf8');

  test('uses an append-only, scoped and advisory-locked migration', () => {
    expect(body).toContain(
      "SELECT pg_advisory_lock(hashtext('202607181200_shipment_batch_result_contract_v1'))",
    );
    expect(body).toContain("WHERE s.category = 'ui_command_registry'");
    expect(body).toContain('ORDER BY s.scope_type, s.scope_id NULLS FIRST, s.id');
    expect(body).toContain('IF v_delete_count <> 1 OR v_reschedule_count <> 1 THEN');
    expect(body).toContain(
      "SELECT pg_advisory_unlock(hashtext('202607181200_shipment_batch_result_contract_v1'))",
    );
  });

  test('adds only the nested result discriminator and preserves command objects', () => {
    expect(body).toContain("v_command->>'key' IN ('shipments.delete', 'shipments.reschedule')");
    expect(body).toContain("'{execution,result_contract}'");
    expect(body).toContain("to_jsonb('batch_items_v1'::TEXT)");
    expect(body).toContain(
      'v_updated_commands := v_updated_commands || jsonb_build_array(v_command)',
    );
    expect(body).not.toContain('v_canonical_commands');
  });

  test('extends the active schema without replacing its existing JSON schema', () => {
    expect(body).toContain(
      "'{properties,commands,items,properties,execution,properties,result_contract}'",
    );
    expect(body).toContain("'enum', jsonb_build_array('batch_items_v1')");
    expect(body).toContain("WHERE category = 'ui_command_registry'");
    expect(body).toContain('AND is_active = TRUE');
    expect(body).not.toMatch(/SET\s+schema\s*=\s*jsonb_build_object/i);
  });
});
