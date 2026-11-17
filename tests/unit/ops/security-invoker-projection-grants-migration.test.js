const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const migrationName = '202608140900_security_invoker_projection_grants_v1.sql';

describe('security-invoker projection grant repair migration', () => {
  test('runs after both source view migrations', () => {
    expect(migrationName > '202604101380_b09_return_to_branch_intake_visibility_replay_v1.sql').toBe(true);
    expect(migrationName > '202604241920_uc114_sla_breach_view_shape_repair_v1.sql').toBe(true);
  });

  test.each([
    'return_to_branch_shipments_v1',
    'dispatch_exception_review_sla_breaches_v',
  ])('keeps public.%s fail-closed while enabling nested API security-invoker reads', (viewName) => {
    const sql = fs.readFileSync(path.join(migrationsDir, migrationName), 'utf8');

    expect(sql).toContain(`REVOKE ALL ON public.${viewName} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON public.${viewName} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON public.${viewName} FROM authenticated;`);
    expect(sql).toContain(`REVOKE ALL ON public.${viewName} FROM service_role;`);
    expect(sql).toContain(
      `GRANT SELECT ON public.${viewName} TO authenticated, service_role;`,
    );
    expect(sql).not.toContain(`GRANT SELECT ON public.${viewName} TO anon`);
  });
});
