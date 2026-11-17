-- Migration: Workflow handler finalisation
-- Purpose: Enforce handler metadata consistency post-dispatcher refactor.
-- Date: 2025-10-20

BEGIN;

-- Ensure all existing metadata rows have handler assignments.
DO $$
DECLARE
    v_missing_templates INT;
    v_missing_steps INT;
    v_missing_run_steps INT;
BEGIN
    SELECT COUNT(*) INTO v_missing_templates
    FROM operation_templates
    WHERE handler_key IS NULL;

    IF v_missing_templates > 0 THEN
        RAISE EXCEPTION 'workflow_handler_finalize: operation_templates missing handler_key (count=%).', v_missing_templates;
    END IF;

    SELECT COUNT(*) INTO v_missing_steps
    FROM workflow_template_steps
    WHERE handler_key IS NULL;

    IF v_missing_steps > 0 THEN
        RAISE EXCEPTION 'workflow_handler_finalize: workflow_template_steps missing handler_key (count=%).', v_missing_steps;
    END IF;

    SELECT COUNT(*) INTO v_missing_run_steps
    FROM workflow_run_steps
    WHERE handler_key IS NULL;

    IF v_missing_run_steps > 0 THEN
        RAISE EXCEPTION 'workflow_handler_finalize: workflow_run_steps missing handler_key (count=%).', v_missing_run_steps;
    END IF;
END;
$$;

ALTER TABLE operation_templates
    ALTER COLUMN handler_key SET NOT NULL;

ALTER TABLE workflow_template_steps
    ALTER COLUMN handler_key SET NOT NULL;

ALTER TABLE workflow_run_steps
    ALTER COLUMN handler_key SET NOT NULL;

COMMIT;

