const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260919002000_tasks_controls_route_read_performance_v1.sql',
), 'utf8');

describe('tasks controls route read performance repair', () => {
  test('uses narrow route base joins instead of compositional visible views', () => {
    expect(migration).toContain('LEFT JOIN public.route_stops rs');
    expect(migration).toContain('LEFT JOIN public.route_runs stop_rr');
    expect(migration).toContain('LEFT JOIN public.route_runs direct_rr');
    expect(migration).not.toContain('route_stops_visible_v1');
    expect(migration).not.toContain('route_runs_visible_v1');
  });

  test('guards both route identities with the canonical actor predicate', () => {
    expect(migration).toContain(
      'public.route_run_actor_can_read_v1(stop_rr.organization_id, stop_rr.id, stop_rr.driver_user_id)',
    );
    expect(migration).toContain(
      'public.route_run_actor_can_read_v1(direct_rr.organization_id, direct_rr.id, direct_rr.driver_user_id)',
    );
    expect(migration).toMatch(
      /CASE[\s\S]*WHEN t\.resource_type = 'route_stop'[\s\S]*stop_rr\.id IS NOT NULL[\s\S]*THEN rs\.planned_window_start_at[\s\S]*WHEN t\.resource_type = 'route_run'[\s\S]*direct_rr\.id IS NOT NULL[\s\S]*THEN direct_rr\.planned_start_at[\s\S]*ELSE NULL[\s\S]*END AS planned_at/,
    );
  });

  test('preserves the exact task projection, grants, and capability scope', () => {
    for (const required of [
      "'tasks.read'",
      't.organization_id = public.current_user_org_id()',
      't.client_id = public.current_user_client_id()',
      't.sender_id = public.current_user_sender_id()',
      "WHEN planned_at IS NULL THEN 'later'",
      'AS smart_order',
      'AS urgency_now',
      'AS urgency_today',
      'AS urgency_later',
      'AS reference',
      'REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;',
      'GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;',
    ]) expect(migration).toContain(required);
    expect(migration).not.toContain('statement_timeout');
    expect(migration).not.toContain('CREATE INDEX');
    expect(migration).not.toContain('ui_read_registry');
  });
});
