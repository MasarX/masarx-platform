const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');

function readMigration(name) {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

describe('dispatch exception SLA breach view repair migrations', () => {
  test('pre-shape migration drops dependent views before the original UC114 view rebuild', () => {
    const preShapeMigration = '202604032244_uc114_sla_breach_view_pre_shape_compat_v1.sql';
    const originalMigration = '202604032245_uc114_ndr_sla_sweeper_reporting_v1.sql';
    expect(preShapeMigration < originalMigration).toBe(true);

    const sql = readMigration(preShapeMigration);
    const apiDropIndex = sql.indexOf('DROP VIEW IF EXISTS api.dispatch_exception_review_sla_breaches_v;');
    const publicDropIndex = sql.indexOf('DROP VIEW IF EXISTS public.dispatch_exception_review_sla_breaches_v;');

    expect(apiDropIndex).toBeGreaterThan(-1);
    expect(publicDropIndex).toBeGreaterThan(apiDropIndex);
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  test('final repair migration restores the canonical reason-aware API projection', () => {
    const reasonProjectionMigration = '202604051430_uc111_ndr_reason_projection_v1.sql';
    const finalRepairMigration = '202604241920_uc114_sla_breach_view_shape_repair_v1.sql';
    expect(reasonProjectionMigration < finalRepairMigration).toBe(true);

    const sql = readMigration(finalRepairMigration);
    const apiDropIndex = sql.indexOf('DROP VIEW IF EXISTS api.dispatch_exception_review_sla_breaches_v;');
    const publicDropIndex = sql.indexOf('DROP VIEW IF EXISTS public.dispatch_exception_review_sla_breaches_v;');
    const publicCreateIndex = sql.indexOf('CREATE VIEW public.dispatch_exception_review_sla_breaches_v');
    const apiCreateIndex = sql.indexOf('CREATE VIEW api.dispatch_exception_review_sla_breaches_v');

    expect(apiDropIndex).toBeGreaterThan(-1);
    expect(publicDropIndex).toBeGreaterThan(apiDropIndex);
    expect(publicCreateIndex).toBeGreaterThan(publicDropIndex);
    expect(apiCreateIndex).toBeGreaterThan(publicCreateIndex);
    expect(sql).toContain('dispatch_exception_reason');
    expect(sql).toContain('WITH (security_invoker = true)');
    expect(sql).toContain('GRANT SELECT ON api.dispatch_exception_review_sla_breaches_v TO authenticated, service_role;');
  });
});
