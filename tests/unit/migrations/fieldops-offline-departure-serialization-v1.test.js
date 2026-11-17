const fs = require('fs');
const path = require('path');

const migrationRoot = path.resolve(__dirname, '../../../supabase/migrations');
const previous = fs.readFileSync(path.join(
  migrationRoot, '202604101500_uc082_route_run_scan_out_departure_gate_v1.sql',
), 'utf8').replace(/\r\n/g, '\n');
const replacement = fs.readFileSync(path.join(
  migrationRoot, '20261008120000_fieldops_offline_departure_serialization_v1.sql',
), 'utf8').replace(/\r\n/g, '\n');

describe('F675 serialized offline departure replay', () => {
  test('only serializes the canonical route read; preserves every authorization and scan gate', () => {
    const start = previous.indexOf('CREATE OR REPLACE FUNCTION public.confirm_route_run_departure_v1(');
    const end = previous.indexOf('CREATE OR REPLACE FUNCTION public.ui_confirm_route_run_departure_v1(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const oldFunctionAndGrants = previous.slice(start, end).trim();
    const newFunctionAndGrants = replacement.slice(
      replacement.indexOf('CREATE OR REPLACE FUNCTION public.confirm_route_run_departure_v1('),
      replacement.lastIndexOf('COMMIT;'),
    ).trim();
    const oldRead = '   WHERE rr.id = v_route_run_id\n   LIMIT 1;';
    expect(oldFunctionAndGrants.split(oldRead)).toHaveLength(2);
    expect(newFunctionAndGrants).toBe(oldFunctionAndGrants.replace(
      oldRead, '   WHERE rr.id = v_route_run_id\n   LIMIT 1\n   FOR UPDATE OF rr;',
    ));
  });

  test('locks before reading previous confirmation and retains the existing API signature', () => {
    const lock = replacement.indexOf('FOR UPDATE OF rr;');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(replacement.indexOf("v_existing_departure :="));
    expect(replacement).toContain("SET row_security = on");
    expect(replacement).toContain("public.route_run_scan_out_reconciliation_v1(v_route_run.id)");
    expect(replacement).toContain("p_input JSONB DEFAULT '{}'::jsonb");
    expect(replacement).not.toContain('CREATE TABLE');
    expect(replacement).not.toContain('CREATE OR REPLACE FUNCTION api.');
    expect(replacement).not.toContain('expected_actor');
    expect(replacement).not.toContain('SKIP LOCKED');
  });
});
