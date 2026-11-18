const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '../../../supabase/migrations/202607031420_command_dashboard_statusbar_telemetry_readiness_v1.sql',
);

describe('Command dashboard statusbar telemetry readiness migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('keeps provider telemetry views browser-safe and registry-readable', () => {
    expect(sql).toContain('CREATE OR REPLACE VIEW public.provider_health_latest_v');
    expect(sql).toContain('CREATE OR REPLACE VIEW public.circuit_breaker_dashboard_v');
    expect(sql).toContain('WITH (security_invoker = true)');
    expect(sql).toContain('GRANT SELECT ON public.provider_health_latest_v TO authenticated, service_role');
    expect(sql).toContain('GRANT SELECT ON public.circuit_breaker_dashboard_v TO authenticated, service_role');
  });

  test('registers provider telemetry resources with row-driven capability gates', () => {
    for (const key of ['provider_health_latest', 'circuit_breaker_dashboard']) {
      expect(sql).toContain(`'key', '${key}'`);
      expect(sql).toContain(`'${key}', jsonb_build_object('read', 'integrations.read')`);
    }

    expect(sql).toContain("'allow_view_relation', TRUE");
    expect(sql).toContain("'capability_read', 'integrations.read'");
    expect(sql).toContain('Map Command Center provider telemetry capabilities');
  });

  test('projects latency from provider health metadata without demo fallbacks', () => {
    expect(sql).toContain("ph.metadata->>'latency_ms'");
    expect(sql).toContain("ph.metadata->>'avg_latency_ms'");
    expect(sql).toContain("'latency_ms'");
    expect(sql).not.toMatch(/RESOURCE_DATA\s*\(/);
    expect(sql).not.toMatch(/seed-raw/);
    expect(sql).not.toMatch(/localStorage/i);
  });
});
