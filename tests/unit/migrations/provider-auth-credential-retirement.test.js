const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const sql = read('supabase/migrations/20261020133000_provider_auth_credential_retirement_v1.sql');
const command = JSON.parse(sql.match(/v_command JSONB := \$command\$([\s\S]*?)\$command\$::JSONB/)[1]);

describe('provider credential retirement boundary', () => {
  test('uses current actor capability, provider RBAC and tenant boundaries without service bypass', () => {
    expect(sql).toContain("auth.role() IS DISTINCT FROM 'authenticated'");
    expect(sql).toContain('OR public.request_role_is_service_v1()');
    expect(sql).toContain("public.assert_capability_v1('integration_plugins.write')");
    expect(sql).toContain('public.user_can_write() IS NOT TRUE');
    expect(sql).toContain("public.user_has_permission_v1('agreements.write', v_config.organization_id) IS NOT TRUE");
    expect(sql).toContain('public.is_platform_user() OR p.organization_id = v_actor_org');
    expect(sql).toContain('FOR UPDATE OF pac, p');
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]+TO[^;]*service_role/i);
  });

  test('retires only the selected row without deleting configurations or Vault payloads', () => {
    expect(sql).toContain('cardinality(p_selection_ids) IS DISTINCT FROM 1');
    expect(sql).toContain('p_selection_ids[1] IS DISTINCT FROM p_selection_id');
    expect(sql).toMatch(/UPDATE public\.provider_auth_configs[\s\S]+credentials_vault_id = NULL,[\s\S]+expires_at = v_now\s+WHERE id = v_id;/);
    expect(sql).not.toMatch(/DELETE FROM public\.provider_auth_configs|UPDATE vault\.|DELETE[^;]*vault\.|CREATE TABLE/i);
    expect(sql).toContain("v_config.credentials - ARRAY['revoked', 'revoked_at', 'revoked_by', 'reason', 'correlation_id'] = '{}'::JSONB");
    expect(sql).toContain("'idempotent_no_op', TRUE");
  });

  test('keeps shared audit snapshots secret-safe without weakening existing redaction', () => {
    expect(sql).toContain("audit_redaction_rules.mode = 'allowlist'");
    expect(sql).toContain("array_remove(array_remove(audit_redaction_rules.columns, 'credentials'), 'credentials_vault_id')");
    expect(sql).toContain('audit_redaction_rules.columns || EXCLUDED.columns');
    expect(sql).not.toMatch(/SET mode\s*=|redaction_token\s*=/i);
    const evidence = sql.slice(sql.indexOf('v_decision := public.log_decision('), sql.indexOf('PERFORM set_config', sql.indexOf('v_decision := public.log_decision(')));
    expect(evidence).not.toMatch(/v_config\.credentials|to_jsonb\(v_config|row_to_json/i);
    expect(sql).toContain('v_correlation UUID := gen_random_uuid()');
    expect(sql).not.toContain('gen_random_bytes');
    expect(sql).toContain("p_decision_reason := v_reason");
    expect(sql.match(/COALESCE\(v_previous_correlation, ''\)/g)).toHaveLength(2);
  });

  test('binds to the existing provider ResourcePage and its exact reasoned command envelope', () => {
    expect(read('apps/console/app/integrations/provider-auth/page.tsx')).toContain('resourceKey="provider_auth_configs"');
    expect(command).toMatchObject({
      key: 'provider_auth_configs.retire', capability: 'integration_plugins.write',
      schema_category: 'resource:provider_auth_configs',
      selection: { mode: 'single', min_count: 1, max_count: 1 },
      execution: { type: 'rpc', rpc: 'ui_retire_provider_auth_config_v1',
        input_schema: { fields: [{ key: 'reason', type: 'textarea', required: true }] } },
    });
    const consumer = read('packages/ui/src/bulk-actions.tsx');
    expect(consumer).toContain('action?.execution?.input_schema?.fields');
    for (const key of ['p_action_key', 'p_resource_key', 'p_selection_ids', 'p_selection_id', 'p_selection_count', 'p_params']) {
      expect(consumer).toContain(`${key}:`);
      expect(sql).toMatch(new RegExp(`${key} (?:TEXT|INTEGER|JSONB)`));
    }
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('public.ui_retire_provider_auth_config_v1($1, $2, $3, $4, $5, $6)');
  });

  test('keeps native role, redaction, retained-row and retry qualification explicit', () => {
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_credential_retirement_v1.sql');
    for (const boundary of ['SET LOCAL ROLE authenticated', 'SET LOCAL ROLE anon', 'SET LOCAL ROLE service_role',
      'vault.decrypted_secrets', 'audit_table_changes', 'decision_log', 'domain_events', 'idempotent_no_op',
      'foreign configuration', 'read-only actor', 'missing RBAC', 'legacy revoked marker', 'correlation context']) {
      expect(fixture).toContain(boundary);
    }
    expect(fixture.trim()).toMatch(/ROLLBACK;$/);
  });

  test('native safe readback uses the canonical UUID resource ID instead of a nonexistent text overload', () => {
    const readApi = read('supabase/migrations/202604171030_ui_read_security_invoker_views_v1.sql');
    expect(readApi).toMatch(/CREATE OR REPLACE FUNCTION public\.ui_get_resource_v1\(\s*p_resource TEXT,\s*p_id UUID\s*\)/);
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_credential_retirement_v1.sql');
    expect(fixture).toMatch(/v_config UUID := gen_random_uuid\(\)/);
    expect(fixture).toContain("api.ui_get_resource_v1('provider_auth_configs',v_config);");
    expect(fixture).not.toMatch(/api\.ui_get_resource_v1\([^;]*::TEXT\s*\)/i);
  });

  test('provider readback adds an invoker safe projection without credentials or Vault references', () => {
    const repair = read('supabase/migrations/20261026180000_provider_auth_safe_readback_v1.sql');
    const projection = repair.slice(repair.indexOf('CREATE VIEW'), repair.indexOf('COMMENT ON VIEW'));
    expect(projection).toContain('security_invoker = true, security_barrier = true');
    expect(projection.match(/SELECT ([\s\S]*?)\nFROM/)[1].replace(/\s/g, '')).toBe(
      'pac.id,pac.provider_id,pac.auth_type,pac.expires_at,pac.created_at,pac.updated_at');
    expect(projection).toContain("public.user_has_resource_capability_v1('provider_auth_configs', 'read')");
    expect(projection).toContain('public.is_platform_user() OR p.organization_id = public.current_user_org_id()');
    expect(repair).toContain('REVOKE ALL ON public.provider_auth_configs_visible_v1 FROM PUBLIC, anon');
    expect(repair).toContain('GRANT SELECT ON public.provider_auth_configs_visible_v1 TO authenticated, service_role');
    expect(repair).toContain("WHERE s.category = 'ui_read_registry'");
    expect(repair).toContain('FOR UPDATE OF s, sv');
    expect(repair).toContain("jsonb_set(resource, '{relation}', '\"public.provider_auth_configs_visible_v1\"'::JSONB)");
    expect(repair).toContain("'ui_read_registry', v_row.scope_type, v_row.scope_id, v_value, v_row.schema_version");
    expect(repair).not.toMatch(/UPDATE public\.settings_versions|ALTER (?:FUNCTION|POLICY|TABLE)|DELETE FROM public\.provider_auth_configs/i);
    expect(repair).toContain("cache_key LIKE 'ui_read_registry:%'");
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_credential_retirement_v1.sql');
    expect(fixture.indexOf('v_active_readback :=')).toBeLessThan(fixture.indexOf('EXECUTE v_call INTO v_result'));
    expect(fixture).toContain("v_foreign_readback := api.ui_get_resource_v1('provider_auth_configs',v_foreign)");
    expect(fixture).toContain('v_foreign_readback IS NULL');
  });

  test('provider read routing remains global and visible-view backed', () => {
    const repair = read('supabase/migrations/20261029140000_provider_auth_read_relation_v1.sql');
    expect(repair).toContain('v_row.scope_type = public.get_root_scope_type_key_v1() AND v_row.scope_id IS NULL');
    expect(repair).toContain("'{relation}', '\"public.provider_auth_configs_visible_v1\"'::JSONB");
    expect(repair).toContain("- 'read_relation'");
    expect(repair).toContain('ELSE resource END ORDER BY ordinal');
    expect(repair).toContain('v_row.scope_type, v_row.scope_id, v_value, v_row.schema_version');
    expect(repair).toContain('has no global provider_auth_configs resource');
    expect(repair).toContain('has duplicate provider_auth_configs resources');
    expect(repair).not.toMatch(/UPDATE public\.settings_versions|CREATE(?: OR REPLACE)? (?:FUNCTION|VIEW)|ALTER (?:FUNCTION|POLICY|TABLE)/i);
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_credential_retirement_v1.sql');
    expect(fixture).toContain("resource->>'relation' IS DISTINCT FROM 'public.provider_auth_configs_visible_v1'");
    expect(fixture).toContain('provider read routing remains on the visible view without a raw mutation relation');
  });

  test('read routing stays on the visible view and requires an unchanged executor plan', () => {
    const repair = read('supabase/migrations/20261029140000_provider_auth_read_relation_v1.sql');
    expect(repair.match(/FROM public\.ui_rpc_executor_privilege_plan_v1\(\) p/g)).toHaveLength(2);
    expect(repair).toContain('v_plan_added');
    expect(repair).toContain('v_plan_removed');
    expect(repair).toContain('v_plan_added_detail');
    expect(repair).toContain('v_plan_removed_detail');
    expect(repair).toContain('v_registry_trace');
    expect(repair).toContain("'plan_before_count'");
    expect(repair).toContain("'plan_after_count'");
    expect(repair).toContain('DETAIL = jsonb_build_object');
    expect(repair).toContain("'read_relation', resource->>'read_relation'");
    expect(repair).toContain("'{relation}', '\"public.provider_auth_configs_visible_v1\"'::JSONB");
    expect(repair).toContain("- 'read_relation'");
    expect(repair).toContain('v_plan_after IS DISTINCT FROM v_plan_before');
    expect(repair).not.toMatch(/\b(?:GRANT|REVOKE)\s+(?:EXECUTE|ALL|USAGE|SELECT)\b|UPDATE public\.ui_rpc_executor_rollback_state_v1|COMMENT ON TABLE public\.ui_rpc_executor_rollback_state_v1/i);
    expect(repair).toContain("USING ERRCODE = '42501'");
    expect(repair.indexOf('INTO v_plan_before')).toBeLessThan(repair.indexOf('upsert_settings_value_v1('));
    expect(repair.indexOf('INTO v_plan_after')).toBeGreaterThan(repair.indexOf('upsert_settings_value_v1('));
    expect(repair.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    const rollback = read('supabase/rollback/20261029140000_provider_auth_read_relation_v1.sql');
    expect(rollback).toContain('ui_rpc_executor_rollback_state_v1');
    expect(rollback).toContain('upsert_settings_value_v1');
    expect(rollback).toContain('ui_rpc_executor_privilege_plan_v1');
    expect(rollback).toContain('change_reason');
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_read_relation_v1.sql');
    expect(fixture).toContain('has_table_privilege');
    expect(fixture).toContain('ui_rpc_executor_privilege_plan_v1');
  });

  test('registry promotion closes only the prior period and appends a scoped schema-preserving version with pointer CAS', () => {
    const registry = sql.slice(sql.indexOf('DO $registry$'));
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('20261020133000_provider_auth_credential_retirement_v1'))");
    expect(registry).toMatch(/WHERE s\.category = 'ui_command_registry'\s+FOR UPDATE OF s, sv/);
    expect(registry).toMatch(/UPDATE public\.settings_versions\s+SET effective_until = GREATEST\(clock_timestamp\(\), effective_from \+ INTERVAL '1 microsecond'\),\s*updated_at = clock_timestamp\(\)/);
    expect(registry).not.toMatch(/\b(?:SET|,)\s*(?:value|version|change_reason|approved_at|effective_from)\s*=/i);
    expect(registry).toMatch(/WHERE id = v_row\.settings_version_id\s+AND scope_hash = v_row\.scope_hash AND effective_until IS NULL/);
    expect(registry).toMatch(/INSERT INTO public\.settings_versions \([\s\S]*?scope_hash, version, value,[\s\S]*?schema_version, change_reason, approved_at, effective_from/);
    expect(registry).toContain('SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id, v_row.scope_hash');
    expect(registry).toContain('COALESCE(MAX(candidate.version), 0) + 1');
    expect(registry).toContain('candidate.category = v_row.category AND candidate.scope_type = v_row.scope_type');
    expect(registry).toContain('candidate.scope_hash = v_row.scope_hash');
    expect(registry).toContain('v_version_next, v_row.schema_version');
    expect(registry).toContain('SET settings_version_id = inserted.id, cached_value = inserted.value');
    expect(registry).toContain('WHERE s.id = v_row.settings_id AND s.settings_version_id = v_row.settings_version_id');
    expect(registry).toContain('ELSIF v_row.cached_value IS DISTINCT FROM v_row.value');
    expect(registry).toContain('WHERE id = v_row.settings_id AND settings_version_id = v_row.settings_version_id');
    expect(registry.match(/IF NOT FOUND THEN/g)).toHaveLength(2);
    expect(registry).toContain('jsonb_agg(item ORDER BY ordinality)');
  });

  test('invalidates only derived registry/provider resource cache entries and retains native history checks', () => {
    expect([...sql.matchAll(/DELETE FROM ([\w.]+)/g)].map((match) => match[1])).toEqual(['public.settings_cache']);
    const invalidation = sql.slice(sql.indexOf('DELETE FROM public.settings_cache'));
    expect([...invalidation.matchAll(/cache_key LIKE '([^']+)'/g)].map((match) => match[1])).toEqual([
      'ui_command_registry:%', 'ui_list_resource:%provider_auth_configs%', 'ui_get_resource:%provider_auth_configs%',
      'ui_resource_metrics:%provider_auth_configs%', 'ui_filter_distinct_values:%provider_auth_configs%',
    ]);
    const fixture = read('supabase/tests/pgtap/0zz_provider_auth_credential_retirement_v1.sql');
    const assertions = (fixture.match(/^SELECT (?:ok|has_function|function_privs_are)\(/gm) || []).length
      + (fixture.match(/RETURN NEXT (?:ok|is|throws_ok)\(/g) || []).length;
    expect(Number(fixture.match(/SELECT plan\((\d+)\)/)[1])).toBe(assertions);
    expect(fixture).toContain('registry cache and current version retain the exact retirement command across scopes');
    expect(fixture).toContain('sv.value IS DISTINCT FROM s.cached_value OR sv.effective_until IS NOT NULL');
    expect(fixture).toContain('retirement registry history retains closed predecessors, schema and unrelated commands');
  });
});
