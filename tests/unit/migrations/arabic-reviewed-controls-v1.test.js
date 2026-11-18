const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260923002000_arabic_reviewed_controls_v1.sql'), 'utf8');
const source = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const specs = name => JSON.parse(migration.match(new RegExp(name + " jsonb := '([\\s\\S]*?)'::jsonb;"))[1]);

test('reviewed Arabic selectors are bounded, unique, and source-backed', () => {
  const nav = specs('nav');
  const reads = specs('reads');
  const operators = specs('operators');
  const commands = specs('commands');
  expect(nav).toHaveLength(5);
  expect(reads).toHaveLength(10);
  expect(operators.map(row => row.id)).toEqual(['eq', 'ne', 'ilike']);
  expect(commands.map(row => row.id)).toEqual([
    'shipments.delete', 'shipments.print_labels', 'shipments.resort',
    'shipments.update_geocode', 'dispatch_exception_review.complete',
  ]);
  for (const rows of [nav, reads, operators, commands]) {
    for (const row of rows) expect(row.ar).toMatch(/[\u0600-\u06ff]/);
  }
  expect(new Set(nav.map(row => [row.app, row.section || '', row.id].join(':'))).size).toBe(5);
  expect(new Set(reads.map(row => [row.resource, row.collection, row.id].join(':'))).size).toBe(10);
  expect(new Set(commands.map(row => row.id)).size).toBe(5);
  expect(source('202601030900_ui_read_api_v2.sql')).toContain('"id": "portal-shipments"');
  expect(source('202601050900_ui_navigation_portal_tracking.sql')).toContain("'portal-tracking'");
  expect(source('202601051000_ui_navigation_commands.sql')).toContain("'console-commands'");
  const relatedSeed = source('202601191330_ui_read_registry_shipments_all_columns_related.sql');
  for (const row of reads.filter(row => row.collection === 'related')) {
    expect(relatedSeed).toContain("'resource','" + row.id + "'");
    expect(relatedSeed).toContain("'label','" + row.en + "'");
  }
  const actionSources = [
    ['202604081930_uc224_shipment_batch_operation_v1.sql', commands[0]],
    ['202601192240_ui_command_registry_shipments_print_labels_primary.sql', commands[1]],
    ['202604061930_b04_uc054_shipment_resort_after_route_change_v1.sql', commands[2]],
    ['202604081845_uc223_shipment_update_geocode_command_v1.sql', commands[3]],
    ['202604091530_b09_ndr_resolution_orchestration_v1.sql', commands[4]],
  ];
  for (const [file, row] of actionSources) {
    expect(source(file)).toContain(row.id);
    expect(source(file)).toContain(row.en);
  }
});

test('overlay is append-only and preserves approved source and English guards', () => {
  expect(migration).toContain('r.cached_value IS DISTINCT FROM r.value');
  expect(migration).toContain('r.approved_at IS NULL');
  expect(migration).toContain('r.effective_until IS NOT NULL');
  expect(migration).toContain('r.schema_version');
  expect(migration).toContain('public.upsert_settings_value_v1');
  expect(migration).toContain("public.normalize_settings_value_v1('ui_read_registry',v)");
  expect(migration).toContain('Duplicate navigation id');
  expect(migration).toContain('Duplicate read target');
  expect(migration).toContain('Duplicate registry key');
  expect(migration).toContain("NOT (v#>path ? 'label_ar')");
  expect(migration).not.toMatch(/path\s*\|\|\s*'(?:label|label_ar)'/);
  expect(migration).toContain('b:=(a->i)->(collection);');
  expect(migration).toContain("(b->j)->>(CASE WHEN collection='related' THEN 'resource' ELSE 'key' END)");
  expect(migration).toContain('a:=v->(collection);');
  expect(migration).not.toMatch(/\b(?:DELETE\s+FROM|DROP\s+(?:TABLE|FUNCTION)|TRUNCATE\s+TABLE|GRANT\s+EXECUTE|REVOKE\s+ALL)\b/i);
  expect(specs('reads').find(row => row.resource === 'dispatch_exception_review')).toMatchObject({
    id: 'resource_id', en: null, column: 'resource_id', op: 'eq',
  });
});
