-- Migration: workflow_runs_rls_fix
-- Purpose: Tighten RLS isolation on workflow_runs and workflow_run_steps
--          by removing broad EXISTS-based policies that do not filter per-row.

BEGIN;

-- workflow_runs: rely on context-based isolation policy; drop broad EXISTS policy
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_runs'
      AND policyname = 'workflow_runs_isolation_select'
  ) THEN
    EXECUTE 'DROP POLICY workflow_runs_isolation_select ON public.workflow_runs';
  END IF;
END;
$$;

-- workflow_run_steps: rely on workflow_run_id + workflow_runs isolation; drop broad EXISTS policy
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_run_steps'
      AND policyname = 'workflow_run_steps_isolation_select'
  ) THEN
    EXECUTE 'DROP POLICY workflow_run_steps_isolation_select ON public.workflow_run_steps';
  END IF;
END;
$$;

COMMIT;

