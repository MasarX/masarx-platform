-- Migration: Restore JSON helpers and critical foreign keys for workflow integrity
-- Date: 2025-11-20 21:15 UTC

BEGIN;

-------------------------------------------------------------------------------
-- Restore enforced relationships foundational to workflow integrity
-------------------------------------------------------------------------------

ALTER TABLE public.webhook_inbox
    DROP CONSTRAINT IF EXISTS webhook_inbox_webhook_source_id_fkey;

ALTER TABLE public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_webhook_source_id_fkey
        FOREIGN KEY (webhook_source_id)
        REFERENCES public.webhook_sources(id)
        ON DELETE RESTRICT
        NOT DEFERRABLE
        INITIALLY IMMEDIATE
        NOT VALID;

ALTER TABLE public.webhook_inbox
    VALIDATE CONSTRAINT webhook_inbox_webhook_source_id_fkey;

ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_workflow_run_id_fkey;

ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_workflow_run_id_fkey
        FOREIGN KEY (workflow_run_id)
        REFERENCES public.workflow_runs(id)
        ON DELETE CASCADE
        NOT DEFERRABLE
        INITIALLY IMMEDIATE
        NOT VALID;

ALTER TABLE public.workflow_run_steps
    VALIDATE CONSTRAINT workflow_run_steps_workflow_run_id_fkey;

ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_template_step_fkey;

ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_template_step_fkey
        FOREIGN KEY (workflow_template_step_id)
        REFERENCES public.workflow_template_steps(id)
        ON DELETE RESTRICT
        NOT DEFERRABLE
        INITIALLY IMMEDIATE
        NOT VALID;

ALTER TABLE public.workflow_run_steps
    VALIDATE CONSTRAINT workflow_run_steps_template_step_fkey;

ALTER TABLE public.outbound_calls
    DROP CONSTRAINT IF EXISTS outbound_calls_workflow_run_step_id_fkey;

ALTER TABLE public.outbound_calls
    ADD CONSTRAINT outbound_calls_workflow_run_step_id_fkey
        FOREIGN KEY (workflow_run_step_id)
        REFERENCES public.workflow_run_steps(id)
        ON DELETE SET NULL
        NOT DEFERRABLE
        INITIALLY IMMEDIATE
        NOT VALID;

ALTER TABLE public.outbound_calls
    VALIDATE CONSTRAINT outbound_calls_workflow_run_step_id_fkey;

COMMIT;
