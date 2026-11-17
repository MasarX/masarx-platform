-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Add missing lookup values required by verify:cloud (integration tests + workflow stop semantics).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- request_entry_point: system/internal workflow wrappers used by platform helpers.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'label_job_wrapper', 'Label Job Wrapper', 45, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'enqueue_outbound_call', 'Enqueue Outbound Call', 46, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- workflow_run_status: support opt-out stop semantics and workflow_mark_run_stopped contract.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'stopped', 'Stopped', 35, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

