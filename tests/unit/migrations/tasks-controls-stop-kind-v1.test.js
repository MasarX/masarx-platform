const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260919003000_tasks_controls_stop_kind_v1.sql',
), 'utf8');

describe('tasks controls stop-kind repair', () => {
  test('appends only actor-visible stop kind to the existing projection shape', () => {
    expect(migration).toMatch(
      /AS reference,\s*CASE\s+WHEN classified\.resource_type = 'route_stop' AND exposed_rr\.id IS NOT NULL\s+THEN exposed_rs\.stop_kind\s+ELSE NULL\s+END AS stop_kind/s,
    );
    expect(migration).toContain('LEFT JOIN public.route_stops exposed_rs');
    expect(migration).toContain('LEFT JOIN public.route_runs exposed_rr');
    expect(migration).toContain(
      'public.route_run_actor_can_read_v1(exposed_rr.organization_id, exposed_rr.id, exposed_rr.driver_user_id)',
    );
    expect(migration).not.toContain('route_stops_visible_v1');
    expect(migration).not.toContain('route_runs_visible_v1');
  });

  test('CAS-promotes only stop_kind through the canonical tasks registry row', () => {
    for (const required of [
      "s.category = 'ui_read_registry'",
      "v_task->>'relation' IS DISTINCT FROM 'public.tasks'",
      "v_task->>'read_relation' IS DISTINCT FROM 'api.tasks_controls_v1'",
      "v_task->>'capability_read' IS DISTINCT FROM 'tasks.read'",
      "'[\"stop_kind\"]'::jsonb",
      "v_task := jsonb_set(v_task, '{select}', v_select, TRUE)",
      'AND s.settings_version_id = v_row.settings_version_id',
      "DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%'",
    ]) expect(migration).toContain(required);
    expect(migration).not.toContain('["metadata"]');
    expect(migration).not.toContain('statement_timeout');
    expect(migration).not.toContain('CREATE INDEX');
  });

  test('preserves grants, task scope, and the prior read-model contract', () => {
    for (const required of [
      "'tasks.read'",
      't.organization_id = public.current_user_org_id()',
      't.client_id = public.current_user_client_id()',
      't.sender_id = public.current_user_sender_id()',
      'AS smart_order',
      'AS urgency_now',
      'AS urgency_today',
      'AS urgency_later',
      'REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;',
      'GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;',
    ]) expect(migration).toContain(required);
  });
});
