const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/202608161890_webhook_policy_binding_normalization_v1.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

describe('webhook policy binding normalization v1', () => {
  test('routes future writes through one category normalizer without replacing either upsert', () => {
    expect(
      sql.match(
        /CREATE OR REPLACE FUNCTION public\.normalize_webhook_ingest_policy_workflow_bindings_v1\(/g,
      ),
    ).toHaveLength(1);
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.normalize_settings_value_v1\(/g)).toHaveLength(1);
    expect(sql).toContain("= 'webhook_ingest_policy' THEN");
    expect(sql).toContain('RETURN public.normalize_webhook_ingest_policy_workflow_bindings_v1(p_value);');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.upsert_webhook_ingest_policy(');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1(');
  });

  test('normalizes the three canonical intents while preserving original-policy applicability', () => {
    expect(sql).toContain("('shipment.create'::TEXT, 'webhook_shipment_create_v1'::TEXT)");
    expect(sql).toContain("('shipment.delete'::TEXT, 'shipment_delete_v1'::TEXT)");
    expect(sql).toContain("('shipment.reschedule'::TEXT, 'shipment_reschedule_v1'::TEXT)");
    expect(sql).toContain(
      'public.webhook_policy_applies_to_shipment_intent_v1(v_value, v_binding.intent)',
    );
    expect(sql).toContain('public.resolve_webhook_followup_template_id_v1(');
    expect(sql).toContain('public.workflow_template_supports_shipment_intent_v1(');
    expect(sql).toContain("IF v_binding.intent = 'shipment.create' THEN");
    expect(sql).not.toContain("jsonb_build_object('intent', 'shipment.create'");
  });

  test('reconciles every current policy append-only and at most once per changed scope', () => {
    const reconciliation = sql.slice(sql.indexOf('DO $reconcile$'));
    expect(reconciliation).toMatch(
      /WHERE s\.category = 'webhook_ingest_policy'\s+FOR UPDATE OF s, sv/,
    );
    expect(reconciliation).not.toMatch(
      /WHERE s\.category = 'webhook_ingest_policy'[\s\S]*?webhook_policy_applies_to_shipment_intent_v1[\s\S]*?FOR UPDATE OF s, sv/,
    );
    expect(reconciliation).toContain('IF v_normalized IS DISTINCT FROM v_setting.value THEN');
    expect(sql.match(/FROM public\.upsert_settings_value_v1\(/g)).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.settings_versions\s+(?:\w+\s+)?SET\s+(?:value|schema_version)/);
    expect(sql).not.toMatch(/UPDATE public\.settings\s+(?:\w+\s+)?SET\s+cached_value/);
  });

  test('keeps the new security-definer helper service-only with a pinned search path', () => {
    expect(sql).toMatch(
      /normalize_webhook_ingest_policy_workflow_bindings_v1\([\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO public, extensions, pg_temp/,
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB)',
    );
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB)',
    );
    expect(sql).toContain('TO service_role;');
    expect(sql).toContain(
      'COMMENT ON FUNCTION public.normalize_webhook_ingest_policy_workflow_bindings_v1(JSONB)',
    );
  });
});
