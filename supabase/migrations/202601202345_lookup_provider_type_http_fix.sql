-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup provider_type lookup values to include runtime/test usage (no hardcoding in checks).
-- Notes:
--   - provider_type is enforced via lookup_column_contracts; values must exist in lookup_values.
--   - pgTAP fixtures use provider_type='http' and seed data uses additional types.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('provider_type', 'http', 'HTTP', 5, false),
    ('provider_type', 'sms', 'SMS', 15, false),
    ('provider_type', 'ai', 'AI', 25, false),
    ('provider_type', '3pl', '3PL', 35, false),
    ('provider_type', 'routing', 'Routing', 45, false),
    ('provider_type', 'payment', 'Payment', 55, false),
    ('provider_type', 'delivery', 'Delivery', 65, false)
) AS v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

