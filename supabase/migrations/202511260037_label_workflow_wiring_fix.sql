-- Migration: Fix labels_print_workflow wiring back to label_bundle v2 and label_print_prepare v1
-- Context: prior wiring placeholder accidentally set label_bundle step to barcode_generate. This restores intended handlers.

BEGIN;

WITH template AS (
    SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1
)
UPDATE workflow_template_steps
SET handler_key = 'label_print_prepare',
    handler_version = 'v1'
WHERE workflow_template_id = (SELECT id FROM template)
  AND operation_name = 'prepare_labels_for_print';

WITH template AS (
    SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1
)
UPDATE workflow_template_steps
SET handler_key = 'label_bundle',
    handler_version = 'v2'
WHERE workflow_template_id = (SELECT id FROM template)
  AND operation_name = 'bundle_labels_pdf';

-- label_print_finalize remains unchanged

COMMIT;
