const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/202608161860_runtime_failure_wave_reconciliation_v1.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

describe('runtime failure-wave reconciliation v1', () => {
  test('replaces the geo handler deterministically and handles invalid free-form input', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION workflow_handlers\.execute_geo_local_lookup_v1\(/g)).toHaveLength(1);
    expect(sql).toMatch(/EXCEPTION\s+WHEN invalid_text_representation THEN\s+v_raw := '\{\}'::jsonb;/);
    expect(sql).not.toContain('pg_get_functiondef');
  });

  test('keeps marketplace dedupe and compliance lineage canonical', () => {
    expect(sql).toContain("'dedupe_reason', v_reason");
    expect(sql).toContain("THEN 'phone'");
    expect(sql).toContain("ELSE 'employee_or_contractor_id'");
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(sql).toContain('r.requested_organization_id = p_requested_organization_id');
    expect(sql).toContain("lower(btrim(r.organization_name)) = lower(btrim(p_organization_name))");
    expect(sql).not.toMatch(/'dedupe_reason', v_reason,\s*'application_status_token'/);
    expect(sql).toContain('marketplace_driver_compliance_from_participant_request_v1');
    expect(sql).toContain('profile.organization_id = v_req.approved_organization_id');
    expect(sql).toContain("definition.category = 'driver_document_type'");
    expect(sql).toContain("v_req.decision_metadata->'verified_documents'");
    expect(sql).toContain("CASE WHEN v_is_reviewer_verified THEN 'verified' ELSE 'submitted' END");
    expect(sql).toContain('uq_driver_documents_marketplace_request_ref');
    expect(sql).toContain('uq_driver_compliance_events_marketplace_request');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.marketplace_driver_compliance_from_participant_request_v1\(UUID, UUID\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.marketplace_driver_compliance_from_participant_request_v1\(UUID, UUID\)/,
    );
    expect(sql).toContain('INSERT INTO public.driver_documents');
    expect(sql).toContain('INSERT INTO public.driver_compliance_events');
    expect(sql).toContain("'marketplace_participant_review_reason'");
    expect(sql).toContain("'compliance_document_mismatch'");
    expect(sql).toContain("'fleet.driver_assigned'");
  });

  test('converges schema, locality, geocoding, and API-gateway runtime contracts', () => {
    expect(sql).toContain('FROM public.upsert_settings_value_v1(');
    expect(sql).not.toMatch(/UPDATE public\.settings_versions\s+(?:sv\s+)?SET\s+(?:value|schema_version)/);
    expect(sql).not.toMatch(/UPDATE public\.settings\s+SET\s+cached_value/);
    expect(sql).toContain("WHERE lower(c.name_canonical) = 'riyadh'");
    expect(sql.match(/JOIN public\.settings_versions sv ON sv\.id = s\.settings_version_id/g)).toHaveLength(2);
    expect(sql).toContain('CREATE TRIGGER a000_fill_api_gateway_route');
    expect(sql).toContain("'api_gateway_materialized'");
    expect(sql).toContain("'api_gateway_materialization'");
  });

  test('repairs only shipment-applicable policies and preserves compatible custom templates', () => {
    expect(sql).toContain('public.webhook_policy_applies_to_shipment_intent_v1(v_value, v_binding.intent)');
    expect(sql).toContain('public.workflow_template_supports_shipment_intent_v1(v_template.id, v_binding.intent)');
    expect(sql).toContain("'webhook_shipment_create_v1'::TEXT");
    expect(sql).toContain("'shipment_delete_v1'::TEXT");
    expect(sql).toContain("'shipment_reschedule_v1'::TEXT");
    expect(sql).toContain("v_template.name IN ('async_provider_dispatch_v1', 'webhook_intake_v1')");
  });
});
