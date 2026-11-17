const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20261010193000_pickup_assignment_options_v1.sql'), 'utf8');

describe('pickup lookup security contracts', () => {
  test('keeps assignment choices tenant-bound with explicit fleet permission and bounded display fields', () => {
    expect(sql).toContain("v_scope.organization_id IS DISTINCT FROM p_organization_id");
    expect(sql).toContain("public.user_has_permission_v1('fleet.write',p_organization_id) IS NOT TRUE");
    expect(sql).toContain('auth.uid() IS NULL');
    expect(sql).toContain('LEAST(GREATEST(COALESCE(p_limit,100),1),250)');
    expect(sql).not.toMatch(/\bemail\b|\bvin\b/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(assign_pickup_wave_v1|pickup_policy_default_v1)/);
  });
  test('reads approved partners only from the requester private pool and retains policy defaults', () => {
    expect(sql).toContain('request.requester_organization_id=p_organization_id');
    expect(sql).toContain('supplier.id::text=pool.value');
    expect(sql).toContain("status='approved' AND compliance_state='approved'");
    expect(sql).toContain("'{assignment,partner_lookup}'");
    expect(sql).toContain('request_statuses');
  });
  test('intersects mixed requested IDs with the exact existing pickup visibility predicate, never a route ID alone', () => {
    expect(sql).toContain("lower(COALESCE(s.service_type,''))='pickup'");
    expect(sql).toContain("v_scope.scope_type='tenant' AND s.organization_id=v_scope.organization_id");
    expect(sql).toContain("v_scope.scope_type='client' AND s.client_id=v_scope.client_id");
    expect(sql).toContain("v_scope.scope_type='sender' AND s.sender_id=v_scope.sender_id");
    expect(sql).toContain('JOIN visible_shipments s ON s.id=rs.shipment_id AND s.client_id=rs.client_id AND s.organization_id=rs.organization_id');
    expect(sql).toContain('rs.organization_id=rr.organization_id');
    expect(sql).toContain('cardinality(p_shipment_ids),0)>100');
    expect(sql).toContain('FROM PUBLIC,anon,authenticated');
  });
});
