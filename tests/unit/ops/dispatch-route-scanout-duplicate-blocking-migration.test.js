const fs = require('fs');
const path = require('path');

const migrationName = '202606302145_dispatch_route_scanout_duplicate_blocking_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function functionBody(sql) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.route_run_scan_out_reconciliation_v1');
  const end = sql.indexOf('\n$function$;', start);
  expect(start).toBeGreaterThan(-1);
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

describe('dispatch route scanout duplicate blocking migration', () => {
  test('blocks departure readiness when duplicate load scans are present', () => {
    const body = functionBody(readMigration());
    const readiness = sectionBetween(
      body,
      "'ready_for_departure',",
      'END\n    )'
    );

    expect(readiness).toContain('v_expected_stop_count > 0');
    expect(readiness).toContain('v_missing_stop_count = 0');
    expect(readiness).toContain('v_duplicate_scan_count = 0');
    expect(readiness).toContain('v_unexpected_scan_count = 0');
    expect(readiness.indexOf('v_duplicate_scan_count = 0')).toBeLessThan(
      readiness.indexOf('THEN TRUE')
    );
  });

  test('preserves duplicate count and duplicate route-stop readback', () => {
    const body = functionBody(readMigration());

    expect(body).toContain('v_duplicate_scan_count := v_duplicate_scan_count + (v_count - 1)');
    expect(body).toContain('v_duplicate_route_stop_ids || jsonb_build_array(v_expected.route_stop_id)');
    expect(body).toContain("'duplicate_scan_count', v_duplicate_scan_count");
    expect(body).toContain("'duplicate_route_stop_ids', NULLIF(v_duplicate_route_stop_ids, '[]'::jsonb)");
  });

  test('keeps reconciliation route-run scoped and free of departure mutation', () => {
    const body = functionBody(readMigration());

    expect(body).toContain('WHERE se.organization_id = v_route_run.organization_id');
    expect(body).toContain('AND se.route_run_id = v_route_run.id');
    expect(body).toContain("AND lower(COALESCE(se.scan_type, '')) = 'load'");
    expect(body).not.toMatch(/UPDATE\s+public\.route_runs\b/i);
    expect(body).not.toContain('confirm_route_run_departure_v1');
    expect(body).not.toContain('app-side');
  });
});
