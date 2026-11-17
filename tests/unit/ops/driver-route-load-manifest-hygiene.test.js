const fs = jest.requireActual('node:fs');
const path = jest.requireActual('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '../../../supabase/migrations', name), 'utf8');
const original = read('202610201115_driver_route_load_manifest_v1.sql');
const repair = read('20261020151500_driver_route_load_manifest_hygiene_v1.sql');
const table = original.match(/CREATE TABLE public\.route_load_manifest_actions \(([\s\S]*?)\n\);/)[1];
const columns = (value) => value.split(',').map((column) => column.trim().split(/\s+/)[0]);
const indexes = (sql) => [...sql.matchAll(/ON public\.route_load_manifest_actions \(([^)]+)\)/g)]
  .map((match) => columns(match[1]));

test('registers immutable creation time and keeps both canonical audits without adding mutable columns', () => {
  expect(repair).toMatch(/'public', 'route_load_manifest_actions', TRUE, FALSE, TRUE/);
  expect(repair).toContain('CREATE TRIGGER audit_truncate_change');
  expect(repair).toContain('public.audit_capture_row_change()');
  expect(original).toContain('CREATE TRIGGER audit_row_change');
  expect(repair).not.toMatch(/ADD COLUMN|SET audit_enabled\s*=\s*FALSE|apply_table_contracts|ensure_audit_triggers/);
});

test('derives exactly four uncovered FK prefixes and indexes only those actual columns', () => {
  const foreignKeys = [...table.matchAll(/^\s*(\w+) UUID[^\n]*REFERENCES public\.(\w+)\(id\)/gm)]
    .map((match) => ({ column: match[1], target: match[2] }));
  expect(foreignKeys).toEqual([
    { column: 'organization_id', target: 'organizations' },
    { column: 'route_run_id', target: 'route_runs' },
    { column: 'route_stop_id', target: 'route_stops' },
    { column: 'shipment_box_id', target: 'shipment_boxes' },
    { column: 'actor_user_id', target: 'users' },
  ]);
  const existing = indexes(original).concat([...table.matchAll(/UNIQUE \(([^)]+)\)/g)].map((match) => columns(match[1])));
  const missing = foreignKeys.filter(({ column }) => !existing.some((index) => index[0] === column)).map(({ column }) => column);
  expect(missing).toEqual(['organization_id', 'route_stop_id', 'shipment_box_id', 'actor_user_id']);
  expect(indexes(repair)).toEqual(missing.map((column) => [column]));
  for (const { column } of foreignKeys) expect(existing.concat(indexes(repair)).some((index) => index[0] === column)).toBe(true);
  expect(repair).not.toMatch(/CREATE (?:UNIQUE )?INDEX[^;]+WHERE|DROP (?:INDEX|FOREIGN KEY)/);
});

test('replaces only the printed enum check with the same three row-driven allowed actions', () => {
  expect(repair).toContain("'route_load_manifest_action'");
  expect(repair).toContain("ARRAY['mark_missing', 'undo_missing', 'report_discrepancy']::TEXT[]");
  expect(repair).toMatch(/'action', 'route_load_manifest_action', FALSE/);
  expect(repair).toContain("substr(md5('public.route_load_manifest_actions'), 1, 12)");
  expect(repair).toContain('BEFORE INSERT OR UPDATE OF action');
  expect(repair).toContain('public.enforce_lookup_column_contracts()');
  expect(repair.indexOf('CREATE TRIGGER %I')).toBeLessThan(repair.indexOf('DROP CONSTRAINT route_load_manifest_actions_action_check'));
  expect(repair.match(/DROP CONSTRAINT/g)).toHaveLength(1);
  expect(original).toContain("v_action NOT IN ('mark_missing', 'undo_missing', 'report_discrepancy')");
});

test('does not rewrite the existing writer, actor authorization, ledger grants or shape checks', () => {
  expect(repair).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION|GRANT |REVOKE |DROP POLICY|DISABLE|UPDATE public\.route_load_manifest_actions/);
  expect(original).toContain('GRANT SELECT, INSERT ON public.route_load_manifest_actions TO service_role');
  expect(original).toContain('route_load_actor_mismatch');
  expect(original).toContain('route_load_scope_denied');
  expect(original).toContain("CHECK ((action = 'report_discrepancy' AND route_stop_id IS NULL");
  expect(repair).toContain('LOCK TABLE public.route_load_manifest_actions IN SHARE ROW EXCLUSIVE MODE');
});
