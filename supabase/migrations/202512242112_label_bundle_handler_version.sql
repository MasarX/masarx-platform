-- Migration: Set label_bundle handler_version to v2 for labels_print_workflow_v1
-- Purpose: Ensure bundle step uses the new ready_to_merge handler (no render in handler; worker merges).

BEGIN;

SET search_path TO public, pg_temp;

UPDATE workflow_template_steps wts
SET handler_version = 'v2'
FROM workflow_templates wt
WHERE wt.id = wts.workflow_template_id
  AND wt.name = 'labels_print_workflow_v1'
  AND wts.handler_key = 'label_bundle';

COMMIT;
