-- Migration: Fix workflow_schedule_triggers updated_at trigger name (timestamp contracts)
-- Purpose: Align updated_at trigger naming with canonical pgTAP contracts.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;

SET search_path TO public, extensions, pg_temp;

DROP TRIGGER IF EXISTS set_updated_at_workflow_schedule_triggers ON public.workflow_schedule_triggers;
DROP TRIGGER IF EXISTS trg_workflow_schedule_triggers_set_updated_at ON public.workflow_schedule_triggers;

CREATE TRIGGER trg_workflow_schedule_triggers_set_updated_at
    BEFORE UPDATE ON public.workflow_schedule_triggers
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

COMMIT;

