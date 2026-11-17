const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '202608161850_runtime_qualification_reconciliation_v1.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('runtime qualification reconciliation v1', () => {
  test('keeps lookup, RLS, FK, ACL, API, and registry contracts fail closed', () => {
    expect(sql).toContain('webhook_source_token_history_service_all');
    expect(sql).toContain("('public', 'intake_auth_rejections', 'service', 'intake_service')");
    expect(sql).toContain("('public', 'webhook_source_token_history', 'retired_reason', 'credential_retired_reason')");
    expect(sql).toContain('idx_outbound_calls_execution_url_vault_id_fk');
    expect(sql).toContain('FROM anon;');
    expect(sql).toContain('CREATE OR REPLACE VIEW api.intake_auth_rejections');
    expect(sql).toContain('CREATE OR REPLACE VIEW api.workflow_templates');
    expect(sql).toContain("'resource', 'senders'");
  });

  test('keeps URL overloads unambiguous and mapping fallbacks row driven', () => {
    const threeArgHeader = sql.match(/CREATE OR REPLACE FUNCTION public\.redact_sensitive_url\([\s\S]*?\)\nRETURNS TEXT/)[0];
    expect(threeArgHeader).not.toContain('DEFAULT');
    expect(sql).toContain("regexp_split_to_array(v_field_spec #>> '{}', '\\s*\\|\\s*')");
    expect(sql).toContain("jsonb_strip_nulls(COALESCE(p_match, '{}'::jsonb) || v_inputs)");
    expect(sql).toContain("value <> 'api_gateway_inbound'");
  });

  test('restores function documentation and keeps the registry base internal', () => {
    expect(sql).toContain('COMMENT ON FUNCTION public.redact_sensitive_url(TEXT, JSONB, BOOLEAN)');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.ui_read_registry_v1_base_202608161850()\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).toContain('Internal 202608161850 base for the governed ui_read_registry_v1 wrapper');
  });

  test('forwards decision metadata and updates current defaults from the canonical profile', () => {
    const defaultAlignmentStart = sql.indexOf('-- Keep first-tenant defaults');
    const defaultAlignmentEnd = sql.indexOf('-- Canonical tenant-review wrapper');
    expect(defaultAlignmentStart).toBeGreaterThan(-1);
    expect(defaultAlignmentEnd).toBeGreaterThan(defaultAlignmentStart);
    const defaultAlignment = sql.slice(defaultAlignmentStart, defaultAlignmentEnd);

    expect(sql).toContain('tenant_signup_review_apply_v1_impl_202605031930');
    expect(sql).toContain('COALESCE(p_decision_metadata');
    expect(defaultAlignment).toContain(
      'v_default JSONB := public.default_shipment_webhook_intake_mapping_config_v1();',
    );
    expect(defaultAlignment).toContain("d.plugin_key = 'default-shipment-webhook-intake'");
    expect(defaultAlignment).not.toContain('FROM public.mapping_configs');
    expect(sql).not.toContain('console_v2');
  });
});
