-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup job_status lookup values (outbound_calls uses in_progress_edge).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'in_progress_edge', 'In Progress Edge', 25, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'job_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

