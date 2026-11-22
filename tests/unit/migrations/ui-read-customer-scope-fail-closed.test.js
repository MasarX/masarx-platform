const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (name) => readFileSync(join(__dirname, '../../..', name), 'utf8');
const source = read('supabase/migrations/20261105130000_ui_read_customer_scope_fail_closed_v2.sql');
const runtime = read('supabase/tests/pgtap/0zz_ui_read_scope_failclosed_v1.sql');

test('rejects missing customer scope mappings before considering ancestors', () => {
  const guard = source.indexOf('Customer-partitioned rows never fall back');
  expect(guard).toBeGreaterThanOrEqual(0);
  const ladder = source.indexOf('FOR v_scope IN', guard);
  expect(ladder).toBeGreaterThan(guard);
  const boundary = source.slice(guard, ladder);
  expect(boundary).toContain('public.ui_scope_partition_column_v1(');
  expect(boundary).toContain("ERRCODE = '42501'");
  for (const assertion of ['list fails closed', 'get fails closed', 'metrics fail closed', 'distinct fails closed']) {
    expect(runtime).toContain(assertion);
  }
});
