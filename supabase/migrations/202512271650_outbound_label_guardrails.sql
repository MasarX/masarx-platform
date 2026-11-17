-- Migration: Workflow guardrails for outbound_calls + label_jobs
-- Purpose: Enforce workflow context via row-driven guardrails and align outbound inserts.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Remove deprecated engine-specific guard triggers/functions if present.
DROP TRIGGER IF EXISTS trg_outbound_calls_insert_guard_v1 ON public.outbound_calls;
DROP TRIGGER IF EXISTS trg_outbound_calls_forbid_step_change_v1 ON public.outbound_calls;
DROP TRIGGER IF EXISTS trg_label_jobs_insert_guard_v1 ON public.label_jobs;
DROP TRIGGER IF EXISTS trg_label_jobs_forbid_step_change_v1 ON public.label_jobs;

DO $$
BEGIN
  IF to_regclass('public.label_jobs_p0') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_label_jobs_insert_guard_v1 ON public.label_jobs_p0;
    DROP TRIGGER IF EXISTS trg_label_jobs_forbid_step_change_v1 ON public.label_jobs_p0;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.outbound_calls_insert_guard_v1();
DROP FUNCTION IF EXISTS public.outbound_calls_forbid_step_change_v1();
DROP FUNCTION IF EXISTS public.label_jobs_insert_guard_v1();
DROP FUNCTION IF EXISTS public.label_jobs_forbid_step_change_v1();

-- Fill workflow_run_step_id from app context when present.
CREATE OR REPLACE FUNCTION public.outbound_calls_fill_step_from_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_step TEXT;
  v_step_id UUID;
BEGIN
  IF NEW.workflow_run_step_id IS NULL THEN
    v_step := current_setting('app.workflow_run_step_id', TRUE);
    IF v_step IS NOT NULL AND btrim(v_step) <> '' THEN
      BEGIN
        v_step_id := v_step::UUID;
      EXCEPTION
        WHEN others THEN
          v_step_id := NULL;
      END;

      IF v_step_id IS NOT NULL THEN
        NEW.workflow_run_step_id := v_step_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbound_calls_fill_step_from_context ON public.outbound_calls;
CREATE TRIGGER trg_outbound_calls_fill_step_from_context
  BEFORE INSERT ON public.outbound_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.outbound_calls_fill_step_from_context();

-- Enforce immutable workflow_run_step_id on outbound_calls.
CREATE OR REPLACE FUNCTION public.outbound_calls_forbid_step_change_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
BEGIN
  IF NEW.workflow_run_step_id IS DISTINCT FROM OLD.workflow_run_step_id THEN
    RAISE EXCEPTION 'outbound_calls update rejected: workflow_run_step_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbound_calls_forbid_step_change_v1 ON public.outbound_calls;
CREATE TRIGGER trg_outbound_calls_forbid_step_change_v1
  BEFORE UPDATE OF workflow_run_step_id ON public.outbound_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.outbound_calls_forbid_step_change_v1();

-- Guardrails rows (row-driven enforcement).
INSERT INTO public.workflow_guardrails (
  resource_table,
  enforcement_mode,
  enforce_on,
  required_context_keys,
  context_match,
  allow_roles,
  notes
)
VALUES
  (
    'outbound_calls',
    'enforce',
    ARRAY['INSERT']::TEXT[],
    ARRAY['workflow_run_id', 'workflow_run_step_id']::TEXT[],
    jsonb_build_object('workflow_run_step_id', 'workflow_run_step_id'),
    ARRAY[]::TEXT[],
    'Guard outbound_calls inserts to require workflow context.'
  ),
  (
    'label_jobs',
    'enforce',
    ARRAY['INSERT']::TEXT[],
    ARRAY['workflow_run_id']::TEXT[],
    '{}'::jsonb,
    ARRAY[]::TEXT[],
    'Guard label_jobs inserts to require workflow context.'
  )
ON CONFLICT (resource_table) DO UPDATE
SET enforcement_mode = EXCLUDED.enforcement_mode,
    enforce_on = EXCLUDED.enforce_on,
    required_context_keys = EXCLUDED.required_context_keys,
    context_match = EXCLUDED.context_match,
    allow_roles = EXCLUDED.allow_roles,
    notes = EXCLUDED.notes,
    updated_at = now();

-- Attach guardrails triggers after fill/require triggers.
DROP TRIGGER IF EXISTS trg_outbound_calls_z_guardrails ON public.outbound_calls;
CREATE TRIGGER trg_outbound_calls_z_guardrails
  BEFORE INSERT OR UPDATE OR DELETE ON public.outbound_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_workflow_guardrails();

DROP TRIGGER IF EXISTS trg_label_jobs_guardrails ON public.label_jobs;
CREATE TRIGGER trg_label_jobs_guardrails
  BEFORE INSERT OR UPDATE OR DELETE ON public.label_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_workflow_guardrails();

COMMIT;
