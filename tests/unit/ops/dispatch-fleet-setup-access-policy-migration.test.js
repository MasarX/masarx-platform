const fs = require('fs');
const path = require('path');

const migrationName = '202607032215_dispatch_fleet_setup_access_policy_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

describe('dispatch fleet setup access policy migration', () => {
  test('uses the canonical access-control policy and transaction-scoped lock', () => {
    const sql = readMigration();

    expect(sql).toContain("pg_advisory_xact_lock(hashtext('202607032215_dispatch_fleet_setup_access_policy_v1'))");
    expect(sql).toContain("WHERE category = 'user_type'");
    expect(sql).toContain("WHERE s.category = 'access_control_policy'");
    expect(sql).toContain('UPDATE public.settings_versions');
    expect(sql).toContain('UPDATE public.settings');
    expect(sql).not.toContain('pg_advisory_unlock');
  });

  test('registers fleet capabilities for tenant operators without bypassing assertions', () => {
    const sql = readMigration();

    expect(sql).toContain("'key', 'fleet.read'");
    expect(sql).toContain("'key', 'fleet.write'");
    expect(sql).toContain("IF v_role->>'key' IN ('ops_admin', 'fleet_manager') THEN");
    expect(sql).toContain("'{fleet_manager}'");
    expect(sql).toContain("jsonb_build_array('fleet_manager')");
    expect(sql).not.toContain('PERFORM public.assert_capability_v1');
  });

  test('maps fleet setup resources to fleet read/write capabilities', () => {
    const sql = readMigration();

    for (const resource of [
      'drivers',
      'driver_profiles',
      'driver_profile_picker',
      'vehicles',
      'vehicle_directory',
      'vehicle_assignments',
    ]) {
      expect(sql).toContain(`'${resource}'`);
    }

    expect(sql).toContain("jsonb_build_object('read', 'fleet.read', 'write', 'fleet.write')");
  });
});
