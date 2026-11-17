-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup processing_status lookup values (webhook_inbox uses received/skipped).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, false, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('received', 'Received', 5),
    ('skipped', 'Skipped', 35)
) AS v(value, label, sort_order)
  ON TRUE
WHERE d.category = 'processing_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

