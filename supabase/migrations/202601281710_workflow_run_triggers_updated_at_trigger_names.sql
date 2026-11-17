-- Plan: PLAN-202601-workflow-trigger-plugins-v1 / Step: S04
-- Fix: align updated_at trigger naming with timestamp contract.

BEGIN;

-- workflow_run_triggers
DROP TRIGGER IF EXISTS set_updated_at_workflow_run_triggers ON public.workflow_run_triggers;
DROP TRIGGER IF EXISTS trg_workflow_run_triggers_set_updated_at ON public.workflow_run_triggers;

CREATE TRIGGER trg_workflow_run_triggers_set_updated_at
BEFORE UPDATE ON public.workflow_run_triggers
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- workflow_trigger_fires
DROP TRIGGER IF EXISTS set_updated_at_workflow_trigger_fires ON public.workflow_trigger_fires;
DROP TRIGGER IF EXISTS trg_workflow_trigger_fires_set_updated_at ON public.workflow_trigger_fires;

CREATE TRIGGER trg_workflow_trigger_fires_set_updated_at
BEFORE UPDATE ON public.workflow_trigger_fires
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

COMMIT;

