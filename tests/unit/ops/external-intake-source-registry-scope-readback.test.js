const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '../../../supabase/migrations/202608161300_b3_external_intake_source_registry_scope_readback_v1.sql',
);

describe('External Intake source registry scope readback migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('creates the scoped security-invoker source directory before registering it', () => {
    const helperDefinition = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.webhook_source_directory_policy_summary_v1(',
    );
    const viewDefinition = sql.indexOf(
      'CREATE OR REPLACE VIEW public.v_webhook_source_directory',
    );
    const registryRepair = sql.indexOf('DO $registry$');
    const viewSql = sql.slice(
      viewDefinition,
      sql.indexOf('REVOKE ALL ON public.v_webhook_source_directory'),
    );

    expect(helperDefinition).toBeGreaterThan(-1);
    expect(viewDefinition).toBeGreaterThan(helperDefinition);
    expect(registryRepair).toBeGreaterThan(viewDefinition);
    expect(sql).toContain('WITH (security_invoker = true)');
    expect(sql).toContain(
      'LEFT JOIN LATERAL public.webhook_source_directory_policy_summary_v1(ws.id)',
    );
    expect(viewSql).not.toMatch(/JOIN public\.settings\b/);
    expect(viewSql).not.toContain('public.webhook_rules');
    expect(viewSql).not.toContain('rule_count');
    expect(viewSql).not.toContain('active_rule_count');
  });

  test('keeps the directory helper scoped and secret-safe', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) FROM PUBLIC;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) FROM anon;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) TO authenticated, service_role;',
    );
    expect(sql).toContain('v_user_org := public.current_user_org_id();');
    expect(sql).toContain("WHEN ws.auth_token IS NOT NULL THEN 'stored'");
    expect(sql).not.toMatch(/AS auth_token[,\s]/);
  });

  test('derives canonical templates once and replace-or-appends exactly one of each key', () => {
    expect(sql).toContain("v_source_template JSONB := jsonb_build_object(");
    expect(sql).toContain("v_directory_template JSONB := jsonb_build_object(");
    expect(sql).toContain(
      "WHERE resource->>'key' NOT IN ('webhook_sources', 'webhook_source_directory')",
    );
    expect(sql).toContain("WHERE resource->>'key' = 'webhook_sources'");
    expect(sql).toContain("WHERE resource->>'key' = 'webhook_source_directory'");
    expect(sql).toContain("COALESCE(v_existing_source, '{}'::jsonb) || v_source_template");
    expect(sql).toContain(
      "COALESCE(v_existing_directory, '{}'::jsonb) || v_directory_template",
    );
    expect(sql).toContain(
      'v_filtered || jsonb_build_array(v_source_resource, v_directory_resource)',
    );
    expect(sql).toContain("'key', 'webhook_source_directory'");
    expect(
      sql.match(/'relation', 'public\.v_webhook_source_directory'/g),
    ).toHaveLength(2);
    expect(sql).not.toContain("'relation', 'public.webhook_sources'");
    expect(sql).toContain(') <> 1');
  });

  test('retains executable tenant, client, sender scope assertions', () => {
    for (const [scope, column] of [
      ['tenant', 'organization_id'],
      ['client', 'client_id'],
      ['sender', 'sender_id'],
    ]) {
      expect(sql).toContain(`resource#>>'{scope_columns,${scope}}' = '${column}'`);
    }

    expect(sql).toContain(
      "CROSS JOIN LATERAL jsonb_each_text(COALESCE(resource->'scope_columns', '{}'::jsonb))",
    );
    expect(sql).toContain(
      "column_info.table_schema = split_part(resource->>'relation', '.', 1)",
    );
    expect(sql).toContain('column_info.column_name = scope.column_name');

    expect(sql).toContain(
      "RAISE EXCEPTION 'External Intake source resources are missing, duplicated, or incorrectly scoped in ui_read_registry'",
    );
  });
});
