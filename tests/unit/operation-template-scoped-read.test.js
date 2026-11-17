const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20260912203000_operation_template_scoped_read_v1.sql'), 'utf8');
test('operation template projection retains explicit caller capability and platform/provider ownership', () => {
  expect(sql).toContain("public.user_has_resource_capability_v1('operation_templates','read')");
  expect(sql).toContain('public.is_platform_user() OR EXISTS');
  expect(sql).toContain('p.id=ot.provider_id AND p.organization_id=public.current_user_org_id()');
  expect(sql).toContain("COALESCE(auth.jwt()->>'role','')='service_role'");
  expect(sql).not.toMatch(/\b(?:current_user|session_user)\b/);
  expect(sql).toContain('WITH (security_invoker=true)');
  expect(sql).toContain('REVOKE ALL ON public.operation_templates_read_v1 FROM PUBLIC,anon,authenticated,service_role');
  expect(sql).not.toMatch(/GRANT |ALTER TABLE|CREATE POLICY|CREATE OR REPLACE FUNCTION/);
});
test('registry repair uses approved versioned state and changes only the read relation', () => {
  expect(sql).toContain('r.cached_value IS DISTINCT FROM r.value');
  expect(sql).toContain("active_schema.schema#>>'{properties,resources,items,properties,read_relation,type}' IS DISTINCT FROM 'string'");
  expect(sql).toContain('v.id IS NULL OR v.approved_at IS NULL OR s.cached_value IS DISTINCT FROM v.value');
  expect(sql).toContain('next_value,active_schema.version');
  expect(sql).toContain("THEN e||jsonb_build_object('read_relation','public.operation_templates_read_v1')");
  expect(sql).toContain("public.upsert_settings_value_v1('ui_read_registry'");
  expect(sql).not.toMatch(/UPDATE public.settings|SET cached_value|read_scope_types|caller_scope_id/);
});
