const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const current = read('202608161850_runtime_qualification_reconciliation_v1.sql');
const repair = read('20260912161000_studio_mapping_preview_v1.sql');
test('Studio evaluator preserves the canonical runtime mapping algorithm verbatim', () => {
  const original = current.slice(current.indexOf('CREATE OR REPLACE FUNCTION public.apply_mapping_config('), current.indexOf('CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match('));
  const expected = original
    .replace('public.apply_mapping_config(', 'public.evaluate_mapping_config_v1(')
    .replace('p_mapping_config_id UUID', 'p_mapping_config JSONB')
    .replace('  v_config RECORD;\n', '')
    .replace("  IF p_source IS NULL OR p_mapping_config_id IS NULL THEN RETURN p_source; END IF;\n  SELECT mapping_config INTO v_config FROM public.mapping_configs WHERE id = p_mapping_config_id;\n  IF NOT FOUND OR v_config.mapping_config IS NULL THEN RETURN p_source; END IF;", "  IF p_source IS NULL OR p_mapping_config IS NULL THEN RETURN p_source; END IF;")
    .replaceAll('v_config.mapping_config', 'p_mapping_config');
  expect(repair).toContain(expected.trim());
});
test('extracted evaluator retains invoker execution and preview is explicitly service-only', () => {
  expect(repair).not.toMatch(/SECURITY\s+DEFINER/i);
  expect(repair).toContain("REVOKE ALL ON FUNCTION api.integration_studio_preview_mapping_v1(JSONB, JSONB) FROM PUBLIC, anon, authenticated");
  expect(repair).toContain("GRANT EXECUTE ON FUNCTION api.integration_studio_preview_mapping_v1(JSONB, JSONB) TO service_role");
  expect(repair).toContain("acldefault('f', p.proowner)");
  expect(repair).toContain('bool_or(a.is_grantable)');
});
