-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Allow request_entry_point='test' for pgTAP fixtures (contract-enforced lookup).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'test', 'Test', 5, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

