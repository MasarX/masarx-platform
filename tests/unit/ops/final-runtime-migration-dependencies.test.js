const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');

describe('final runtime migration dependency closure', () => {
  test('orders the final runtime reconciliation after the qualification closeout', () => {
    const qualification = read('supabase/migrations/202608161850_runtime_qualification_reconciliation_v1.sql');
    const reconciliation = read('supabase/migrations/202608161860_runtime_failure_wave_reconciliation_v1.sql');
    expect(qualification).toContain('CREATE OR REPLACE VIEW api.workflow_templates');
    expect(reconciliation).toContain('CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_local_lookup_v1(');
    expect(reconciliation).toContain('CREATE TRIGGER a000_fill_api_gateway_route');
    expect(reconciliation).not.toContain('refresh_api_contract_views_v1()');
  });

  test('ships one deterministic shipment-create definition before Maps/SNA use', () => {
    const sql = read('supabase/migrations/202608161400_b3_maps_sna_backend_lineage_current_v1.sql');
    const workflowTable = read('supabase/migrations/202510110005_communications.sql');
    const typedIntent = read('supabase/migrations/202608161450_b3_webhook_async_typed_intent_normalization_v1.sql');
    const coordinatesHelperStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.address_coordinates_from_payload_v1(');
    const shortCodeHelperStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.address_sa_short_code_from_payload_v1(');
    const definitionStart = sql.indexOf('CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(');
    const definitionEnd = sql.indexOf('\n$function$;', definitionStart);
    expect(coordinatesHelperStart).toBeGreaterThan(-1);
    expect(shortCodeHelperStart).toBeGreaterThan(coordinatesHelperStart);
    expect(definitionStart).toBeGreaterThan(shortCodeHelperStart);
    expect(definitionStart).toBeGreaterThan(-1);
    expect(definitionEnd).toBeGreaterThan(definitionStart);
    const definition = sql.slice(definitionStart, definitionEnd);
    expect(sql.match(/CREATE OR REPLACE FUNCTION workflow_handlers\.execute_shipment_create_v1\(/g)).toHaveLength(1);
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.address_coordinates_from_payload_v1\(/g)).toHaveLength(1);
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.address_sa_short_code_from_payload_v1\(/g)).toHaveLength(1);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.address_coordinates_from_payload_v1(JSONB) TO authenticated, service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB) TO authenticated, service_role');
    expect(sql).toContain("v_materialized_payload#>'{shipment,recipient}'");
    expect(sql).toContain('missing_required_context_failed_webhook_inbox');
    expect(sql).toContain('public.address_sa_short_code_from_payload_v1(v_payload_address)');
    expect(sql).toContain('public.address_coordinates_from_payload_v1(v_payload_address)');
    expect(sql).toContain("NULLIF(v_address_short_plugin->'params'->>'code_regex', '')");
    expect(sql).not.toContain('pg_get_functiondef');
    expect(definition).not.toContain("'^[A-Z]{4}[0-9]{4}$'");

    const inboundTemplateProducer = sql.indexOf("INSERT INTO public.workflow_templates (");
    const inboundStepProducer = sql.indexOf("INSERT INTO public.workflow_template_steps (");
    expect(inboundTemplateProducer).toBeGreaterThan(definitionEnd);
    expect(inboundStepProducer).toBeGreaterThan(inboundTemplateProducer);
    expect(sql).toContain(
      "v_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770002'::uuid",
    );
    expect(sql).toContain("'provider_dispatch', FALSE");
    expect(workflowTable).toMatch(/CREATE TABLE workflow_templates \([\s\S]*?name TEXT NOT NULL UNIQUE,/);
    expect(workflowTable).not.toMatch(/CREATE TABLE workflow_templates \([\s\S]*?\btemplate_key\b/);
    expect(sql).not.toMatch(/INSERT INTO public\.workflow_templates \([\s\S]{0,300}\btemplate_key\b/);
    expect(sql).not.toContain('template_key = EXCLUDED.template_key');
    expect(sql).toContain("'77770000-0000-0000-0000-000000770021'::uuid");
    expect(sql).toContain("'77770000-0000-0000-0000-000000770022'::uuid");
    expect(sql).toContain("'77770000-0000-0000-0000-000000770023'::uuid");
    expect(sql).toContain("'77770000-0000-0000-0000-000000770024'::uuid");
    expect(sql).toContain("'77770000-0000-0000-0000-000000770025'::uuid");
    expect(sql).toContain("v_templates->'shipment.create'");
    expect(sql).toContain("v_existing_binding = 'null'::jsonb");
    expect(sql).toContain("jsonb_typeof(v_existing_binding) = 'string'");
    expect(sql).toContain("jsonb_typeof(v_existing_binding) = 'object'");
    expect(sql).toContain('v_resolved_binding := public.resolve_active_workflow_template_ref_v1(v_existing_ref)');
    expect(sql).toContain('custom follow-up is missing or inactive for scope');
    expect(sql).toContain('public.upsert_settings_value_v1(');
    expect(sql).toContain('public.resolve_webhook_followup_template_id_v1(');
    expect(sql).toContain('public.workflow_template_supports_inbound_shipment_create_v1(v_resolved_binding)');
    expect(sql).toContain('public.workflow_template_supports_shipment_intent_v1(');
    expect(sql).toContain('public.webhook_policy_applies_to_shipment_intent_v1(');
    expect(sql).toContain("WHEN 'shipment.create' THEN 'shipment_create'");
    expect(sql).toContain("WHEN 'shipment.delete' THEN 'shipment_delete'");
    expect(sql).toContain("WHEN 'shipment.reschedule' THEN 'shipment_reschedule'");
    expect(sql).toContain("IN ('provider_dispatch', 'outbound_http', 'call_supplier_api')");
    expect(sql).toContain('contains an unresolved, inactive, or shared-dispatch binding');
    expect(sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_active_workflow_template_ref_v1('))
      .toBeLessThan(inboundTemplateProducer);
    expect(sql).toContain("AND wt.status = 'active';");
    expect(sql).toContain("'{properties,workflow}'");
    expect(sql).toContain("'{properties,workflow,properties,templates_by_intent}'");
    expect(typedIntent.match(/public\.webhook_policy_applies_to_shipment_intent_v1\(/g))
      .toHaveLength(2);
    expect(typedIntent).toContain('IF v_templates IS NOT DISTINCT FROM v_original_templates THEN');
    expect(sql).toContain("v_top_intent IN ('shipment.create', 'shipment.created', 'shipment_create')");
    expect(typedIntent).toContain('v_top_intent := public.normalize_shipment_intent_v1(');
    expect(typedIntent).toContain('v_resolved_template_id := public.resolve_active_workflow_template_ref_v1(v_existing_ref)');
    expect(typedIntent).toContain('public.workflow_template_supports_shipment_intent_v1(');
    expect(typedIntent).toContain("'webhook % custom follow-up is incompatible for scope %/%'");
    expect(typedIntent).toContain("jsonb_build_object('template_name', v_target.canonical_name)");
    expect(typedIntent).not.toContain("'shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1')");
    expect(sql).toContain('public.workflow_refresh_steps_checksum(v_template_id, FALSE)');
    expect(sql).not.toContain("WHERE name = 'async_provider_dispatch_v1'");
    expect(sql).not.toContain('WITH recalculated AS (');

    const integration = read('tests/integration/webhook-ingest.test.js');
    const followupStateDeclaration = integration.indexOf('let inboundFollowupTemplateId = null;');
    const followupStateAssignment = integration.indexOf(
      "inboundFollowupTemplateId = await fetchTemplateId('webhook_shipment_create_v1');",
    );
    expect(followupStateDeclaration).toBeGreaterThan(-1);
    expect(followupStateAssignment).toBeGreaterThan(followupStateDeclaration);
    expect(integration).not.toContain('const inboundFollowupTemplateId =');
  });

  test('retains the canonical shipment command seed before result-contract enrichment', () => {
    const seed = read('supabase/migrations/202604081930_uc224_shipment_batch_operation_v1.sql');
    const contract = read('supabase/migrations/202608161530_b3_shipment_batch_result_contract_v1.sql');
    expect(seed).toContain("ARRAY['shipments.delete']");
    expect(seed).toContain("ARRAY['shipments.reschedule']");
    expect(seed).toContain("IF v_command_key IN ('shipments.delete', 'shipments.reschedule') THEN");
    expect(seed).toContain("jsonb_build_array(v_canonical_commands->'shipments.delete')");
    expect(seed).toContain("jsonb_build_array(v_canonical_commands->'shipments.reschedule')");
    expect(contract).toContain("v_command->>'key' IN ('shipments.delete', 'shipments.reschedule')");
    expect(contract).toContain("'{execution,result_contract}'");
    expect(contract).toContain("to_jsonb('batch_items_v1'::TEXT)");
  });
});
