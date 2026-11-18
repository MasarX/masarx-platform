const fs = require('fs');
const path = require('path');

const migrationName = '202606301520_dispatch_route_scanout_barcode_readback_alignment_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function sectionBetween(sql, startNeedle, endNeedle) {
  const start = sql.indexOf(startNeedle);
  const end = sql.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout barcode readback migration', () => {
  test('centralizes per-stop load scan readback with barcode-only matching', () => {
    const sql = readMigration();
    const helper = sectionBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.route_stop_load_scan_readback_v1',
      'COMMENT ON FUNCTION public.route_stop_load_scan_readback_v1',
    );

    expect(helper).toContain('public.route_run_actor_can_read_v1');
    expect(helper).toContain("upper(NULLIF(btrim(COALESCE(s.tracking_number, '')), '')) AS tracking_upper");
    expect(helper).toContain("upper(NULLIF(btrim(COALESCE(se.barcode, '')), '')) = expected.tracking_upper");
    expect(helper).toMatch(/se\.route_stop_id\s+IS\s+NULL\s+AND\s+se\.shipment_id\s+IS\s+NULL/i);
    expect(helper).toContain("lower(COALESCE(se.scan_type, '')) = 'load'");
  });

  test('uses the same readback helper for route manifests and route-stop API projection', () => {
    const sql = readMigration();
    const manifest = sectionBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_current_v1',
      'COMMENT ON FUNCTION public.route_run_execution_manifest_current_v1',
    );
    const routeStops = sectionBetween(
      sql,
      'CREATE OR REPLACE VIEW public.route_stops_visible_v1',
      'COMMENT ON VIEW public.route_stops_visible_v1',
    );

    expect(manifest).toContain('public.route_stop_load_scan_readback_v1(');
    expect(manifest).toContain('v_route_run.organization_id');
    expect(manifest).toContain('rs.shipment_id');
    expect(routeStops).toContain('public.route_stop_load_scan_readback_v1(');
    expect(routeStops).toContain('rs.organization_id');
    expect(routeStops).toContain('rs.shipment_id');
    expect(sql).toContain('CREATE OR REPLACE VIEW api.route_stops');
  });
});
