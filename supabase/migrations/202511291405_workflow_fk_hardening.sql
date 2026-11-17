-- Migration: Workflow and webhook foreign keys hardening
-- Purpose:
--   - Ensure core workflow tables have explicit foreign key constraints so
--     pgTAP constraint tests pass and runtime integrity is enforced.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'webhook_inbox'
      AND c.conname = 'webhook_inbox_webhook_source_fk'
  ) THEN
    ALTER TABLE public.webhook_inbox
      ADD CONSTRAINT webhook_inbox_webhook_source_fk
      FOREIGN KEY (webhook_source_id) REFERENCES public.webhook_sources(id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'workflow_run_steps'
      AND c.conname = 'workflow_run_steps_run_fk'
  ) THEN
    ALTER TABLE public.workflow_run_steps
      ADD CONSTRAINT workflow_run_steps_run_fk
      FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'workflow_run_steps'
      AND c.conname = 'workflow_run_steps_template_step_fk'
  ) THEN
    ALTER TABLE public.workflow_run_steps
      ADD CONSTRAINT workflow_run_steps_template_step_fk
      FOREIGN KEY (workflow_template_step_id) REFERENCES public.workflow_template_steps(id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'outbound_calls'
      AND c.conname = 'outbound_calls_workflow_step_fk'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_workflow_step_fk
      FOREIGN KEY (workflow_run_step_id) REFERENCES public.workflow_run_steps(id);
  END IF;
END;
$$;

COMMIT;

