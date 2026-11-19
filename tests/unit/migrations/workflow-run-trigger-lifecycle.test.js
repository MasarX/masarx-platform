const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260906010000_workflow_run_trigger_lifecycle_v1.sql');
function functionOf(sql, name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  const end = sql.indexOf('\n$$;', start);
  if (start < 0 || end < start) throw new Error('Missing complete function: ' + name);
  return sql.slice(start, end + 4);
}
describe('F641 workflow trigger lifecycle source contract (not DB execution)', () => {
  test('prior trigger pgTAP returns all planned assertions to its caller', () => {
    const pg = read('supabase/tests/pgtap/0zhg_workflow_run_triggers.sql');
    const planned = Number(pg.match(/^SELECT plan\((\d+)\)/m)[1]);
    expect(pg.match(/RETURN NEXT (?:ok|is|throws_ok)\(/g)).toHaveLength(planned);
    expect(pg).not.toMatch(/PERFORM (?:ok|is|throws_ok)\(|\b(?:skip|todo)\(/i);
    expect(pg).toContain('CREATE FUNCTION pg_temp.f641_prior_trigger_tests() RETURNS SETOF TEXT');
    expect(pg).toContain('SELECT * FROM pg_temp.f641_prior_trigger_tests();');
    const scalarActors = [...pg.matchAll(/set_config\('request.jwt.claim.sub', (v_user_\w+)::text, true\)/g)];
    const claimActors = [...pg.matchAll(/set_config\('request.jwt.claims', jsonb_build_object\('sub', (v_user_\w+), 'role', 'authenticated'\)/g)];
    expect(claimActors.map((match) => match[1])).toEqual(scalarActors.map((match) => match[1]));
    expect(new Set(claimActors.map((match) => match[1]))).toEqual(new Set(['v_user_client_admin', 'v_user_platform', 'v_user_sender']));
    expect(pg).toContain("SET LOCAL ROLE authenticated");
    expect(pg).toContain('BEGIN;');
    expect(pg).toContain('ROLLBACK;');
  });
  test.each([
    ['ui_update_resource_v1', 'supabase/migrations/202601111110_ui_update_resource.sql'],
    ['ui_delete_resource_v1', 'supabase/migrations/202601152100_ui_command_execute_v1.sql'],
  ])('%s preserves all current logic except the shared resolved-relation guard', (name, source) => {
    const old = functionOf(read(source), name);
    const current = functionOf(migration, name);
    const guard = "  PERFORM public.ui_assert_generic_mutation_relation_v1(to_regclass(format('%I.%I', v_schema, v_table)));\n\n";
    expect(current.replace(guard, '')).toBe(old);
    expect(current.indexOf(guard)).toBeGreaterThan(current.indexOf('relation not found'));
    expect(current.indexOf(guard)).toBeLessThan(current.indexOf('EXECUTE v_sql'));
  });
  test('private OID boundary cannot be bypassed by resource aliases or session flags', () => {
    expect(migration).toContain("p_relation = 'public.workflow_run_triggers'::REGCLASS");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.ui_assert_generic_mutation_relation_v1(REGCLASS) FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).not.toMatch(/set_config\(|CREATE ROLE|mutation_mode/);
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.workflow_run_triggers FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON api.workflow_run_triggers FROM PUBLIC, anon, authenticated;');
  });
  test('preserves six-argument defaults and nonambiguous explicit seventh scope argument', () => {
    expect(migration).toMatch(/p_notes TEXT,\s*p_scope_id UUID\s*\)/);
    expect(migration).toContain('SELECT public.ui_create_workflow_run_trigger_v1($1, $2, $3, $4, $5, $6, NULL::UUID);');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION api.ui_create_workflow_run_trigger_v1(');
    expect(migration).not.toContain("assert_capability_v1('workflows.write'");
    expect(migration.match(/assert_capability_v1\('workflow_runs.write'/g)).toHaveLength(3);
    expect(migration).toContain("COALESCE(p_source_statuses, ARRAY['completed']::TEXT[])");
    expect(migration).toContain("v_actor_scope_type NOT IN ('platform', 'tenant', 'organization')");
    expect(migration).toContain('public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)');
  });
  test('retains tombstones, first deletion metadata and every fire while leaving worker and uniqueness unchanged', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    expect(migration).toContain('deleted_at = COALESCE(deleted_at, now())');
    expect(migration).toContain('deleted_by = COALESCE(deleted_by, auth.uid())');
    expect(migration).toContain("delete_reason = COALESCE(delete_reason, 'operator_delete')");
    expect(migration).toContain('cannot update a deleted workflow run trigger');
    expect(migration).toContain("USING ERRCODE = '55000'");
    expect(migration).not.toMatch(/DELETE FROM public\.workflow_(?:run_triggers|trigger_fires)|CREATE.*INDEX|DROP.*INDEX|FUNCTION public\.run_workflow_run_triggers_worker/);
    const current = read('supabase/migrations/202601281600_workflow_run_triggers.sql');
    expect(current).toContain("WHERE f.fire_status = 'pending'\n      AND t.enabled = TRUE");
  });
  test('writes canonical row readback and same-correlation lifecycle evidence', () => {
    expect(migration).toContain("IF v_action IS NULL OR v_action NOT IN ('create', 'update', 'delete')");
    expect(migration).toContain('RETURN to_jsonb(v_created) || jsonb_build_object(');
    expect(migration).toContain('RETURN to_jsonb(v_updated) || jsonb_build_object(');
    expect(migration).toContain("'workflow_binding'");
    expect(migration).toContain("v_payload || jsonb_build_object('decision_log_id', v_decision_log_id)");
    expect(migration).toContain("'correlation_id', v_correlation_id::text");
  });
  test('active projection retains raw scoped-history RLS and disables generic editing in current registry entries', () => {
    expect(migration).toContain('WITH (security_invoker = true)\nAS SELECT * FROM public.workflow_run_triggers WHERE deleted_at IS NULL;');
    expect(migration).toContain("'relation', 'public.workflow_run_triggers_active_v1'");
    expect(migration).toContain("'edit_mode', 'none'");
    expect(migration).not.toMatch(/DROP POLICY|ALTER POLICY|ALTER TABLE public\.workflow_trigger_fires/);
  });
  test('prepared pgTAP emits every planned assertion and retains rollback', () => {
    const pg = read('supabase/tests/pgtap/0zz_console_v2_workflow_run_trigger_lifecycle_rpc_v1.sql');
    const count = Number(pg.match(/SELECT plan\((\d+)\)/)[1]);
    const emitted = (pg.match(/^SELECT (?:has_function|ok|is|throws_ok|lives_ok)\(/gm) || []).length +
      (pg.match(/RETURN NEXT (?:has_function|ok|is|throws_ok|lives_ok)\(/g) || []).length;
    expect(emitted).toBe(count);
    expect(pg).not.toMatch(/PERFORM (?:ok|is|throws_ok|lives_ok)\(|\b(?:skip|todo)\(/i);
    expect(pg).not.toContain("'succeeded'");
    expect(pg).toContain('LANGUAGE plpgsql AS $f641$\nDECLARE');
    expect(pg).toContain('END;\n$f641$;\n\nSELECT * FROM pg_temp.f641_lifecycle_tests();');
    expect(pg.match(/\$f641\$/g)).toHaveLength(2);
    expect(pg).toContain('ROLLBACK;');
  });
});
