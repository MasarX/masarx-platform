const fs = require('node:fs');
const path = require('node:path');
const migrations = path.join(process.cwd(), 'supabase/migrations');
const bridgeName = '20260906015000_settings_upsert_reserved_argument_bridge_v1.sql';
const retireName = '20260906045000_settings_upsert_reserved_argument_bridge_retire_v1.sql';
const callers = ['202609060200_fieldops_reassignment_request_workflow_v1.sql',
  '202609060400_fieldops_self_kyc_submission_v1.sql'];
const read = name => fs.readFileSync(path.join(migrations, name), 'utf8');
const bridge = read(bridgeName);
const retire = read(retireName);

test('dependency ordering brackets all six immutable compatibility callers', () => {
  const ordered = fs.readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  for (const caller of callers) {
    expect(ordered.indexOf(bridgeName)).toBeLessThan(ordered.indexOf(caller));
    expect(ordered.indexOf(retireName)).toBeGreaterThan(ordered.indexOf(caller));
  }
  expect(callers.map(read).join('\n').match(/PERFORM public\.upsert_settings_value_v1\(/g)).toHaveLength(6);
  const predecessor = ordered.findIndex(name => name.startsWith('20260906011000_'));
  expect(predecessor).toBeGreaterThanOrEqual(0);
  expect(ordered.indexOf(bridgeName)).toBeGreaterThan(predecessor);
});

test('temporary invoker adapter delegates only the unchanged six-argument SSOT', () => {
  expect(bridge).toContain('SECURITY INVOKER');
  expect(bridge).toContain('IF p_reserved_null IS NOT NULL THEN');
  expect(bridge).toContain("USING ERRCODE = '22023'");
  expect(bridge).toMatch(/RETURN QUERY SELECT \* FROM public\.upsert_settings_value_v1\(\s*p_category, p_scope_type, p_scope_id, p_value, p_schema_version, p_change_reason\s*\);/);
  expect(bridge).toContain('REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT) FROM PUBLIC');
  expect(bridge).toContain('GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT) TO service_role');
  expect(bridge).toContain("SQLERRM <> 'settings_upsert_reserved_argument_must_be_null'");
  expect(bridge).toContain("SQLERRM <> 'upsert_settings_value_v1 requires category'");
  expect(bridge).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.settings/i);
});

test('retirement drops only exact temporary overload without cascading dependencies', () => {
  const executable = retire.replace(/--[^\n]*/g, '');
  expect(executable.match(/DROP FUNCTION/g)).toHaveLength(1);
  expect(executable).toContain('DROP FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT);');
  expect(executable).not.toMatch(/CASCADE|CREATE OR REPLACE|DROP FUNCTION public\.upsert_settings_value_v1\(TEXT,TEXT,UUID,JSONB,INT,TEXT\);/);
});

test('canonical upserts close approved current rows even when their effective date is in the future', () => {
  const canonical = read('202604121730_settings_versions_monotonic_closeout_v1.sql');
  const upsert = canonical.slice(canonical.indexOf('CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1('));
  const closeout = upsert.match(/UPDATE public\.settings_versions[\s\S]*?;/)[0];
  expect(closeout).toMatch(/effective_until = GREATEST\(\s*clock_timestamp\(\),\s*effective_from \+ INTERVAL '1 microsecond'\s*\)/);
  expect(closeout).toContain('category = v_category');
  expect(closeout).toContain('scope_type = v_scope_type');
  expect(closeout).toContain('scope_id IS NOT DISTINCT FROM v_scope_id');
  expect(closeout).toContain('effective_until IS NULL');
  expect(closeout).toContain('approved_at IS NOT NULL');
  expect(closeout).not.toMatch(/effective_from\s*(?:<=|<|BETWEEN)/i);
});

test('native closeout regressions retain future-date monotonicity and the single-current invariant', () => {
  const native = fs.readFileSync(path.join(process.cwd(), 'supabase/tests/pgtap/0zz_settings_versions_monotonic_closeout_v1.sql'), 'utf8');
  expect(native).toContain("clock_timestamp() + INTERVAL '1 minute'");
  expect(native).toContain('effective_until > effective_from');
  expect(native).toContain('leaves exactly one approved current settings_versions row');
  expect(Number(native.match(/SELECT plan\((\d+)\)/)[1])).toBe((native.match(/PERFORM (?:ok|is)\(/g) || []).length);
  expect(native).not.toMatch(/\b(?:skip|todo)\(/i);
  expect(native.trim()).toMatch(/ROLLBACK;$/);
});
