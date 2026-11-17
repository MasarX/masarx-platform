-- Migration: Add immediate dispatch step to logestechs_shipment_ack_v1
-- Purpose: After enqueueing WhatsApp notification, immediately call edge api-caller with the job_id
--          carried in context.last_outbound_call_id (strict workflow-only, no cron/batch).

BEGIN;

WITH tmpl AS (
  SELECT id FROM workflow_templates WHERE name='logestechs_shipment_ack_v1' LIMIT 1
),
edge_op AS (
  SELECT id FROM operation_templates WHERE operation_name='edge_api_dispatch_single_v1' LIMIT 1
),
completion AS (
  SELECT id, sequence_order FROM workflow_template_steps
  WHERE workflow_template_id=(SELECT id FROM tmpl) AND operation_name='record_workflow_completion'
  LIMIT 1
)
-- Bump completion step to make room if needed
UPDATE workflow_template_steps s
SET sequence_order = (SELECT sequence_order FROM completion) + 1,
    updated_at = now()
WHERE s.id = (SELECT id FROM completion)
  AND (SELECT sequence_order FROM completion) = 5;

-- Insert edge dispatch step at sequence 5 if missing
WITH tmpl AS (
  SELECT id FROM workflow_templates WHERE name='logestechs_shipment_ack_v1' LIMIT 1
),
edge_op AS (
  SELECT id FROM operation_templates WHERE operation_name='edge_api_dispatch_single_v1' LIMIT 1
)
INSERT INTO workflow_template_steps (
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  condition_jsonlogic,
  next_operation_name,
  next_operation_priority,
  next_operation_delay_seconds,
  manual_action_required,
  metadata,
  enabled,
  handler_key,
  handler_version
)
SELECT
  (SELECT id FROM tmpl),
  5,
  'edge_dispatch_single',
  NULL,
  'always',
  NULL,
  'record_workflow_completion',
  60,
  NULL,
  FALSE,
  jsonb_build_object('operation_template_id', (SELECT id FROM edge_op), 'expects_provider_defaults', TRUE),
  TRUE,
  'outbound_http',
  'v1'
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_template_steps
  WHERE workflow_template_id=(SELECT id FROM tmpl) AND sequence_order=5
);

COMMIT;
