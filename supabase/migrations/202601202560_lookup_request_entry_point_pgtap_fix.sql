-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup request_entry_point lookup values (tests use pgtap).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'pgtap', 'pgTAP', 90, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

