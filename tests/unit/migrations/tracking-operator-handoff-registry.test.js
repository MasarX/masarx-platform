const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (file) => readFileSync(join(process.cwd(), file), 'utf8');
const sql = read('supabase/migrations/20261025005000_tracking_operator_handoff_registry_v1.sql');

test('scoped handoff defaults retain tenant overrides, temporal history and public boundaries', () => {
  expect(sql).toContain("WHERE category = 'ui_tracking_registry' AND version = 1 AND is_active");
  expect(sql).toContain("AND s.scope_type = 'global' AND s.scope_id IS NULL");
  expect(sql).toContain('FOR UPDATE OF s');
  expect(sql.indexOf("IF v_current.value ? 'operator_handoff' THEN CONTINUE; END IF;"))
    .toBeLessThan(sql.indexOf('PERFORM public.upsert_settings_value_v1('));
  expect(sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(sql.indexOf('pg_advisory_xact_lock'));
  expect(sql).not.toMatch(/\b(?:GRANT|CREATE OR REPLACE FUNCTION|DELETE FROM|UPDATE public\.settings(?:_versions)?\b)/i);
  const schema = JSON.parse(sql.match(/\$handoff_schema\$([\s\S]*?)\$handoff_schema\$/)[1]);
  const defaults = JSON.parse(sql.match(/\$handoff_value\$([\s\S]*?)\$handoff_value\$/)[1]);
  expect(schema.required).toBeUndefined();
  expect(schema.properties.route_targets.properties.console.properties.path.type).toBe('string');
  expect(defaults).toMatchObject({ enabled: true, identifier_param: 'focus',
    identifier_source: 'tracking_number', tab_param: 'tab', tab: 'timeline',
    route_targets: { console: { path: '/operate/shipments' } } });
  expect(defaults.label_ar).toMatch(/[\u0600-\u06ff]/);
});

test('history writer closes the prior approved revision before inserting its successor', () => {
  const writer = read('supabase/migrations/202604121730_settings_versions_monotonic_closeout_v1.sql')
    .split('CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1(')[1];
  const close = writer.indexOf('SET effective_until = GREATEST(');
  const insert = writer.indexOf('INSERT INTO public.settings_versions');
  expect(close).toBeGreaterThanOrEqual(0);
  expect(insert).toBeGreaterThan(close);
  expect(writer).toContain('AND effective_until IS NULL');
  expect(writer).toContain('AND approved_at IS NOT NULL');
});

test('the existing public facade stays whitelisted and native proof covers real anonymous queries', () => {
  const facade = read('supabase/migrations/202609010900_b5_public_tracking_config_v1.sql');
  expect(facade).toContain('jsonb_build_object(');
  expect(facade).not.toContain('operator_handoff');
  const native = read('supabase/tests/pgtap/0zz_tracking_operator_handoff_registry_v1.sql');
  expect(native).toContain('SELECT plan(14);');
  expect(native.match(/^\s*(?:SELECT|RETURN NEXT)\s+(?:is|ok|throws_ok)\(/gm)).toHaveLength(14);
  expect(native).toContain('SET LOCAL ROLE anon;');
  expect(native).toContain('real anonymous public facade query omits operator configuration');
  expect(native).toContain('real anonymous caller cannot query scoped operator registry');
});
