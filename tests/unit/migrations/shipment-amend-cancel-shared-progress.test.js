const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const original = read('supabase/migrations/202603191030_shipment_amend_cancel_ui_v1.sql');
const migration = read('supabase/migrations/20260905212000_shipment_amend_cancel_shared_progress_v1.sql');
const functionOf = sql => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_v1(');
  const end = sql.indexOf('$function$;', start);
  if (start < 0 || end < start) throw new Error('Missing complete shipment amend/cancel function');
  return sql.slice(start, end + '$function$;'.length);
};
const before = functionOf(original);
const current = functionOf(migration);
const startRun = '  v_run_id := public.start_workflow_run(v_template_id, v_context);';
const tail = '  SELECT workflow_status\n    INTO v_workflow_status';
const inline = current.slice(current.indexOf(startRun) + startRun.length, current.indexOf(tail));

describe('shipment amend/cancel shared inline progression source contract (not DB execution)', () => {
  test('changes only inline progression and obsolete timer declarations in the current function', () => {
    let prefix = before.slice(0, before.indexOf(startRun) + startRun.length);
    for (const declaration of [
      '  v_inline_kick_poll_ms INT := 50;\n',
      '  v_inline_started_at TIMESTAMPTZ := clock_timestamp();\n',
      '  v_inline_deadline TIMESTAMPTZ := NULL;\n',
    ]) {
      expect(prefix).toContain(declaration);
      prefix = prefix.replace(declaration, '');
    }
    expect(current.slice(0, current.indexOf(startRun) + startRun.length)).toBe(prefix);
    expect(current.slice(current.indexOf(tail))).toBe(before.slice(before.indexOf(tail)));
    expect(migration.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(1);
    expect(current).toContain('LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path TO public, workflow_handlers, extensions, pg_temp');
  });

  test('starts the existing bounded shared helper only after validation and workflow creation', () => {
    expect(inline.match(/public\.progress_workflow_run_until_wait_v1\(/g)).toHaveLength(1);
    expect(inline).toMatch(/public\.progress_workflow_run_until_wait_v1\(\s*v_run_id,\s*v_inline_explicit_input,\s*v_inline_kick_budget_ms,\s*v_inline_kick_max_attempts\s*\)/);
    expect(current).toContain('v_inline_kick_max_attempts INT := 3;');
    expect(current).toContain('v_inline_kick_budget_ms INT := 500;');
    expect(current).toMatch(/'ui_explicit_wake',\s*TRUE,\s*'source',\s*'shipment_amend_cancel_v1'/);
    expect(current.indexOf('v_guard :=')).toBeLessThan(current.indexOf(startRun));
    expect(current).not.toMatch(/pg_sleep\(|v_inline_deadline|v_inline_started_at|v_inline_kick_poll_ms|WHILE v_inline_attempts/);
    expect(inline).not.toMatch(/clock_timestamp|public\.progress_workflow_run\(/);
  });

  test('projects shared diagnostics and retains safe malformed-next-run handling', () => {
    expect(inline).toContain("v_inline_attempts := COALESCE(NULLIF(v_progress->>'attempts', '')::INT, 0);");
    expect(inline).toContain("v_inline_elapsed_ms := COALESCE(NULLIF(v_progress->>'elapsed_ms', '')::INT, 0);");
    expect(inline).toContain("v_step_status := lower(NULLIF(v_progress->>'status', ''));");
    expect(inline).toContain("v_inline_error := NULLIF(v_progress->>'error', '');");
    expect(inline).toMatch(/v_inline_next_run_at := NULLIF\(v_progress->>'next_run_at', ''\)::TIMESTAMPTZ;\s*EXCEPTION\s*WHEN others THEN\s*v_inline_next_run_at := NULL;/);
    expect(current.match(/'workflow_inline_kick'/g)).toHaveLength(2);
  });

  test('does not swallow the current shared helper authorization boundary', () => {
    expect(inline).toMatch(/EXCEPTION\s*WHEN SQLSTATE '42501' THEN\s*RAISE;\s*WHEN others THEN\s*v_inline_error := SQLERRM;/);
    const helper = read('supabase/migrations/202609041020_workflow_progress_access_boundary_v1.sql');
    expect(helper).toMatch(/WHEN SQLSTATE '42501' THEN\s*RAISE;/);
    expect(helper).toContain('v_last := public.progress_workflow_run(p_workflow_run_id, v_injected_operation_result);');
    expect(helper).toContain("v_injected_operation_result := '{}'::JSONB;");
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.progress_workflow_run');
  });

  test('the later destination-capture replacement preserves shared progression and authorization', () => {
    const latest = functionOf(read('supabase/migrations/20260907120000_shipment_destination_capture_v1.sql'));
    expect(latest).toContain(startRun);
    expect(latest.match(/public\.progress_workflow_run_until_wait_v1\(/g)).toHaveLength(1);
    expect(latest).toMatch(/public\.progress_workflow_run_until_wait_v1\(\s*v_run_id,\s*v_inline_explicit_input,\s*v_inline_kick_budget_ms,\s*v_inline_kick_max_attempts\s*\)/);
    expect(latest).toContain("v_inline_error := NULLIF(v_progress->>'error', '');");
    expect(latest).toMatch(/WHEN SQLSTATE '42501' THEN\s*RAISE;/);
    expect(latest).not.toMatch(/pg_sleep\(|WHILE v_inline_attempts/);
  });

  test('keeps public grants and current API/batch callers without new entrypoints', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.shipment_amend_cancel_v1(JSONB) FROM PUBLIC, anon;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_v1(JSONB) TO authenticated, service_role;');
    const api = read('supabase/migrations/202604111130_api_shipment_amend_cancel_wrappers_v1.sql');
    expect(api).toMatch(/CREATE OR REPLACE FUNCTION api\.shipment_amend_cancel_v1\([\s\S]*?SECURITY INVOKER[\s\S]*?SELECT public\.shipment_amend_cancel_v1\(p_input\);/);
    const batch = read('supabase/migrations/202604081930_uc224_shipment_batch_operation_v1.sql');
    expect(batch).toContain('v_result := public.shipment_amend_cancel_v1(');
    expect(batch).toContain('v_visible_shipment := public.ui_get_resource_v1(p_resource_key, v_selected_uuid);');
    expect(migration).not.toMatch(/CREATE (?:TABLE|SCHEMA)|CREATE OR REPLACE FUNCTION api\./);
    expect(migration.indexOf("SET LOCAL lock_timeout = '30s';")).toBeLessThan(migration.indexOf('pg_advisory_xact_lock('));
  });

  test('restores selected pgTAP helper/no-sleep assertions and current security regression without skips', () => {
    const pgtap = read('supabase/tests/pgtap/051_shipment_amend_cancel_ui.sql');
    expect(pgtap).toContain('SELECT plan(36);');
    expect(pgtap.match(/^SELECT (?:ok|matches|is|function_privs_are|has_function)\(/gm)).toHaveLength(36);
    expect(pgtap).toContain('reuses the shared inline workflow progress helper');
    expect(pgtap).toContain('does not maintain a bespoke inline sleep loop');
    expect(pgtap).toContain("WHEN SQLSTATE ''42501'' THEN[[:space:]]+RAISE;");
    expect(pgtap).toContain('retains returned shared-helper error diagnostics');
    expect(pgtap).toContain('ROLLBACK;');
    expect(pgtap).not.toMatch(/\b(?:skip|todo)\(/i);
  });

});
