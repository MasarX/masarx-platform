const fs = require('fs');
const path = require('path');

describe('API Gateway compatibility typed mapping migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161510_b3_api_gateway_compat_typed_mapping_v1.sql',
  );
  const readbackMigrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161240_b3_client_api_mapping_action_readback_v1.sql',
  );
  const pgtapPath = path.join(
    process.cwd(),
    'supabase',
    'tests',
    'pgtap',
    '0zz_api_gateway_compat_typed_mapping_v1.sql',
  );

  let sql;
  let readbackSql;
  let pgtap;

  beforeAll(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
    readbackSql = fs.readFileSync(readbackMigrationPath, 'utf8');
    pgtap = fs.readFileSync(pgtapPath, 'utf8');
  });

  test('uses row-driven mapping taxonomy without restoring a literal type constraint', () => {
    expect(sql).toContain("'api_gateway_inbound'");
    expect(sql).toContain("ld.category = 'mapping_target'");
    expect(sql).toContain("'{allowed_mapping_types}'");
    expect(sql).not.toMatch(/ADD CONSTRAINT mapping_configs_type_check/i);
  });

  test('defines canonical route intent before readback and consumes it without redefinition', () => {
    const definition = 'CREATE OR REPLACE FUNCTION public.api_gateway_route_canonical_intent_v1';
    expect(readbackSql.indexOf(definition)).toBeGreaterThanOrEqual(0);
    expect(readbackSql.indexOf(definition)).toBeLessThan(
      readbackSql.indexOf('CREATE OR REPLACE VIEW public.v_api_gateway_request_directory'),
    );
    expect(readbackSql).toContain("WHEN 'shipment_update_v1' THEN 'shipment.update'");
    expect(readbackSql).toContain("WHEN 'shipment_reschedule_v1' THEN 'shipment.reschedule'");
    expect(readbackSql).toContain(
      'REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) FROM PUBLIC',
    );
    expect(readbackSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.api_gateway_route_canonical_intent_v1(JSONB) TO service_role, edge_api_gateway_role',
    );
    expect(sql).toContain('api_gateway_route_canonical_intent_v1');
    expect(sql).not.toContain(definition);
    expect(sql).toContain('api_gateway_mapping_target_intent_v1');
    expect(sql).toContain('api_gateway_mapping_intents_compatible_v1');
    expect(sql).toContain("lower(p_mapping_intent) LIKE 'update.%'");
  });

  test('resolves only tenant-safe route-bound Mapping Studio profiles', () => {
    expect(sql).toContain('api_gateway_route_request_mapping_v1');
    expect(sql).toContain('api_gateway_apply_request_mapping_v1');
    expect(sql).toContain("mc.mapping_type = v_mapping_type");
    expect(sql).toContain('(mc.organization_id IS NULL OR mc.organization_id = p_organization_id)');
    expect(sql).toContain("'mapping_target_mismatch'");
    expect(sql).toContain('public.apply_mapping_config(v_payload, v_mapping_id)');
  });

  test('keeps mutation compatibility routes workflow-engine-first', () => {
    expect(sql).toContain('api_gateway_shipment_mutation_default_v1');
    expect(sql).toContain("'api_gateway_dispatch_outbound'");
    expect(sql).toContain('trg_api_routes_shipment_mutation_workflow_defaults_v1');
    expect(sql).toContain("RAISE EXCEPTION 'enabled shipment mutation API Gateway routes must use workflow.enabled=true'");
    expect(sql).toContain("'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202)");
  });

  test('binds mappings through capability-checked public and API RPCs', () => {
    expect(sql).toContain('public.ui_upsert_api_gateway_route_mapping_v1');
    expect(sql).toContain('api.ui_upsert_api_gateway_route_mapping_v1');
    const current = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260909110000_api_gateway_mapping_resource_authority_v1.sql'), 'utf8');
    expect(current).toContain("public.user_has_resource_capability_v1('api_routes', 'write', 'tenant', v_org_id) IS NOT TRUE");
    expect(current).toContain('IF NOT public.request_role_is_service_v1()');
    expect(current).toContain("public.assert_capability_v1('mappings.write', 'tenant', v_org_id)");
    expect(current).toContain("public.user_has_capability_v1('system.write', 'tenant', v_org_id)");
    expect(current).not.toContain("assert_capability_v1('api_gateway.write'");
    const previousBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1('), sql.indexOf('CREATE OR REPLACE FUNCTION api.ui_upsert_api_gateway_route_mapping_v1('));
    const currentBody = current.slice(current.indexOf('CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1('), current.lastIndexOf('COMMIT;'));
    expect(currentBody.replace(/  IF NOT public\.request_role_is_service_v1\(\)[\s\S]*?  END IF;/, "  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_org_id);")).toBe(previousBody);
    expect(sql).toContain("public.assert_capability_v1('mappings.write', 'tenant', v_org_id)");
    expect(sql).toContain("public.user_has_capability_v1('system.write', 'tenant', v_org_id)");
  });

  test('composes around the latest intake implementation without source-text patching', () => {
    expect(sql).toContain('RENAME TO workflow_intake_api_gateway_base_v1');
    expect(sql).toContain('RETURN public.workflow_intake_api_gateway_base_v1(');
    expect(sql).toContain("v_route_intent LIKE 'update.%'");
    expect(sql).not.toMatch(/pg_get_functiondef\s*\(/i);
    expect(sql).not.toMatch(/replace\s*\(\s*v_def/i);
    expect(sql).not.toMatch(/EXECUTE\s+v_def/i);
  });

  test('fails closed before dispatch while retaining rate-limited redacted evidence', () => {
    expect(sql).toContain('api_gateway_reject_before_dispatch_v1');
    expect(sql).toContain('INSERT INTO public.api_gateway_rate_limits');
    expect(sql).toContain('INSERT INTO public.api_gateway_requests');
    expect(sql).toContain('public.redact_sensitive_headers');
    expect(sql).toContain('public.redact_sensitive_json');
    expect(sql).toContain("'api_gateway_source_missing_sender_client'");
    expect(sql).toContain("'api_gateway_request_mapping_failed'");
  });

  test('dispatches mapped payloads but restores original redacted request readback and lineage', () => {
    expect(sql).toContain("v_mapped_body := COALESCE(v_mapping->'payload', '{}'::jsonb)");
    expect(sql).toContain('SET request_body = v_original_safe_body');
    expect(sql).toContain("p_decision_point := 'api_gateway_request_mapping'");
    expect(sql).toContain("'api_gateway_request_mapping_applied', TRUE");
    expect(sql).toContain("'transformed_payload', public.redact_sensitive_json(v_mapped_body)");
  });

  test('ships focused database contract coverage', () => {
    expect(pgtap).toContain('SELECT plan(31)');
    expect(pgtap).toContain("has_function('public', 'api_gateway_route_canonical_intent_v1'");
    expect(pgtap).toContain("has_function('api', 'ui_upsert_api_gateway_route_mapping_v1'");
    expect(pgtap).toMatch(
      /has_trigger\(\s*'public',\s*'api_routes',\s*'trg_api_routes_shipment_mutation_workflow_defaults_v1',\s*'shipment mutation routes receive workflow defaults'/,
    );
    expect(pgtap).toContain('api_gateway_shipment_mutation_default_v1');
    expect(pgtap).toContain('api_gateway_inbound');
  });
});
