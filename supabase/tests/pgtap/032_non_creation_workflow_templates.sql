-- Test Suite: non-creation workflow templates exist for policy routing

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_delete_v1'), 'shipment_delete_v1 exists');
SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_modify_v1'), 'shipment_modify_v1 exists');
SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_swap_v1'), 'shipment_swap_v1 exists');
SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_return_v1'), 'shipment_return_v1 exists');
SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_update_status_v1'), 'shipment_update_status_v1 exists');
SELECT ok(EXISTS(SELECT 1 FROM workflow_templates WHERE name = 'shipment_update_address_v1'), 'shipment_update_address_v1 exists');

SELECT * FROM finish();

ROLLBACK;

