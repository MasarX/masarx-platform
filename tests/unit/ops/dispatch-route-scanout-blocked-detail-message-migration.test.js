const fs = require('fs');
const path = require('path');

const migrationName = '202607030900_dispatch_route_scanout_blocked_detail_message_v1.sql';
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

describe('dispatch route scanout blocked detail message migration', () => {
  test('keeps the blocked departure error compatible with the UI command wrapper', () => {
    const body = functionBody(readMigration());
    const blockedGate = body.slice(
      body.indexOf("v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id)"),
      body.indexOf('v_existing_departure :=', body.indexOf('v_scan_out :='))
    );

    expect(blockedGate).toContain(
      "'confirm_route_run_departure_v1 route_run % is not ready for departure (missing %, duplicate %, unexpected %)%'"
    );
    expect(blockedGate).toContain("USING ERRCODE = '23514'");
    expect(blockedGate).toContain('public.route_run_scan_out_reconciliation_v1(v_route_run.id)');
    expect(blockedGate.indexOf('public.route_run_scan_out_reconciliation_v1(v_route_run.id)')).toBeLessThan(
      blockedGate.indexOf('RAISE EXCEPTION')
    );
  });

  test('adds canonical reconciliation detail arrays to operator failure messages', () => {
    const body = functionBody(readMigration());
    const blockedGate = body.slice(
      body.indexOf("v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id)"),
      body.indexOf('v_existing_departure :=', body.indexOf('v_scan_out :='))
    );

    expect(blockedGate).toContain('v_blocked_detail := concat_ws(');
    expect(blockedGate).toContain("jsonb_typeof(v_scan_out->'missing_route_stop_ids') = 'array'");
    expect(blockedGate).toContain("format('missing_route_stop_ids %s', v_scan_out->>'missing_route_stop_ids')");
    expect(blockedGate).toContain("jsonb_typeof(v_scan_out->'duplicate_route_stop_ids') = 'array'");
    expect(blockedGate).toContain("format('duplicate_route_stop_ids %s', v_scan_out->>'duplicate_route_stop_ids')");
    expect(blockedGate).toContain("jsonb_typeof(v_scan_out->'unexpected_barcodes') = 'array'");
    expect(blockedGate).toContain("format('unexpected_barcodes %s', v_scan_out->>'unexpected_barcodes')");
    expect(blockedGate).toContain("CASE WHEN NULLIF(v_blocked_detail, '') IS NOT NULL");
  });
});
