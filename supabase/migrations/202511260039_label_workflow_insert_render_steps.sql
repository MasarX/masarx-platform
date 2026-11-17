-- Migration: Insert barcode_generate and render_v2 steps into labels_print_workflow_v1

BEGIN;

WITH tmpl AS (
    SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1
), existing AS (
    SELECT workflow_template_id, sequence_order, operation_name FROM workflow_template_steps WHERE workflow_template_id = (SELECT id FROM tmpl)
)
-- Insert barcode_generate step if missing
INSERT INTO workflow_template_steps (
    id,
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
) SELECT
    gen_random_uuid(),
    (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1),
    2,
    'generate_barcodes',
    NULL,
    'always',
    '{}'::jsonb,
    'render_labels_pdf',
    1,
    0,
    FALSE,
    '{}'::jsonb,
    TRUE,
    'barcode_generate',
    'v1'
WHERE NOT EXISTS (
    SELECT 1 FROM workflow_template_steps
    WHERE operation_name = 'generate_barcodes'
      AND workflow_template_id = (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1)
);

-- Insert render_v2 step if missing
INSERT INTO workflow_template_steps (
    id,
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
) SELECT
    gen_random_uuid(),
    (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1),
    3,
    'render_labels_pdf',
    NULL,
    'always',
    '{}'::jsonb,
    'bundle_labels_pdf',
    1,
    0,
    FALSE,
    '{}'::jsonb,
    TRUE,
    'label_render',
    'v2'
WHERE NOT EXISTS (
    SELECT 1 FROM workflow_template_steps
    WHERE operation_name = 'render_labels_pdf'
      AND workflow_template_id = (SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1)
);

-- Re-sequence to keep order: 1 prepare, 2 barcodes, 3 render, 4 bundle, 5 finalize, 6 complete
WITH tmpl AS (
    SELECT id FROM workflow_templates WHERE name = 'labels_print_workflow_v1' ORDER BY created_at DESC LIMIT 1
)
UPDATE workflow_template_steps
SET sequence_order = CASE operation_name
    WHEN 'prepare_labels_for_print' THEN 1
    WHEN 'generate_barcodes' THEN 2
    WHEN 'render_labels_pdf' THEN 3
    WHEN 'bundle_labels_pdf' THEN 4
    WHEN 'finalize_label_print' THEN 5
    WHEN 'complete_workflow' THEN 6
    ELSE sequence_order
END
WHERE workflow_template_id = (SELECT id FROM tmpl);

COMMIT;
