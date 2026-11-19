const fs = require('fs');
const path = require('path');

const migrationName = '202606291700_dispatch_route_scanout_ui_actions_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function commandBlock(sql, commandKey) {
  const start = sql.indexOf(`'key', '${commandKey}'`);
  expect(start).toBeGreaterThan(-1);
  const nextCommand = sql.indexOf("\n      jsonb_build_object(\n        'key',", start + commandKey.length);
  const end = nextCommand > start ? nextCommand : sql.indexOf('\n    );', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout UI action registry migration', () => {
  test('registers the scan-load operator action through the route-run scoped executor', () => {
    const sql = readMigration();
    const scanLoad = commandBlock(sql, 'routes.scan_load');

    expect(scanLoad).toContain("'label', 'Scan route load'");
    expect(scanLoad).toContain("'description', 'Record a route-load scan against the selected route run and refresh scan-out readiness.'");
    expect(scanLoad).toContain("'capability', 'routes.read'");
    expect(scanLoad).toContain("'schema_category', 'resource:routes'");
    expect(scanLoad).toContain("'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1)");
    expect(scanLoad).toContain("'rpc', 'ui_execute_route_run_scanout_v1'");
    expect(scanLoad).toContain("'description', 'This writes an append-only load scan event for the selected route run and recalculates departure readiness.'");
    expect(scanLoad).toContain("'title', 'Record route load scan?'");
    expect(scanLoad).toContain("'confirm_label', 'Record scan'");
    expect(scanLoad).toContain("'cancel_label', 'Cancel'");
    expect(scanLoad).toContain("'tone', 'default'");
    expect(scanLoad).toContain("'key', 'barcode'");
    expect(scanLoad).toContain("'required', true");
    expect(scanLoad).toContain("'path', 'scan_out.scanned_stop_count'");
    expect(scanLoad).toContain("'path', 'scan_out.missing_stop_count'");
    expect(scanLoad).toContain("'path', 'scan_out.unexpected_scan_count'");
    expect(scanLoad).toContain("'path', 'scan_out.ready_for_departure'");
  });

  test('registers departure confirmation wording and readback on the same supported path', () => {
    const sql = readMigration();
    const confirmDeparture = commandBlock(sql, 'routes.confirm_departure');

    expect(confirmDeparture).toContain("'label', 'Confirm departure'");
    expect(confirmDeparture).toContain("'description', 'Confirm route departure after the selected route load reconciles cleanly.'");
    expect(confirmDeparture).toContain("'capability', 'routes.read'");
    expect(confirmDeparture).toContain("'schema_category', 'resource:routes'");
    expect(confirmDeparture).toContain("'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1)");
    expect(confirmDeparture).toContain("'rpc', 'ui_execute_route_run_scanout_v1'");
    expect(confirmDeparture).toContain("'title', 'Confirm route departure?'");
    expect(confirmDeparture).toContain("'description', 'This confirms departure only after route-load scan-out is ready and writes the canonical departure audit snapshot.'");
    expect(confirmDeparture).toContain("'confirm_label', 'Confirm departure'");
    expect(confirmDeparture).toContain("'cancel_label', 'Cancel'");
    expect(confirmDeparture).toContain("'tone', 'default'");
    expect(confirmDeparture).toContain("'path', 'scan_out.ready_for_departure'");
    expect(confirmDeparture).toContain("'path', 'route_departure.confirmed_at'");
    expect(confirmDeparture).toContain("'path', 'route_run_id'");
  });

  test('replaces existing route scanout registry commands before appending supported actions', () => {
    const sql = readMigration();

    const dedupeStart = sql.indexOf(
      "WHERE value->>'key' NOT IN ('routes.scan_load', 'routes.confirm_departure')"
    );
    const appendStart = sql.indexOf("jsonb_build_object(\n        'key', 'routes.scan_load'");
    const cacheUpdate = sql.indexOf('SET cached_value = v_next');

    expect(dedupeStart).toBeGreaterThan(-1);
    expect(appendStart).toBeGreaterThan(-1);
    expect(cacheUpdate).toBeGreaterThan(-1);
    expect(dedupeStart).toBeLessThan(appendStart);
    expect(appendStart).toBeLessThan(cacheUpdate);
  });

  test('keeps both operator actions free of contact fallbacks and route-stop resource shortcuts', () => {
    const sql = readMigration();
    const actions = `${commandBlock(sql, 'routes.scan_load')}\n${commandBlock(sql, 'routes.confirm_departure')}`;

    expect(actions).not.toContain("'schema_category', 'resource:route_stops'");
    expect(actions).not.toContain("'resource_key', 'route_stops'");
    expect(actions).not.toContain('support_contacts');
    expect(actions).not.toContain('phone');
    expect(actions).not.toContain('email');
  });
});
