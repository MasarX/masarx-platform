const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const migrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '202605041400_console_v2_support_warehouse_live_views_v1.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const registrySeed = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'seed-raw', 'registry.js'),
  'utf8',
);

describe('Console V2 support + warehouse live views migration', () => {
  test('backs support_users with a security-invoker backend projection and row-driven roster policy', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.support_user_roster_policy');
    expect(migration).toContain('CREATE VIEW public.support_users');
    expect(migration).toContain('WITH (security_invoker = true)');
    expect(migration).toContain('FROM public.users u');
    expect(migration).toContain('JOIN public.support_user_roster_policy p');
    expect(migration).toContain("WHERE u.status = 'active'");
    expect(migration).toContain('"key": "support_users"');
    expect(migration).toContain('"relation": "public.support_users"');
    expect(migration).toContain('"capability_read": "support.read"');
    expect(registrySeed).toContain('support_users');
  });

  test('backs warehouse_checkpoint_scans from canonical scan_events only', () => {
    expect(migration).toContain('CREATE VIEW public.warehouse_checkpoint_scans');
    expect(migration).toContain('FROM public.scan_events se');
    expect(migration).toContain("WHERE se.scan_type = 'warehouse_checkpoint'");
    expect(migration).toContain('se.warehouse_transfer_id AS transfer_id');
    expect(migration).toContain('se.captured_at AS occurred_at');
    expect(migration).toContain('se.checkpoint_sequence');
    expect(migration).toContain('scan_events_warehouse_checkpoint_select');
    expect(migration).toContain("public.user_has_capability_v1('warehouse.read', 'tenant', organization_id)");
    expect(migration).toContain('"key": "warehouse_checkpoint_scans"');
    expect(migration).toContain('"relation": "public.warehouse_checkpoint_scans"');
    expect(migration).toContain('"capability_read": "warehouse.read"');
    expect(registrySeed).toContain('warehouse_checkpoint_scans');
  });

  test('registers resources through ui_read_registry without app-side fallback shortcuts', () => {
    expect(migration).toContain("SELECT pg_advisory_lock(hashtext('202605041400_console_v2_support_warehouse_live_views_v1'))");
    expect(migration).toContain("SELECT pg_advisory_unlock(hashtext('202605041400_console_v2_support_warehouse_live_views_v1'))");
    expect(migration).toContain("WHERE s.category = 'ui_read_registry'");
    expect(migration).toContain('v_filtered || jsonb_build_array(v_resource)');
    expect(migration).toContain("RAISE EXCEPTION 'ui_read_registry global settings missing'");
    expect(migration).not.toMatch(/RESOURCE_DATA\s*\(/);
    expect(migration).not.toMatch(/seed-raw/);
    expect(migration).not.toMatch(/localStorage/i);
  });
});
