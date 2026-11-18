const fs = require('fs');
const path = require('path');

describe('webhook async typed-intent normalization migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161450_b3_webhook_async_typed_intent_normalization_v1.sql',
  );
  const corePath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202603101105_webhook_ingest_generic_update_routing_v1.sql',
  );
  const pgtapPath = path.join(
    process.cwd(),
    'supabase',
    'tests',
    'pgtap',
    '0zz_webhook_async_typed_intent_normalization_v1.sql',
  );

  let sql;
  let core;
  let pgtap;

  beforeAll(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
    core = fs.readFileSync(corePath, 'utf8');
    pgtap = fs.readFileSync(pgtapPath, 'utf8');
  });

  test('plural create alias repair preserves every prior normalizer branch', () => {
    const repair = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260911100000_webhook_create_alias_normalization_v1.sql'), 'utf8');
    const definition = text => {
      const start = text.indexOf('CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1(');
      const end = text.indexOf('$function$;', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end + '$function$;'.length);
    };
    const addition = "    WHEN 'shipments.create' THEN RETURN 'shipment.create';\n";
    expect(definition(repair).split(addition)).toHaveLength(2);
    expect(definition(repair).replace(addition, '')).toBe(definition(sql));
    const native = fs.readFileSync(path.join(process.cwd(), 'supabase/tests/pgtap/0zz_webhook_canonical_identity_v1.sql'), 'utf8');
    expect(native).toContain("('alias-missing', 'shipments.create')");
    expect(native).toContain("'webhook_source_missing_sender_client'");
  });

  test('defines the final compatibility aliases at one canonical seam', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1');
    expect(sql).toContain("'shipments.cancel'");
    expect(sql).toContain("'shipments.delete'");
    expect(sql).toContain("'shipments.reschedule'");
    expect(sql).toContain("WHEN 'shipments.reschedule' THEN RETURN 'shipment.reschedule'");
    expect(sql).toContain("WHEN 'shipment.updated' THEN RETURN 'shipment.updated'");
    expect(sql).toContain("THEN 'shipment.delete'");
    expect(sql).toContain("THEN 'shipment.reschedule'");
    expect(sql).toContain('SET search_path TO public, extensions, pg_temp');
  });

  test('preserves exact-one typed classification and fail-closed ambiguity', () => {
    expect(core).toContain('CREATE OR REPLACE FUNCTION public.resolve_webhook_shipment_intent_v1');
    expect(core).toContain("'multiple_specific_update_segments'");
    expect(core).toContain("'missing_update_segment'");
    expect(core).toContain("'shipment_update_payload_ambiguous'");
    expect(core).toContain("'shipment_update_payload_unclassified'");
    expect(core).toContain("v_chosen_intent := 'update.status'");
    expect(core).toContain('public.webhook_payload_set_event_type_v1');
  });

  test('adds append-only row-driven workflow defaults', () => {
    expect(sql).toContain('public.upsert_settings_value_v1');
    expect(sql).toContain("('shipment.delete'::TEXT, 'shipment_delete_v1'::TEXT)");
    expect(sql).toContain("('shipment.reschedule'::TEXT, 'shipment_reschedule_v1'::TEXT)");
    expect(sql).toContain("jsonb_build_object('template_name', v_target.canonical_name)");
    expect(sql).toContain(
      'v_resolved_template_id := public.resolve_active_workflow_template_ref_v1(v_existing_ref)',
    );
    expect(sql).toContain('public.workflow_template_supports_shipment_intent_v1(');
    expect(sql).toContain('IF v_templates IS NOT DISTINCT FROM v_original_templates THEN');
    expect(sql).toContain('custom follow-up is missing or inactive');
    expect(sql).toContain('custom follow-up is incompatible');
    expect(sql).toContain("wt.name IN ('shipment_delete_v1', 'shipment_reschedule_v1')");
    expect(sql).not.toMatch(/UPDATE\s+public\.settings_versions/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.settings\b/i);
  });

  test('keeps mapping targets async webhook-only', () => {
    expect(sql).toMatch(
      /INSERT INTO public\.lookup_definitions[\s\S]*?'mapping_target'[\s\S]*?ON CONFLICT \(category\) DO UPDATE/,
    );
    expect(sql).toContain("'shipments.cancel'");
    expect(sql).toContain("'shipments.reschedule'");
    expect(sql).toContain('"ingress_mode":"async_third_party_event"');
    expect(sql).toContain('"allowed_mapping_types":["webhook_inbound"]');
    expect(sql).not.toContain('"api_gateway_inbound"');
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.(api_routes|api_route_packs|api_gateway_requests)/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.(shipments|workflow_runs|webhook_inbox)/i);
  });

  test('does not patch or replace the canonical intake core', () => {
    expect(sql).not.toContain('workflow_intake_webhook_core_v1');
    expect(sql).not.toMatch(/pg_get_functiondef\s*\(/i);
    expect(sql).not.toMatch(/EXECUTE\s+v_def/i);
    expect(sql).not.toMatch(/replace\s*\(\s*v_def/i);
  });

  test('retains workflow, idempotency, and replay behavior', () => {
    expect(core).toContain('public.resolve_webhook_followup_template_id_v1');
    expect(core).toContain('start_workflow_run');
    expect(core).toContain('webhook_ack_history');
    expect(core).toContain("'missing_required_idempotency_key'");
    expect(core).not.toMatch(/INSERT\s+INTO\s+(public\.)?shipments\b/i);
  });

  test('ships focused pgTAP proof for aliases, ambiguity, defaults, and route isolation', () => {
    expect(pgtap).toContain("public.normalize_shipment_intent_v1('shipments.cancel'");
    expect(pgtap).toContain("public.normalize_shipment_intent_v1(NULL, 'shipment.updated')");
    expect(pgtap).toContain('multiple specific segments fail closed');
    expect(pgtap).toContain('shipment_delete_v1');
    expect(pgtap).toContain('shipment_reschedule_v1');
    expect(pgtap).toContain("allowed_mapping_types' = '[\"webhook_inbound\"]'::jsonb");
    expect(pgtap).toContain("NOT (lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound')");
    expect(pgtap).toContain('async_third_party_event');
  });
});
