const fs = require('fs');
const path = require('path');

const migrationName = '202607060025_dispatch_fleet_assignment_decision_category_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);
const fleetSetupMigrationPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '202607031900_fleet_setup_rpc_contract_v1.sql',
);

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

describe('dispatch fleet assignment decision category migration', () => {
  test('seeds the decision category emitted by assign_driver_to_vehicle_v1', () => {
    const sql = readFile(migrationPath);

    expect(sql).toContain("pg_advisory_xact_lock(hashtext('202607060025_dispatch_fleet_assignment_decision_category_v1'))");
    expect(sql).toContain("WHERE ld.category = 'decision_category'");
    expect(sql).toContain("'fleet.driver_assigned'");
    expect(sql).toContain("'Fleet Driver Assigned'");
    expect(sql).toContain('ON CONFLICT (lookup_definition_id, value) DO UPDATE');
    expect(sql).toContain('status = EXCLUDED.status');
  });

  test('stays aligned with the fleet setup RPC decision writer', () => {
    const sql = readFile(fleetSetupMigrationPath);

    expect(sql).toContain('assign_driver_to_vehicle_v1');
    expect(sql).toContain("'fleet.driver_assigned'");
    expect(sql).toContain('public.log_decision');
  });
});
