const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const migration = fs.readFileSync(
  path.join(repoRoot, 'supabase', 'migrations', '202605041345_console_v2_live_contract_closure_v1.sql'),
  'utf8',
);
const vehicleCreateMigration = fs.readFileSync(
  path.join(repoRoot, 'supabase', 'migrations', '202605041630_console_v2_vehicle_live_paths_v1.sql'),
  'utf8',
);
const dataSource = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'data-source.ts'),
  'utf8',
);
const api = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'api.ts'),
  'utf8',
);
const queries = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'queries.ts'),
  'utf8',
);

function expectDataSourceRpcExport(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constWrapper = new RegExp(
    `${escapedName}\\s*=\\s*\\(args:[\\s\\S]*phaseC6Rpc\\('${escapedName}'`,
  );
  const asyncFunctionWrapper = new RegExp(
    `export\\s+async\\s+function\\s+${escapedName}\\s*\\([^)]*args[^)]*\\)[\\s\\S]*?phaseC6Rpc\\('${escapedName}'`,
  );

  expect(constWrapper.test(dataSource) || asyncFunctionWrapper.test(dataSource)).toBe(true);
}

describe('Console V2 live contract closure', () => {
  test('adds canonical feature flag create/update RPCs and wires Console V2 to them', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.create_feature_flag_v1(p_args jsonb)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.update_feature_flag_v1(p_args jsonb)');
    expect(migration).toContain("PERFORM public.assert_capability_v1('feature_flags.write')");
    expect(migration).toContain('INSERT INTO public.feature_flags');
    expect(migration).toMatch(/jsonb_set\(\s*v_conditions,\s*'\{scopes\}'/);
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.v_feature_flag_summary\s+WITH \(security_invoker = true\)/);
    expect(migration).toContain('COALESCE(NULLIF(btrim(ff.conditions->>\'label\'), \'\'), initcap(replace(ff.name, \'_\', \' \'))) AS label');

    expect(dataSource).toMatch(/create_feature_flag_v1\s*=\s*\(args:[\s\S]*phaseC6Rpc\('create_feature_flag_v1'/);
    expect(dataSource).toMatch(/update_feature_flag_v1\s*=\s*\(args:[\s\S]*phaseC6Rpc\('update_feature_flag_v1'/);
    expect(dataSource).not.toMatch(/create_feature_flag_v1[\s\S]{0,160}toggle_feature_flag_v1/);
    expect(api).toContain('export const update_feature_flag_v1');
    expect(queries).toContain('export function useUpdateFeatureFlag()');
  });

  test('adds provider credential upsert with tenant scope and credential-source guards', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)');
    expect(migration).toContain("PERFORM public.assert_capability_v1('integration_plugins.write')");
    expect(migration).toContain('public.current_user_org_id()');
    expect(migration).toContain('public.is_platform_user()');
    expect(migration).toContain('credentials_vault_id');
    expect(migration).toContain('requires credentials or credentials_vault_id for create');
    expect(migration).toMatch(/SELECT pac\.provider_id, p\.organization_id[\s\S]*INTO v_existing_provider_id, v_target_org[\s\S]*FROM public\.provider_auth_configs pac[\s\S]*JOIN public\.providers p ON p\.id = pac\.provider_id/);
    expect(migration).toMatch(/ELSIF v_provider_id <> v_existing_provider_id THEN[\s\S]*belongs to provider/);
    expect(migration).toMatch(/INSERT INTO public\.provider_auth_configs[\s\S]*credentials_vault_id/);
    expect(migration).toMatch(/UPDATE public\.provider_auth_configs[\s\S]*credentials_vault_id = COALESCE[\s\S]*WHERE id = v_config_id[\s\S]*AND provider_id = v_provider_id/);
  });

  test('adds vehicle create RPC and wires Console V2 fleet creation to it', () => {
    expect(vehicleCreateMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.create_vehicle_v1\(p_args JSONB\)/);
    expect(vehicleCreateMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.upload_vehicle_document_v1\(p_args JSONB\)/);
    expect(vehicleCreateMigration).toContain("PERFORM public.assert_capability_v1('fleet.write'");
    expect(vehicleCreateMigration).toContain("ld.category = 'vehicle_status'");
    expect(vehicleCreateMigration).toContain("ld.category = 'vehicle_document_kind'");
    expect(vehicleCreateMigration).toContain('INSERT INTO public.vehicles');
    expect(vehicleCreateMigration).toContain('INSERT INTO public.vehicle_documents');
    expect(vehicleCreateMigration).toMatch(/CREATE OR REPLACE FUNCTION api\.create_vehicle_v1\(p_args JSONB\)/);
    expect(vehicleCreateMigration).toMatch(/CREATE OR REPLACE FUNCTION api\.upload_vehicle_document_v1\(p_args JSONB\)/);
    expectDataSourceRpcExport('create_vehicle_v1');
    expectDataSourceRpcExport('upload_vehicle_document_v1');
    expect(api).toContain('export const create_vehicle_v1');
    expect(api).toContain('export const upload_vehicle_document_v1');
    expect(queries).toContain('export function useCreateVehicle()');
    expect(queries).toContain('export function useUploadVehicleDocument()');
  });

  test('exposes browser-safe api wrappers for Console V2 lifecycle RPC groups', () => {
    const wrapperNames = [
      'create_support_case_v1',
      'update_support_case_v1',
      'assign_support_case_v1',
      'bulk_assign_support_cases_v1',
      'resolve_support_case_v1',
      'bulk_resolve_support_cases_v1',
      'reopen_support_case_v1',
      'send_support_message_v1',
      'add_support_tag_v1',
      'plugin_submit_v1',
      'plugin_approve_v1',
      'plugin_activate_v1',
      'plugin_set_binding_v1',
      'create_feature_flag_v1',
      'update_feature_flag_v1',
      'toggle_feature_flag_v1',
      'engage_kill_switch_v1',
      'release_kill_switch_v1',
      'set_rollout_v1',
      'bulk_toggle_feature_flags_v1',
      'pause_alert_rule_v1',
      'resume_alert_rule_v1',
      'test_alert_rule_v1',
      'acknowledge_ops_alert_v1',
      'resolve_ops_alert_v1',
      'complete_maintenance_v1',
      'cancel_maintenance_v1',
      'record_vehicle_event_v1',
      'ui_upsert_provider_auth_config_v1',
      'ui_revoke_provider_auth_config_v1',
      'integration_plugin_rotate_credentials_v1',
    ];

    for (const name of wrapperNames) {
      expect(migration).toContain(`'${name}'`);
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION api.${name}(%s)`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION api.${name}(%s) FROM PUBLIC, anon`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION api.${name}(%s) TO authenticated, service_role`);
    }

    expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS api');
    expect(dataSource).toContain("client.schema('api')");
    expect(migration).toContain('Console V2 api-schema wrapper for public.');
  });

  test('keeps the migration bounded and append-only', () => {
    expect(migration).toContain("SELECT pg_advisory_lock(hashtext('202605041345_console_v2_live_contract_closure_v1'))");
    expect(migration).toContain("SELECT pg_advisory_unlock(hashtext('202605041345_console_v2_live_contract_closure_v1'))");
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/TRUNCATE\s+/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\./i);
  });
});
