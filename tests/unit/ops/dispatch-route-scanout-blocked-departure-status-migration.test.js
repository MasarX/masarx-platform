const fs = require('fs');
const path = require('path');

const migrationName = '202606302120_dispatch_route_scanout_blocked_departure_status_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function functionBody(sql) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.ui_execute_route_run_scanout_v1');
  const end = sql.indexOf('\n$function$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout blocked departure status migration', () => {
  test('keeps blocked departure on the supported route-run scoped command path', () => {
    const body = functionBody(readMigration());

    expect(body).toContain("ELSIF v_action_key = 'routes.confirm_departure' THEN");
    expect(body).toContain('public.ui_confirm_route_run_departure_v1(');
    expect(body).toContain("WHEN SQLSTATE '23514' THEN");
    expect(body).toContain("SQLERRM NOT LIKE 'confirm_route_run_departure_v1 route_run % is not ready for departure%'");
    expect(body).toContain("public.route_run_scan_out_reconciliation_v1(v_route_run_id)");
    expect(body).toContain("public.ui_route_run_execution_manifest_v1(v_route_run_id)");
  });

  test('returns operator-visible blocked status and reconciliation readback', () => {
    const body = functionBody(readMigration());
    const blockedStart = body.indexOf("'status', 'route_departure_blocked'");
    const confirmedStart = body.indexOf("'status', 'route_departure_confirmed'");

    expect(blockedStart).toBeGreaterThan(-1);
    expect(confirmedStart).toBeGreaterThan(blockedStart);
    expect(body).toContain("'blocked_reason', 'route_load_reconciliation'");
    expect(body).toContain("'scan_out', COALESCE(NULLIF(v_scan_out, '{}'::jsonb), v_manifest->'scan_out', '{}'::jsonb)");
    expect(body).toContain("'route_execution_manifest', v_manifest");
    expect(body).toContain("'error', jsonb_build_object(");
    expect(body).toContain("'code', SQLSTATE");
    expect(body).toContain("'message', SQLERRM");
    expect(body).toContain("'items', jsonb_build_array(");
  });

  test('preserves fail-closed behavior for non-reconciliation errors', () => {
    const body = functionBody(readMigration());
    const exceptionBlock = body.slice(body.indexOf("WHEN SQLSTATE '23514' THEN"));

    expect(exceptionBlock).toContain('RAISE;');
    expect(exceptionBlock.indexOf('RAISE;')).toBeLessThan(exceptionBlock.indexOf("v_scan_out := COALESCE"));
    expect(body).not.toContain('app-side');
    expect(body).not.toContain('fallback');
  });
});
