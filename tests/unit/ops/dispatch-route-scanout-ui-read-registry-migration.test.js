const fs = require('fs');
const path = require('path');

const migrationName = '202607031430_dispatch_route_scanout_ui_read_registry_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function registryResourceBlock(sql, resourceKey) {
  const start = sql.indexOf(`'key', '${resourceKey}'`);
  expect(start).toBeGreaterThan(-1);
  const nextResource = sql.indexOf("\n    jsonb_build_object(\n      'key',", start + resourceKey.length);
  const end = nextResource > start ? nextResource : sql.indexOf('\n  );\n$function$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function viewBlock(sql, viewName) {
  const start = sql.indexOf(`CREATE VIEW public.${viewName}`);
  const nextView = sql.indexOf('\nDROP VIEW IF EXISTS public.', start + viewName.length);
  const nextPolicy = sql.indexOf('\nDROP POLICY IF EXISTS', start + viewName.length);
  const endCandidates = [nextView, nextPolicy].filter((value) => value > start);
  const end = Math.min(...endCandidates);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout UI read registry migration', () => {
  test('registers route execution resources through canonical read relations', () => {
    const sql = readMigration();

    expect(registryResourceBlock(sql, 'route_runs')).toEqual(expect.stringContaining("'relation', 'api.route_runs'"));
    expect(registryResourceBlock(sql, 'route_runs')).toEqual(expect.stringContaining("'allow_view_relation', TRUE"));
    expect(registryResourceBlock(sql, 'route_run_directory')).toEqual(
      expect.stringContaining("'relation', 'public.v_route_run_directory'")
    );
    expect(registryResourceBlock(sql, 'route_run_assignments')).toEqual(
      expect.stringContaining("'relation', 'public.route_run_assignments'")
    );
    expect(registryResourceBlock(sql, 'route_run_assignment_events')).toEqual(
      expect.stringContaining("'relation', 'public.route_run_assignment_events'")
    );
    expect(registryResourceBlock(sql, 'route_stop_reassignment_events')).toEqual(
      expect.stringContaining("'relation', 'public.route_stop_reassignment_events'")
    );
  });

  test('keeps Dispatch picker projections security-invoker and registry-backed', () => {
    const sql = readMigration();

    expect(viewBlock(sql, 'v_route_run_directory')).toContain('WITH (security_invoker = true)');
    expect(viewBlock(sql, 'driver_profile_picker_v1')).toContain('WITH (security_invoker = true)');
    expect(viewBlock(sql, 'v_vehicle_directory')).toContain('WITH (security_invoker = true)');
    expect(registryResourceBlock(sql, 'drivers')).toContain("'relation', 'public.driver_profile_picker_v1'");
    expect(registryResourceBlock(sql, 'drivers')).toContain("'capability_read', 'fleet.read'");
    expect(registryResourceBlock(sql, 'vehicle_directory')).toContain("'relation', 'public.v_vehicle_directory'");
    expect(registryResourceBlock(sql, 'vehicle_directory')).toContain("'capability_read', 'fleet.read'");
  });

  test('exposes scan-out reconciliation through the browser-safe api wrapper only', () => {
    const sql = readMigration();
    const wrapperStart = sql.indexOf('CREATE OR REPLACE FUNCTION api.route_run_scan_out_reconciliation_v1');
    const wrapperEnd = sql.indexOf('\nCREATE OR REPLACE FUNCTION public.ui_read_registry_dispatch_route_scanout_resources_v1', wrapperStart);
    const wrapper = sql.slice(wrapperStart, wrapperEnd);

    expect(wrapperStart).toBeGreaterThan(-1);
    expect(wrapperEnd).toBeGreaterThan(wrapperStart);
    expect(wrapper).toContain('SECURITY DEFINER');
    expect(wrapper).toContain('SELECT public.route_run_scan_out_reconciliation_v1($1);');
    expect(wrapper).toContain('REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM anon;');
    expect(wrapper).toContain('GRANT EXECUTE ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;');
  });

  test('updates only the Dispatch read-registry keys without app-side fallbacks', () => {
    const sql = readMigration();

    expect(sql).toContain("v_keys TEXT[] := ARRAY[\n    'route_runs',");
    expect(sql).toContain("WHERE s.category = 'ui_read_registry'");
    expect(sql).toContain("change_reason = 'Register Dispatch route scan-out resources for canonical ui_list_resource_v1 reads'");
    expect(sql).not.toContain('raw server');
    expect(sql).not.toContain('app-side');
    expect(sql).not.toContain('fallback');
  });
});
