-- Migration: Rename webhook follow-up handler key to dispatch_followup_workflow
-- Date: 2025-11-20 20:56 UTC

BEGIN;

ALTER TABLE operation_templates DROP CONSTRAINT IF EXISTS operation_templates_handler_fk;
ALTER TABLE workflow_template_steps DROP CONSTRAINT IF EXISTS workflow_template_steps_handler_fk;
ALTER TABLE workflow_run_steps DROP CONSTRAINT IF EXISTS workflow_run_steps_handler_fk;

UPDATE operation_handlers
SET handler_key = 'dispatch_followup_workflow',
    updated_at = now()
WHERE handler_key = 'dispatch_webhook_followup';

UPDATE workflow_template_steps
SET handler_key = 'dispatch_followup_workflow',
    handler_version = 'v1',
    operation_name = 'dispatch_followup_workflow'
WHERE handler_key = 'dispatch_webhook_followup'
   OR id = '77770000-0000-0000-0000-000000770013';

UPDATE workflow_run_steps
SET handler_key = 'dispatch_followup_workflow',
    handler_version = 'v1'
WHERE handler_key = 'dispatch_webhook_followup';

UPDATE operation_templates
SET handler_key = 'dispatch_followup_workflow',
    handler_version = 'v1'
WHERE handler_key = 'dispatch_webhook_followup';

ALTER TABLE operation_templates
    ADD CONSTRAINT operation_templates_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

ALTER TABLE workflow_template_steps
    ADD CONSTRAINT workflow_template_steps_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

ALTER TABLE workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

COMMIT;
