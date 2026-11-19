const fs = require('fs');
const path = require('path');

const migrationName = '202606301650_dispatch_route_scanout_stop_readback_scope_guard_v1.sql';
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

describe('dispatch route scanout stop readback scope guard migration', () => {
  test('guards per-stop scan readback through the selected route run and route stop', () => {
    const sql = readMigration();
    const helper = sectionBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.route_stop_load_scan_readback_v1',
      'COMMENT ON FUNCTION public.route_stop_load_scan_readback_v1',
    );

    expect(helper).toContain('route_stop_scope AS');
    expect(helper).toContain('JOIN route_run_scope scope');
    expect(helper).toContain('scope.id = rs.route_run_id');
    expect(helper).toContain('rs.id = p_route_stop_id');
    expect(helper).toContain('rs.route_run_id = p_route_run_id');
    expect(helper).toContain('rs.organization_id = p_organization_id');
    expect(helper).toContain('rs.client_id = p_client_id');
    expect(helper).toContain('p_shipment_id IS NULL');
    expect(helper).toContain('OR rs.shipment_id = p_shipment_id');
    expect(helper).toContain('JOIN route_stop_scope stop');
    expect(helper).toContain('se.route_stop_id = stop.route_stop_id');
  });

  test('keeps shipment and barcode readback tied to the scoped route stop shipment', () => {
    const sql = readMigration();
    const helper = sectionBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.route_stop_load_scan_readback_v1',
      'COMMENT ON FUNCTION public.route_stop_load_scan_readback_v1',
    );

    expect(helper).toContain('FROM route_stop_scope stop');
    expect(helper).toContain('JOIN public.shipments s');
    expect(helper).toContain('s.id = stop.shipment_id');
    expect(helper).toContain('s.client_id = stop.client_id');
    expect(helper).toContain('s.organization_id = stop.organization_id');
    expect(helper).toContain('AND s.id = p_shipment_id');
    expect(helper).toContain('AND se.shipment_id = expected.id');
    expect(helper).toContain("upper(NULLIF(btrim(COALESCE(se.barcode, '')), '')) = expected.tracking_upper");
  });

  test('preserves helper grants for browser-safe manifest consumers', () => {
    const sql = readMigration();

    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM anon'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) TO authenticated, service_role'
    );
  });
});
