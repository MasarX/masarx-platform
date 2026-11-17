const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '../../../supabase/migrations/202608161410_b3_command_dashboard_registry_readiness_v1.sql',
);

describe('Command dashboard registry readiness migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('restores dashboard API and read projections without app-side fallbacks', () => {
    expect(sql).toContain('api.resolve_settings_row_from_policy_context_v1');
    expect(sql).toContain('public.command_dashboard_kpi_rollup_directory_v1');
    expect(sql).toContain('public.command_ops_alerts_console_v1');
    expect(sql).toContain('public.command_comms_attempt_directory_v1');
    expect(sql).toContain('public.command_route_runs_dashboard_v1');
    expect(sql).toContain('WITH (security_invoker = true)');
    expect(sql).not.toMatch(/RESOURCE_DATA\s*\(/);
    expect(sql).not.toMatch(/seed-raw/);
    expect(sql).not.toMatch(/localStorage/i);
  });

  test('keeps the generic settings resolver service-role-only', () => {
    const signature = 'api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)';

    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION api\.resolve_settings_row_from_policy_context_v1\(TEXT,\s*JSONB\)\s+TO\s+[^;]*\bauthenticated\b/i);
    expect(sql).not.toMatch(/resolve_settings_row_from_policy_context_v1\([^)]*'[^']+'[^)]*\)/i);
  });

  test('registers the Command dashboard resources and capability map rows', () => {
    for (const key of ['kpi_rollup_directory', 'ops_alerts', 'comms_attempts', 'route_runs']) {
      expect(sql).toContain(`'key', '${key}'`);
      expect(sql).toContain(`'${key}', jsonb_build_object`);
    }

    expect(sql).toContain("'capability_read', 'insights.read'");
    expect(sql).toContain("'capability_read', 'alerts.read'");
    expect(sql).toContain("'capability_read', 'shipments.read'");
    expect(sql).toContain("'capability_read', 'routes.read'");
  });

  test('creates row-driven Command dashboard KPI definitions and rollups', () => {
    expect(sql).toContain('INSERT INTO public.kpi_definitions');
    expect(sql).toContain('INSERT INTO public.kpi_rollups_daily');
    expect(sql).toContain("'surface', 'command_dashboard'");
    expect(sql).toContain('FROM public.organizations org');
    expect(sql).toContain('ON CONFLICT (organization_id, kpi_key, day, dimensions) DO UPDATE');
  });
});
