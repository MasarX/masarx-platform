const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913101000_fieldops_return_scan_readback_v1.sql',
), 'utf8');

describe('FieldOps returned-to-branch scan readback', () => {
  test('requires exact actor, tenant, scan type and canonical projections', () => {
    for (const required of [
      'public.ui_get_return_to_branch_scan_readback_v1',
      'api.ui_get_return_to_branch_scan_readback_v1',
      "se.scan_type = 'return_to_branch_intake'",
      'se.organization_id = v_organization_id',
      'se.actor_user_id = v_actor_id',
      'im.related_scan_event_id = se.id',
      'im.actor_user_id = v_actor_id',
      "sa.action_type = 'scan'",
      'sa.performed_by_user_id = v_actor_id',
      "sa.action_data->>'source_scan_event_id'",
      'r.intake_scan_event_id = se.id',
      "s.metadata#>>'{return_to_branch,inventory_movement_id}'",
      "s.metadata#>>'{return_to_branch,shipment_action_id}'",
      "sa.action_data->>'inventory_movement_id'",
      'r.inventory_movement_id = im.id',
      'SECURITY INVOKER',
      'TO authenticated',
    ]) expect(source).toContain(required);
    expect(source).not.toContain('LEFT JOIN public.return_to_branch_shipments_v1');
  });

  test('does not mutate scan, shipment, inventory, task or action truth', () => {
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*\bpublic\.(?:scan_events|shipments|inventory_movements|tasks|shipment_actions)\b/i);
    expect(source).not.toMatch(/service_role/);
    expect(source).not.toMatch(/current_user\s*(?:=|<>|IS)/i);
  });
});
