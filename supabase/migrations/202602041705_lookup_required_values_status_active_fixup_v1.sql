-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: Drift repair - enforce required lookup_values are active (v1)
-- Purpose:
--   - In reused preview DBs, required lookup values may exist but drift to status=inactive.
--   - Reassert required values as status=active (idempotent upserts).
-- Values:
--   - request_entry_point: label_job_wrapper, enqueue_outbound_call
--   - workflow_run_status: stopped

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- request_entry_point platform wrappers
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'label_job_wrapper', 'Label Job Wrapper', 45, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'enqueue_outbound_call', 'Enqueue Outbound Call', 46, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

-- workflow_run_status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'stopped', 'Stopped', 35, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

COMMIT;

