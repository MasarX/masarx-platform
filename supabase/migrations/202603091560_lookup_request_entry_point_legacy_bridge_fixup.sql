-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Fixup: restore request_entry_point=legacy_bridge for existing outbound/workflow bridge paths.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'legacy_bridge', 'Legacy Bridge', 47, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

COMMIT;
