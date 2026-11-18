const fs = require('fs');
const path = require('path');

const migrationName = '202606302130_dispatch_route_scanout_blocked_departure_readback_schema_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);
const pgtapPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'tests',
  'pgtap',
  '0zz_dispatch_route_scanout_ui_registry_capabilities_v1.sql'
);

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function fieldBlock(sql, key) {
  const needle = `'key', '${key}'`;
  const start = sql.indexOf(needle);
  expect(start).toBeGreaterThan(-1);
  const nextField = sql.indexOf("jsonb_build_object(\n                  'key'", start + needle.length);
  const end = nextField > start ? nextField : sql.indexOf(')\n              ),', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout blocked departure readback schema migration', () => {
  test('extends only confirm-departure readback with blocked status fields', () => {
    const sql = readFile(migrationPath);

    expect(sql).toContain("WHEN 'routes.confirm_departure' THEN");
    expect(sql).not.toContain("WHEN 'routes.scan_load' THEN");
    expect(sql).toContain("'{execution,readback_schema,fields}'");
    expect(sql).toContain("field->>'key' NOT IN");
    expect(sql).toContain("'status'");
    expect(sql).toContain("'blocked_reason'");
    expect(sql).toContain("'error_message'");
  });

  test('maps blocked departure readback to canonical command response paths', () => {
    const sql = readFile(migrationPath);

    expect(fieldBlock(sql, 'status')).toContain("'path', 'status'");
    expect(fieldBlock(sql, 'blocked_reason')).toContain("'path', 'blocked_reason'");
    expect(fieldBlock(sql, 'error_message')).toContain("'path', 'error.message'");
  });

  test('persists registry updates without stale cached readback schema', () => {
    const sql = readFile(migrationPath);

    expect(sql).toContain('UPDATE public.settings_versions');
    expect(sql).toContain('version = v_row.version + 1');
    expect(sql).toContain("change_reason = 'Expose blocked route departure status in route scan-out readback schema.'");
    expect(sql).toContain('UPDATE public.settings');
    expect(sql).toContain('cached_value = v_next');
    expect(sql).toContain('last_updated = now()');
  });

  test('keeps pgTAP registry contract aligned with blocked departure readback fields', () => {
    const sql = readFile(pgtapPath);

    expect(sql).toContain('SELECT plan(20);');
    expect(sql).toContain("readback_field.field_value->>'key' = 'status'");
    expect(sql).toContain("'status'");
    expect(sql).toContain("readback_field.field_value->>'key' = 'blocked_reason'");
    expect(sql).toContain("'blocked_reason'");
    expect(sql).toContain("readback_field.field_value->>'key' = 'error_message'");
    expect(sql).toContain("'error.message'");
  });
});
