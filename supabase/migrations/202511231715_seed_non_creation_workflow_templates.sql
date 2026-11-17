-- Migration: Seed non-creation workflow templates
-- Purpose: Ensure delete/modify/swap/return and update flows have templates to attach policies

BEGIN;

INSERT INTO workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
SELECT gen_random_uuid(), name, descr, 1, 'active', 'global', NULL, 'Seeded placeholder for policy routing'
FROM (
  VALUES
    ('shipment_delete_v1', 'Shipment delete flow (placeholder)'),
    ('shipment_modify_v1', 'Shipment modify flow (placeholder)'),
    ('shipment_swap_v1', 'Shipment swap flow (placeholder)'),
    ('shipment_return_v1', 'Shipment return flow (placeholder)'),
    ('shipment_update_status_v1', 'Shipment status update flow (placeholder)'),
    ('shipment_update_geocode_v1', 'Shipment geocode update flow (placeholder)'),
    ('shipment_update_address_v1', 'Shipment address update flow (placeholder)'),
    ('shipment_update_driver_v1', 'Shipment driver update flow (placeholder)'),
    ('shipment_update_action_v1', 'Shipment action update flow (placeholder)'),
    ('shipment_update_attachment_v1', 'Shipment attachment update flow (placeholder)')
) AS t(name, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_templates wt WHERE wt.name = t.name
);

COMMIT;
