const fs = require('fs');
const path = require('path');
const migration = 'supabase/migrations/202609060200_fieldops_reassignment_request_workflow_v1.sql';
const sql = fs.readFileSync(path.resolve(migration),'utf8');
const pg = fs.readFileSync('supabase/tests/pgtap/0zz_fieldops_reassignment_request_workflow_v1.sql','utf8');
const native = fs.readFileSync('tests/integration/workflows/route-run-assignment-lifecycle.test.js','utf8');
function body(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$function$;',start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start,end);
}
test('append-only migration has closed transaction and paired named function delimiters',()=>{
  expect(sql).toMatch(/BEGIN;/);
  expect(sql.trim()).toMatch(/COMMIT;$/);
  expect((sql.match(/\$function\$/g)||[]).length).toBe(16);
  expect(sql).not.toMatch(/LANGUAGE plpgsql AS \$\s/);
});
test('driver authority and expected actor precede idempotent request reads',()=>{
  const prepare=body('prepare_fieldops_reassignment_v1');
  const read=prepare.indexOf('SELECT * INTO v_request');
  for(const guard of ['p_expected_actor_user_id IS DISTINCT FROM v_actor','user_has_resource_capability_v1','lower(u.status) = \'active\'']) {
    expect(prepare.indexOf(guard)).toBeGreaterThanOrEqual(0);
    expect(prepare.indexOf(guard)).toBeLessThan(read);
  }
  expect(prepare).toContain('source_assignment_version IS DISTINCT FROM');
  expect(sql).toContain('UNIQUE (actor_user_id, idempotency_key)');
});
test.each(['fieldops_reassignment_source_v1','submit_fieldops_reassignment_v1'])('canonical latest executor and stop guards remain in %s',(name)=>{
  const text=body(name);
  for(const guard of ["ORDER BY t.created_at DESC, t.id DESC LIMIT 1","rs.metadata->>'shipment_action'",
    "tt.key = 'route_stop_execute'","t.completed_at IS NULL AND t.canceled_at IS NULL",
    "('open','pending','assigned','in_progress')","public.shipment_actions","lower(u.status) = 'active'"]) expect(text).toContain(guard);
});
test('service dispatch remains engine-first with exact persisted task, lineage and correlation',()=>{
  const submit=body('submit_fieldops_reassignment_v1');
  for(const guard of ["auth.jwt()->>'role'","<> 'service_role'","public.run_workflow_binding_stage_v1",
    "v_dispatch->>'outcome' IS DISTINCT FROM 'completed'","public.workflow_binding_dispatches",
    "tt.key = 'dispatch_exception_review'","t.metadata->>'parent_workflow_run_id'",
    "v_assignment_version IS DISTINCT FROM r.source_assignment_version",
    "set_config('request.correlation_id', r.id::text, TRUE)",
    "public.resolve_access_control_policy_v1","public.access_eval_capability_v1(v_actor_policy",
    "v_actor_scope,v_actor_scope_id,r.actor_user_id,v_actor_type",
    "v_actor_allowed IS DISTINCT FROM TRUE"]) expect(submit).toContain(guard);
  expect(submit).not.toMatch(/INSERT INTO public.tasks|set_config\('request.jwt|SQLERRM/i);
});
test('private event deputy binds exact generation and terminal task before canonical transition',()=>{
  const complete=body('complete_fieldops_reassignment_request_v1');
  for(const guard of ["TG_RELID <> 'public.route_stop_reassignment_events'::regclass",
    "NEW.source_route_run_assignment_id IS NULL","NEW.target_route_run_assignment_id IS NULL",
    "NEW.payload#>>'{source_assignment,assignment_version}' = q.source_assignment_version::text",
    "q.client_id IS NOT DISTINCT FROM NEW.client_id","q.shipment_id IS NOT DISTINCT FROM NEW.shipment_id",
    "a.driver_user_id = q.target_driver_user_id","v_task.completed_at IS NOT NULL",
    "public.transition_task_system_v1","'request_correlation_id', r.id","'operator_correlation_id'"]) expect(complete).toContain(guard);
  expect(complete).not.toMatch(/set_config\('request.jwt|run_task_completion_effects/i);
  expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role;');
});
test('selected scoped candidate projection and current mobile registry survive',()=>{
  const candidates=body('fieldops_reassignment_candidates_v1');
  for(const guard of ['public.fieldops_reassignment_source_v1(p_stop_id)','public.driver_profiles',
    "lower(dp.status) = 'active'","lower(u.status) = 'active'","'capacity_left'","'eta_min'","'distance_km'",'LIMIT 8']) expect(candidates).toContain(guard);
  for(const field of ['fieldops-reassignment-request','lookup_rpc','lookup_selection_param']) expect(sql).toContain(field);
  const registry=JSON.parse(fs.readFileSync('config/ops/workflow-binding-audit.json','utf8'));
  expect(JSON.stringify(registry)).toContain(migration);
});
test('native catalog plan counts emitted assertions and behavioral suite invokes actual UC078',()=>{
  const count=Number(pg.match(/SELECT plan\((\d+)\)/)[1]);
  expect((pg.match(/^SELECT (?:ok|is|has_table|has_column)\(/gm)||[]).length).toBe(count);
  expect(pg).toContain('SELECT * FROM finish();');
  expect(pg.trim()).toMatch(/ROLLBACK;$/);
  for(const marker of ['api.prepare_fieldops_reassignment_v1','api.submit_fieldops_reassignment_v1',
    'api.ui_execute_route_stop_reassign_v1','ROLLBACK TO SAVEPOINT r11_expected_rejection',
    'r11_owned_transition_failure','operator_correlation_id','never-sent-']) expect(native).toContain(marker);
});
