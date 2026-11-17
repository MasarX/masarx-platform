-- Test Suite: Non-creation workflow templates wiring

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(28);

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_delete_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    LIMIT 1
  ),
  'context_extract_from_mapping',
  'shipment_delete_v1 starts with context_extract_from_mapping'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_delete_v1'
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
      AND handler_key = 'reserve_shipment_identifiers'
  ),
  'shipment_delete_v1 does not reserve identifiers'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_modify_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    LIMIT 1
  ),
  'context_extract_from_mapping',
  'shipment_modify_v1 starts with context_extract_from_mapping'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_modify_v1'
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
      AND handler_key = 'reserve_shipment_identifiers'
  ),
  'shipment_modify_v1 does not reserve identifiers'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    LIMIT 1
  ),
  'context_extract_from_mapping',
  'shipment_swap_v1 starts with context_extract_from_mapping'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 1
    LIMIT 1
  ),
  'reserve_shipment_identifiers',
  'shipment_swap_v1 reserves identifiers immediately after context extraction'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 2
    LIMIT 1
  ),
  'context_set_defaults',
  'shipment_swap_v1 applies context defaults after identifier reservation'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 3
    LIMIT 1
  ),
  'context_require',
  'shipment_swap_v1 requires client context (early-complete when missing)'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 4
    LIMIT 1
  ),
  'shipment_create',
  'shipment_swap_v1 creates planned shipment when client context exists'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_swap_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 5
    LIMIT 1
  ),
  'task_enqueue',
  'shipment_swap_v1 enqueues a dispatch task after shipment creation'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
      AND handler_key = 'reserve_shipment_identifiers'
  ),
  'shipment_return_v1 keeps reserve_identifiers step configured'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
      AND handler_key = 'context_extract_from_mapping'
  ),
  'shipment_return_v1 keeps context_extract_from_mapping configured'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 2
    LIMIT 1
  ),
  'context_set_defaults',
  'shipment_return_v1 applies context defaults after identifier reservation'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 3
    LIMIT 1
  ),
  'context_require',
  'shipment_return_v1 requires client context (early-complete when missing)'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 4
    LIMIT 1
  ),
  'shipment_create',
  'shipment_return_v1 creates planned shipment when client context exists'
)
FROM tpl;

WITH tpl AS (
  SELECT id
  FROM workflow_templates
  WHERE name = 'shipment_return_v1'
)
SELECT is(
  (
    SELECT handler_key
    FROM workflow_template_steps
    WHERE workflow_template_id = tpl.id
    ORDER BY sequence_order
    OFFSET 5
    LIMIT 1
  ),
  'task_enqueue',
  'shipment_return_v1 enqueues a dispatch task after shipment creation'
)
FROM tpl;

WITH expected AS (
  SELECT unnest(ARRAY[
    'shipment_update_status_v1',
    'shipment_update_geocode_v1',
    'shipment_update_address_v1',
    'shipment_update_driver_v1',
    'shipment_update_action_v1',
    'shipment_update_attachment_v1'
  ]) AS template_name
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM workflow_templates wt
    WHERE wt.name = expected.template_name
      AND wt.status = 'active'
      AND wt.scope_type = 'global'
  ),
  format('%s is seeded as active global template', expected.template_name)
)
FROM expected;

WITH expected AS (
  SELECT unnest(ARRAY[
    'shipment_update_status_v1',
    'shipment_update_geocode_v1',
    'shipment_update_address_v1',
    'shipment_update_driver_v1',
    'shipment_update_action_v1',
    'shipment_update_attachment_v1'
  ]) AS template_name
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = (
      SELECT id FROM workflow_templates WHERE name = expected.template_name
    )
      AND wts.handler_key = 'reserve_shipment_identifiers'
  ),
  format('%s does not include reserve_identifiers (non-creation)', expected.template_name)
)
FROM expected;

SELECT finish();

ROLLBACK;
