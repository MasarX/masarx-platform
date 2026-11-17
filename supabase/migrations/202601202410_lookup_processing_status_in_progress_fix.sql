-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup processing_status lookup values (webhook_inbox uses in_progress).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'in_progress', 'In Progress', 15, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'processing_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

