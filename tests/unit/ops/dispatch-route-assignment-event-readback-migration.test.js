const fs = require('fs');
const path = require('path');

describe('dispatch route assignment event readback migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161420_b3_dispatch_route_assignment_event_readback_v1.sql',
  );

  test('adds a browser-safe exact assignment and event readback', () => {
    const body = fs.readFileSync(migrationPath, 'utf8');

    expect(body).toContain(
      'CREATE OR REPLACE FUNCTION public.ui_route_run_assignment_readback_v1(',
    );
    expect(body).toContain("public.ui_get_resource_v1('routes', p_route_run_id)");
    expect(body).toContain('FROM public.route_run_assignments a');
    expect(body).toContain('FROM public.route_run_assignment_events e');
    expect(body).toContain('e.assignment_version = p_assignment_version');
    expect(body).toContain("'visible', v_assignment IS NOT NULL AND v_event IS NOT NULL");
    expect(body).toContain(
      'CREATE OR REPLACE FUNCTION api.ui_route_run_assignment_readback_v1(',
    );
    expect(body).toContain(
      'GRANT EXECUTE ON FUNCTION api.ui_route_run_assignment_readback_v1(UUID, UUID, INTEGER) TO authenticated, service_role;',
    );
    expect(body).not.toMatch(/\b(?:session_user|current_user)\b/i);
  });

  test('adds reusable readback metadata without replacing route command definitions', () => {
    const body = fs.readFileSync(migrationPath, 'utf8');

    expect(body).toContain("value->>'key' IN ('routes.assign', 'routes.reassign')");
    expect(body).toContain("jsonb_set(value, '{execution,readback}', v_readback, TRUE)");
    expect(body).toContain("'path', 'items.0.route_run_assignment_id'");
    expect(body).toContain("'path', 'items.0.assignment_version'");
    expect(body).toContain("'success_path', 'visible'");
    expect(body).toContain("'max_attempts', 4");
    expect(body).toContain("'delay_ms', 150");
    expect(body).not.toContain("WHERE value->>'key' NOT IN ('routes.assign', 'routes.reassign')");
  });

  test('balances the migration advisory lock', () => {
    const body = fs.readFileSync(migrationPath, 'utf8');
    const lockName = '202607141930_dispatch_route_assignment_event_readback_v1';

    expect(body).toContain(`SELECT pg_advisory_lock(hashtext('${lockName}'))`);
    expect(body).toContain(`SELECT pg_advisory_unlock(hashtext('${lockName}'))`);
  });
});
