const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20260923001000_arabic_registry_display_v1.sql'), 'utf8');
const specs = name => JSON.parse(migration.match(new RegExp(name + " jsonb := '([\\s\\S]*?)'::jsonb;"))[1]);

test('Arabic overlays retain exact English and stable selectors', () => {
  const nav = specs('nav');
  const read = specs('read_labels');
  const commands = specs('command_labels');
  const tracking = specs('tracking_labels');
  expect(nav.length).toBe(23);
  for (const id of ["workflow-templates", "workflow-template-steps", "workflow-run-steps", "manual-review-tasks", "request-history", "operations"]) expect(nav.some(row => row.id === id)).toBe(true);
  expect(nav.some(row => row.app === "portal" && row.kind === "section" && row.id === "operations")).toBe(true);
  expect(read.map(x => x.id)).toEqual(['shipments', 'dispatch_exception_review']);
  expect(commands.map(x => x.id)).toEqual(['marketplace.accept_award', 'route_runs.accept_assignment']);
  expect(tracking.length).toBe(8);
  for (const group of [nav, read, commands, tracking]) {
    for (const row of group) {
      expect(row.en).toEqual(expect.any(String));
      expect(row.en.length).toBeGreaterThan(0);
      expect(row.ar).toMatch(/[\u0600-\u06ff]/);
    }
  }
  expect(new Set(nav.map(x => x.app + ':' + x.kind + ':' + x.id)).size).toBe(nav.length);
});

test('navigation item identity includes its parent section', () => {
  const nav = specs('nav');
  const items = nav.filter(row => row.kind === 'item');
  expect(items).toHaveLength(19);
  expect(items.every(row => typeof row.section === 'string' && row.section.length > 0)).toBe(true);
  expect(new Set(items.map(row => [row.app, row.section, row.id].join(':'))).size).toBe(items.length);
  expect(migration).toContain("ELSIF e->>'kind'='item' AND b->>'id'=e->>'section' THEN");
  expect(migration).toContain("IF n>1 THEN RAISE EXCEPTION 'Duplicate navigation id %'");

  const selector = nav.find(row => row.app === 'console' && row.kind === 'item' && row.id === 'workflow-runs');
  expect(selector.section).toBe('workflows');
  const sections = [
    { id: 'workflows', items: [{ id: 'workflow-runs', label: 'Workflow runs', href: '/console/resources/workflow_runs' }] },
    { id: 'observability', items: [{ id: 'workflow-runs', label: 'Workflow runs', href: '/console/observability/workflow-runs' }] },
  ];
  const selected = source => source
    .filter(section => section.id === selector.section)
    .flatMap(section => section.items.filter(item => item.id === selector.id));
  expect(selected(sections)).toHaveLength(1);
  expect(selected(sections)[0].href).toBe('/console/resources/workflow_runs');
  expect(sections[1].items[0].href).toBe('/console/observability/workflow-runs');
  expect(selected([
    { id: 'workflows', items: [sections[0].items[0], { ...sections[0].items[0] }] },
    sections[1],
  ])).toHaveLength(2);
});

test('migration is append-only, guarded, and limits public Arabic keys to eight', () => {
  expect(migration).toContain('CREATE OR REPLACE FUNCTION public.public_tracking_config_v1()');
  expect(migration).toContain("REVOKE ALL ON FUNCTION public.public_tracking_config_v1() FROM PUBLIC, anon;");
  expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.public_tracking_config_v1() TO authenticated, service_role;");
  expect(migration).not.toContain("GRANT EXECUTE ON FUNCTION public.public_tracking_config_v1() TO anon");
  expect(migration).toContain('public.upsert_settings_value_v1');
  expect(migration).not.toMatch(/path\s*\|\|\s*'(?:label|label_ar|description|description_ar)'/);
  expect((migration.match(/array_append\(path,'(?:label|label_ar|description|description_ar)'\)/g) || []).length).toBe(6);
  expect(migration).toContain('r.cached_value IS DISTINCT FROM r.value');
  expect(migration).toContain("IF n>1 THEN RAISE EXCEPTION");
  expect(migration).toContain("public.normalize_settings_value_v1('ui_read_registry',v)");
  expect(migration).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
  const publicFields = migration.split('AS $function$')[1];
  const keys = [...publicFields.matchAll(/'([a-z_]+_ar)',\s*(?:source\.)?value/g)].map(m => m[1]);
  expect(keys).toEqual([
    'title_ar', 'description_ar', 'results_description_ar', 'empty_ar',
    'label_ar', 'placeholder_ar', 'search_label_ar', 'clear_label_ar',
  ]);
});
