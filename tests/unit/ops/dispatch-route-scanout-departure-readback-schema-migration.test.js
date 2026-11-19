const fs = require('fs');
const path = require('path');

const migrationName = '202606301725_dispatch_route_scanout_departure_readback_schema_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
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

function sectionBetween(sql, startNeedle, endNeedle) {
  const start = sql.indexOf(startNeedle);
  const end = sql.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout departure readback schema migration', () => {
  test('extends only the confirm-departure registry command readback schema', () => {
    const sql = readMigration();
    const confirmBranchStart = sql.indexOf("WHEN 'routes.confirm_departure' THEN");
    const scanLoadBranchStart = sql.indexOf("WHEN 'routes.scan_load' THEN");

    expect(confirmBranchStart).toBeGreaterThan(-1);
    expect(scanLoadBranchStart).toBe(-1);
    expect(sql).toContain("'{execution,readback_schema,fields}'");
    expect(sql).toContain("field->>'key' NOT IN");
    expect(sql).toContain("'missing_stop_count'");
    expect(sql).toContain("'unexpected_scan_count'");
    expect(sql).toContain("'duplicate_scan_count'");
    expect(sql).toContain("'last_load_scanned_at'");
  });

  test('maps blocked-departure reconciliation fields to canonical scan_out readback paths', () => {
    const sql = readMigration();

    expect(fieldBlock(sql, 'missing_stop_count')).toContain("'path', 'scan_out.missing_stop_count'");
    expect(fieldBlock(sql, 'unexpected_scan_count')).toContain("'path', 'scan_out.unexpected_scan_count'");
    expect(fieldBlock(sql, 'duplicate_scan_count')).toContain("'path', 'scan_out.duplicate_scan_count'");
    expect(fieldBlock(sql, 'last_load_scanned_at')).toContain("'path', 'scan_out.last_load_scanned_at'");
  });

  test('preserves existing departure status readback fields while refreshing reconciliation fields', () => {
    const sql = readMigration();
    const replacementFilter = sectionBetween(
      sql,
      "WHERE field->>'key' NOT IN (",
      ')'
    );

    expect(replacementFilter).toContain("'missing_stop_count'");
    expect(replacementFilter).toContain("'unexpected_scan_count'");
    expect(replacementFilter).toContain("'duplicate_scan_count'");
    expect(replacementFilter).toContain("'last_load_scanned_at'");
    expect(replacementFilter).not.toContain("'ready_for_departure'");
    expect(replacementFilter).not.toContain("'confirmed_at'");
    expect(replacementFilter).not.toContain("'route_run_id'");
  });

  test('persists registry updates without cached stale success', () => {
    const sql = readMigration();

    expect(sql).toContain('UPDATE public.settings_versions');
    expect(sql).toContain('version = v_row.version + 1');
    expect(sql).toContain("change_reason = 'Expose route departure reconciliation counters in route scan-out readback schema.'");
    expect(sql).toContain('UPDATE public.settings');
    expect(sql).toContain('cached_value = v_next');
    expect(sql).toContain('last_updated = now()');
  });
});
