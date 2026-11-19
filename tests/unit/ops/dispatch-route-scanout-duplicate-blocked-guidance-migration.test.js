const fs = require('fs');
const path = require('path');

const migrationName = '202606302230_dispatch_route_scanout_duplicate_blocked_guidance_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function functionBody(sql) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.confirm_route_run_departure_v1');
  const end = sql.indexOf('\n$function$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout duplicate blocked guidance migration', () => {
  test('reports duplicate load scans in canonical blocked-departure guidance', () => {
    const body = functionBody(readMigration());
    const blockedGate = body.slice(
      body.indexOf("v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id)"),
      body.indexOf('v_existing_departure :=', body.indexOf('v_scan_out :='))
    );

    expect(blockedGate).toContain("(v_scan_out->>'ready_for_departure')::BOOLEAN");
    expect(blockedGate).toContain(
      'is not ready for departure (missing %, duplicate %, unexpected %)'
    );
    expect(blockedGate).toContain("COALESCE(v_scan_out->>'missing_stop_count', '0')");
    expect(blockedGate).toContain("COALESCE(v_scan_out->>'duplicate_scan_count', '0')");
    expect(blockedGate).toContain("COALESCE(v_scan_out->>'unexpected_scan_count', '0')");
    expect(blockedGate.indexOf("COALESCE(v_scan_out->>'duplicate_scan_count', '0')")).toBeLessThan(
      blockedGate.indexOf("COALESCE(v_scan_out->>'unexpected_scan_count', '0')")
    );
  });

  test('keeps departure confirmation route-run scoped and workflow-gated', () => {
    const body = functionBody(readMigration());

    expect(body).toContain("PERFORM public.assert_capability_v1('tasks.complete', v_scope_type, v_scope_id)");
    expect(body).toContain('public.route_run_actor_can_read_v1(');
    expect(body).toContain('public.route_run_scan_out_reconciliation_v1(v_route_run.id)');
    expect(body).toContain('UPDATE public.route_runs rr');
    expect(body.indexOf('public.route_run_scan_out_reconciliation_v1(v_route_run.id)')).toBeLessThan(
      body.indexOf('UPDATE public.route_runs rr')
    );
    expect(body).not.toContain('app-side');
    expect(body).not.toContain('fallback');
  });
});
