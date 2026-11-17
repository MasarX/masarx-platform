const fs = require('fs');
const path = require('path');

describe('route stops visible view migration rebuild', () => {
  test('pre-shapes route-stop views before the delivery-attempt projection migration', () => {
    const preShapeMigration = '202604101059_route_stops_visible_pre_shape_compat_v1.sql';
    const deliveryAttemptMigration = '202604101100_b07_delivery_attempt_contract_v1.sql';
    expect(preShapeMigration < deliveryAttemptMigration).toBe(true);

    const migrationPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'supabase',
      'migrations',
      preShapeMigration,
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const apiDropIndex = sql.indexOf('DROP VIEW IF EXISTS api.route_stops;');
    const publicDropIndex = sql.indexOf('DROP VIEW IF EXISTS public.route_stops_visible_v1;');
    const createIndex = sql.indexOf('CREATE VIEW public.route_stops_visible_v1');

    expect(apiDropIndex).toBeGreaterThan(-1);
    expect(publicDropIndex).toBeGreaterThan(apiDropIndex);
    expect(createIndex).toBeGreaterThan(publicDropIndex);
    expect(sql).toContain('NULL::uuid AS shipment_action_id');
    expect(sql).toContain('NULL::text AS delivery_attempt_outcome');
    expect(sql).toContain('NULL::integer AS delivery_attempt_count');
    expect(sql).toContain('CREATE VIEW api.route_stops');
  });
});
