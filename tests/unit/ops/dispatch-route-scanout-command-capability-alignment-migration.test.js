const fs = require('fs');
const path = require('path');

const migrationName = '202606291755_dispatch_route_scanout_command_capability_alignment_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function branchBlock(sql, actionKey) {
  const start = sql.indexOf(`WHEN '${actionKey}' THEN`);
  expect(start).toBeGreaterThan(-1);
  const nextBranch = sql.indexOf('\n          WHEN ', start + actionKey.length);
  const end = nextBranch > start ? nextBranch : sql.indexOf('\n          ELSE value', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout command capability alignment migration', () => {
  test('maps scanout commands to their canonical mutation permissions', () => {
    const sql = readMigration();

    expect(branchBlock(sql, 'routes.scan_load')).toContain(
      "jsonb_set(value, '{capability}', to_jsonb('scan_events.write'::text), TRUE)"
    );
    expect(branchBlock(sql, 'routes.confirm_departure')).toContain(
      "jsonb_set(value, '{capability}', to_jsonb('tasks.complete'::text), TRUE)"
    );
    expect(sql).toContain("CASE value->>'key'");
  });

  test('refreshes only route-run scanout command registry entries and cached readback', () => {
    const sql = readMigration();

    expect(sql).toContain("WHERE s.category = 'ui_command_registry'");
    expect(sql).toContain('UPDATE public.settings_versions');
    expect(sql).toContain('version = v_row.version + 1');
    expect(sql).toContain(
      "change_reason = 'Align route scan-out UI command capabilities with canonical scan/departure mutation guards.'"
    );
    expect(sql).toContain('UPDATE public.settings');
    expect(sql).toContain('SET cached_value = v_next');
    expect(sql).toContain('last_updated = now()');
  });

  test('keeps route-run scoped command behavior without fallback shortcuts', () => {
    const sql = readMigration();

    expect(sql).not.toContain("'schema_category', 'resource:route_stops'");
    expect(sql).not.toContain("'resource_key', 'route_stops'");
    expect(sql).not.toContain('support_contacts');
    expect(sql).not.toContain('app-side');
    expect(sql).not.toContain('fallback');
  });
});
