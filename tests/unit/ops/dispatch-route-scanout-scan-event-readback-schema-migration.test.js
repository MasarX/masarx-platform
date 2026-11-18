const fs = require('fs');
const path = require('path');

const migrationName = '202606302005_dispatch_route_scanout_scan_event_readback_schema_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function fieldBlock(sql, key) {
  const needle = `'key', '${key}'`;
  const start = sql.indexOf(needle);
  expect(start).toBeGreaterThan(-1);
  const nextField = sql.indexOf("jsonb_build_object(\n                  'key'", start + needle.length);
  const end = nextField > start ? nextField : sql.indexOf('\n              ),', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout scan-event readback schema migration', () => {
  test('extends only the scan-load registry command readback schema with scan-event lineage', () => {
    const sql = readMigration();

    expect(sql).toContain("WHEN 'routes.scan_load' THEN");
    expect(sql).not.toContain("WHEN 'routes.confirm_departure' THEN");
    expect(sql).toContain("field->>'key' NOT IN ('scan_event_id', 'scan_created')");
    expect(fieldBlock(sql, 'scan_event_id')).toContain("'path', 'scan_event_id'");
    expect(fieldBlock(sql, 'scan_created')).toContain("'path', 'scan_created'");
  });

  test('persists registry updates without stale cached readback', () => {
    const sql = readMigration();

    expect(sql).toContain("WHERE s.category = 'ui_command_registry'");
    expect(sql).toContain('UPDATE public.settings_versions');
    expect(sql).toContain('version = v_row.version + 1');
    expect(sql).toContain("change_reason = 'Expose route-load scan event lineage in route scan-out readback schema.'");
    expect(sql).toContain('UPDATE public.settings');
    expect(sql).toContain('cached_value = v_next');
    expect(sql).toContain('last_updated = now()');
  });
});
