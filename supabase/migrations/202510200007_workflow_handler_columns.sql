-- Migration: Workflow handler metadata columns
-- Purpose: Extend workflow metadata tables to reference the handler registry.
-- Date: 2025-10-20

BEGIN;

ALTER TABLE operation_templates
    ADD COLUMN IF NOT EXISTS handler_key TEXT,
    ADD COLUMN IF NOT EXISTS handler_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE operation_templates
    ADD CONSTRAINT operation_templates_handler_version_ck CHECK (handler_version ~ '^v[0-9]+$');

ALTER TABLE operation_templates
    ADD CONSTRAINT operation_templates_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

COMMENT ON COLUMN operation_templates.handler_key IS 'Handler key from operation_handlers driving execution of this template.';
COMMENT ON COLUMN operation_templates.handler_version IS 'Handler version pinned at definition time (default v1).';

ALTER TABLE workflow_template_steps
    ADD COLUMN IF NOT EXISTS handler_key TEXT,
    ADD COLUMN IF NOT EXISTS handler_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE workflow_template_steps
    ADD CONSTRAINT workflow_template_steps_handler_version_ck CHECK (handler_version ~ '^v[0-9]+$');

ALTER TABLE workflow_template_steps
    ADD CONSTRAINT workflow_template_steps_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

COMMENT ON COLUMN workflow_template_steps.handler_key IS 'Handler to execute for this template step.';
COMMENT ON COLUMN workflow_template_steps.handler_version IS 'Handler version pinned for this step.';

ALTER TABLE workflow_run_steps
    ADD COLUMN IF NOT EXISTS handler_key TEXT,
    ADD COLUMN IF NOT EXISTS handler_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_handler_version_ck CHECK (handler_version ~ '^v[0-9]+$');

ALTER TABLE workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_handler_fk
        FOREIGN KEY (handler_key) REFERENCES operation_handlers(handler_key);

COMMENT ON COLUMN workflow_run_steps.handler_key IS 'Handler actually used when executing the step (copied from template).';
COMMENT ON COLUMN workflow_run_steps.handler_version IS 'Handler version associated with execution.';

COMMIT;
