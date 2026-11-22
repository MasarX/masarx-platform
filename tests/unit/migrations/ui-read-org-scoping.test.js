const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname,
  '../../../supabase/migrations/20261027030000_ui_rpc_executor_role_v1.sql'), 'utf8');

test.each([
  'ui_get_resource_v1',
  'ui_list_resource_v1',
  'ui_filter_distinct_values_v1',
  'ui_resource_metrics_v1',
  'ui_update_resource_v1',
  'ui_delete_resource_v1',
])('%s applies the common scope predicate before executing its query', (name) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start).split(/\nCREATE OR REPLACE FUNCTION /)[0];
  expect(body).toMatch(/SET row_security (?:= on|TO 'on')/);
  const scope = body.indexOf('public.ui_resource_scope_predicate_v1(');
  expect(scope).toBeGreaterThanOrEqual(0);
  expect(body.indexOf('  EXECUTE ')).toBeGreaterThan(scope);
});
